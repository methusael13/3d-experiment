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
import type { GridRendererGPU, GridGroundRenderParams } from '../../renderers/GridRendererGPU';
import type { ShadowRendererGPU } from '../../renderers/ShadowRendererGPU';
import type { DebugTextureManager } from '../../renderers/DebugTextureManager';

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
 * Supports both single shadow map and Cascaded Shadow Maps (CSM).
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
    
    // Update shadow renderer params and compute light space matrix (single + CSM)
    // Use SCENE camera (not debug/view camera) so CSM frustum splits match what the scene sees
    this.shadowRenderer.updateLightMatrix({
      lightDirection: lightDirection as [number, number, number],
      cameraPosition: ctx.sceneCameraPosition,
      cameraForward: ctx.sceneCameraForward,
      cameraViewMatrix: ctx.sceneCameraViewMatrix,
      cameraProjectionMatrix: ctx.sceneCameraProjectionMatrix,
      cameraNearPlane: ctx.near,
      cameraFarPlane: ctx.far,
    });
    
    const shadowConfig = this.shadowRenderer.getConfig();
    const lightPos = this.shadowRenderer.getDirectionalLightPos();
    
    // Check if CSM is enabled
    if (shadowConfig.csmEnabled) {
      this.executeCSM(ctx, shadowConfig, lightPos);
    } else {
      this.executeSingleMap(ctx, shadowConfig, lightPos);
    }
  }
  
  /** Render single shadow map (non-CSM mode) */
  private executeSingleMap(
    ctx: RenderContext, 
    shadowConfig: ReturnType<ShadowRendererGPU['getConfig']>,
    lightPos: ArrayLike<number>,
    slotIndex: number = 0
  ): void {
    const lightPosArray = [lightPos[0], lightPos[1], lightPos[2]] as [number, number, number];
    const shadowMap = this.shadowRenderer.getShadowMap();
    const lightSpaceMatrix = this.shadowRenderer.getLightSpaceMatrix();
    
    if (!shadowMap) return;
    
    // Pre-write single matrix when called standalone (not from executeCSM)
    if (slotIndex === 0) {
      this.objectRenderer.writeShadowMatrices([lightSpaceMatrix]);
    }
    
    // Begin shadow render pass
    const passEncoder = ctx.encoder.beginRenderPass({
      label: 'single-shadow-pass',
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
    const shadowCasters = ctx.scene?.getShadowCasters() ?? [];
    for (const caster of shadowCasters) {
      if (caster.canCastShadows) {
        caster.renderDepthOnly(passEncoder, lightSpaceMatrix, lightPosArray, slotIndex);
      }
    }

    // Render batched object shadows via ObjectRendererGPU (using dynamic offset slot)
    this.objectRenderer.renderShadowPass(passEncoder, slotIndex, lightPosArray);
    
    passEncoder.end();
  }
  
  /** Render multiple cascade shadow maps (CSM mode) */
  private executeCSM(
    ctx: RenderContext,
    shadowConfig: ReturnType<ShadowRendererGPU['getConfig']>,
    lightPos: ArrayLike<number>
  ): void {
    const lightPosArray = [lightPos[0], lightPos[1], lightPos[2]] as [number, number, number];
    const shadowCasters = ctx.scene?.getShadowCasters() ?? [];
    
    // Pre-write ALL shadow matrices (cascades + single map) in one call
    // Slot layout: [cascade0, cascade1, cascade2, cascade3, singleMap]
    const matrices: (Float32Array | ReturnType<ShadowRendererGPU['getCascadeLightSpaceMatrix']>)[] = [];
    const casterMatrices: { lightSpaceMatrix: mat4; lightPosition: [number, number, number] }[] = [];
    for (let i = 0; i < shadowConfig.cascadeCount; i++) {
      const m = this.shadowRenderer.getCascadeLightSpaceMatrix(i);
      matrices.push(m);
      casterMatrices.push({ lightSpaceMatrix: m as mat4, lightPosition: lightPosArray });
    }
    // Single map matrix goes in the slot after all cascades
    const singleMapSlot = shadowConfig.cascadeCount;
    const singleMatrix = this.shadowRenderer.getLightSpaceMatrix();
    matrices.push(singleMatrix);
    casterMatrices.push({ lightSpaceMatrix: singleMatrix as mat4, lightPosition: lightPosArray });
    this.objectRenderer.writeShadowMatrices(matrices);
    
    // Pre-write shadow uniforms for all shadow casters that support it
    for (const caster of shadowCasters) {
      if (caster.canCastShadows && caster.prepareShadowPasses) {
        caster.prepareShadowPasses(casterMatrices);
      }
    }
    
    // Render each cascade using its pre-written slot
    for (let cascadeIdx = 0; cascadeIdx < shadowConfig.cascadeCount; cascadeIdx++) {
      const cascadeView = this.shadowRenderer.getCascadeView(cascadeIdx);
      const cascadeLightMatrix = this.shadowRenderer.getCascadeLightSpaceMatrix(cascadeIdx);
      
      if (!cascadeView) continue;
      
      // Begin cascade shadow render pass
      const passEncoder = ctx.encoder.beginRenderPass({
        label: `csm-shadow-pass-cascade-${cascadeIdx}`,
        colorAttachments: [],
        depthStencilAttachment: {
          view: cascadeView,
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      
      passEncoder.setViewport(0, 0, shadowConfig.resolution, shadowConfig.resolution, 0, 1);
      
      // Render shadow casters for this cascade (uses dynamic offset slot)
      for (const caster of shadowCasters) {
        if (caster.canCastShadows) {
          caster.renderDepthOnly(passEncoder, cascadeLightMatrix, lightPosArray, cascadeIdx);
        }
      }

      // Render batched object shadows for this cascade (uses dynamic offset slot)
      this.objectRenderer.renderShadowPass(passEncoder, cascadeIdx, lightPosArray);
      
      passEncoder.end();
    }
    
    // Also render single shadow map for fallback/compatibility
    // This ensures non-CSM aware receivers still work
    // Uses the pre-written slot after cascade slots
    this.executeSingleMap(ctx, shadowConfig, lightPos, singleMapSlot);
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
      lightColor, shadowEnabled, shadowSoftShadows,
      shadowRadius, dynamicIBL
    } = ctx.options;
    
    // Get terrain from scene
    const terrainManager = ctx.scene?.getWebGPUTerrain()?.getTerrainManager() ?? null;

    // Get shadow map and light space matrix if shadows enabled
    const lightSpaceMatrix = shadowEnabled ? this.shadowRenderer.getLightSpaceMatrix() : null;
    const shadowMap = shadowEnabled ? this.shadowRenderer.getShadowMap() : null;

    const pass = ctx.encoder.beginRenderPass({
      label: 'opaque-pass',
      // Always load color (sky and/or ground already rendered)
      colorAttachments: [ctx.getColorAttachment('load')],
      // Load depth from ground pass (ground clears depth, opaque loads it)
      depthStencilAttachment: ctx.getDepthAttachment('load'),
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
        csmEnabled: this.shadowRenderer.isCSMEnabled(),
      } : undefined;
      
      terrainManager.render(pass, {
        viewProjectionMatrix: ctx.viewProjectionMatrix,
        modelMatrix: this.identityMatrix,
        cameraPosition: ctx.cameraPosition,
        lightDirection,
        lightColor,
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
      lightColor,
      ambientIntensity,
      // Shadow parameters for objects to receive shadows
      lightSpaceMatrix: lightSpaceMatrix ?? undefined,
      shadowEnabled: shadowEnabled,
      shadowBias: 0.002,
      csmEnabled: this.shadowRenderer.isCSMEnabled(),
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
// GROUND PASS - Grid ground plane with shadow receiving
// ============================================================================

export interface GroundPassDependencies {
  gridRenderer: GridRendererGPU;
  shadowRenderer: ShadowRendererGPU;
}

/**
 * GroundPass - Renders solid grid ground plane into HDR buffer
 * Category: scene (participates in post-processing and shadow receiving)
 * Priority: between SKY and OPAQUE so objects render on top
 */
export class GroundPass extends BaseRenderPass {
  readonly name = 'ground';
  readonly priority = PassPriority.SKY + 50; // After sky, before opaque
  readonly category: PassCategory = 'scene';
  
  private gridRenderer: GridRendererGPU;
  private shadowRenderer: ShadowRendererGPU;
  
  constructor(deps: GroundPassDependencies) {
    super();
    this.gridRenderer = deps.gridRenderer;
    this.shadowRenderer = deps.shadowRenderer;
  }
  
  execute(ctx: RenderContext): void {
    const { showGrid, shadowEnabled, lightDirection, lightColor, ambientIntensity } = ctx.options;
    
    // Color: load from sky pass if sky ran, otherwise clear
    const colorLoadOp = ctx.options.skyMode !== 'none' ? 'load' : 'clear';
    
    // Always begin pass to clear depth (OpaquePass depends on depth being cleared here).
    // Only render the ground plane geometry when showGrid is true.
    const pass = ctx.encoder.beginRenderPass({
      label: 'ground-pass',
      colorAttachments: [ctx.getColorAttachment(colorLoadOp as 'clear' | 'load')],
      // Ground is the first pass using the main depth buffer - always clear it
      depthStencilAttachment: ctx.getDepthAttachment('clear'),
    });
    
    if (showGrid && ctx.sceneEnvironment) {
      // Get light space matrix for shadow receiving
      const lightSpaceMatrix = shadowEnabled ? this.shadowRenderer.getLightSpaceMatrix() : null;
      
      const params: GridGroundRenderParams = {
        viewProjectionMatrix: ctx.viewProjectionMatrix,
        cameraPosition: ctx.cameraPosition,
        lightDirection: lightDirection as [number, number, number],
        lightColor: lightColor as [number, number, number],
        ambientIntensity,
        lightSpaceMatrix: lightSpaceMatrix ?? undefined,
        shadowEnabled,
        shadowResolution: this.shadowRenderer.getConfig().resolution,
      };
      
      this.gridRenderer.renderGround(pass, params, ctx.sceneEnvironment);
    }
    
    pass.end();
  }
}

// ============================================================================
// OVERLAY PASS - Axis lines only (viewport overlay)
// ============================================================================

/**
 * OverlayPass - Renders axis lines (depth test, no write)
 * Category: viewport (renders AFTER post-processing to avoid tonemapping)
 * 
 * Note: Grid ground plane is now rendered in GroundPass (scene category).
 * This pass only renders the colored axis indicator lines.
 */
export class OverlayPass extends BaseRenderPass {
  readonly name = 'overlay';
  readonly priority = PassPriority.OVERLAY;
  readonly category: PassCategory = 'viewport';
  
  constructor(private gridRenderer: GridRendererGPU) {
    super();
  }
  
  execute(ctx: RenderContext): void {
    const { showAxes } = ctx.options;
    
    if (!showAxes) return;
    
    // Viewport passes render to final backbuffer (after post-processing)
    const pass = ctx.encoder.beginRenderPass({
      label: 'overlay-pass',
      colorAttachments: [ctx.getBackbufferColorAttachment('load')],
      depthStencilAttachment: ctx.getDepthAttachment('load'),
    });
    
    this.gridRenderer.renderAxes(pass, ctx.viewProjectionMatrix);
    
    pass.end();
  }
}

// ============================================================================
// DEBUG PASS
// ============================================================================

export interface DebugPassDependencies {
  shadowRenderer: ShadowRendererGPU;
  debugTextureManager: DebugTextureManager;
}

/**
 * DebugPass - Renders debug visualizations using DebugTextureManager
 * Category: viewport (renders AFTER post-processing)
 * 
 * Supports multiple debug textures stacked horizontally from bottom-left:
 * - shadow-map: Shadow depth texture
 * - flow-map: Water flow accumulation from erosion
 * - heightmap: Terrain height data
 * - etc.
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
    // Render all enabled debug textures via the manager
    if (this.deps.debugTextureManager.hasEnabledTextures()) {
      this.deps.debugTextureManager.render(
        ctx.encoder,
        ctx.outputView,
        ctx.width,
        ctx.height
      );
    }
  }
}

// NOTE: GizmoPass was removed - gizmo rendering is now handled by TransformGizmoManager
// directly in the Viewport, outside the forward pipeline passes.
