/**
 * GPUForwardPipeline - WebGPU Forward Rendering Pipeline
 * 
 * Uses a pass-based architecture for modularity:
 * 1. ShadowPass - Renders shadow map from light's perspective
 * 2. SkyPass - Renders sky background
 * 3. OpaquePass - Renders terrain and opaque objects
 * 4. TransparentPass - Renders water
 * 5. OverlayPass - Renders grid and axes
 * 6. DebugPass - Debug visualizations (skipped in HDR path)
 * 7. Post-processing via PostProcessPipeline:
 *    - SSAOEffect (optional) - Screen-space ambient occlusion
 *    - CompositeEffect (always) - Tonemapping + gamma correction
 * 
 * All scene passes render to an HDR intermediate buffer (rgba16float).
 * The CompositePass always runs to apply tonemapping and gamma correction.
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { GridRendererGPU } from '../renderers/GridRendererGPU';
import { SkyRendererGPU } from '../renderers/SkyRendererGPU';
import { ObjectRendererGPU } from '../renderers/ObjectRendererGPU';
import { ShadowRendererGPU, DebugTextureManager } from '../renderers';
import { SceneEnvironment, type IBLResources } from '../renderers/shared';
import { DynamicSkyIBL, type IBLTextures } from '../ibl';
import { WebGPUShadowSettings } from '@/demos/sceneBuilder/components/panels/RenderingPanel';
import { 
  PostProcessPipeline, 
  SSAOEffect, 
  CompositeEffect,
  AtmosphericFogEffect,
  CloudCompositeEffect,
  type SSAOEffectConfig,
  type CompositeEffectConfig,
  type AtmosphericFogConfig,
  type EffectUniforms,
} from '../postprocess';
import { CloudRayMarcher, CloudShadowGenerator, CloudTemporalFilter, type CloudConfig } from '../clouds';
import { RenderContextImpl, type RenderContextOptions } from './RenderContext';
import type { World } from '../../ecs/World';
import type { RenderPass } from './RenderPass';
import { MeshRenderSystem } from '../../ecs/systems/MeshRenderSystem';
import { SSRSystem } from '../../ecs/systems/SSRSystem';
import { 
  SkyPass, 
  ShadowPass, 
  OpaquePass, 
  TransparentPass, 
  GroundPass,
  OverlayPass,
  DebugPass,
  SelectionMaskPass,
  SelectionOutlinePass,
  SSRPass,
  DebugViewPass,
} from './passes';
import type { DebugViewMode } from './passes';
import type { SSRConfig, SSRQualityLevel } from './SSRConfig';
import { SelectionOutlineRendererGPU } from '../renderers/SelectionOutlineRendererGPU';

/**
 * Simple camera interface for WebGPU pipeline
 */
export interface GPUCamera {
  getViewMatrix(): Float32Array | number[];
  getProjectionMatrix(): Float32Array | number[];
  getPosition(): Float32Array | number[];
  getVpMatrix(): Float32Array | number[];
  /** Near clipping plane distance */
  near?: number;
  /** Far clipping plane distance */
  far?: number;
}

export interface GPUForwardPipelineOptions {
  width: number;
  height: number;
  sampleCount?: number;
}

export interface RenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
  skyMode?: 'sun' | 'hdr' | 'none';
  sunIntensity?: number;
  hdrExposure?: number;
  wireframe?: boolean;
  ambientIntensity?: number;
  lightDirection?: [number, number, number];
  lightColor?: [number, number, number];
  shadowEnabled?: boolean;
  shadowSoftShadows?: boolean;
  shadowRadius?: number;
  showShadowThumbnail?: boolean;
  /** Enable dynamic IBL (Image-Based Lighting) from procedural sky. Default: true in sun mode */
  dynamicIBL?: boolean;
}

/**
 * Default render options
 */
export const DEFAULT_RENDER_OPTIONS: Required<RenderOptions> = {
  showGrid: true,
  showAxes: true,
  skyMode: 'sun',
  sunIntensity: 20,
  hdrExposure: 1.0,
  wireframe: false,
  ambientIntensity: 0.3,
  lightDirection: [1, 0, 1],
  lightColor: [1, 1, 1],
  shadowEnabled: true,
  shadowSoftShadows: true,
  shadowRadius: 200,
  showShadowThumbnail: false,
  dynamicIBL: true,  // Enabled by default for sun mode
};

/**
 * Forward rendering pipeline for WebGPU
 */
export class GPUForwardPipeline {
  private ctx: GPUContext;
  private width: number;
  private height: number;
  private sampleCount: number;
  
  // Render targets
  private depthTexture: UnifiedGPUTexture;
  private depthTextureCopy: UnifiedGPUTexture;
  private msaaColorTexture: UnifiedGPUTexture | null = null;
  private msaaHdrColorTexture: UnifiedGPUTexture | null = null;
  private sceneColorTexture: UnifiedGPUTexture | null = null;
  private sceneColorTextureCopy: UnifiedGPUTexture | null = null;
  private selectionMaskTexture: UnifiedGPUTexture | null = null;
  private normalsTexture: UnifiedGPUTexture | null = null;
  private selectionOutlineRenderer!: SelectionOutlineRendererGPU;
  
  // Post-processing pipeline (plugin-based)
  private postProcessPipeline: PostProcessPipeline | null = null;
  
  // Default camera parameters (used when camera doesn't provide them)
  private defaultNearPlane = 0.1;
  private defaultFarPlane = 2000;
  
  // Renderers
  private gridRenderer: GridRendererGPU;
  private skyRenderer: SkyRendererGPU;
  private objectRenderer: ObjectRendererGPU;
  private shadowRenderer: ShadowRendererGPU;
  
  // IBL (Image-Based Lighting)
  private dynamicSkyIBL: DynamicSkyIBL;
  private iblBindGroup: GPUBindGroup | null = null;
  private iblEnabled: boolean = true;  // Can be toggled for performance
  
  // Shared environment (shadow + IBL) - Group 3 for all renderers
  private sceneEnvironment: SceneEnvironment;
  
  // Debug texture manager
  private debugTextureManager: DebugTextureManager;
  
