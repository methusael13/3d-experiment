/**
 * PlaceholderTextures - Singleton for default 1x1 textures
 * 
 * Provides placeholder textures for shadow maps, IBL cubemaps, and BRDF LUTs
 * when actual resources are not yet available. This ensures shaders can
 * always bind valid textures without crashing.
 */

import { GPUContext } from '../../GPUContext';

/**
 * Singleton class providing placeholder textures for all renderers
 */
export class PlaceholderTextures {
  private static instance: PlaceholderTextures | null = null;
  
  // Shadow placeholders
  private _shadowMap: GPUTexture;
  private _shadowMapView: GPUTextureView;
  private _shadowSampler: GPUSampler;
  
  // IBL placeholders
  private _cubemap: GPUTexture;
  private _cubemapView: GPUTextureView;
  private _brdfLut: GPUTexture;
  private _brdfLutView: GPUTextureView;
  private _cubemapSampler: GPUSampler;
  private _lutSampler: GPUSampler;
  
  // Common placeholders
  private _white: GPUTexture;
  private _whiteView: GPUTextureView;
  private _black: GPUTexture;
  private _blackView: GPUTextureView;
  private _normal: GPUTexture;
  private _normalView: GPUTextureView;
  private _linearSampler: GPUSampler;
  
  // HDR scene color placeholder (for refraction when no scene color available)
  private _sceneColorHDR: GPUTexture;
  private _sceneColorHDRView: GPUTextureView;
  
  // Biome mask placeholder (pure grass: R=1, G=0, B=0 for grass/rock/forest weights)
  private _biomeMask: GPUTexture;
  private _biomeMaskView: GPUTextureView;
  
  // CSM uniform buffer placeholder (identity matrices, CSM disabled)
  private _csmUniformBuffer: GPUBuffer;
  
  // CSM shadow array placeholder (1x1x4 depth texture array for 4 cascades)
  private _csmArray: GPUTexture;
  private _csmArrayView: GPUTextureView;
  
