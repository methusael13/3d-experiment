/**
 * Render Pass Implementations
 * 
 * Each pass handles a specific stage of the forward rendering pipeline.
 */

import { mat4 } from 'gl-matrix';
import { BaseRenderPass, PassPriority, type PassCategory } from '../RenderPass';
import type { RenderContext } from '../RenderContext';
import type { SkyRendererGPU } from '../../renderers/SkyRendererGPU';
import type { ObjectRendererGPU } from '../../renderers/ObjectRendererGPU';
import type { GridRendererGPU } from '../../renderers/GridRendererGPU';
import type { ShadowRendererGPU } from '../../renderers/ShadowRendererGPU';

// ============================================================================
// SKY PASS
// ============================================================================

/**
 * SkyPass - Renders sky background (sun or HDR)
 * Category: scene (goes through post-processing)
 */
export class SkyPass extends BaseRenderPass {
  readonly name = 'sky';
  readonly priority = PassPriority.SKY;
  readonly category: PassCategory = 'scene';
  
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
  objectRenderer: ObjectRendererGPU;
}

/**
 * ShadowPass - Renders shadow map from light's perspective
 * Category: scene (shadow maps are used by scene passes)
 * 
 * Uses actual mesh geometry via ShadowCaster interface. Scene objects that
 * implement ShadowCaster (terrain, etc.) render their own depth. Batched
 * objects (primitives) are handled separately via ObjectRendererGPU.
 */
export class ShadowPass extends BaseRenderPass {
  readonly name = 'shadow';
  readonly priority = PassPriority.SHADOW;
  readonly category: PassCategory = 'scene';
  
  private shadowRenderer: ShadowRendererGPU;
  private objectRenderer: ObjectRendererGPU;
  
  constructor(deps: ShadowPassDependencies) {
    super();
    this.shadowRenderer = deps.shadowRenderer;
    this.objectRenderer = deps.objectRenderer;
  }
  
  execute(ctx: RenderContext): void {
    const { shadowEnabled, lightDirection } = ctx.options;
    
    if (!shadowEnabled) return;
    
    // Update shadow renderer params and compute light space matrix
    this.shadowRenderer.updateLightMatrix({
      lightDirection: lightDirection as [number, number, number],
      cameraPosition: ctx.cameraPosition,
      cameraForward: ctx.cameraForward,
    });
    
    const shadowMap = this.shadowRenderer.getShadowMap();
    const lightSpaceMatrix = this.shadowRenderer.getLightSpaceMatrix();
    const shadowConfig = this.shadowRenderer.getConfig();
    const lightPos = this.shadowRenderer.getDirectionalLightPos();
    
    if (!shadowMap) return;
    
    // Begin shadow render pass
    const passEncoder = ctx.encoder.beginRenderPass({
      label: 'unified-shadow-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowMap.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    
    passEncoder.setViewport(0, 0, shadowConfig.resolution, shadowConfig.resolution, 0, 1);
    
    // Render shadow casters via ShadowCaster interface
    // This includes terrain and any other objects that implement ShadowCaster
    const shadowCasters = ctx.scene?.getShadowCasters() ?? [];
    for (const caster of shadowCasters) {
      if (caster.canCastShadows) {
        caster.renderDepthOnly(
          passEncoder,
          lightSpaceMatrix,
          lightPos
        );
      }
    }

    // Render batched object shadows via ObjectRendererGPU
    // (PrimitiveObjects are batched together, not individual ShadowCasters)
    this.objectRenderer.renderShadowPass(passEncoder, lightSpaceMatrix, lightPos);
    
    passEncoder.end();
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
 * Category: scene (goes through post-processing)
 * Reads terrain from ctx.scene
 * Supports IBL (Image-Based Lighting) for realistic ambient lighting
 */
export class OpaquePass extends BaseRenderPass {
  readonly name = 'opaque';
  readonly priority = PassPriority.OPAQUE;
  readonly category: PassCategory = 'scene';
  
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
      shadowEnabled, shadowSoftShadows, shadowRadius,
      dynamicIBL
    } = ctx.options;
    
    // Get terrain from scene
    const terrainManager = ctx.scene?.getWebGPUTerrain()?.getTerrainManager() ?? null;
    
    // Get shadow map and light space matrix if shadows enabled
    const lightSpaceMatrix = shadowEnabled ? this.shadowRenderer.getLightSpaceMatrix() : null;
    const shadowMap = shadowEnabled ? this.shadowRenderer.getShadowMap() : null;
    
    // Determine loadOp based on whether sky pass ran
    const loadOp = ctx.options.skyMode !== 'none' ? 'load' : 'clear';
    
    const pass = ctx.encoder.beginRenderPass({
      label: 'opaque-pass',
      colorAttachments: [ctx.getColorAttachment(loadOp as 'clear' | 'load')],
      depthStencilAttachment: ctx.getDepthAttachment('clear'),
    });
    
    // Render terrain (terrain uses its own SceneEnvironment integration)
    if (terrainManager?.isReady) {
      // Build shadow params for terrain (terrain has its own shadow implementation)
      const shadowParams = (shadowEnabled && lightSpaceMatrix && shadowMap) ? {
        enabled: true,
        softShadows: shadowSoftShadows,
        shadowRadius: shadowRadius,
        lightSpaceMatrix: lightSpaceMatrix,
        shadowMap: shadowMap,
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
        sceneEnvironment: ctx.sceneEnvironment,
      });
    }
    
    // Common render parameters for objects
    const renderParams = {
      viewProjectionMatrix: ctx.viewProjectionMatrix,
      cameraPosition: ctx.cameraPosition,
      lightDirection,
      lightColor: [1, 1, 1] as [number, number, number],
      ambientIntensity,
      // Shadow parameters for objects to receive shadows
      lightSpaceMatrix: lightSpaceMatrix ?? undefined,
      shadowEnabled: shadowEnabled,
      shadowBias: 0.002,
    };
    
    // Render objects with unified SceneEnvironment (shadow + IBL)
    // Falls back to standard render if no environment provided
    this.objectRenderer.renderWithSceneEnvironment(pass, renderParams, ctx.sceneEnvironment ?? null);
    
    pass.end();
  }
}

// ============================================================================
// TRANSPARENT PASS
// ============================================================================

/**
 * TransparentPass - Renders water and other transparent objects
 * Category: scene (goes through post-processing)
 * Reads ocean and terrain from ctx.scene
 * 
 * For water refraction:
 * - Copies scene color before water rendering
 * - Passes scene color copy texture to water for refraction sampling
 */
export class TransparentPass extends BaseRenderPass {
  readonly name = 'transparent';
  readonly priority = PassPriority.TRANSPARENT;
  readonly category: PassCategory = 'scene';
  
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
    