  // Render passes (ordered by priority)
  private passes: RenderPass[] = [];
  
  // SSR pass reference (for direct config access)
  private ssrPass: SSRPass | null = null;
  
  // Debug view pass reference
  private debugViewPass: DebugViewPass | null = null;
  
  // Cached per-frame: whether SSRSystem found any consumers
  private lastSSRSystemHasConsumers = false;
  
  // Default shadow settings
  private shadowEnabled = true;
  private shadowSoftShadows = true;
  private shadowRadius = 200;
  
  // Volumetric clouds
  private cloudRayMarcher: CloudRayMarcher | null = null;
  private cloudShadowGenerator: CloudShadowGenerator | null = null;
  private cloudTemporalFilter: CloudTemporalFilter | null = null;
  private cloudEnabled = false;
  
  // Previous frame's view-projection matrix for temporal reprojection motion vectors
  private prevViewProjectionMatrix: Float32Array = new Float32Array(16);
  private hasPrevViewProjectionMatrix = false;
  
  // GPU timestamp query profiling (Phase 3)
  private timestampQuerySet: GPUQuerySet | null = null;
  private timestampBuffer: GPUBuffer | null = null;
  private timestampReadBuffer: GPUBuffer | null = null;
  private timestampSupported = false;
  private _cloudTimings: { raymarch: number; temporal: number; total: number } = { raymarch: 0, temporal: 0, total: 0 };
  
  // Animation time
  private time = 0;
  private lastFrameTime = performance.now();

  // Stats
  private lastDrawCallsCount = 0;
  
  constructor(ctx: GPUContext, options: GPUForwardPipelineOptions) {
    this.ctx = ctx;
    this.width = options.width;
    this.height = options.height;
    this.sampleCount = options.sampleCount || 1;
    
    // Create depth textures
    this.depthTexture = UnifiedGPUTexture.createDepth(
      ctx, this.width, this.height, 'depth24plus', 'forward-depth'
    );
    this.depthTextureCopy = this.createDepthTextureCopy();
    
    // Create MSAA color texture if needed
    if (this.sampleCount > 1) {
      this.msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        ctx, this.width, this.height, ctx.format, this.sampleCount, 'forward-msaa-color'
      );
    }
    
    // Create renderers
    this.gridRenderer = new GridRendererGPU(ctx);
    this.skyRenderer = new SkyRendererGPU(ctx);
    // Use shared objectRenderer from GPUContext (so primitives add meshes to the same instance)
    this.objectRenderer = ctx.objectRenderer;
    this.shadowRenderer = new ShadowRendererGPU(ctx, {
      resolution: 2048,
      shadowRadius: this.shadowRadius,
    });

    // Wire the shared shadow renderer into the object renderer so it can
    // use the shared depth-pass resources (bind group layout + buffer).
    this.objectRenderer.setShadowRenderer(this.shadowRenderer);
    
    // Create Dynamic Sky IBL for image-based lighting
    this.dynamicSkyIBL = new DynamicSkyIBL(ctx);
    
    // Create shared SceneEnvironment for shadow + IBL (Group 3 bind group)
    this.sceneEnvironment = new SceneEnvironment(ctx);
    
    // Create selection outline renderer
    this.selectionOutlineRenderer = new SelectionOutlineRendererGPU(ctx);
    
    // Create selection mask texture (r8unorm, same size as viewport)
    this.selectionMaskTexture = this._createSelectionMaskTexture();
    
    // Create normals G-buffer texture (rgba16float, for SSR)
    this.normalsTexture = this._createNormalsTexture();
    
    // Create debug texture manager
    this.debugTextureManager = new DebugTextureManager(ctx);
    
    // Register shadow map for debug visualization
    this.debugTextureManager.register(
      'shadow-map',
      'depth',
      () => this.shadowRenderer.getShadowMap()?.view ?? null
    );

    // Register CSM cascade shadow maps for debug visualization
    for (let i = 0; i < 4; i++) {
      const cascadeIndex = i;
      this.debugTextureManager.register(
        `csm-cascade-${i}`,
        'depth',
        () => this.shadowRenderer.getCascadeView(cascadeIndex)
      );
    }
    
    // Create render passes
    this.initializePasses();
    
    // Register SSR texture for debug visualization
    this.debugTextureManager.register(
      'ssr',
      'float',
      () => this.ssrPass?.getSSRTexture()?.view ?? null
    );
    