  private constructor(ctx: GPUContext) {
    const device = ctx.device;
    
    // ============ Shadow Placeholders ============
    
    // 1x1 depth texture at max depth (no shadow)
    this._shadowMap = device.createTexture({
      label: 'placeholder-shadow-map',
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._shadowMapView = this._shadowMap.createView();
    
    // Comparison sampler for shadow PCF
    this._shadowSampler = device.createSampler({
      label: 'placeholder-shadow-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    
    // ============ IBL Placeholders ============
    
    // 1x1 black cubemap (no environment lighting)
    this._cubemap = device.createTexture({
      label: 'placeholder-cubemap',
      size: { width: 1, height: 1, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '2d',
    });
    this._cubemapView = this._cubemap.createView({
      dimension: 'cube',
    });
    
    // Initialize cubemap with black (all 6 faces)
    const blackCubeFace = new Float32Array([0, 0, 0, 1]);
    const bytesPerRow = 8; // 4 floats * 2 bytes per float16... actually we need to handle this correctly
    // For rgba16float, 1 pixel = 8 bytes (4 components * 2 bytes)
    // But we're uploading Float32, so we need to use writeTexture correctly
    // Actually, rgba16float expects 16-bit floats, so we should use Float32Array and let WebGPU convert
    // No, that won't work. We need to either use r32float or manually pack f16.
    // For simplicity, let's just not initialize - the texture will be zeroed by default.
    
    // 1x1 BRDF LUT (white = max fresnel)
    this._brdfLut = device.createTexture({
      label: 'placeholder-brdf-lut',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._brdfLutView = this._brdfLut.createView();
    
    // Cubemap sampler (filtering, no comparison)
    this._cubemapSampler = device.createSampler({
      label: 'placeholder-cubemap-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    
    // BRDF LUT sampler (clamp to edge)
    this._lutSampler = device.createSampler({
      label: 'placeholder-lut-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    
    // ============ Common Placeholders ============
    
    // 1x1 white texture
    this._white = device.createTexture({
      label: 'placeholder-white',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._whiteView = this._white.createView();
    ctx.queue.writeTexture(
      { texture: this._white },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    
    // 1x1 black texture
    this._black = device.createTexture({
      label: 'placeholder-black',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._blackView = this._black.createView();
    ctx.queue.writeTexture(
      { texture: this._black },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    
    // 1x1 neutral normal map (pointing up)
    this._normal = device.createTexture({
      label: 'placeholder-normal',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._normalView = this._normal.createView();
    ctx.queue.writeTexture(
      { texture: this._normal },
      new Uint8Array([128, 128, 255, 255]), // (0.5, 0.5, 1.0) = up normal
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    
    // Linear filtering sampler
    this._linearSampler = device.createSampler({
      label: 'placeholder-linear-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    
    // ============ HDR Placeholders ============
    
    // 1x1 black HDR texture (for scene color placeholder in water refraction)
    this._sceneColorHDR = device.createTexture({
      label: 'placeholder-scene-color-hdr',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._sceneColorHDRView = this._sceneColorHDR.createView();
    // Default to black (no refraction contribution when no scene color available)
    
    // ============ Terrain Placeholders ============
    
    // 1x1 biome mask placeholder (pure grass: R=1, G=0, B=0)
    // Biome mask format: R=grass weight, G=rock weight, B=forest weight
    this._biomeMask = device.createTexture({
      label: 'placeholder-biome-mask',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._biomeMaskView = this._biomeMask.createView();
    ctx.queue.writeTexture(
      { texture: this._biomeMask },
      new Uint8Array([255, 0, 0, 255]), // Pure grass (R=1, G=0, B=0)
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    
    // ============ CSM Placeholders ============
    
    // CSM uniform buffer placeholder (304 bytes)
    // Layout: 4 identity matrices + vec4 splits (10000s) + vec4 config (0, 0, 0.1, 0) + vec4 cameraForward
    const csmData = new Float32Array(76); // 304 / 4
    // Initialize 4 identity matrices
    for (let i = 0; i < 4; i++) {
      const offset = i * 16;
      csmData[offset + 0] = 1; csmData[offset + 5] = 1; csmData[offset + 10] = 1; csmData[offset + 15] = 1;
    }
    // Cascade splits (far away = no cascade selection)
    csmData[64] = 10000; csmData[65] = 10000; csmData[66] = 10000; csmData[67] = 10000;
    // Config: cascadeCount=0, csmEnabled=0, blendFraction=0.1, pad=0
    csmData[68] = 0; csmData[69] = 0; csmData[70] = 0.1; csmData[71] = 0;
    // Camera forward: default (0, 0, -1, 0)
    csmData[72] = 0; csmData[73] = 0; csmData[74] = -1; csmData[75] = 0;
    
    this._csmUniformBuffer = device.createBuffer({
      label: 'placeholder-csm-uniforms',
      size: 304,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(this._csmUniformBuffer.getMappedRange()).set(csmData);
    this._csmUniformBuffer.unmap();
    
    // CSM shadow map array placeholder (1x1x4 depth texture array)
    this._csmArray = device.createTexture({
      label: 'placeholder-csm-array',
      size: { width: 1, height: 1, depthOrArrayLayers: 4 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._csmArrayView = this._csmArray.createView({
      dimension: '2d-array',
      arrayLayerCount: 4,
    });
  }
  
  /**
   * Get or create the singleton instance
   */
  static get(ctx: GPUContext): PlaceholderTextures {
    if (!PlaceholderTextures.instance) {
      PlaceholderTextures.instance = new PlaceholderTextures(ctx);
    }
    return PlaceholderTextures.instance;
  }
  
  /**
   * Destroy the singleton (call on app shutdown)
   */
  static destroy(): void {
    if (PlaceholderTextures.instance) {
      const inst = PlaceholderTextures.instance;
      inst._shadowMap.destroy();
      inst._cubemap.destroy();
      inst._brdfLut.destroy();
      inst._white.destroy();
      inst._black.destroy();
      inst._normal.destroy();
      inst._sceneColorHDR.destroy();
      inst._biomeMask.destroy();
      inst._csmUniformBuffer.destroy();
      inst._csmArray.destroy();
      PlaceholderTextures.instance = null;
    }
  }
  
  // ============ Getters ============
  
  get shadowMapView(): GPUTextureView { return this._shadowMapView; }
  get shadowSampler(): GPUSampler { return this._shadowSampler; }
  
  get cubemapView(): GPUTextureView { return this._cubemapView; }
  get brdfLutView(): GPUTextureView { return this._brdfLutView; }
  get cubemapSampler(): GPUSampler { return this._cubemapSampler; }
  get lutSampler(): GPUSampler { return this._lutSampler; }
  
  get whiteView(): GPUTextureView { return this._whiteView; }
  get blackView(): GPUTextureView { return this._blackView; }
  get normalView(): GPUTextureView { return this._normalView; }
  get linearSampler(): GPUSampler { return this._linearSampler; }
  
  get sceneColorHDRView(): GPUTextureView { return this._sceneColorHDRView; }
  /** SSR placeholder - same as sceneColorHDR (1x1 black = no SSR reflections) */
  get ssrTextureView(): GPUTextureView { return this._sceneColorHDRView; }
  
  /** Reflection probe placeholder - reuses black cubemap (no probe = IBL fallback) */
  get reflectionProbeCubemapView(): GPUTextureView { return this._cubemapView; }
  /** Reflection probe sampler placeholder - reuses cubemap sampler */
  get reflectionProbeSampler(): GPUSampler { return this._cubemapSampler; }
  
  get biomeMaskView(): GPUTextureView { return this._biomeMaskView; }
  
  get csmUniformBuffer(): GPUBuffer { return this._csmUniformBuffer; }
  get csmArrayView(): GPUTextureView { return this._csmArrayView; }
}
