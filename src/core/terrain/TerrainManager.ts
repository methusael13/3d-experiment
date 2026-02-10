/**
 * TerrainManager - High-level terrain orchestration
 * 
 * Manages the full terrain pipeline:
 * 1. Heightmap generation (procedural noise)
 * 2. Erosion simulation (hydraulic + thermal)
 * 3. Normal map generation
 * 4. CDLOD rendering
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext, UnifiedGPUTexture, ShaderSources } from '../gpu';
import { type BoundingBox } from '../gpu/renderers/types';
import { registerWGSLShader, unregisterWGSLShader } from '../../demos/sceneBuilder/shaderManager';
import { 
  HeightmapGenerator, 
  NoiseParams, 
  createDefaultNoiseParams,
  IslandMaskParams,
  createDefaultIslandMaskParams,
} from './HeightmapGenerator';
import { ErosionSimulator, HydraulicErosionParams, ThermalErosionParams } from './ErosionSimulator';
import { BiomeMaskGenerator, BiomeParams, createDefaultBiomeParams, PlantRegistry } from '../vegetation';
import { CDLODRendererGPU, CDLODGPUConfig, CDLODRenderParams, TerrainMaterial } from './CDLODRendererGPU';
import { QuadtreeConfig } from './TerrainQuadtree';

/**
 * Terrain generation configuration
 * 
 * Note: Noise type is now controlled via NoiseParams fields:
 * - warpStrength = 0, ridgeWeight = 0 → Pure FBM
 * - warpStrength = 0, ridgeWeight = 1 → Pure Ridged
 * - warpStrength > 0 → Domain warped noise
 */
export interface TerrainGenerationConfig {
  /** Heightmap resolution (power of 2, e.g., 512, 1024, 2048) */
  resolution: number;
  /** Noise generation parameters (controls noise type via warpStrength/ridgeWeight) */
  noise: Partial<NoiseParams>;
  /** Enable hydraulic erosion */
  enableHydraulicErosion: boolean;
  /** Hydraulic erosion iterations */
  hydraulicIterations: number;
  /** Hydraulic erosion parameters */
  hydraulicParams: Partial<HydraulicErosionParams>;
  /** Enable thermal erosion */
  enableThermalErosion: boolean;
  /** Thermal erosion iterations */
  thermalIterations: number;
  /** Thermal erosion parameters */
  thermalParams: Partial<ThermalErosionParams>;
  /** Normal map strength */
  normalStrength: number;
}

/**
 * Island mode configuration (runtime, not part of generation)
 */
export interface IslandConfig {
  /** Enable island mode */
  enabled: boolean;
  /** Ocean floor depth (normalized, e.g., -0.3) */
  seaFloorDepth: number;
  /** Island mask generation parameters */
  maskParams: IslandMaskParams;
}

/**
 * Default island configuration
 */
export function createDefaultIslandConfig(): IslandConfig {
  return {
    enabled: false,
    seaFloorDepth: -0.3,
    maskParams: createDefaultIslandMaskParams(),
  };
}

/**
 * Terrain manager configuration
 */
export interface TerrainManagerConfig {
  /** World size in units */
  worldSize: number;
  /** Maximum terrain height */
  heightScale: number;
  /** Quadtree configuration */
  quadtreeConfig?: Partial<QuadtreeConfig>;
  /** Renderer configuration */
  rendererConfig?: Partial<CDLODGPUConfig>;
  /** Generation configuration */
  generationConfig?: Partial<TerrainGenerationConfig>;
  /** Island mode configuration */
  islandConfig?: IslandConfig;
}

/**
 * Default terrain generation configuration
 */
export function createDefaultGenerationConfig(): TerrainGenerationConfig {
  return {
    resolution: 1024,
    noise: createDefaultNoiseParams(),
    enableHydraulicErosion: true,
    hydraulicIterations: 30,
    hydraulicParams: {},
    enableThermalErosion: true,
    thermalIterations: 10,
    thermalParams: {},
    normalStrength: 1.0,
  };
}

