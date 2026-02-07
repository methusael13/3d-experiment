/**
 * Render Pass Implementations
 * 
 * Each pass handles a specific stage of the forward rendering pipeline.
 */

import { mat4 } from 'gl-matrix';
import { BaseRenderPass, PassPriority } from '../RenderPass';
import type { RenderContext } from '../RenderContext';
import type { SkyRendererGPU } from '../../renderers/SkyRendererGPU';
import type { ObjectRendererGPU } from '../../renderers/ObjectRendererGPU';
import type { GridRendererGPU } from '../../renderers/GridRendererGPU';
import type { ShadowRendererGPU } from '../../renderers/ShadowRendererGPU';
import type { TerrainManager } from '../../../terrain/TerrainManager';
import type { OceanManager } from '../../../ocean/OceanManager';
import type { UnifiedGPUTexture } from '../../GPUTexture';

// ============================================================================
// SKY PASS
// ============================================================================

/**
 * SkyPass - Renders sky background (sun or HDR)
 */
export class SkyPass extends BaseRenderPass {
  readonly name = 'sky';
  readonly priority = PassPriority.SKY;
  
  constructor(private skyRenderer: SkyRendererGPU) {
    super();
  }
  
  execute(ctx: RenderContext): void {
    const { skyMode, sunIntensity, hdrExposure, lightDirection } = ctx.options;
    
    if (skyMode === 'none') return;
    
    const pass = ctx.encoder.beginRenderPass({
      label: 'sky-pass',
      colorAttachments: [ctx.getColorAttachment('clear')],
      // No depth attachment - sky is at infinite depth
    });
    
    if (skyMode === 'sun') {
      this.skyRenderer.renderSunSky(pass, ctx.viewProjectionMatrix, lightDirection, sunIntensity);
    } else if (skyMode === 'hdr') {
      this.skyRenderer.renderHDRSky(pass, ctx.viewProjectionMatrix, hdrExposure);
    }
    
    pass.end();
  }
}

// ============================================================================
// SHADOW PASS
// ============================================================================

export interface ShadowPassDependencies {
  shadowRenderer: ShadowRendererGPU;
}

/**
 * ShadowPass - Renders shadow map from light's perspective
 * Reads terrain from ctx.scene
 */
export class ShadowPass extends BaseRenderPass {
  readonly name = 'shadow';
  readonly priority = PassPriority.SHADOW;
  
  private shadowRenderer: ShadowRendererGPU;
  
  constructor(deps: ShadowPassDependencies) {
    super();
    this.shadowRenderer = deps.shadowRenderer;
  }
  
  execute(ctx: RenderContext): void {
    const { shadowEnabled, lightDirection } = ctx.options;
    
    // Get terrain from scene
    const terrainManager = ctx.scene?.getWebGPUTerrain()?.getTerrainManager() ?? null;
    
    if (!shadowEnabled || !terrainManager) return;
    
    // Update bind group with terrain heightmap
    const heightmap = terrainManager.getHeightmapTexture();
    if (heightmap) {
      this.shadowRenderer.updateBindGroup(heightmap);
    }
    
    // Get terrain config for shadow params
    const terrainConfig = terrainManager.getConfig();
    
    // Render shadow map
    this.shadowRenderer.renderShadowMap(ctx.encoder, {
      lightDirection: lightDirection as [number, number, number],
      cameraPosition: ctx.cameraPosition,
      cameraForward: ctx.cameraForward,
      heightScale: terrainConfig?.heightScale ?? 50,
      terrainSize: terrainConfig?.worldSize ?? 1000,
      gridSize: 129,
    });
  }
}

// ============================================================================
// OPAQUE PASS
// ============================================================================

export interface OpaquePassDependencies {
  objectRenderer: ObjectRendererGPU;
  shadowRenderer: ShadowRendererGPU;
}

/**
 * OpaquePass - Renders terrain and opaque objects with depth
 * Reads terrain from ctx.scene
 */
export class OpaquePass extends BaseRenderPass {
  readonly name = 'opaque';
  readonly priority = PassPriority.OPAQUE;
  
  private objectRenderer: ObjectRendererGPU;
  private shadowRenderer: ShadowRendererGPU;
  private identityMatrix = mat4.create();
  
  constructor(deps: OpaquePassDependencies) {
    super();
    this.objectRenderer = deps.objectRenderer;
    this.shadowRenderer = deps.shadowRenderer;
  }
  
