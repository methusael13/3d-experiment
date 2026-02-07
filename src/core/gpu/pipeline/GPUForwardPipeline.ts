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

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { GridRendererGPU } from '../renderers/GridRendererGPU';
import { SkyRendererGPU } from '../renderers/SkyRendererGPU';
import { ObjectRendererGPU } from '../renderers/ObjectRendererGPU';
import { ShadowRendererGPU } from '../renderers';
import { WebGPUShadowSettings } from '@/demos/sceneBuilder/componentPanels/RenderingPanel';
import { 
  PostProcessPipeline, 
  SSAOEffect, 
  CompositeEffect,
  type SSAOEffectConfig,
  type CompositeEffectConfig,
  type EffectUniforms,
} from '../postprocess';
import { RenderContextImpl, type RenderContextOptions } from './RenderContext';
import type { RenderPass } from './RenderPass';
import { 
  SkyPass, 
  ShadowPass, 
  OpaquePass, 
  TransparentPass, 
  OverlayPass, 
  DebugPass 
} from './passes';
import type { Scene } from '../../Scene';

/**
 * Simple camera interface for WebGPU pipeline
 */
export interface GPUCamera {
  getViewMatrix(): Float32Array | number[];
  getProjectionMatrix(): Float32Array | number[];
  getPosition(): Float32Array | number[];
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
  shadowEnabled?: boolean;
  shadowSoftShadows?: boolean;
  shadowRadius?: number;
  showShadowThumbnail?: boolean;
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
  shadowEnabled: true,
  shadowSoftShadows: true,
  shadowRadius: 200,
  showShadowThumbnail: false,
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
  
  // Render passes (ordered by priority)
  private passes: RenderPass[] = [];
  
  // Default shadow settings
  private shadowEnabled = true;
  private shadowSoftShadows = true;
  private shadowRadius = 200;
  private showShadowThumbnail = false;
  
  // Animation time
  private time = 0;
  private lastFrameTime = performance.now();
  
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
    this.objectRenderer = new ObjectRendererGPU(ctx);
    this.shadowRenderer = new ShadowRendererGPU(ctx, {
      resolution: 2048,
      shadowRadius: this.shadowRadius,
    });
    
    // Create render passes
    this.initializePasses();
    
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
    });
    
    const skyPass = new SkyPass(this.skyRenderer);
    
    const opaquePass = new OpaquePass({
      objectRenderer: this.objectRenderer,
      shadowRenderer: this.shadowRenderer,
    });
    
    const transparentPass = new TransparentPass();
    
    const overlayPass = new OverlayPass(this.gridRenderer);
    
    const debugPass = new DebugPass({
      shadowRenderer: this.shadowRenderer,
    });
    
    // Store passes in priority order
    this.passes = [
      shadowPass,
      skyPass,
      opaquePass,
      transparentPass,
      overlayPass,
      debugPass,
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
    }
    if (config.resolution !== undefined) {
      this.shadowRenderer.setResolution(config.resolution);
    }
  }
  
  /**
   * Show/hide shadow map debug thumbnail
   */
  setShowShadowThumbnail(show: boolean): void {
    this.showShadowThumbnail = show;
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
    
    // Add Composite effect (order 200 - runs after SSAO)
    // ALWAYS enabled - handles tonemapping + gamma correction
    const compositeEffect = new CompositeEffect(this.ctx.format, {
      tonemapping: 3, // ACES
      gamma: 2.2,
      exposure: 1.0,
    });
    this.postProcessPipeline.addEffect(compositeEffect, 200);
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
    
    if (this.msaaHdrColorTexture) {
      this.msaaHdrColorTexture.destroy();
      this.msaaHdrColorTexture = this.createMsaaHdrColorTexture();
    }
    
    // Resize post-processing pipeline
    if (this.postProcessPipeline) {
      this.postProcessPipeline.resize(width, height);
    }
  }
  
  /**
   * Render a frame using pass-based architecture
   */
  render(
    scene: Scene | null,
    camera: GPUCamera,
    options: RenderOptions = {}
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
    const mergedOptions: RenderOptions = {
      ...DEFAULT_RENDER_OPTIONS,
      shadowEnabled: this.shadowEnabled,
      shadowSoftShadows: this.shadowSoftShadows,
      shadowRadius: this.shadowRadius,
      showShadowThumbnail: this.showShadowThumbnail,
      ...options,
    };
    
    // Get near/far from camera or use defaults
    const nearPlane = camera.near ?? this.defaultNearPlane;
    const farPlane = camera.far ?? this.defaultFarPlane;
    
    // Create render context
    const contextOptions: RenderContextOptions = {
      ctx: this.ctx,
      encoder,
      camera,
      scene,
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
      msaaHdrColorTexture: this.msaaHdrColorTexture ?? undefined,
      msaaColorTexture: this.msaaColorTexture ?? undefined,
    };
    
    const renderCtx = new RenderContextImpl(contextOptions);
    
    // Execute all enabled render passes in order
    for (const pass of this.passes) {
      if (pass.enabled) {
        pass.execute(renderCtx);
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
      
      // Execute post-processing pipeline
      this.postProcessPipeline.execute(
        encoder,
        this.sceneColorTexture,
        this.depthTextureCopy,
        outputView,
        effectUniforms
      );
      
      // Render debug thumbnail after composite (if enabled)
      if (mergedOptions.showShadowThumbnail && mergedOptions.shadowEnabled) {
        this.shadowRenderer.renderDebugThumbnail(
          encoder, outputView, 10, 10, 200, this.width, this.height
        );
      }
    }
    
    // Submit commands
    this.ctx.queue.submit([encoder.finish()]);
  }
  
  // ========== Public API ==========
  
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
    this.gridRenderer.destroy();
    this.skyRenderer.destroy();
    this.objectRenderer.destroy();
    this.shadowRenderer.destroy();
    // OceanManager is owned externally, not destroyed here
    this.postProcessPipeline?.destroy();
    
    // Destroy render passes
    for (const pass of this.passes) {
      pass.destroy?.();
    }
  }
}