/**
 * Default terrain manager configuration
 */
export function createDefaultTerrainManagerConfig(): TerrainManagerConfig {
  return {
    worldSize: 1000,
    heightScale: 50,
    quadtreeConfig: {},
    rendererConfig: {},
    generationConfig: createDefaultGenerationConfig(),
    islandConfig: createDefaultIslandConfig(),
  };
}

/**
 * Generation progress callback
 */
export type GenerationProgressCallback = (stage: string, progress: number) => void;

/**
 * TerrainManager - Orchestrates terrain generation and rendering
 * 
 * Note: Shadow casting is handled by GPUTerrainSceneObject which delegates
 * to CDLODRendererGPU.renderShadowPass()
 */
export class TerrainManager {
  private ctx: GPUContext;
  private config: TerrainManagerConfig;
  
  // Components
  private heightmapGenerator: HeightmapGenerator | null = null;
  private erosionSimulator: ErosionSimulator | null = null;
  private renderer: CDLODRendererGPU | null = null;
  
  // Vegetation system
  private biomeMaskGenerator: BiomeMaskGenerator | null = null;
  private plantRegistry: PlantRegistry | null = null;
  
  // Generated textures
  private heightmap: UnifiedGPUTexture | null = null;
  private normalMap: UnifiedGPUTexture | null = null;
  private islandMask: UnifiedGPUTexture | null = null;
  private flowMap: UnifiedGPUTexture | null = null;
  private biomeMask: UnifiedGPUTexture | null = null;
  
  // State
  private isInitialized = false;
  private isGenerating = false;
  
  // CPU-side heightfield for collision/FPS camera
  private cpuHeightfield: Float32Array | null = null;
  private heightfieldResolution: number = 0;
  
