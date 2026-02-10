/**
 * TerrainBiomeTextureResources - Manages biome texture arrays for terrain splatting
 * 
 * Uses texture_2d_array for efficient biome texture sampling:
 * - 3 layers per array: grass=0, rock=1, forest=2
 * - Biome weights sourced from biome mask texture (R=grass, G=rock, B=forest)
 * - Configurable resolution: 1024, 2048, or 4096
 * - Lazy allocation: tiny placeholder arrays until first texture is loaded
 * - Downsampling: 4K imports are downsampled to target resolution via canvas
 * 
 * Shader bindings (Group 1):
 * - binding 0: biomeAlbedoArray (texture_2d_array)
 * - binding 1: biomeNormalArray (texture_2d_array)
 * - binding 2: biomeSampler
 * - binding 3: biomeParams uniform buffer
 */

import { 
  GPUContext, 
  UnifiedGPUBuffer,
  downsampleBitmap,
  loadBitmapFromURL,
  generateMipmapsForTextureArrayLayer,
} from '../gpu';
import {
  type TerrainMaterialParams,
  createBiomeTextureUniform,
  biomeTextureUniformToFloat32Array,
} from './types';

/** Biome layer indices matching shader constants */
export const BIOME_LAYERS = {
  grass: 0,
  rock: 1,
  forest: 2,
} as const;

export type BiomeType = keyof typeof BIOME_LAYERS;
export type TextureType = 'albedo' | 'normal';

/** Supported texture array resolutions */
export type BiomeResolution = 1024 | 2048 | 4096;

/** Minimum required source texture size */
const MIN_SOURCE_SIZE = 4096;

/** Number of biome layers (grass, rock, forest) */
const NUM_BIOME_LAYERS = 3;

/** 
 * Cached source image for re-downsampling on resolution change.
 * Stores the original 4K ImageBitmap from the imported texture.
 */
interface CachedSourceImage {
  bitmap: ImageBitmap;
  biome: BiomeType;
  type: TextureType;
}

/**
 * Manages biome texture arrays for terrain rendering
 */
export class TerrainBiomeTextureResources {
  private ctx: GPUContext;
  
  // Bind group resources
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  
  // Texture arrays (5 layers each)
  private albedoArray: GPUTexture | null = null;
  private normalArray: GPUTexture | null = null;
  private albedoArrayView: GPUTextureView | null = null;
  private normalArrayView: GPUTextureView | null = null;
  
  // Current array resolution
  private _resolution: BiomeResolution = 2048;
  
  // Track if full-size arrays are allocated
  private fullArraysAllocated = false;
  
  // Cache source images for re-downsampling
  private sourceCache: Map<string, CachedSourceImage> = new Map();
  
  // Track which layers have real textures (vs placeholder)
  private loadedAlbedoLayers: Set<number> = new Set();
  private loadedNormalLayers: Set<number> = new Set();
  
  // Per-biome tiling scales (grass, rock, forest)
  private tilingScales: Record<BiomeType, number> = {
    grass: 4.0,
    rock: 8.0,
    forest: 4.0,
  };
  
