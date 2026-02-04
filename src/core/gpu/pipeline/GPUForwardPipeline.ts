/**
 * GPUForwardPipeline - WebGPU Forward Rendering Pipeline
 * 
 * Orchestrates all WebGPU renderers in the correct order:
 * 1. Sky pass (background)
 * 2. Opaque pass (terrain, objects)
 * 3. Overlay pass (grid, gizmos)
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { GridRendererGPU } from '../renderers/GridRendererGPU';
import { SkyRendererGPU } from '../renderers/SkyRendererGPU';
import { ObjectRendererGPU } from '../renderers/ObjectRendererGPU';
import { ShadowRendererGPU, type ShadowCaster, WaterRendererGPU, type WaterConfig } from '../renderers';
import { TerrainManager } from '../../terrain/TerrainManager';
import { WebGPUShadowSettings } from '@/demos/sceneBuilder/componentPanels/RenderingPanel';
import { PostProcessStack, SSAOPass, type SSAOConfig } from '../postprocess';

/**
 * Simple camera interface for WebGPU pipeline
 * Allows using either CameraObject or a simple adapter
 */
export interface GPUCamera {
  getViewMatrix(): Float32Array | number[];
  getProjectionMatrix(): Float32Array | number[];
  getPosition(): Float32Array | number[];
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
  /** Pre-computed light direction vector (from DirectionalLight) - avoids redundant calculation */
  lightDirection?: [number, number, number];
  /** Shadow settings */
  shadowEnabled?: boolean;
  shadowSoftShadows?: boolean;
  shadowRadius?: number;
  /** Show shadow map debug thumbnail */
  showShadowThumbnail?: boolean;
}

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
  private depthTextureCopy: UnifiedGPUTexture; // Copy for reading in shaders (water transparency)
  private msaaColorTexture: UnifiedGPUTexture | null = null;
  
  // Post-processing
  private postProcessStack: PostProcessStack | null = null;
  private ssaoPass: SSAOPass | null = null;
  private ssaoEnabled = false;
  
  // Renderers
  private gridRenderer: GridRendererGPU;
  private skyRenderer: SkyRendererGPU;
  private objectRenderer: ObjectRendererGPU;
  private shadowRenderer: ShadowRendererGPU;
  private waterRenderer: WaterRendererGPU;
  private terrainManager: TerrainManager | null = null;
  
  // Shadow casters (objects that can cast shadows)
  private shadowCasters: ShadowCaster[] = [];
  
  // Shadow settings
  private shadowEnabled = true;
  private shadowSoftShadows = true;
  private shadowRadius = 200;
  private showShadowThumbnail = false;
  
  // Animation time for water
  private time = 0;
  
  // Matrices
  private viewMatrix = mat4.create();
  private projectionMatrix = mat4.create();
  private viewProjectionMatrix = mat4.create();
  private identityMatrix = mat4.create(); // For terrain model matrix
  
  constructor(ctx: GPUContext, options: GPUForwardPipelineOptions) {
    this.ctx = ctx;
    this.width = options.width;
    this.height = options.height;
    this.sampleCount = options.sampleCount || 1;
    
    // Create depth texture (for depth testing as render attachment)
    this.depthTexture = UnifiedGPUTexture.createDepth(
      ctx,
      this.width,
      this.height,
      'depth24plus',
      'forward-depth'
    );
    
    // Create depth texture copy (for reading in shaders - water transparency)
    // This texture has TEXTURE_BINDING usage for shader sampling
    this.depthTextureCopy = this.createDepthTextureCopy();
    
    // Create MSAA color texture if needed
    if (this.sampleCount > 1) {
      this.msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        ctx,
        this.width,
        this.height,
        ctx.format,
        this.sampleCount,
        'forward-msaa-color'
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
    this.waterRenderer = new WaterRendererGPU(ctx);
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
   * Set the terrain manager for terrain rendering
   * Automatically registers it as a shadow caster
   */
  setTerrainManager(terrainManager: TerrainManager): void {
    // Unregister old terrain manager if exists
    if (this.terrainManager) {
      this.unregisterShadowCaster(this.terrainManager);
    }
    
    this.terrainManager = terrainManager;
    
    // Register as shadow caster
    this.registerShadowCaster(terrainManager);
  }

  resetTerrainManager(): void {
    this.terrainManager = null;
  }
  
  /**
   * Register an object as a shadow caster
   */
  registerShadowCaster(caster: ShadowCaster): void {
    if (!this.shadowCasters.includes(caster)) {
      this.shadowCasters.push(caster);
    }
  }
  
  /**
   * Unregister a shadow caster
   */
  unregisterShadowCaster(caster: ShadowCaster): void {
    const index = this.shadowCasters.indexOf(caster);
    if (index !== -1) {
      this.shadowCasters.splice(index, 1);
    }
  }
  
  /**
   * Create a depth texture copy that can be used for shader sampling
   * Uses TEXTURE_BINDING usage (not RENDER_ATTACHMENT) to avoid usage conflicts
   */
  private createDepthTextureCopy(): UnifiedGPUTexture {
    // Create a depth texture with COPY_DST and TEXTURE_BINDING usage
    // This will receive copied depth data and be used for shader sampling
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
      aspect: 'depth-only', // Required for depth texture sampling
    });
    
    // Wrap in UnifiedGPUTexture for consistency
    return {
      texture,
      view,
      format: 'depth24plus',
      width: this.width,
      height: this.height,
      destroy: () => texture.destroy(),
    } as UnifiedGPUTexture;
  }
  
  /**
   * Resize render targets
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) {
      return;
    }
    
    this.width = width;
    this.height = height;
    
    // Recreate depth texture
    this.depthTexture.destroy();
    this.depthTexture = UnifiedGPUTexture.createDepth(
      this.ctx,
      this.width,
      this.height,
      'depth24plus',
      'forward-depth'
    );
    
    // Recreate depth texture copy
    this.depthTextureCopy.destroy();
    this.depthTextureCopy = this.createDepthTextureCopy();
    
    // Recreate MSAA color texture if needed
    if (this.msaaColorTexture) {
      this.msaaColorTexture.destroy();
      this.msaaColorTexture = UnifiedGPUTexture.createRenderTarget(
        this.ctx,
        this.width,
        this.height,
        this.ctx.format,
        this.sampleCount,
        'forward-msaa-color'
      );
    }
    
    // Resize post-processing stack
    if (this.postProcessStack) {
      this.postProcessStack.resize(width, height);
      this.postProcessStack.setDepthBuffer(this.depthTextureCopy);
    }
  }
  
  /**
   * Render a frame
   * @param scene - Scene object (can be null for basic rendering)
   * @param camera - Camera providing view/projection matrices
   * @param options - Render options
   */
  render(
    scene: unknown | null,
    camera: GPUCamera,
    options: RenderOptions = {}
  ): void {
    const {
      showGrid = true,
      showAxes = true,
      skyMode = 'sun',
      sunIntensity = 20,
      hdrExposure = 1.0,
      wireframe = false,
      ambientIntensity = 0.3,
      lightDirection = [1, 0, 1],
      shadowEnabled = this.shadowEnabled,
      shadowSoftShadows = this.shadowSoftShadows,
      shadowRadius = this.shadowRadius,
    } = options;
    
    // Update matrices from camera
    const viewMat = camera.getViewMatrix();
    const projMat = camera.getProjectionMatrix();
    mat4.copy(this.viewMatrix, viewMat as mat4);
    mat4.copy(this.projectionMatrix, projMat as mat4);
    mat4.multiply(this.viewProjectionMatrix, this.projectionMatrix, this.viewMatrix);
    
    // Get the current swap chain texture
    if (!this.ctx.context) {
      console.warn('[GPUForwardPipeline] Canvas not configured');
      return;
    }
    
    const colorTexture = this.ctx.context.getCurrentTexture();
    const colorView = colorTexture.createView();
    
    // Create command encoder
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'forward-pipeline-encoder',
    });
    
    // Determine color attachment based on MSAA
    const colorAttachment: GPURenderPassColorAttachment = this.msaaColorTexture
      ? {
          view: this.msaaColorTexture.view,
          resolveTarget: colorView,
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
        }
      : {
          view: colorView,
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
        };
    
    // ========== SKY PASS ==========
    // Render sky first (no depth, background)
    if (skyMode !== 'none') {
      const skyPass = encoder.beginRenderPass({
        label: 'sky-pass',
        colorAttachments: [colorAttachment],
        // No depth attachment for sky - it's at infinite depth
      });
      
      if (skyMode === 'sun') {
        this.skyRenderer.renderSunSky(skyPass, this.viewProjectionMatrix, lightDirection, sunIntensity);
      } else if (skyMode === 'hdr') {
        this.skyRenderer.renderHDRSky(skyPass, this.viewProjectionMatrix, hdrExposure);
      }
      
      skyPass.end();
      
      // Update color attachment to load (not clear) for subsequent passes
      colorAttachment.loadOp = 'load';
    }
    
    // ========== SHADOW PASS ==========
    // Render terrain depth from light's perspective using unified grid (no CDLOD LOD artifacts)
    if (shadowEnabled && this.terrainManager) {
      const cameraPosition = camera.getPosition() as [number, number, number];
      
      // Extract camera forward direction from view matrix for frustum optimization
      // View matrix row 2 (index 8-10) contains -forward in world space
      const cameraForward: vec3 = [
        -this.viewMatrix[8],
        0, // We only care about XZ plane for shadow offset
        -this.viewMatrix[10],
      ];
      // Normalize on XZ plane
      const fwdLen = Math.sqrt(cameraForward[0] * cameraForward[0] + cameraForward[2] * cameraForward[2]);
      if (fwdLen > 0.001) {
        cameraForward[0] /= fwdLen;
        cameraForward[2] /= fwdLen;
      }
      
      // Update bind group with terrain heightmap
      const heightmap = this.terrainManager.getHeightmapTexture();
      if (heightmap) {
        this.shadowRenderer.updateBindGroup(heightmap);
      }
      
      // Get terrain config for shadow params
      const terrainConfig = this.terrainManager.getConfig();
      
      // Render shadow map using unified grid (self-contained, no external casters needed)
      this.shadowRenderer.renderShadowMap(encoder, {
        lightDirection: lightDirection as [number, number, number],
        cameraPosition,
        cameraForward,
        heightScale: terrainConfig?.heightScale ?? 50,
        terrainSize: terrainConfig?.worldSize ?? 1000,
        gridSize: 129,
      });
    }
    
    // ========== OPAQUE PASS ==========
    // Render terrain and opaque objects with depth testing
    const opaquePass = encoder.beginRenderPass({
      label: 'opaque-pass',
      colorAttachments: [colorAttachment],
      depthStencilAttachment: {
        view: this.depthTexture.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    
    // Render terrain if available
    if (this.terrainManager && this.terrainManager.isReady) {
      const cameraPosition = camera.getPosition() as [number, number, number];
      
      // Prepare shadow params for terrain rendering
      const shadowParams = shadowEnabled ? {
        enabled: true,
        softShadows: shadowSoftShadows,
        shadowRadius: shadowRadius,
        lightSpaceMatrix: this.shadowRenderer.getLightSpaceMatrix(),
        shadowMap: this.shadowRenderer.getShadowMap(),
      } : undefined;
      
      this.terrainManager.render(opaquePass, {
        viewProjectionMatrix: this.viewProjectionMatrix,
        modelMatrix: this.identityMatrix,
        cameraPosition,
        lightDirection,
        lightColor: [1, 1, 1],
        ambientIntensity,
        wireframe,
        shadow: shadowParams,
      });
    }
    
    // Render objects
    const cameraPos = camera.getPosition() as [number, number, number];
    this.objectRenderer.render(opaquePass, {
      viewProjectionMatrix: this.viewProjectionMatrix,
      cameraPosition: cameraPos,
      lightDirection,
      lightColor: [1, 1, 1],
      ambientIntensity,
    });
    
    opaquePass.end();
    
    // ========== TRANSPARENT PASS (WATER) ==========
    // Render water after terrain (reads depth for transparency effects)
    if (this.waterRenderer.isEnabled() && this.terrainManager) {
      // Update animation time
      this.time += 0.016; // Assume ~60fps, could be passed from outside
      
      // Copy depth texture to separate texture for shader sampling
      // This avoids the "writable usage and another usage in same synchronization scope" error
      // because we can't both write to (depthStencilAttachment) and read from (texture binding) the same texture
      encoder.copyTextureToTexture(
        { texture: this.depthTexture.texture },
        { texture: this.depthTextureCopy.texture },
        { width: this.width, height: this.height, depthOrArrayLayers: 1 }
      );
      
      const terrainConfig = this.terrainManager.getConfig();
      
      const transparentPass = encoder.beginRenderPass({
        label: 'transparent-pass',
        colorAttachments: [{
          ...colorAttachment,
          loadOp: 'load',
        }],
        depthStencilAttachment: {
          view: this.depthTexture.view,
          depthLoadOp: 'load',
          depthStoreOp: 'store', // Water doesn't write depth
        },
      });
      
      // Use depthTextureCopy for shader sampling (to avoid usage conflict)
      this.waterRenderer.render(transparentPass, {
        viewProjectionMatrix: this.viewProjectionMatrix,
        modelMatrix: this.identityMatrix,
        cameraPosition: cameraPos,
        terrainSize: terrainConfig?.worldSize ?? 1000,
        heightScale: terrainConfig?.heightScale ?? 50,
        time: this.time,
        sunDirection: lightDirection as vec3,
        sunIntensity,
        ambientIntensity,
        depthTexture: this.depthTextureCopy,
      });
      
      transparentPass.end();
    }
    
    // ========== OVERLAY PASS ==========
    // Render grid and other overlays (with depth test but no depth write)
    if (showGrid || showAxes) {
      const overlayPass = encoder.beginRenderPass({
        label: 'overlay-pass',
        colorAttachments: [{
          ...colorAttachment,
          loadOp: 'load',
        }],
        depthStencilAttachment: {
          view: this.depthTexture.view,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      
      this.gridRenderer.render(overlayPass, this.viewProjectionMatrix, {
        showGrid,
        showAxes,
      });
      
      overlayPass.end();
    }
    
    // ========== DEBUG THUMBNAIL PASS ==========
    // Render shadow map thumbnail if enabled
    const shouldShowThumbnail = options.showShadowThumbnail ?? this.showShadowThumbnail;
    if (shouldShowThumbnail && shadowEnabled) {
      const thumbnailSize = 200;
      const thumbnailX = 10;
      const thumbnailY = 10;
      
      this.shadowRenderer.renderDebugThumbnail(
        encoder,
        colorView,
        thumbnailX,
        thumbnailY,
        thumbnailSize,
        this.width,
        this.height
      );
    }
    
    // Submit commands
    this.ctx.queue.submit([encoder.finish()]);
  }
  
  /**
   * Set HDR texture for sky
   */
  setHDRTexture(texture: UnifiedGPUTexture): void {
    this.skyRenderer.setHDRTexture(texture);
  }
  
  /**
   * Get the object renderer for adding/removing meshes
   */
  getObjectRenderer(): ObjectRendererGPU {
    return this.objectRenderer;
  }
  
  /**
   * Get the shadow renderer for debug purposes
   */
  getShadowRenderer(): ShadowRendererGPU {
    return this.shadowRenderer;
  }
  
  /**
   * Get the water renderer for configuration
   */
  getWaterRenderer(): WaterRendererGPU {
    return this.waterRenderer;
  }
  
  /**
   * Configure water settings
   */
  setWaterConfig(config: Partial<WaterConfig>): void {
    this.waterRenderer.setConfig(config);
  }
  
  /**
   * Get current water configuration
   */
  getWaterConfig(): WaterConfig {
    return this.waterRenderer.getConfig();
  }
  
  /**
   * Enable/disable water rendering
   */
  setWaterEnabled(enabled: boolean): void {
    this.waterRenderer.setEnabled(enabled);
  }
  
  /**
   * Set water level (normalized -0.5 to 0.5)
   */
  setWaterLevel(level: number): void {
    this.waterRenderer.setWaterLevel(level);
  }
  
  // ========== SSAO Methods ==========
  
  /**
   * Enable/disable SSAO effect
   * Note: SSAO requires view-space normals from terrain/object shaders (MRT)
   * This is not yet implemented - enabling SSAO will have no effect until
   * terrain and object shaders output normals to a second render target.
   */
  setSSAOEnabled(enabled: boolean): void {
    this.ssaoEnabled = enabled;
    
    // Lazy-create PostProcessStack and SSAOPass when first enabled
    if (enabled && !this.postProcessStack) {
      this.postProcessStack = new PostProcessStack(this.ctx, this.width, this.height, {
        hdr: false, // Use LDR for now since renderers already tonemap
        generateNormals: true,
      });
      
      this.ssaoPass = new SSAOPass(this.ctx, this.width, this.height, {
        radius: 1.0,
        intensity: 1.5,
        bias: 0.025,
        samples: 16,
        blur: true,
      });
      
      this.postProcessStack.addPass(this.ssaoPass);
      this.postProcessStack.setDepthBuffer(this.depthTextureCopy);
    }
    
    if (this.ssaoPass) {
      this.ssaoPass.setEnabled(enabled);
    }
  }
  
  /**
   * Check if SSAO is enabled
   */
  isSSAOEnabled(): boolean {
    return this.ssaoEnabled;
  }
  
  /**
   * Configure SSAO parameters
   */
  setSSAOConfig(config: Partial<SSAOConfig>): void {
    if (this.ssaoPass) {
      this.ssaoPass.setConfig(config);
    }
  }
  
  /**
   * Get current SSAO configuration
   */
  getSSAOConfig(): SSAOConfig | null {
    return this.ssaoPass?.getConfig() ?? null;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.depthTexture.destroy();
    this.depthTextureCopy.destroy();
    this.msaaColorTexture?.destroy();
    this.gridRenderer.destroy();
    this.skyRenderer.destroy();
    this.objectRenderer.destroy();
    this.shadowRenderer.destroy();
    this.waterRenderer.destroy();
    this.postProcessStack?.destroy();
  }
}