    // Initialize post-processing pipeline (always active for tonemapping)
    this.initializePostProcessing();
  }
  
  /**
   * Initialize render passes
   * Passes read terrain/ocean from ctx.scene during execute()
   */
  private initializePasses(): void {
    // Create passes with renderer references
    // Note: Terrain and ocean are read from scene during execute(), not stored in passes
    const shadowPass = new ShadowPass({
      shadowRenderer: this.shadowRenderer,
      objectRenderer: this.objectRenderer,
      meshPool: this.ctx.variantMeshPool,
    });
    
    const skyPass = new SkyPass(this.skyRenderer);
    
    const opaquePass = new OpaquePass({
      objectRenderer: this.objectRenderer,
      shadowRenderer: this.shadowRenderer,
      meshPool: this.ctx.variantMeshPool,
    });
    
    const transparentPass = new TransparentPass();
    
    const groundPass = new GroundPass({
      gridRenderer: this.gridRenderer,
      shadowRenderer: this.shadowRenderer,
    });
    
    const overlayPass = new OverlayPass(this.gridRenderer);
    
    const debugPass = new DebugPass({
      shadowRenderer: this.shadowRenderer,
      debugTextureManager: this.debugTextureManager,
    });
    
    const selectionMaskPass = new SelectionMaskPass({
      objectRenderer: this.objectRenderer,
    });
    
    const selectionOutlinePass = new SelectionOutlinePass({
      objectRenderer: this.objectRenderer,
      outlineRenderer: this.selectionOutlineRenderer,
    });
    
    // Create SSR pass (disabled by default - user enables via UI)
    const ssrPass = new SSRPass(this.ctx, this.width, this.height, { enabled: false });
    this.ssrPass = ssrPass;
    
    // Wire consumer check — SSR pass skips when no consumers exist (zero GPU cost)
    // SSRSystem.hasConsumers is computed each frame before the pipeline renders
    ssrPass.setConsumerCheck(() => {
      return this.lastSSRSystemHasConsumers;
    });
    
    // Create debug view pass (fullscreen depth/normals/SSR visualization)
    const debugViewPass = new DebugViewPass(this.ctx);
    this.debugViewPass = debugViewPass;
    debugViewPass.setSSRTextureProvider(() => ssrPass.getSSRTexture());
    
    // Store passes in priority order
    // Note: Gizmos are rendered by TransformGizmoManager, not by the pipeline
    this.passes = [
      shadowPass,
      skyPass,
      groundPass,
      opaquePass,
      ssrPass,
      transparentPass,
      overlayPass,
      selectionMaskPass,
      selectionOutlinePass,
      debugPass,
      debugViewPass,
    ].sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Configure shadow settings
   */
  setShadowSettings(config: WebGPUShadowSettings): void {
    if (config.enabled !== undefined) this.shadowEnabled = config.enabled;
    if (config.softShadows !== undefined) this.shadowSoftShadows = config.softShadows;
    if (config.shadowRadius !== undefined) {
      this.shadowRadius = config.shadowRadius;
      this.shadowRenderer.setShadowRadius(config.shadowRadius);
      // Sync cloud shadow coverage area with CSM shadow radius
      this.cloudShadowGenerator?.setShadowRadius(config.shadowRadius);
    }
    if (config.resolution !== undefined) {
      this.shadowRenderer.setResolution(config.resolution);
    }
    // CSM settings
    if (config.csmEnabled !== undefined) {
      this.shadowRenderer.setCSMEnabled(config.csmEnabled);
    }
    if (config.cascadeCount !== undefined) {
      this.shadowRenderer.setCascadeCount(config.cascadeCount);
    }
    if (config.cascadeBlendFraction !== undefined) {
      this.shadowRenderer.setCascadeBlendFraction(config.cascadeBlendFraction);
    }
  }
  
  /**
   * Create depth texture copy for shader sampling
   */
  private createDepthTextureCopy(): UnifiedGPUTexture {
    const texture = this.ctx.device.createTexture({
      label: 'forward-depth-copy',
      size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
      format: 'depth24plus',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    
    const view = texture.createView({
      label: 'forward-depth-copy-view',
      format: 'depth24plus',
      dimension: '2d',
      aspect: 'depth-only',
    });
    
    return {
      texture, view, format: 'depth24plus',
      width: this.width, height: this.height,
      destroy: () => texture.destroy(),
    } as UnifiedGPUTexture;
  }
  
  /**
   * Create HDR scene color texture
   */
  private createSceneColorTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'scene-color-hdr',
      width: this.width,
      height: this.height,
      format: 'rgba16float',
      renderTarget: true,
      sampled: true,
      copySrc: true,
    });
  }
  
  /**
   * Create copy of scene color texture for shader reading (e.g., water refraction)
   */
  private createSceneColorTextureCopy(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'scene-color-hdr-copy',
      width: this.width,
      height: this.height,
      format: 'rgba16float',
      renderTarget: false,  // Not a render target, just copy destination
      sampled: true,
      copyDst: true,
    });
  }
  
  /**
   * Create selection mask texture (r8unorm) for selection outline pass
   */
  private _createSelectionMaskTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'selection-mask',
      width: this.width,
      height: this.height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
    });
  }
  
  /**
   * Create normals G-buffer texture (rgba16float)
   * Written by opaque pass MRT, read by SSR pass
   */
  private _createNormalsTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'normals-gbuffer',
      width: this.width,
      height: this.height,
      format: 'rgba16float',
      renderTarget: true,
      sampled: true,
    });
  }
  
  /**
   * Create MSAA HDR texture
   */
  private createMsaaHdrColorTexture(): UnifiedGPUTexture {
    return UnifiedGPUTexture.createRenderTarget(
      this.ctx, this.width, this.height,
      'rgba16float', this.sampleCount, 'forward-msaa-hdr-color'
    );
  }
  
  /**
   * Initialize post-processing pipeline with effects
   */
  private initializePostProcessing(): void {
    // Create HDR intermediate buffer for scene rendering
    this.sceneColorTexture = this.createSceneColorTexture();
    // Create copy for reading (water refraction needs scene rendered before water)
    this.sceneColorTextureCopy = this.createSceneColorTextureCopy();
    
    if (this.sampleCount > 1) {
      this.msaaHdrColorTexture = this.createMsaaHdrColorTexture();
    }
    
    // Create post-processing pipeline
    this.postProcessPipeline = new PostProcessPipeline(
      this.ctx,
      this.width,
      this.height
    );
    
    // Add SSAO effect (order 100 - runs first, starts DISABLED)
    const ssaoEffect = new SSAOEffect({
      radius: 1.0,
      intensity: 1.5,
      bias: 0.025,
      samples: 16,
      blur: true,
    });
    ssaoEffect.enabled = false; // SSAO is optional, disabled by default
    this.postProcessPipeline.addEffect(ssaoEffect, 100);
    
    // Add Atmospheric Fog effect (order 150 - runs between SSAO and Composite, starts DISABLED)
    const fogEffect = new AtmosphericFogEffect({
      enabled: false,
      visibilityDistance: 3000,
      hazeIntensity: 0.8,
      hazeScaleHeight: 800,
      heightFogEnabled: false,
      fogVisibilityDistance: 1500,
      fogMode: 'exp' as const,
      fogHeight: 0,
      fogHeightFalloff: 0.05,
      fogColor: [0.85, 0.88, 0.92],
      fogSunScattering: 0.3,
    });
    fogEffect.enabled = false; // Disabled by default
    this.postProcessPipeline.addEffect(fogEffect, 150);
    
    // Add Composite effect (order 200 - runs after SSAO + Fog)
    // ALWAYS enabled - handles tonemapping + gamma correction
    const compositeEffect = new CompositeEffect(this.ctx.format, {
      tonemapping: 3, // ACES
      gamma: 2.2,
      exposure: 1.0,
    });
    this.postProcessPipeline.addEffect(compositeEffect, 200);
    
    // Add Cloud Composite effect (order 125 — before fog @150, after SSAO @100, starts DISABLED)
    // Cloud ray march output is fed to this effect each frame when clouds are enabled
    const cloudCompositeEffect = new CloudCompositeEffect();
    cloudCompositeEffect.enabled = false;
    this.postProcessPipeline.addEffect(cloudCompositeEffect, 125);
    
    // Register cloud debug textures
    this.debugTextureManager.register(
      'cloud-result',
      'float',
      () => this.cloudRayMarcher?.outputView ?? null
    );
    this.debugTextureManager.register(
      'weather-map',
      'float',
      () => this.cloudRayMarcher?.weatherMapGenerator.textureView ?? null
    );
  }
  
  /**
   * Resize render targets
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    
    this.width = width;
    this.height = height;
    
    // Recreate textures
    this.depthTexture.destroy();
    this.depthTexture = UnifiedGPUTexture.createDepth(
      this.ctx, this.width, this.height, 'depth24plus', 'forward-depth'
    );
    
    this.depthTextureCopy.destroy();
    this.depthTextureCopy = this.createDepthTextureCopy();
    
    if (this.msaaColorTexture) {
      this.msaaColorTexture.destroy();
      this.msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        this.ctx, this.width, this.height, this.ctx.format, this.sampleCount, 'forward-msaa-color'
      );
    }
    
    if (this.sceneColorTexture) {
      this.sceneColorTexture.destroy();
      this.sceneColorTexture = this.createSceneColorTexture();
    }
    
    if (this.sceneColorTextureCopy) {
      this.sceneColorTextureCopy.destroy();
      this.sceneColorTextureCopy = this.createSceneColorTextureCopy();
    }
    
    if (this.msaaHdrColorTexture) {
      this.msaaHdrColorTexture.destroy();
      this.msaaHdrColorTexture = this.createMsaaHdrColorTexture();
    }
    
    // Recreate selection mask texture
    if (this.selectionMaskTexture) {
      this.selectionMaskTexture.destroy();
      this.selectionMaskTexture = this._createSelectionMaskTexture();
    }
    
    // Recreate normals texture
    if (this.normalsTexture) {
      this.normalsTexture.destroy();
      this.normalsTexture = this._createNormalsTexture();
    }
    
    // Resize SSR pass
    this.ssrPass?.resize(width, height);
    
    // Resize cloud ray marcher + temporal filter (Phase 3)
    if (this.cloudRayMarcher) {
      this.cloudRayMarcher.resize(width, height);
      if (this.cloudTemporalFilter) {
        const halfW = this.cloudRayMarcher.outputWidth;
        const halfH = this.cloudRayMarcher.outputHeight;
        this.cloudTemporalFilter.resize(halfW, halfH, width, height);
      }
    }
    
    // Resize post-processing pipeline
    if (this.postProcessPipeline) {
      this.postProcessPipeline.resize(width, height);
    }
  }
  
  /**
   * Render a frame using pass-based architecture
   * @param camera The view camera (what appears on screen - may be debug camera)
   * @param options Render options
   * @param sceneCamera Optional separate scene camera for shadows/culling/shader uniforms.
   *                    If not provided, `camera` is used for everything.
   * @param world ECS World — passes query entities from this
   */
  render(
    camera: GPUCamera,
    options: RenderOptions = {},
    sceneCamera?: GPUCamera,
    world?: World
  ): void {
    // Calculate delta time
    const now = performance.now();
    const deltaTime = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.time += deltaTime;
    
    // Get swap chain texture
    if (!this.ctx.context) {
      console.warn('[GPUForwardPipeline] Canvas not configured');
      return;
    }
    
    const outputTexture = this.ctx.context.getCurrentTexture();
    const outputView = outputTexture.createView();
    
    // Create command encoder
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'forward-pipeline-encoder',
    });
    
    // Always use HDR path since composite is always enabled
    const useHDR = this.postProcessPipeline && this.sceneColorTexture;
    
    // Merge options with instance defaults
    const mergedOptions: Required<RenderOptions> = {
      ...DEFAULT_RENDER_OPTIONS,
      shadowEnabled: this.shadowEnabled,
      shadowSoftShadows: this.shadowSoftShadows,
      shadowRadius: this.shadowRadius,
      ...options,
    };
    
    // ========== UPDATE DYNAMIC SKY IBL ==========
    // Only update in sun mode when dynamicIBL is enabled
    if (mergedOptions.skyMode === 'sun' && mergedOptions.dynamicIBL && this.iblEnabled) {
      // Normalize sun direction
      const lightDir = mergedOptions.lightDirection;
      const len = Math.sqrt(lightDir[0] * lightDir[0] + lightDir[1] * lightDir[1] + lightDir[2] * lightDir[2]);
      const sunDirection: [number, number, number] = len > 0 
        ? [lightDir[0] / len, lightDir[1] / len, lightDir[2] / len]
        : [0, 1, 0];
      
      // Update IBL (processes one task per frame)
      this.dynamicSkyIBL.update(encoder, sunDirection, mergedOptions.sunIntensity, deltaTime);
      
      // Get IBL textures if ready and update SceneEnvironment
      if (this.dynamicSkyIBL.isReady()) {
        const iblTextures = this.dynamicSkyIBL.getIBLTextures();
        
        // Update SceneEnvironment with IBL resources
        const iblResources: IBLResources = {
          diffuseCubemap: iblTextures.diffuse,
          specularCubemap: iblTextures.specular,
          brdfLut: iblTextures.brdfLut,
        };
        this.sceneEnvironment.setIBL(iblResources);
      }
    } else {
      // Clear IBL when not in sun mode or IBL disabled
      this.sceneEnvironment.setIBL(null);
    }
    
    // Update SceneEnvironment with shadow map and CSM resources
    if (mergedOptions.shadowEnabled) {
      const shadowMap = this.shadowRenderer.getShadowMap();
      if (shadowMap) {
        this.sceneEnvironment.setShadowMap(shadowMap.view);
      }
      
      // Update CSM resources if CSM is enabled
      if (this.shadowRenderer.isCSMEnabled()) {
        const csmArrayView = this.shadowRenderer.getShadowMapArrayView();
        const csmUniformBuffer = this.shadowRenderer.getCSMUniformBuffer();
        if (csmArrayView && csmUniformBuffer) {
          this.sceneEnvironment.setCSM({
            shadowArrayView: csmArrayView,
            uniformBuffer: csmUniformBuffer,
          });
        }
      } else {
        this.sceneEnvironment.setCSM(null);
      }
    } else {
      this.sceneEnvironment.setShadowMap(null);
      this.sceneEnvironment.setCSM(null);
    }
    
    // Get near/far from camera or use defaults
    const nearPlane = camera.near ?? this.defaultNearPlane;
    const farPlane = camera.far ?? this.defaultFarPlane;
    
    // Create render context
    const contextOptions: RenderContextOptions = {
      ctx: this.ctx,
      encoder,
      camera,
      sceneCamera,
      world,
      options: mergedOptions,
      width: this.width,
      height: this.height,
      near: nearPlane,
      far: farPlane,
      time: this.time,
      deltaTime,
      sampleCount: this.sampleCount,
      depthTexture: this.depthTexture,
      depthTextureCopy: this.depthTextureCopy,
      outputTexture,
      outputView,
      useHDR: !!useHDR,
      sceneColorTexture: this.sceneColorTexture ?? undefined,
      sceneColorTextureCopy: this.sceneColorTextureCopy ?? undefined,
      msaaHdrColorTexture: this.msaaHdrColorTexture ?? undefined,
      msaaColorTexture: this.msaaColorTexture ?? undefined,
      // Selection mask texture for outline pass
      selectionMaskTexture: this.selectionMaskTexture ?? undefined,
      // Normals G-buffer for SSR
      normalsTexture: this.normalsTexture ?? undefined,
      // Unified SceneEnvironment (shadow + IBL) for all renderers
      sceneEnvironment: this.sceneEnvironment,
      // MeshRenderSystem — provides per-frame variant groups for composed rendering
      meshRenderSystem: world ? this.findMeshRenderSystem(world) : undefined,
    };
    
    const renderCtx = new RenderContextImpl(contextOptions);
    
    // ========== UPDATE SSR TEXTURE FOR OPAQUE OBJECTS ==========
    // Set SSR texture on SceneEnvironment so opaque objects can sample it (1-frame lag)
    const ssrTexture = this.ssrPass?.getSSRTexture();
    this.sceneEnvironment.setSSR(ssrTexture?.view ?? null);
    
    // ========== UPDATE SSR CONSUMER STATE ==========
    // Read SSRSystem.hasConsumers so the SSR pass can skip when no consumers exist
    if (world) {
      const ssrSystem = this.findSSRSystem(world);
      this.lastSSRSystemHasConsumers = ssrSystem?.hasConsumers ?? false;
    } else {
      this.lastSSRSystemHasConsumers = false;
    }
    
    // ========== SCENE PASSES (render to HDR buffer) ==========
    // Execute scene category passes first (terrain, objects, water, sky)
    for (const pass of this.passes) {
      if (pass.enabled && pass.category === 'scene') {
        pass.execute(renderCtx);
      }
    }
    
    // ========== CLOUD SHADOW MAP (compute, before scene passes use it) ==========
    if (this.cloudEnabled && this.cloudRayMarcher?.isReady && this.cloudShadowGenerator) {
      const dirLight = renderCtx.getDirectionalLight();
      const config = this.cloudRayMarcher.getConfig();
      
      // Dispatch cloud shadow map generation
      if (config.cloudShadows) {
        this.cloudShadowGenerator.execute(
          encoder,
          this.cloudRayMarcher.noiseGenerator,
          this.cloudRayMarcher.weatherMapGenerator,
          config,
          dirLight.direction,
          renderCtx.cameraPosition,
          this.cloudRayMarcher.currentWeatherOffsetX,
          this.cloudRayMarcher.currentWeatherOffsetZ,
        );
        
        // Wire cloud shadow map + uniforms into SceneEnvironment (bindings 17-18)
        this.sceneEnvironment.setCloudShadow(
          this.cloudShadowGenerator.textureView,
          this.cloudShadowGenerator.sceneUniformBuffer,
        );
      } else {
        this.sceneEnvironment.setCloudShadow(null, null);
      }
    }
    
    // ========== CLOUD RAY MARCH + TEMPORAL REPROJECTION (compute, between scene and post-processing) ==========
    if (this.cloudEnabled && this.cloudRayMarcher?.isReady) {
      const dirLight = renderCtx.getDirectionalLight();
      const config = this.cloudRayMarcher.getConfig();
      // Scale sunIntensity by sunIntensityFactor (fades to ~0 at night for moonlight)
      const cloudSunIntensity = mergedOptions.sunIntensity * dirLight.sunIntensityFactor;
      
      // Sync frame index from temporal filter → ray marcher (for checkerboard pattern)
      if (this.cloudTemporalFilter) {
        this.cloudRayMarcher.setFrameIndex(this.cloudTemporalFilter.frameIndex);
      }

      // Dispatch cloud ray march (half-resolution, checkerboard)
      this.cloudRayMarcher.execute(
        encoder,
        renderCtx.inverseViewProjectionMatrix,
        renderCtx.cameraPosition,
        dirLight.direction,
        dirLight.effectiveColor,
        cloudSunIntensity,
        this.time,
        deltaTime,
        nearPlane,
        farPlane,
      );
      
      // Dispatch temporal reprojection (Phase 3)
      // Uses motion vectors from prevViewProj + inverseViewProj to reproject
      // history samples to their correct screen locations during camera motion.
      let cloudOutputView = this.cloudRayMarcher.outputView;
      let cloudOutputWidth = this.cloudRayMarcher.outputWidth;
      let cloudOutputHeight = this.cloudRayMarcher.outputHeight;
      
      if (this.cloudTemporalFilter && config.temporalReprojection) {
        // Feed current and previous VP matrices for motion vector generation
        this.cloudTemporalFilter.setMatrices(
          this.prevViewProjectionMatrix,
          renderCtx.inverseViewProjectionMatrix,
        );
        
        // Only run temporal filter if we have a valid previous VP matrix
        // (skip on first frame — no history to reproject)
        if (this.hasPrevViewProjectionMatrix) {
          this.cloudTemporalFilter.execute(encoder, this.cloudRayMarcher.outputView!);
          // Use the temporally filtered output instead of the raw raymarch result
          cloudOutputView = this.cloudTemporalFilter.outputView;
        }
      }
      
      // Save current VP matrix for next frame's motion vector generation.
      // Must be done AFTER we pass prevVP to the temporal filter but BEFORE
      // we finish the frame, so next frame's prevVP = this frame's current VP.
      this.prevViewProjectionMatrix.set(renderCtx.viewProjectionMatrix);
      this.hasPrevViewProjectionMatrix = true;
      
      // Feed cloud texture to the composite effect (with half-res dimensions for bilateral upscale)
      const cloudComposite = this.postProcessPipeline?.getEffect<CloudCompositeEffect>('cloudComposite');
      if (cloudComposite) {
        cloudComposite.setCloudTexture(cloudOutputView, cloudOutputWidth, cloudOutputHeight);
      }
    } else {
      // No clouds — clear the cloud texture on the composite effect
      const cloudComposite = this.postProcessPipeline?.getEffect<CloudCompositeEffect>('cloudComposite');
      if (cloudComposite) {
        cloudComposite.setCloudTexture(null);
      }
    }
    
    // ========== POST-PROCESSING ==========
    if (useHDR && this.postProcessPipeline && this.sceneColorTexture) {
      // Ensure depth is copied for post-processing effects
      renderCtx.copyDepthForReading();
      
      // Compute inverse matrices for SSAO
      const inverseProjectionMatrix = mat4.create();
      mat4.invert(inverseProjectionMatrix, renderCtx.projectionMatrix as unknown as mat4);
      
      const inverseViewMatrix = mat4.create();
      mat4.invert(inverseViewMatrix, renderCtx.viewMatrix as unknown as mat4);
      
      // Build effect uniforms
      const effectUniforms: EffectUniforms = {
        near: nearPlane,
        far: farPlane,
        width: this.width,
        height: this.height,
        time: this.time,
        deltaTime,
        projectionMatrix: renderCtx.projectionMatrix,
        inverseProjectionMatrix: new Float32Array(inverseProjectionMatrix),
        viewMatrix: renderCtx.viewMatrix,
        inverseViewMatrix: new Float32Array(inverseViewMatrix),
      };
      
      // Feed sun data to atmospheric fog effect (before execute)
      const fogEffect = this.postProcessPipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
      if (fogEffect) {
        const lightDir = mergedOptions.lightDirection;
        const len = Math.sqrt(lightDir[0] * lightDir[0] + lightDir[1] * lightDir[1] + lightDir[2] * lightDir[2]);
        const sunDir: [number, number, number] = len > 0
          ? [lightDir[0] / len, lightDir[1] / len, lightDir[2] / len]
          : [0, 1, 0];
        fogEffect.setSunData(
          sunDir,
          mergedOptions.lightColor as [number, number, number],
          mergedOptions.sunIntensity,
        );
      }
      
      // Execute post-processing pipeline (tonemapping, SSAO, fog, etc.)
      // This writes the final composited result to outputView (backbuffer)
      this.postProcessPipeline.execute(
        encoder,
        this.sceneColorTexture,
        this.depthTextureCopy,
        outputView,
        effectUniforms
      );
    }
    
    // ========== VIEWPORT PASSES (render directly to backbuffer) ==========
    // Execute viewport category passes AFTER post-processing
    // These render grid, gizmos, debug overlays without tonemapping
    for (const pass of this.passes) {
      if (pass.enabled && pass.category === 'viewport') {
        pass.execute(renderCtx);
      }
    }
    
    // Submit commands
    this.ctx.queue.submit([encoder.finish()]);
    this.lastDrawCallsCount = renderCtx.getDrawCalls();
  }

  // ========== Public API ==========

  getLastDrawCallsCount(): number {
    return this.lastDrawCallsCount;
  }
  
  setHDRTexture(texture: UnifiedGPUTexture): void {
    this.skyRenderer.setHDRTexture(texture);
  }
  
  getObjectRenderer(): ObjectRendererGPU {
    return this.objectRenderer;
  }
  
  getShadowRenderer(): ShadowRendererGPU {
    return this.shadowRenderer;
  }
  
  
  // ========== Post-Processing Methods ==========

  /**
   * Enable/disable SSAO post-processing
   */
  setSSAOEnabled(enabled: boolean): void {
    // Enable/disable SSAO effect in pipeline (composite always stays enabled)
    this.postProcessPipeline?.setEnabled('ssao', enabled);
  }
  
  /**
   * Check if SSAO is enabled
   */
  isSSAOEnabled(): boolean {
    return this.postProcessPipeline?.isEnabled('ssao') ?? false;
  }
  
  /**
   * Configure SSAO effect parameters
   */
  setSSAOConfig(config: Partial<SSAOEffectConfig>): void {
    if (this.postProcessPipeline) {
      const ssaoEffect = this.postProcessPipeline.getEffect<SSAOEffect>('ssao');
      if (ssaoEffect) {
        ssaoEffect.setConfig(config);
      }
    }
  }
  
  /**
   * Get SSAO configuration
   */
  getSSAOConfig(): SSAOEffectConfig | null {
    if (this.postProcessPipeline) {
      const ssaoEffect = this.postProcessPipeline.getEffect<SSAOEffect>('ssao');
      return ssaoEffect?.getConfig() ?? null;
    }
    return null;
  }
  
  /**
   * Configure composite effect parameters (tonemapping, gamma, exposure)
   */
  setCompositeConfig(config: Partial<CompositeEffectConfig>): void {
    if (this.postProcessPipeline) {
      const compositeEffect = this.postProcessPipeline.getEffect<CompositeEffect>('composite');
      if (compositeEffect) {
        compositeEffect.setConfig(config);
      }
    }
  }
  
  /**
   * Get composite effect configuration
   */
  getCompositeConfig(): CompositeEffectConfig | null {
    if (this.postProcessPipeline) {
      const compositeEffect = this.postProcessPipeline.getEffect<CompositeEffect>('composite');
      return compositeEffect?.getConfig() ?? null;
    }
    return null;
  }
  
  /**
   * Get the post-processing pipeline (for advanced configuration)
   */
  getPostProcessPipeline(): PostProcessPipeline | null {
    return this.postProcessPipeline;
  }
  
  // ========== Atmospheric Fog Methods ==========
  
  /**
   * Enable/disable atmospheric fog post-processing
   */
  setAtmosphericFogEnabled(enabled: boolean): void {
    this.postProcessPipeline?.setEnabled('atmosphericFog', enabled);
  }
  
  /**
   * Check if atmospheric fog is enabled
   */
  isAtmosphericFogEnabled(): boolean {
    return this.postProcessPipeline?.isEnabled('atmosphericFog') ?? false;
  }
  
  /**
   * Configure atmospheric fog parameters
   */
  setAtmosphericFogConfig(config: Partial<AtmosphericFogConfig>): void {
    if (this.postProcessPipeline) {
      const fogEffect = this.postProcessPipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
      if (fogEffect) {
        fogEffect.setConfig(config);
      }
    }
  }
  
  /**
   * Get atmospheric fog configuration
   */
  getAtmosphericFogConfig(): AtmosphericFogConfig | null {
    if (this.postProcessPipeline) {
      const fogEffect = this.postProcessPipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
      return fogEffect?.getConfig() ?? null;
    }
    return null;
  }
  
  // ========== Volumetric Cloud Methods ==========
  
  /**
   * Enable/disable volumetric clouds.
   * Lazily initializes the cloud ray marcher on first enable.
   */
  setCloudEnabled(enabled: boolean): void {
    this.cloudEnabled = enabled;
    
    // Lazily create the cloud ray marcher when first enabled
    if (enabled && !this.cloudRayMarcher) {
      this.cloudRayMarcher = new CloudRayMarcher(this.ctx);
      this.cloudRayMarcher.init(this.width, this.height);
      
      // Create cloud shadow generator (Phase 2)
      this.cloudShadowGenerator = new CloudShadowGenerator(this.ctx);
      this.cloudShadowGenerator.init();
      this.cloudShadowGenerator.setShadowRadius(this.shadowRadius);
      
      // Create temporal filter (Phase 3)
      this.cloudTemporalFilter = new CloudTemporalFilter(this.ctx);
      const halfW = this.cloudRayMarcher.outputWidth;
      const halfH = this.cloudRayMarcher.outputHeight;
      this.cloudTemporalFilter.init(halfW, halfH, this.width, this.height);
      
      // Wire blue noise texture from temporal filter to ray marcher
      this.cloudRayMarcher.setBlueNoiseView(this.cloudTemporalFilter.blueNoiseView);
      
      // Temporal filter is now active with motion-vector reprojection (Phase 3).
      // Checkerboard is safe because the temporal shader correctly fills non-marched
      // pixels using motion-reprojected history from the previous frame.
      this.cloudRayMarcher.setForceDisableCheckerboard(false);
      
      // Initialize timestamp query profiling (if supported)
      this.initTimestampQueries();
      
      // Register cloud shadow debug texture
      this.debugTextureManager.register(
        'cloud-shadow',
        'depth',
        () => this.cloudShadowGenerator?.textureView ?? null
      );
      
      // Register cloud temporal history debug texture (Phase 3)
      this.debugTextureManager.register(
        'cloud-history',
        'float',
        () => this.cloudTemporalFilter?.historyView ?? null
      );
      
      // Register cloud temporal output as the main resolved result
      this.debugTextureManager.register(
        'cloud-temporal',
        'float',
        () => this.cloudTemporalFilter?.outputView ?? null
      );
    }
    
    // Enable/disable the cloud composite post-process effect
    this.postProcessPipeline?.setEnabled('cloudComposite', enabled);
    
    // Clear cloud shadow from SceneEnvironment when disabled
    if (!enabled) {
      this.sceneEnvironment.setCloudShadow(null, null);
    }
  }
  
  /**
   * Check if volumetric clouds are enabled
   */
  isCloudEnabled(): boolean {
    return this.cloudEnabled;
  }
  
  /**
   * Configure cloud settings
   */
  setCloudConfig(config: Partial<CloudConfig>): void {
    // If enabling clouds, ensure ray marcher is created
    if (config.enabled !== undefined) {
      this.setCloudEnabled(config.enabled);
    }
    
    // Apply config to ray marcher
    if (this.cloudRayMarcher) {
      this.cloudRayMarcher.setConfig(config);
    }
  }
  
  /**
   * Get current cloud configuration
   */
  getCloudConfig(): CloudConfig | null {
    return this.cloudRayMarcher?.getConfig() ?? null;
  }
  
  // ========== SSR Methods ==========
  
  /**
   * Enable/disable SSR
   */
  setSSREnabled(enabled: boolean): void {
    this.ssrPass?.setEnabled(enabled);
    // Also propagate to water inline SSR (TransparentPass)
    const transparentPass = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (transparentPass) {
      transparentPass.ssrEnabled = enabled;
      // Sync config too
      const config = this.ssrPass?.getConfig();
      if (config) {
        const { enabled: _, quality: __, ...ssrParams } = config;
        transparentPass.ssrConfig = ssrParams;
      }
    }
  }
  
  /**
   * Check if SSR is enabled
   */
  isSSREnabled(): boolean {
    return this.ssrPass?.getConfig().enabled ?? false;
  }
  
  /**
   * Set SSR quality level
   */
  setSSRQuality(quality: SSRQualityLevel): void {
    this.ssrPass?.setQuality(quality);
    // Propagate new quality settings to water inline SSR
    const transparentPass = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (transparentPass) {
      const config = this.ssrPass?.getConfig();
      if (config) {
        const { enabled: _, quality: __, ...ssrParams } = config;
        transparentPass.ssrConfig = ssrParams;
      }
    }
  }
  
  /**
   * Configure SSR parameters
   */
  setSSRConfig(config: Partial<SSRConfig>): void {
    this.ssrPass?.setConfig(config);
  }
  
  /**
   * Get SSR configuration
   */
  getSSRConfig(): SSRConfig | null {
    return this.ssrPass?.getConfig() ?? null;
  }
  
  /**
   * Get the SSR pass (for advanced access)
   */
  getSSRPass(): SSRPass | null {
    return this.ssrPass;
  }
  
  // ========== Debug View Methods ==========
  
  /**
   * Set debug view mode (off, depth, normals, ssr)
   */
  setDebugViewMode(mode: DebugViewMode): void {
    this.debugViewPass?.setMode(mode);
  }
  
  /**
   * Get current debug view mode
   */
  getDebugViewMode(): DebugViewMode {
    return this.debugViewPass?.getMode() ?? 'off';
  }
  
  /**
   * Get a render pass by name (for external configuration)
   */
  getPass(name: string): RenderPass | undefined {
    return this.passes.find(p => p.name === name);
  }
  
  /**
   * Enable/disable a render pass by name
   */
  setPassEnabled(name: string, enabled: boolean): void {
    const pass = this.getPass(name);
    if (pass) {
      pass.enabled = enabled;
    }
  }
  
  destroy(): void {
    this.depthTexture.destroy();
    this.depthTextureCopy.destroy();
    this.msaaColorTexture?.destroy();
    this.msaaHdrColorTexture?.destroy();
    this.sceneColorTexture?.destroy();
    this.sceneColorTextureCopy?.destroy();
    this.gridRenderer.destroy();
    this.skyRenderer.destroy();
    // objectRenderer is owned by GPUContext, not destroyed here
    this.shadowRenderer.destroy();
    this.dynamicSkyIBL.destroy();
    // OceanManager is owned externally, not destroyed here
    this.postProcessPipeline?.destroy();
    this.selectionMaskTexture?.destroy();
    this.normalsTexture?.destroy();
    this.selectionOutlineRenderer.destroy();
    this.debugTextureManager.destroy();
    this.cloudRayMarcher?.destroy();
    this.cloudShadowGenerator?.destroy();
    this.cloudTemporalFilter?.destroy();
    this.timestampQuerySet?.destroy();
    this.timestampBuffer?.destroy();
    this.timestampReadBuffer?.destroy();
    
    // Destroy render passes
    for (const pass of this.passes) {
      pass.destroy?.();
    }
  }
  
  // ========== IBL Methods ==========
  
  /**
   * Enable or disable IBL rendering
   */
  setIBLEnabled(enabled: boolean): void {
    this.iblEnabled = enabled;
  }
  
  /**
   * Check if IBL is enabled
   */
  isIBLEnabled(): boolean {
    return this.iblEnabled;
  }
  
  /**
   * Get the DynamicSkyIBL instance for direct access
   */
  getDynamicSkyIBL(): DynamicSkyIBL {
    return this.dynamicSkyIBL;
  }
  
  /**
   * Check if IBL is ready for rendering
   */
  isIBLReady(): boolean {
    return this.dynamicSkyIBL.isReady();
  }
  
  /**
   * Get the shared SceneEnvironment for renderers to use
   * Contains combined shadow + IBL bind group (Group 3)
   */
  getSceneEnvironment(): SceneEnvironment {
    return this.sceneEnvironment;
  }
  
  /**
   * Get the debug texture manager for registering/controlling debug visualizations
   */
  getDebugTextureManager(): DebugTextureManager {
    return this.debugTextureManager;
  }
  
  // ========== GPU Timestamp Profiling (Phase 3) ==========
  
  /**
   * Initialize GPU timestamp query resources for cloud pass profiling.
   * Only creates resources if the 'timestamp-query' feature is available.
   * Timestamps measure GPU time for the raymarch and temporal compute dispatches.
   */
  private initTimestampQueries(): void {
    // Check if timestamp-query feature is available on the device
    if (!this.ctx.device.features.has('timestamp-query')) {
      this.timestampSupported = false;
      return;
    }
    
    try {
      // 4 timestamp slots: [0]=before raymarch, [1]=after raymarch, [2]=before temporal, [3]=after temporal
      this.timestampQuerySet = this.ctx.device.createQuerySet({
        type: 'timestamp',
        count: 4,
      });
      
      // Buffer to resolve timestamps into (GPU-side)
      this.timestampBuffer = this.ctx.device.createBuffer({
        label: 'cloud-timestamp-buffer',
        size: 4 * 8, // 4 timestamps × 8 bytes each (u64)
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      
      // Mappable read buffer (CPU-readable)
      this.timestampReadBuffer = this.ctx.device.createBuffer({
        label: 'cloud-timestamp-read-buffer',
        size: 4 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      
      this.timestampSupported = true;
    } catch {
      // Timestamp queries not supported on this device/browser
      this.timestampSupported = false;
    }
  }
  
  /**
   * Get the latest cloud GPU timing measurements (in milliseconds).
   * Returns { raymarch, temporal, total } or null if timestamps aren't supported.
   * Timings are updated asynchronously from GPU readback (1-2 frame lag).
   */
  getCloudTimings(): { raymarch: number; temporal: number; total: number } | null {
    if (!this.timestampSupported) return null;
    return { ...this._cloudTimings };
  }
  
  /**
   * Find the MeshRenderSystem from the ECS World.
   * Cached result per-frame since World.getSystems() is cheap.
   */
  private findMeshRenderSystem(world: World): MeshRenderSystem | undefined {
    // World stores systems; look up by name
    for (const system of world.getSystems()) {
      if (system instanceof MeshRenderSystem) {
        return system;
      }
    }
    return undefined;
  }
  
  /**
   * Find the SSRSystem from the ECS World.
   */
  private findSSRSystem(world: World): SSRSystem | undefined {
    for (const system of world.getSystems()) {
      if (system instanceof SSRSystem) {
        return system;
      }
    }
    return undefined;
  }
}