  constructor(ctx: GPUContext, config?: Partial<TerrainManagerConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultTerrainManagerConfig(), ...config };
  }
  
  /**
   * Initialize the terrain manager and its components
   */
  initialize(): void {
    if (this.isInitialized) return;
    
    // Create heightmap generator
    this.heightmapGenerator = new HeightmapGenerator(this.ctx);
    
    // Create erosion simulator
    this.erosionSimulator = new ErosionSimulator(this.ctx);
    
    // Create biome mask generator
    this.biomeMaskGenerator = new BiomeMaskGenerator(this.ctx);
    
    // Create plant registry with default presets
    this.plantRegistry = new PlantRegistry();
    this.plantRegistry.loadDefaultPresets();
    
    // Create renderer with quadtree and renderer configs
    const quadtreeConfig: Partial<QuadtreeConfig> = {
      worldSize: this.config.worldSize,
      maxHeight: this.config.heightScale * 2,
      minHeight: -this.config.heightScale * 0.5,
      ...this.config.quadtreeConfig,
    };
    
    this.renderer = new CDLODRendererGPU(
      this.ctx,
      quadtreeConfig,
      this.config.rendererConfig
    );
    
    // Register CDLOD shader for live editing
    registerWGSLShader('Terrain CDLOD', {
      device: this.ctx.device,
      source: ShaderSources.terrainCDLOD,
      label: 'terrain-cdlod',
      onRecompile: (module) => {
        this.renderer?.reloadShaderFromModule(module);
      },
    });
    
    this.isInitialized = true;
  }
  
  /**
   * Generate terrain with the current configuration
   */
  async generate(
    progressCallback?: GenerationProgressCallback
  ): Promise<void> {
    if (!this.isInitialized) {
      this.initialize();
    }
    
    if (this.isGenerating) {
      console.warn('Terrain generation already in progress');
      return;
    }
    
    this.isGenerating = true;
    
    try {
      // Merge with defaults to ensure all fields are defined
      const genConfig: TerrainGenerationConfig = {
        ...createDefaultGenerationConfig(),
        ...this.config.generationConfig,
      };
      console.log('Generating with config: ', genConfig);
      
      // Step 1: Generate base heightmap
      progressCallback?.('Generating heightmap...', 0);
      
      this.heightmap = this.heightmapGenerator!.generateHeightmap(
        genConfig.resolution,
        genConfig.noise
      );
      
      // Give GPU time to process
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Heightmap generated', 20);
      
      // Step 2: Apply erosion if enabled
      if (genConfig.enableHydraulicErosion || genConfig.enableThermalErosion) {
        progressCallback?.('Initializing erosion...', 25);
        
        this.erosionSimulator!.initialize(this.heightmap);
        
        // Apply hydraulic erosion
        if (genConfig.enableHydraulicErosion && genConfig.hydraulicIterations > 0) {
          const hydraulicTotal = genConfig.hydraulicIterations;
          const hydraulicBatch = Math.min(5, hydraulicTotal);
          
          // Include heightScale for proper erosion strength scaling
          const hydraulicParamsWithScale = {
            ...genConfig.hydraulicParams,
            heightScale: this.config.heightScale,
          };
          
          for (let i = 0; i < hydraulicTotal; i += hydraulicBatch) {
            const batch = Math.min(hydraulicBatch, hydraulicTotal - i);
            this.erosionSimulator!.applyHydraulicErosion(batch, hydraulicParamsWithScale);
            
            const progress = 25 + (i / hydraulicTotal) * 30;
            progressCallback?.(`Hydraulic erosion: ${i + batch}/${hydraulicTotal}`, progress);
            
            // Allow UI to update
            await this.ctx.device.queue.onSubmittedWorkDone();
          }
          const configStr = JSON.stringify(hydraulicParamsWithScale, null, 2);
          console.debug(
            `[TerrainManager] Applied hydraulic erosion, total iterations: ${hydraulicTotal} and config: ${configStr}`
          );
        }
        
        // Apply thermal erosion
        if (genConfig.enableThermalErosion && genConfig.thermalIterations > 0) {
          const thermalTotal = genConfig.thermalIterations;
          const thermalBatch = Math.min(5, thermalTotal);
          
          for (let i = 0; i < thermalTotal; i += thermalBatch) {
            const batch = Math.min(thermalBatch, thermalTotal - i);
            this.erosionSimulator!.applyThermalErosion(batch, genConfig.thermalParams);
            
            const progress = 55 + (i / thermalTotal) * 20;
            progressCallback?.(`Thermal erosion: ${i + batch}/${thermalTotal}`, progress);
            
            await this.ctx.device.queue.onSubmittedWorkDone();
          }
          const configStr = JSON.stringify(genConfig.thermalParams, null, 2);
          console.debug(
            `[TerrainManager] Applied thermal erosion, total iterations: ${thermalTotal} and config: ${configStr}`
          );
        }
        
        // Get final eroded heightmap
        const erodedHeightmap = this.erosionSimulator!.getResultHeightmap();
        if (erodedHeightmap) {
          // Destroy original heightmap
          this.heightmap.destroy();
          this.heightmap = erodedHeightmap;
        }
        
        // Store flow map for vegetation system
        this.flowMap = this.erosionSimulator!.getFlowMap();
      }
      
      progressCallback?.('Generating normal map...', 80);
      
      // Step 3: Generate normal map
      // Pass terrain world size and height scale for correct gradient calculation
      this.normalMap = this.heightmapGenerator!.generateNormalMap(
        this.heightmap,
        this.config.worldSize,
        this.config.heightScale,
        genConfig.normalStrength
      );
      
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Complete', 100);
      
      // Readback heightmap to CPU for collision/FPS camera
      await this.readbackHeightmap();
    } finally {
      this.isGenerating = false;
    }
  }
  
  /**
   * Read GPU heightmap texture back to CPU for collision detection
   * This enables FPS camera ground following without GPU access per frame
   */
  private async readbackHeightmap(): Promise<void> {
    if (!this.heightmap) {
      console.warn('[TerrainManager] No heightmap to readback');
      return;
    }
    const startTime = performance.now();
    
    const width = this.heightmap.width;
    const height = this.heightmap.height;
    const bytesPerPixel = 4; // r32float = 4 bytes
    const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256; // Must be multiple of 256
    const bufferSize = bytesPerRow * height;
    
    // Create staging buffer (COPY_DST | MAP_READ)
    const stagingBuffer = this.ctx.device.createBuffer({
      label: 'heightmap-readback-staging',
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    
    // Copy texture to buffer
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'heightmap-readback-encoder',
    });
    
    encoder.copyTextureToBuffer(
      { 
        texture: this.heightmap.texture,
        mipLevel: 0, // Read from highest resolution mip
      },
      { 
        buffer: stagingBuffer, 
        bytesPerRow,
        rowsPerImage: height,
      },
      { width, height, depthOrArrayLayers: 1 }
    );
    
    this.ctx.queue.submit([encoder.finish()]);
    
    // Map buffer and copy to CPU
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const mappedRange = stagingBuffer.getMappedRange();
    
    // Copy to Float32Array, handling row padding
    this.cpuHeightfield = new Float32Array(width * height);
    this.heightfieldResolution = width;
    
    const srcView = new Float32Array(mappedRange);
    const srcRowElements = bytesPerRow / bytesPerPixel;
    
    for (let y = 0; y < height; y++) {
      const srcOffset = y * srcRowElements;
      const dstOffset = y * width;
      this.cpuHeightfield.set(
        srcView.subarray(srcOffset, srcOffset + width),
        dstOffset
      );
    }
    
    stagingBuffer.unmap();
    stagingBuffer.destroy();    
    console.log(`[TerrainManager] CPU heightfield ready (${width}x${height})`);

    const latencySec = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`[TerrainManager] Time taken for read back: ${latencySec}s`);
  }
  
  /**
   * Regenerate only the heightmap (no erosion) for fast preview
   * Used for live parameter changes like offset scrolling
   */
  async regenerateHeightmapOnly(
    noiseParams?: Partial<NoiseParams>,
    progressCallback?: GenerationProgressCallback
  ): Promise<void> {
    if (!this.isInitialized) {
      this.initialize();
    }
    
    if (this.isGenerating) {
      console.warn('Terrain generation already in progress');
      return;
    }
    
    this.isGenerating = true;
    
    try {
      // Merge with current noise config
      const genConfig = this.config.generationConfig || createDefaultGenerationConfig();
      const mergedNoise = {
        ...createDefaultNoiseParams(),
        ...genConfig.noise,
        ...noiseParams,
      };
      
      // Update stored config for subsequent full regenerations
      this.config.generationConfig = {
        ...genConfig,
        noise: mergedNoise,
      };
      
      progressCallback?.('Generating heightmap...', 0);
      
      // Clean up old textures
      this.heightmap?.destroy();
      this.normalMap?.destroy();
      
      // Generate heightmap (skip erosion)
      this.heightmap = this.heightmapGenerator!.generateHeightmap(
        genConfig.resolution || 1024,
        mergedNoise
      );
      
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Generating normal map...', 50);
      
      // Generate normal map
      this.normalMap = this.heightmapGenerator!.generateNormalMap(
        this.heightmap,
        this.config.worldSize,
        this.config.heightScale,
        genConfig.normalStrength
      );
      
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Complete', 100);
      
    } finally {
      this.isGenerating = false;
    }
  }
  
  /**
   * Regenerate terrain with new parameters
   */
  async regenerate(
    config?: Partial<TerrainGenerationConfig>,
    progressCallback?: GenerationProgressCallback
  ): Promise<void> {
    // Update config with DEEP merge for nested objects
    if (config) {
      const currentGen = this.config.generationConfig || createDefaultGenerationConfig();
      const defaultGen = createDefaultGenerationConfig();
      
      // Deep merge noise params
      const mergedNoise = {
        ...defaultGen.noise,
        ...currentGen.noise,
        ...(config.noise || {}),
      };
      
      // Deep merge hydraulic params  
      const mergedHydraulic = {
        ...defaultGen.hydraulicParams,
        ...currentGen.hydraulicParams,
        ...(config.hydraulicParams || {}),
      };
      
      // Deep merge thermal params
      const mergedThermal = {
        ...defaultGen.thermalParams,
        ...currentGen.thermalParams,
        ...(config.thermalParams || {}),
      };
      
      this.config.generationConfig = {
        ...defaultGen,
        ...currentGen,
        ...config,
        // Override with deep-merged nested objects
        noise: mergedNoise,
        hydraulicParams: mergedHydraulic,
        thermalParams: mergedThermal,
      };
      
      console.log('[TerrainManager] Regenerating with config:', this.config);
    }
    
    // Clean up old textures
    this.heightmap?.destroy();
    this.normalMap?.destroy();
    this.heightmap = null;
    this.normalMap = null;
    
    // Reset erosion simulator
    this.erosionSimulator?.destroy();
    this.erosionSimulator = new ErosionSimulator(this.ctx);
    
    // Generate new terrain
    await this.generate(progressCallback);
  }
  
  /**
   * Render the terrain
   */
  render(
    passEncoder: GPURenderPassEncoder,
    params: Omit<CDLODRenderParams, 'heightmapTexture' | 'normalMapTexture' | 'terrainSize' | 'heightScale' | 'island'>
  ): void {
    if (!this.renderer) {
      console.warn('TerrainManager not initialized');
      return;
    }
    
    const islandConfig = this.config.islandConfig || createDefaultIslandConfig();
    
    this.renderer.render(passEncoder, {
      ...params,
      terrainSize: this.config.worldSize,
      heightScale: this.config.heightScale,
      heightmapTexture: this.heightmap || undefined,
      normalMapTexture: this.normalMap || undefined,
      island: {
        enabled: islandConfig.enabled,
        seaFloorDepth: islandConfig.seaFloorDepth,
        maskTexture: this.islandMask,
      },
    });
  }
  
  // ============ Getters ============
  
  get isReady(): boolean {
    return this.isInitialized && this.heightmap !== null && !this.isGenerating;
  }
  
  get generating(): boolean {
    return this.isGenerating;
  }
  
  getHeightmap(): UnifiedGPUTexture | null {
    return this.heightmap;
  }
  
  /** Alias for getHeightmap() - used by shadow system */
  getHeightmapTexture(): UnifiedGPUTexture | null {
    return this.heightmap;
  }
  
  /** Get geometry buffers for external rendering (e.g., shadow pass) */
  getGeometryBuffers(): ReturnType<CDLODRendererGPU['getGeometryBuffers']> {
    return this.renderer?.getGeometryBuffers() ?? null;
  }

  /**
   * Calculate scene radius from terrain bounds: diagonal of XZ plane + max height
   */
  getApproximateSceneRadius(): number {
    const { worldSize, heightScale } = this.config;
    const diagonal = worldSize * Math.SQRT2 * 0.5; // Half diagonal
    const maxHeight = worldSize * heightScale; // Height is scaled by worldSize
    return Math.sqrt(diagonal * diagonal + maxHeight * maxHeight);
  }
  
  getNormalMap(): UnifiedGPUTexture | null {
    return this.normalMap;
  }
  
  /**
   * Get water flow accumulation map from hydraulic erosion
   * Used for vegetation placement (riparian zones, erosion patterns)
   * Values are normalized 0-1, log-scaled for better distribution
   */
  getFlowMap(): UnifiedGPUTexture | null {
    return this.flowMap;
  }
  
  getIslandMask(): UnifiedGPUTexture | null {
    return this.islandMask;
  }
  
  /**
   * Get biome probability mask texture (RGBA8)
   * R = grassland, G = rock, B = forest, A = reserved
   */
  getBiomeMask(): UnifiedGPUTexture | null {
    return this.biomeMask;
  }
  
  getRenderer(): CDLODRendererGPU | null {
    return this.renderer;
  }
  
  getConfig(): TerrainManagerConfig {
    return { ...this.config };
  }
  
  getErosionStats(): { hydraulic: number; thermal: number } {
    return this.erosionSimulator?.getIterationCounts() || { hydraulic: 0, thermal: 0 };
  }
  
  // ============ Height Sampling (CPU) ============
  
  /**
   * Check if CPU heightfield is available for collision/sampling
   */
  hasCPUHeightfield(): boolean {
    return this.cpuHeightfield !== null && this.heightfieldResolution > 0;
  }
  
  /**
   * Sample terrain height at world coordinates
   * Uses bilinear interpolation for smooth results
   * 
   * @param worldX - World X coordinate
   * @param worldZ - World Z coordinate
   * @returns Height in world units, or 0 if no heightfield available
   */
  sampleHeightAt(worldX: number, worldZ: number): number {
    if (!this.cpuHeightfield || this.heightfieldResolution === 0) {
      return 0;
    }
    
    const worldSize = this.config.worldSize;
    const heightScale = this.config.heightScale;
    const resolution = this.heightfieldResolution;
    
    // Convert world coords to terrain-local UV (terrain centered at origin)
    const halfSize = worldSize / 2;
    const localX = worldX + halfSize;
    const localZ = worldZ + halfSize;
    
    // Convert to UV (0-1)
    const u = localX / worldSize;
    const v = localZ / worldSize;
    
    // Clamp to valid range
    const clampedU = Math.max(0, Math.min(1, u));
    const clampedV = Math.max(0, Math.min(1, v));
    
    // Convert to heightfield coordinates
    const fx = clampedU * (resolution - 1);
    const fz = clampedV * (resolution - 1);
    
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const fracX = fx - ix;
    const fracZ = fz - iz;
    
    const ix1 = Math.min(ix + 1, resolution - 1);
    const iz1 = Math.min(iz + 1, resolution - 1);
    
    // Sample four corners (heightmap stores normalized heights in [-0.5, 0.5])
    const h00 = this.cpuHeightfield[iz * resolution + ix];
    const h10 = this.cpuHeightfield[iz * resolution + ix1];
    const h01 = this.cpuHeightfield[iz1 * resolution + ix];
    const h11 = this.cpuHeightfield[iz1 * resolution + ix1];
    
    // Bilinear interpolation
    const h0 = h00 * (1 - fracX) + h10 * fracX;
    const h1 = h01 * (1 - fracX) + h11 * fracX;
    const normalizedHeight = h0 * (1 - fracZ) + h1 * fracZ;
    
    // Convert to world height
    return normalizedHeight * heightScale;
  }
  
  /**
   * Get terrain bounds in world coordinates
   * Useful for FPS camera boundary clamping
   */
  getWorldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const halfSize = this.config.worldSize / 2;
    return {
      minX: -halfSize,
      maxX: halfSize,
      minZ: -halfSize,
      maxZ: halfSize,
    };
  }
  
  // ============ Configuration ============
  
  setWorldSize(size: number): void {
    this.config.worldSize = size;
  }
  
  setHeightScale(scale: number): void {
    this.config.heightScale = scale;
  }
  
  setDebugMode(enabled: boolean): void {
    this.renderer?.setDebugMode(enabled);
  }
  
  /**
   * Set terrain material for live updates (without regeneration)
   * Changes take effect immediately on next render frame
   */
  setMaterial(material: Partial<TerrainMaterial>): void {
    this.renderer?.setMaterial(material);
  }
  
  /**
   * Get current terrain material
   */
  getMaterial(): TerrainMaterial | null {
    return this.renderer?.getMaterial() ?? null;
  }
  
  /**
   * Set procedural detail configuration for live updates (without regeneration)
   * Changes take effect immediately on next render frame
   */
  setDetailConfig(detail: {
    frequency?: number;
    amplitude?: number;
    octaves?: number;
    fadeStart?: number;
    fadeEnd?: number;
    slopeInfluence?: number;
  }): void {
    this.renderer?.setDetailConfig(detail);
  }
  
  /**
   * Get current procedural detail configuration
   */
  getDetailConfig(): {
    frequency: number;
    amplitude: number;
    octaves: number;
    fadeStart: number;
    fadeEnd: number;
    slopeInfluence: number;
  } | null {
    return this.renderer?.getDetailConfig() ?? null;
  }
  
  // ============ Biome Textures ============
  
  /**
   * Set biome texture from URL path
   * Loads the texture and updates GPU bind group
   * 
   * @param biome Biome type (grass, rock, snow, dirt, beach)
   * @param textureType Type of texture (albedo or normal)
   * @param url URL path to texture file
   * @param tilingScale World-space tiling scale (meters per tile)
   */
  async setBiomeTexture(
    biome: 'grass' | 'rock' | 'snow' | 'dirt' | 'beach',
    textureType: 'albedo' | 'normal',
    url: string,
    tilingScale?: number
  ): Promise<void> {
    if (!this.renderer) {
      console.warn('[TerrainManager] Cannot set biome texture - renderer not initialized');
      return;
    }
    
    await this.renderer.setBiomeTexture(biome, textureType, url, tilingScale);
  }
  
  /**
   * Clear biome texture (revert to procedural color)
   * 
   * @param biome Biome type to clear
   * @param textureType Which texture to clear (albedo or normal)
   */
  clearBiomeTexture(
    biome: 'grass' | 'rock' | 'snow' | 'dirt' | 'beach',
    textureType: 'albedo' | 'normal'
  ): void {
    this.renderer?.clearBiomeTexture(biome, textureType);
  }
  
  /**
   * Set biome tiling scale (world-space meters per texture tile)
   * 
   * @param biome Biome type to update
   * @param scale Tiling scale in world units
   */
  setBiomeTiling(
    biome: 'grass' | 'rock' | 'snow' | 'dirt' | 'beach',
    scale: number
  ): void {
    this.renderer?.setBiomeTiling(biome, scale);
  }
  
  // ============ Island Mode ============
  
  /**
   * Set island mode enabled state
   * Takes effect immediately on next render frame
   */
  setIslandEnabled(enabled: boolean): void {
    if (!this.config.islandConfig) {
      this.config.islandConfig = createDefaultIslandConfig();
    }
    this.config.islandConfig.enabled = enabled;
    
    // Generate island mask if enabling and not yet generated
    if (enabled && !this.islandMask && this.isInitialized) {
      this.regenerateIslandMask();
    }
  }
  
  /**
   * Get current island mode enabled state
   */
  getIslandEnabled(): boolean {
    return this.config.islandConfig?.enabled ?? false;
  }
  
  /**
   * Set island sea floor depth (normalized, e.g., -0.3)
   * Takes effect immediately on next render frame
   */
  setSeaFloorDepth(depth: number): void {
    if (!this.config.islandConfig) {
      this.config.islandConfig = createDefaultIslandConfig();
    }
    this.config.islandConfig.seaFloorDepth = depth;
  }
  
  /**
   * Get current sea floor depth
   */
  getSeaFloorDepth(): number {
    return this.config.islandConfig?.seaFloorDepth ?? -0.3;
  }
  
  /**
   * Regenerate island mask with new parameters
   * This is instant (no heightmap regeneration needed)
   */
  regenerateIslandMask(params?: Partial<IslandMaskParams>): void {
    if (!this.isInitialized || !this.heightmapGenerator) {
      console.warn('TerrainManager not initialized');
      return;
    }
    
    // Ensure island config exists
    if (!this.config.islandConfig) {
      this.config.islandConfig = createDefaultIslandConfig();
    }
    
    // Update stored params
    if (params) {
      this.config.islandConfig.maskParams = {
        ...this.config.islandConfig.maskParams,
        ...params,
      };
    }
    
    // Get resolution from current heightmap or generation config
    const resolution = this.heightmap?.width ?? 
      this.config.generationConfig?.resolution ?? 
      1024;
    
    // Clean up old mask
    this.islandMask?.destroy();
    
    // Generate new mask
    this.islandMask = this.heightmapGenerator.generateIslandMask(
      resolution,
      this.config.islandConfig.maskParams
    );
    
    console.log('[TerrainManager] Island mask regenerated');
  }
  
  /**
   * Get current island mask parameters
   */
  getIslandMaskParams(): IslandMaskParams {
    return this.config.islandConfig?.maskParams ?? createDefaultIslandMaskParams();
  }
  
  /**
   * Get full island configuration
   */
  getIslandConfig(): IslandConfig {
    return this.config.islandConfig ?? createDefaultIslandConfig();
  }
  
  // ============ Biome Mask ============
  
  /**
   * Generate biome mask from current heightmap and flow map
   * Must be called after terrain generation (heightmap exists)
   * 
   * @param params Optional biome parameters override
   * @returns The generated biome mask texture, or null if heightmap not ready
   */
  generateBiomeMask(params?: Partial<BiomeParams>): UnifiedGPUTexture | null {
    if (!this.biomeMaskGenerator || !this.heightmap) {
      console.warn('[TerrainManager] Cannot generate biome mask - heightmap not ready');
      return null;
    }
    
    // Generate biome mask using heightmap and optional flow map
    this.biomeMask = this.biomeMaskGenerator.generate(
      this.heightmap,
      this.flowMap,
      params
    );
    
    return this.biomeMask;
  }
  
  /**
   * Regenerate biome mask with new parameters
   * @param params New biome parameters
   */
  regenerateBiomeMask(params?: Partial<BiomeParams>): UnifiedGPUTexture | null {
    return this.generateBiomeMask(params);
  }
  
  /**
   * Get current biome parameters
   */
  getBiomeParams(): BiomeParams {
    return this.biomeMaskGenerator?.getParams() ?? createDefaultBiomeParams();
  }
  
  /**
   * Set biome parameters (does not regenerate - call regenerateBiomeMask())
   */
  setBiomeParams(params: Partial<BiomeParams>): void {
    this.biomeMaskGenerator?.setParams(params);
  }
  
  /**
   * Check if biome mask has been generated
   */
  hasBiomeMask(): boolean {
    return this.biomeMask !== null;
  }
  
  // ============ Plant Registry ============
  
  /**
   * Get the plant registry for vegetation configuration
   */
  getPlantRegistry(): PlantRegistry | null {
    return this.plantRegistry;
  }
  
  /**
   * Check if plant registry is initialized
   */
  hasPlantRegistry(): boolean {
    return this.plantRegistry !== null;
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    // Unregister shader from live editing
    unregisterWGSLShader('Terrain CDLOD');
    
    this.heightmapGenerator?.destroy();
    this.erosionSimulator?.destroy();
    this.renderer?.destroy();
    this.biomeMaskGenerator?.destroy();
    this.heightmap?.destroy();
    this.normalMap?.destroy();
    this.islandMask?.destroy();
    this.biomeMask?.destroy();
    
    this.heightmapGenerator = null;
    this.erosionSimulator = null;
    this.renderer = null;
    this.biomeMaskGenerator = null;
    this.heightmap = null;
    this.normalMap = null;
    this.islandMask = null;
    this.biomeMask = null;
    this.isInitialized = false;
  }
}