  // Track if bind group needs recreation
  private bindGroupDirty = true;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.initialize();
  }
  
  /**
   * Get current texture array resolution
   */
  get resolution(): BiomeResolution {
    return this._resolution;
  }
  
  /**
   * Set texture array resolution.
   * If changed, recreates arrays and re-downsamples all loaded textures.
   */
  async setResolution(resolution: BiomeResolution): Promise<void> {
    if (resolution === this._resolution) return;
    
    this._resolution = resolution;
    
    // If we have full arrays allocated, recreate them at new resolution
    if (this.fullArraysAllocated) {
      this.destroyTextureArrays();
      this.createFullTextureArrays();
      
      // Re-downsample all cached source images to new resolution
      for (const cached of this.sourceCache.values()) {
        await this.uploadBitmapToLayer(cached.bitmap, cached.biome, cached.type);
      }
      
      this.bindGroupDirty = true;
    }
  }
  
  /**
   * Initialize all GPU resources
   */
  private initialize(): void {
    this.createSampler();
    this.createBindGroupLayout();
    this.createParamsBuffer();
    this.createPlaceholderArrays();
    this.updateBindGroup();
  }
  
  /**
   * Create the repeating texture sampler
   */
  private createSampler(): void {
    this.sampler = this.ctx.device.createSampler({
      label: 'terrain-biome-sampler',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
  }
  
  /**
   * Create tiny 1x1 placeholder texture arrays.
   * These consume minimal VRAM until real textures are loaded.
   */
  private createPlaceholderArrays(): void {
    // Create 1x1x5 placeholder arrays
    this.albedoArray = this.ctx.device.createTexture({
      label: 'terrain-biome-albedo-placeholder',
      size: { width: 1, height: 1, depthOrArrayLayers: NUM_BIOME_LAYERS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    
    this.normalArray = this.ctx.device.createTexture({
      label: 'terrain-biome-normal-placeholder',
      size: { width: 1, height: 1, depthOrArrayLayers: NUM_BIOME_LAYERS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    
    // Fill placeholder albedo with gray (128, 128, 128, 255)
    const grayPixel = new Uint8Array([128, 128, 128, 255]);
    // Fill placeholder normal with flat up-facing (128, 128, 255, 255)
    const flatNormal = new Uint8Array([128, 128, 255, 255]);
    
    for (let layer = 0; layer < NUM_BIOME_LAYERS; layer++) {
      this.ctx.device.queue.writeTexture(
        { texture: this.albedoArray, origin: { x: 0, y: 0, z: layer } },
        grayPixel,
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );
      this.ctx.device.queue.writeTexture(
        { texture: this.normalArray, origin: { x: 0, y: 0, z: layer } },
        flatNormal,
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );
    }
    
    this.albedoArrayView = this.albedoArray.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: NUM_BIOME_LAYERS,
    });
    
    this.normalArrayView = this.normalArray.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: NUM_BIOME_LAYERS,
    });
    
    this.fullArraysAllocated = false;
  }
  
  /**
   * Create full-size texture arrays at current resolution.
   * Called lazily when first texture is loaded.
   */
  private createFullTextureArrays(): void {
    const size = this._resolution;
    const mipLevels = Math.floor(Math.log2(size)) + 1;
    
    // Destroy placeholder arrays
    this.destroyTextureArrays();
    
    // Create full-size albedo array
    this.albedoArray = this.ctx.device.createTexture({
      label: `terrain-biome-albedo-${size}`,
      size: { width: size, height: size, depthOrArrayLayers: NUM_BIOME_LAYERS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: mipLevels,
    });
    
    // Create full-size normal array
    this.normalArray = this.ctx.device.createTexture({
      label: `terrain-biome-normal-${size}`,
      size: { width: size, height: size, depthOrArrayLayers: NUM_BIOME_LAYERS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: mipLevels,
    });
    
    // Fill all layers with placeholder data
    this.fillArrayWithPlaceholder(this.albedoArray, [128, 128, 128, 255]); // gray
    this.fillArrayWithPlaceholder(this.normalArray, [128, 128, 255, 255]); // flat normal
    
    this.albedoArrayView = this.albedoArray.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: NUM_BIOME_LAYERS,
    });
    
    this.normalArrayView = this.normalArray.createView({
      dimension: '2d-array',
      baseArrayLayer: 0,
      arrayLayerCount: NUM_BIOME_LAYERS,
    });
    
    this.fullArraysAllocated = true;
    this.loadedAlbedoLayers.clear();
    this.loadedNormalLayers.clear();
    
    console.log(`[BiomeTextures] Allocated ${size}x${size}x${NUM_BIOME_LAYERS} texture arrays (${mipLevels} mip levels)`);
  }
  
  /**
   * Fill a texture array with solid color placeholder data
   */
  private fillArrayWithPlaceholder(texture: GPUTexture, color: [number, number, number, number]): void {
    const size = this._resolution;
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      pixels[i * 4 + 0] = color[0];
      pixels[i * 4 + 1] = color[1];
      pixels[i * 4 + 2] = color[2];
      pixels[i * 4 + 3] = color[3];
    }
    
    for (let layer = 0; layer < NUM_BIOME_LAYERS; layer++) {
      this.ctx.device.queue.writeTexture(
        { texture, origin: { x: 0, y: 0, z: layer } },
        pixels,
        { bytesPerRow: size * 4 },
        { width: size, height: size }
      );
    }
    
    // Generate mipmaps for the placeholder (simple approach - just write to mip 0)
    // Real mipmaps will be generated when actual textures are loaded
  }
  
  /**
   * Destroy texture arrays
   */
  private destroyTextureArrays(): void {
    this.albedoArray?.destroy();
    this.normalArray?.destroy();
    this.albedoArray = null;
    this.normalArray = null;
    this.albedoArrayView = null;
    this.normalArrayView = null;
  }
  
  /**
   * Create the bind group layout for Group 1
   */
  private createBindGroupLayout(): void {
    this._bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'terrain-biome-bind-group-layout',
      entries: [
        // binding 0: biomeAlbedoArray (texture_2d_array)
        { 
          binding: 0, 
          visibility: GPUShaderStage.FRAGMENT, 
          texture: { 
            sampleType: 'float',
            viewDimension: '2d-array',
          } 
        },
        // binding 1: biomeNormalArray (texture_2d_array)
        { 
          binding: 1, 
          visibility: GPUShaderStage.FRAGMENT, 
          texture: { 
            sampleType: 'float',
            viewDimension: '2d-array',
          } 
        },
        // binding 2: biomeSampler
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // binding 3: biomeParams uniform buffer
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }
  
  /**
   * Create the params uniform buffer
   */
  private createParamsBuffer(): void {
    // 48 bytes for BiomeTextureUniformData (12 floats * 4 bytes) - 3 vec4f
    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'terrain-biome-params',
      size: 48,
    });
  }
  
  /**
   * Update the uniform buffer with current material params.
   * Overrides enable flags based on actual loaded texture state.
   */
  updateParams(material: TerrainMaterialParams): void {
    if (!this.paramsBuffer) return;
    
    // Start with material-derived uniform data (for fallback colors, etc.)
    const uniformData = createBiomeTextureUniform(material);
    
    // Override enable flags based on actual loaded state (3 biomes: grass=0, rock=1, forest=2)
    for (let i = 0; i < NUM_BIOME_LAYERS; i++) {
      uniformData.albedoEnabled[i] = this.loadedAlbedoLayers.has(i) ? 1.0 : 0.0;
      uniformData.normalEnabled[i] = this.loadedNormalLayers.has(i) ? 1.0 : 0.0;
    }
    
    // Override tiling scales from our stored values
    uniformData.tilingScales = [
      this.tilingScales.grass,
      this.tilingScales.rock,
      this.tilingScales.forest,
      0.0,  // unused 4th slot for vec4 alignment
    ];
    
    const data = biomeTextureUniformToFloat32Array(uniformData);
    this.paramsBuffer.write(this.ctx, data);
  }
  
  /**
   * Recreate the bind group with current texture arrays
   */
  private updateBindGroup(): void {
    if (!this._bindGroupLayout || !this.paramsBuffer || !this.sampler ||
        !this.albedoArrayView || !this.normalArrayView) {
      return;
    }
    
    this._bindGroup = this.ctx.device.createBindGroup({
      label: 'terrain-biome-bind-group',
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: this.albedoArrayView },
        { binding: 1, resource: this.normalArrayView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.paramsBuffer.buffer } },
      ],
    });
    
    this.bindGroupDirty = false;
  }
  
  /**
   * Upload an ImageBitmap to a specific layer in the texture array
   */
  private async uploadBitmapToLayer(
    bitmap: ImageBitmap, 
    biome: BiomeType, 
    type: TextureType
  ): Promise<void> {
    const layer = BIOME_LAYERS[biome];
    const array = type === 'albedo' ? this.albedoArray : this.normalArray;
    const loadedSet = type === 'albedo' ? this.loadedAlbedoLayers : this.loadedNormalLayers;

    if (!array) return;

    // Downsample to current resolution using TextureLoader utility
    const downsampledBitmap = await downsampleBitmap(bitmap, this._resolution);

    // Copy to GPU texture layer
    this.ctx.device.queue.copyExternalImageToTexture(
      { source: downsampledBitmap },
      { texture: array, origin: { x: 0, y: 0, z: layer } },
      { width: this._resolution, height: this._resolution }
    );

    // Generate mipmaps for this layer
    this.generateMipmapsForLayer(array, layer);

    loadedSet.add(layer);

    // Clean up downsampled bitmap if it was created
    if (downsampledBitmap !== bitmap) {
      downsampledBitmap.close();
    }
  }

  /**
   * Generate mipmaps for a specific layer of the texture array.
   * Uses the shared TextureLoader mipmap generation pipeline.
   */
  private generateMipmapsForLayer(texture: GPUTexture, layer: number): void {
    generateMipmapsForTextureArrayLayer(this.ctx, texture, layer);
  }
  
  /**
   * Load a texture from URL into a biome layer.
   * Validates that source is 4096x4096, downsamples to current resolution.
   * Uses TextureLoader utility for loading and validation.
   * @param url - URL to load the texture from
   * @param biome - Biome layer to load into
   * @param type - Texture type ('albedo' or 'normal')
   * @returns true if loaded successfully, false if rejected
   */
  async loadTextureFromURL(url: string, biome: BiomeType, type: TextureType): Promise<boolean> {
    try {
      // Load image using TextureLoader utility (validates min size)
      const { bitmap, originalWidth, originalHeight } = await loadBitmapFromURL(url, {
        minSize: MIN_SOURCE_SIZE,
      });
      
      // Lazy allocate full arrays on first real texture load
      if (!this.fullArraysAllocated) {
        this.createFullTextureArrays();
        this.bindGroupDirty = true;
      }
      
      // Cache the source bitmap for re-downsampling on resolution change
      const cacheKey = `${biome}-${type}`;
      const oldCached = this.sourceCache.get(cacheKey);
      if (oldCached) {
        oldCached.bitmap.close();
      }
      this.sourceCache.set(cacheKey, { bitmap, biome, type });
      
      // Upload to texture array layer
      await this.uploadBitmapToLayer(bitmap, biome, type);
      
      this.bindGroupDirty = true;
      
      console.log(`[BiomeTextures] Loaded ${type} for ${biome} (${originalWidth}x${originalHeight} → ${this._resolution})`);
      return true;
      
    } catch (error) {
      if (error instanceof Error && error.message.includes('too small')) {
        console.warn(`[BiomeTextures] Rejected texture: ${error.message}`);
        return false;
      }
      console.error(`[BiomeTextures] Failed to load texture from ${url}:`, error);
      return false;
    }
  }
  
  /**
   * Clear a specific biome texture (revert to placeholder)
   */
  clearTexture(biome: BiomeType, type: TextureType): void {
    const cacheKey = `${biome}-${type}`;
    const cached = this.sourceCache.get(cacheKey);
    if (cached) {
      cached.bitmap.close();
      this.sourceCache.delete(cacheKey);
    }
    
    const layer = BIOME_LAYERS[biome];
    const loadedSet = type === 'albedo' ? this.loadedAlbedoLayers : this.loadedNormalLayers;
    loadedSet.delete(layer);
    
    // Fill this layer with placeholder data
    if (this.fullArraysAllocated) {
      const array = type === 'albedo' ? this.albedoArray : this.normalArray;
      const color: [number, number, number, number] = type === 'albedo' 
        ? [128, 128, 128, 255] 
        : [128, 128, 255, 255];
      
      if (array) {
        const size = this._resolution;
        const pixels = new Uint8Array(size * size * 4);
        for (let i = 0; i < size * size; i++) {
          pixels[i * 4 + 0] = color[0];
          pixels[i * 4 + 1] = color[1];
          pixels[i * 4 + 2] = color[2];
          pixels[i * 4 + 3] = color[3];
        }
        
        this.ctx.device.queue.writeTexture(
          { texture: array, origin: { x: 0, y: 0, z: layer } },
          pixels,
          { bytesPerRow: size * 4 },
          { width: size, height: size }
        );
      }
    }
    
    this.bindGroupDirty = true;
  }
  
  /**
   * Clear all biome textures
   */
  clearAllTextures(): void {
    // Close all cached bitmaps
    for (const cached of this.sourceCache.values()) {
      cached.bitmap.close();
    }
    this.sourceCache.clear();
    
    // Reset to placeholder arrays
    this.destroyTextureArrays();
    this.createPlaceholderArrays();
    
    this.loadedAlbedoLayers.clear();
    this.loadedNormalLayers.clear();
    this.bindGroupDirty = true;
  }
  
  /**
   * Check if a specific biome texture is loaded
   */
  hasTexture(biome: BiomeType, type: TextureType): boolean {
    const layer = BIOME_LAYERS[biome];
    return type === 'albedo' 
      ? this.loadedAlbedoLayers.has(layer) 
      : this.loadedNormalLayers.has(layer);
  }
  
  /**
   * Set the tiling scale for a biome (world-space meters per texture tile)
   */
  setTiling(biome: BiomeType, scale: number): void {
    this.tilingScales[biome] = scale;
  }
  
  /**
   * Get the tiling scale for a biome
   */
  getTiling(biome: BiomeType): number {
    return this.tilingScales[biome];
  }
  
  /**
   * Get all tiling scales
   */
  getAllTilingScales(): Record<BiomeType, number> {
    return { ...this.tilingScales };
  }
  
  /**
   * Ensure bind group is up-to-date before rendering
   */
  ensureBindGroup(): void {
    if (this.bindGroupDirty) {
      this.updateBindGroup();
    }
  }
  
  /**
   * Get the bind group layout for pipeline creation
   */
  get bindGroupLayout(): GPUBindGroupLayout | null {
    return this._bindGroupLayout;
  }
  
  /**
   * Get the bind group for rendering
   */
  get bindGroup(): GPUBindGroup | null {
    return this._bindGroup;
  }
  
  /**
   * Check if any biome textures are loaded
   */
  hasAnyTextures(): boolean {
    return this.loadedAlbedoLayers.size > 0 || this.loadedNormalLayers.size > 0;
  }
  
  /**
   * Destroy all resources
   */
  destroy(): void {
    // Close all cached bitmaps
    for (const cached of this.sourceCache.values()) {
      cached.bitmap.close();
    }
    this.sourceCache.clear();
    
    this.destroyTextureArrays();
    this.paramsBuffer?.destroy();
    
    this.paramsBuffer = null;
    this._bindGroup = null;
    this._bindGroupLayout = null;
    this.sampler = null;
    
    this.loadedAlbedoLayers.clear();
    this.loadedNormalLayers.clear();
  }
}