  execute(ctx: RenderContext): void {
    const { 
      wireframe, ambientIntensity, lightDirection,
      shadowEnabled, shadowSoftShadows, shadowRadius 
    } = ctx.options;
    
    // Get terrain from scene
    const terrainManager = ctx.scene?.getWebGPUTerrain()?.getTerrainManager() ?? null;
    
    // Determine loadOp based on whether sky pass ran
    const loadOp = ctx.options.skyMode !== 'none' ? 'load' : 'clear';
    
    const pass = ctx.encoder.beginRenderPass({
      label: 'opaque-pass',
      colorAttachments: [ctx.getColorAttachment(loadOp as 'clear' | 'load')],
      depthStencilAttachment: ctx.getDepthAttachment('clear'),
    });
    
    // Render terrain
    if (terrainManager?.isReady) {
      const shadowParams = shadowEnabled ? {
        enabled: true,
        softShadows: shadowSoftShadows,
        shadowRadius: shadowRadius,
        lightSpaceMatrix: this.shadowRenderer.getLightSpaceMatrix(),
        shadowMap: this.shadowRenderer.getShadowMap(),
      } : undefined;
      
      terrainManager.render(pass, {
        viewProjectionMatrix: ctx.viewProjectionMatrix,
        modelMatrix: this.identityMatrix,
        cameraPosition: ctx.cameraPosition,
        lightDirection,
        lightColor: [1, 1, 1],
        ambientIntensity,
        wireframe,
        shadow: shadowParams,
      });
    }
    
    // Render objects
    this.objectRenderer.render(pass, {
      viewProjectionMatrix: ctx.viewProjectionMatrix,
      cameraPosition: ctx.cameraPosition,
      lightDirection,
      lightColor: [1, 1, 1],
      ambientIntensity,
    });
    
    pass.end();
  }
}

// ============================================================================
// TRANSPARENT PASS
// ============================================================================

/**
 * TransparentPass - Renders water and other transparent objects
 * Reads ocean and terrain from ctx.scene
 */
export class TransparentPass extends BaseRenderPass {
  readonly name = 'transparent';
  readonly priority = PassPriority.TRANSPARENT;
  
  constructor() {
    super();
  }
  
  execute(ctx: RenderContext): void {
    // Get ocean and terrain from scene
    const oceanManager = ctx.scene?.getOcean()?.getOceanManager() ?? null;
    const terrainManager = ctx.scene?.getWebGPUTerrain()?.getTerrainManager() ?? null;
    
    // Skip if no ocean manager (presence in scene = enabled)
    if (!oceanManager || !oceanManager.isReady) return;
    
    // Copy depth for shader reading (water uses depth for transparency effects)
    ctx.copyDepthForReading();
    
    // Get terrain config for size/scale (default if no terrain)
    const terrainConfig = terrainManager?.getConfig();
    const { lightDirection, sunIntensity, ambientIntensity } = ctx.options;
    
    const pass = ctx.encoder.beginRenderPass({
      label: 'transparent-pass',
      colorAttachments: [ctx.getColorAttachment('load')],
      depthStencilAttachment: ctx.getDepthAttachment('load'),
    });
    
    oceanManager.render(pass, {
      viewProjectionMatrix: ctx.viewProjectionMatrix,
      cameraPosition: ctx.cameraPosition,
      terrainSize: terrainConfig?.worldSize ?? 1000,
      heightScale: terrainConfig?.heightScale ?? 50,
      time: ctx.time,
      sunDirection: lightDirection,
      sunIntensity,
      ambientIntensity,
      depthTexture: ctx.depthTextureCopy,
      near: ctx.near,
      far: ctx.far,
    });
    
    pass.end();
  }
}

// ============================================================================
// OVERLAY PASS
// ============================================================================

/**
 * OverlayPass - Renders grid and axes (depth test, no write)
 */
export class OverlayPass extends BaseRenderPass {
  readonly name = 'overlay';
  readonly priority = PassPriority.OVERLAY;
  
  constructor(private gridRenderer: GridRendererGPU) {
    super();
  }
  
  execute(ctx: RenderContext): void {
    const { showGrid, showAxes } = ctx.options;
    
    if (!showGrid && !showAxes) return;
    
    const pass = ctx.encoder.beginRenderPass({
      label: 'overlay-pass',
      colorAttachments: [ctx.getColorAttachment('load')],
      depthStencilAttachment: ctx.getDepthAttachment('load'),
    });
    
    this.gridRenderer.render(pass, ctx.viewProjectionMatrix, {
      showGrid,
      showAxes,
    });
    
    pass.end();
  }
}

// ============================================================================
// DEBUG PASS
// ============================================================================

export interface DebugPassDependencies {
  shadowRenderer: ShadowRendererGPU;
}

/**
 * DebugPass - Renders debug visualizations (shadow map thumbnail)
 * 
 * Note: When useHDR is true, this pass is skipped because the final swap chain
 * isn't available until after post-processing. The debug thumbnail is rendered
 * separately after the PostProcessPipeline.execute() call.
 */
export class DebugPass extends BaseRenderPass {
  readonly name = 'debug';
  readonly priority = PassPriority.DEBUG;
  
  private deps: DebugPassDependencies;
  
  constructor(deps: DebugPassDependencies) {
    super();
    this.deps = deps;
  }
  
  execute(ctx: RenderContext): void {
    const { showShadowThumbnail, shadowEnabled } = ctx.options;
    
    // Skip if not enabled
    if (!showShadowThumbnail || !shadowEnabled) return;
    
    // When HDR path is active, skip here - thumbnail will be rendered
    // after post-processing completes to draw on final swap chain
    if (ctx.useHDR) return;
    
    const thumbnailSize = 200;
    const thumbnailX = 10;
    const thumbnailY = 10;
    
    this.deps.shadowRenderer.renderDebugThumbnail(
      ctx.encoder,
      ctx.outputView,
      thumbnailX,
      thumbnailY,
      thumbnailSize,
      ctx.width,
      ctx.height
    );
  }
}
