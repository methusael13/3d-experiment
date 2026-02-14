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
 * Refactored to use a config-driven approach for easy addition of new texture types.
 * 
 * Shader bindings (Group 1):
 * - binding 0: biomeAlbedoArray (texture_2d_array)
 * - binding 1: biomeNormalArray (texture_2d_array)
 * - binding 2: biomeAoArray (texture_2d_array)
 * - binding 3: biomeSampler
 * - binding 4: biomeParams uniform buffer
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
export type TextureType = 'albedo' | 'normal' | 'ao';

/** Supported texture array resolutions */
export type BiomeResolution = 1024 | 2048 | 4096;

/** Minimum required source texture size */
const MIN_SOURCE_SIZE = 4096;

/** Number of biome layers (grass, rock, forest) */
const NUM_BIOME_LAYERS = 3;

/** 
 * Configuration for a texture type (albedo, normal, ao, etc.)
 * Defines how to create and manage each texture type.
 */
interface TextureTypeConfig {
  /** Texture type name */
  name: TextureType;
  /** Binding index in the bind group */
  bindingIndex: number;
  /** RGBA placeholder color for unloaded textures */
  placeholderColor: [number, number, number, number];
  /** Label prefix for GPU resources */
  label: string;
}

/**
 * Runtime resources for a texture type.
 * Managed per texture type (albedo, normal, ao).
 */
interface TextureTypeResources {
  /** GPU texture array (3 layers for 3 biomes) */
  array: GPUTexture | null;
  /** Texture view for binding */
  view: GPUTextureView | null;
  /** Set of layer indices that have real textures loaded */
  loadedLayers: Set<number>;
}

/**
 * Configuration for all supported texture types.
 * Add new entries here to support additional texture types (roughness, displacement, etc.)
 */
const TEXTURE_TYPE_CONFIGS: TextureTypeConfig[] = [
  { 
    name: 'albedo', 
    bindingIndex: 0, 
    placeholderColor: [128, 128, 128, 255],  // gray
    label: 'albedo',
  },
  { 
    name: 'normal', 
    bindingIndex: 1, 
    placeholderColor: [128, 128, 255, 255],  // flat up-facing normal
    label: 'normal',
  },
  { 
    name: 'ao', 
    bindingIndex: 2, 
    placeholderColor: [255, 255, 255, 255],  // white (no occlusion)
    label: 'ao',
  },
];

/** Sampler binding index (after all texture types) */
const SAMPLER_BINDING_INDEX = TEXTURE_TYPE_CONFIGS.length;

/** Params uniform buffer binding index (after sampler) */
const PARAMS_BINDING_INDEX = SAMPLER_BINDING_INDEX + 1;

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
 * Get the config for a texture type
 */
function getTextureTypeConfig(type: TextureType): TextureTypeConfig {
  const config = TEXTURE_TYPE_CONFIGS.find(c => c.name === type);
  if (!config) {
    throw new Error(`Unknown texture type: ${type}`);
  }
  return config;
}

/**
 * Manages biome texture arrays for terrain rendering.
 * Uses a config-driven approach to support multiple texture types generically.
 */
export class TerrainBiomeTextureResources {
  private ctx: GPUContext;
  
  // Bind group resources
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  
  // Texture resources per type (keyed by TextureType)
  private textureResources: Map<TextureType, TextureTypeResources> = new Map();
  
  // Current array resolution
  private _resolution: BiomeResolution = 2048;
  
  // Track if full-size arrays are allocated
  private fullArraysAllocated = false;
  