    // Copy scene color for refraction (before water renders over it)
    ctx.copySceneColorForReading();
    
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
      sceneEnvironment: ctx.sceneEnvironment,
      // Pass scene color copy for water refraction
      sceneColorTexture: ctx.sceneColorTextureCopy,
      screenWidth: ctx.width,
      screenHeight: ctx.height,
    });
    
    pass.end();
  }
}

// ============================================================================
// OVERLAY PASS
// ============================================================================

/**
 * OverlayPass - Renders grid and axes (depth test, no write)
 * Category: viewport (renders AFTER post-processing to avoid tonemapping)
 */
export class OverlayPass extends BaseRenderPass {
  readonly name = 'overlay';
  readonly priority = PassPriority.OVERLAY;
  readonly category: PassCategory = 'viewport';
  
  constructor(private gridRenderer: GridRendererGPU) {
    super();
  }
  
  execute(ctx: RenderContext): void {
    const { showGrid, showAxes } = ctx.options;
    
    if (!showGrid && !showAxes) return;
    
    // Viewport passes render to final backbuffer (after post-processing)
    const pass = ctx.encoder.beginRenderPass({
      label: 'overlay-pass',
      colorAttachments: [ctx.getBackbufferColorAttachment('load')],
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
 * Category: viewport (renders AFTER post-processing)
 */
export class DebugPass extends BaseRenderPass {
  readonly name = 'debug';
  readonly priority = PassPriority.DEBUG;
  readonly category: PassCategory = 'viewport';
  
  private deps: DebugPassDependencies;
  
  constructor(deps: DebugPassDependencies) {
    super();
    this.deps = deps;
  }
  
  execute(ctx: RenderContext): void {
    const { showShadowThumbnail, shadowEnabled } = ctx.options;
    
    // Skip if not enabled
    if (!showShadowThumbnail || !shadowEnabled) return;
    
    // Viewport passes render directly to backbuffer
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

// NOTE: GizmoPass was removed - gizmo rendering is now handled by TransformGizmoManager
// directly in the Viewport, outside the forward pipeline passes.