  // Cache source images for re-downsampling
  private sourceCache: Map<string, CachedSourceImage> = new Map();
  
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
    this.initializeTextureResources();
    this.initialize();
  }
  
  /**
   * Initialize the texture resources map for all configured types
   */
  private initializeTextureResources(): void {
    for (const config of TEXTURE_TYPE_CONFIGS) {
      this.textureResources.set(config.name, {
        array: null,
        view: null,
        loadedLayers: new Set(),
      });
    }
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
   * Create tiny 1x1 placeholder texture arrays for all texture types.
   * These consume minimal VRAM until real textures are loaded.
   */
  private createPlaceholderArrays(): void {
    for (const config of TEXTURE_TYPE_CONFIGS) {
      const resources = this.textureResources.get(config.name)!;
      
      // Create 1x1xN placeholder array
      resources.array = this.ctx.device.createTexture({
        label: `terrain-biome-${config.label}-placeholder`,
        size: { width: 1, height: 1, depthOrArrayLayers: NUM_BIOME_LAYERS },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      
      // Fill placeholder with the configured color
      const pixel = new Uint8Array(config.placeholderColor);
      for (let layer = 0; layer < NUM_BIOME_LAYERS; layer++) {
        this.ctx.device.queue.writeTexture(
          { texture: resources.array, origin: { x: 0, y: 0, z: layer } },
          pixel,
          { bytesPerRow: 4 },
          { width: 1, height: 1 }
        );
      }
      
      resources.view = resources.array.createView({
        dimension: '2d-array',
        baseArrayLayer: 0,
        arrayLayerCount: NUM_BIOME_LAYERS,
      });
      
      resources.loadedLayers.clear();
    }
    
    this.fullArraysAllocated = false;
  }
  
  /**
   * Create full-size texture arrays at current resolution for all texture types.
   * Called lazily when first texture is loaded.
   */
  private createFullTextureArrays(): void {
    const size = this._resolution;
    const mipLevels = Math.floor(Math.log2(size)) + 1;
    
    // Destroy placeholder arrays first
    this.destroyTextureArrays();
    
    for (const config of TEXTURE_TYPE_CONFIGS) {
      const resources = this.textureResources.get(config.name)!;
      
      // Create full-size array
      resources.array = this.ctx.device.createTexture({
        label: `terrain-biome-${config.label}-${size}`,
        size: { width: size, height: size, depthOrArrayLayers: NUM_BIOME_LAYERS },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mipLevels,
      });
      
      // Fill all layers with placeholder data
      this.fillArrayWithPlaceholder(resources.array, config.placeholderColor);
      
      resources.view = resources.array.createView({
        dimension: '2d-array',
        baseArrayLayer: 0,
        arrayLayerCount: NUM_BIOME_LAYERS,
      });
      
      resources.loadedLayers.clear();
    }
    
    this.fullArraysAllocated = true;
    
    console.log(`[BiomeTextures] Allocated ${size}x${size}x${NUM_BIOME_LAYERS} texture arrays for ${TEXTURE_TYPE_CONFIGS.length} types (${mipLevels} mip levels)`);
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
  }
  
  /**
   * Destroy all texture arrays
   */
  private destroyTextureArrays(): void {
    for (const resources of this.textureResources.values()) {
      resources.array?.destroy();
      resources.array = null;
      resources.view = null;
    }
  }
  
  /**
   * Create the bind group layout dynamically based on configured texture types.
   * Layout: [texture0, texture1, ..., textureN, sampler, params]
   */
  private createBindGroupLayout(): void {
    const entries: GPUBindGroupLayoutEntry[] = [];
    
    // Add texture entries for each configured type
    for (const config of TEXTURE_TYPE_CONFIGS) {
      entries.push({
        binding: config.bindingIndex,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'float',
          viewDimension: '2d-array',
        },
      });
    }
    
    // Add sampler entry
    entries.push({
      binding: SAMPLER_BINDING_INDEX,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: 'filtering' },
    });
    
    // Add params uniform buffer entry
    entries.push({
      binding: PARAMS_BINDING_INDEX,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    });
    
    this._bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'terrain-biome-bind-group-layout',
      entries,
    });
  }
  
  /**
   * Create the params uniform buffer.
   * Size: 64 bytes for BiomeTextureUniformData (16 floats * 4 bytes) - 4 vec4f
   */
  private createParamsBuffer(): void {
    // 64 bytes for BiomeTextureUniformData (16 floats * 4 bytes) - 4 vec4f
    // [albedoEnabled, normalEnabled, aoEnabled, tilingScales]
    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'terrain-biome-params',
      size: 64,
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
    const albedoResources = this.textureResources.get('albedo')!;
    const normalResources = this.textureResources.get('normal')!;
    const aoResources = this.textureResources.get('ao')!;
    
    for (let i = 0; i < NUM_BIOME_LAYERS; i++) {
      uniformData.albedoEnabled[i] = albedoResources.loadedLayers.has(i) ? 1.0 : 0.0;
      uniformData.normalEnabled[i] = normalResources.loadedLayers.has(i) ? 1.0 : 0.0;
      uniformData.aoEnabled[i] = aoResources.loadedLayers.has(i) ? 1.0 : 0.0;
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
   * Recreate the bind group with current texture arrays.
   * Dynamically builds entries based on configured texture types.
   */
  private updateBindGroup(): void {
    if (!this._bindGroupLayout || !this.paramsBuffer || !this.sampler) {
      return;
    }
    
    // Check all texture views are available
    for (const resources of this.textureResources.values()) {
      if (!resources.view) return;
    }
    
    const entries: GPUBindGroupEntry[] = [];
    
    // Add texture entries for each configured type
    for (const config of TEXTURE_TYPE_CONFIGS) {
      const resources = this.textureResources.get(config.name)!;
      entries.push({
        binding: config.bindingIndex,
        resource: resources.view!,
      });
    }
    
    // Add sampler entry
    entries.push({
      binding: SAMPLER_BINDING_INDEX,
      resource: this.sampler,
    });
    
    // Add params uniform buffer entry
    entries.push({
      binding: PARAMS_BINDING_INDEX,
      resource: { buffer: this.paramsBuffer.buffer },
    });
    
    this._bindGroup = this.ctx.device.createBindGroup({
      label: 'terrain-biome-bind-group',
      layout: this._bindGroupLayout,
      entries,
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
    const resources = this.textureResources.get(type);
    
    if (!resources?.array) return;

    // Downsample to current resolution using TextureLoader utility
    const downsampledBitmap = await downsampleBitmap(bitmap, this._resolution);

    // Copy to GPU texture layer
    this.ctx.device.queue.copyExternalImageToTexture(
      { source: downsampledBitmap },
      { texture: resources.array, origin: { x: 0, y: 0, z: layer } },
      { width: this._resolution, height: this._resolution }
    );

    // Generate mipmaps for this layer
    this.generateMipmapsForLayer(resources.array, layer);

    resources.loadedLayers.add(layer);

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
   * @param type - Texture type ('albedo', 'normal', or 'ao')
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
    const resources = this.textureResources.get(type);
    const config = getTextureTypeConfig(type);
    
    if (!resources) return;
    
    resources.loadedLayers.delete(layer);
    
    // Fill this layer with placeholder data
    if (this.fullArraysAllocated && resources.array) {
      const size = this._resolution;
      const pixels = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        pixels[i * 4 + 0] = config.placeholderColor[0];
        pixels[i * 4 + 1] = config.placeholderColor[1];
        pixels[i * 4 + 2] = config.placeholderColor[2];
        pixels[i * 4 + 3] = config.placeholderColor[3];
      }
      
      this.ctx.device.queue.writeTexture(
        { texture: resources.array, origin: { x: 0, y: 0, z: layer } },
        pixels,
        { bytesPerRow: size * 4 },
        { width: size, height: size }
      );
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
    
    // Clear loaded layers for all texture types
    for (const resources of this.textureResources.values()) {
      resources.loadedLayers.clear();
    }
    
    this.bindGroupDirty = true;
  }
  
  /**
   * Check if a specific biome texture is loaded
   */
  hasTexture(biome: BiomeType, type: TextureType): boolean {
    const layer = BIOME_LAYERS[biome];
    const resources = this.textureResources.get(type);
    return resources?.loadedLayers.has(layer) ?? false;
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
   * Check if any biome textures are loaded (any type)
   */
  hasAnyTextures(): boolean {
    for (const resources of this.textureResources.values()) {
      if (resources.loadedLayers.size > 0) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * Get the list of supported texture types
   */
  static getSupportedTextureTypes(): TextureType[] {
    return TEXTURE_TYPE_CONFIGS.map(c => c.name);
  }
  
  /**
   * Get the binding index for a texture type (useful for shader generation)
   */
  static getBindingIndex(type: TextureType): number {
    return getTextureTypeConfig(type).bindingIndex;
  }
  
  /**
   * Get the sampler binding index
   */
  static get samplerBindingIndex(): number {
    return SAMPLER_BINDING_INDEX;
  }
  
  /**
   * Get the params uniform buffer binding index
   */
  static get paramsBindingIndex(): number {
    return PARAMS_BINDING_INDEX;
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
    
    // Clear loaded layers for all texture types
    for (const resources of this.textureResources.values()) {
      resources.loadedLayers.clear();
    }
  }
}
