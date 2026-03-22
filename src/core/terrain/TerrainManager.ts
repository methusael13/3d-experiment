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
import { TerrainLayerCompositor, CompositorResult } from './TerrainLayerCompositor';
import {
  NoiseLayerGenerator,
  RockLayerGenerator,
  IslandLayerGenerator,
  FlattenLayerGenerator,
} from './layers';
import { BiomeMaskGenerator, BiomeParams, createDefaultBiomeParams, PlantRegistry, VegetationManager, VegetationShadowMap } from '../vegetation';
import {
  TerrainLayer,
  TerrainLayerType,
  TerrainLayerBounds,
  createTerrainLayer,
} from './types';
import { CDLODRendererGPU, CDLODGPUConfig, CDLODRenderParams, TerrainMaterial } from './CDLODRendererGPU';
import { QuadtreeConfig } from './TerrainQuadtree';
import { BiomeType, TextureType } from './TerrainBiomeTextureResources';
import { ShadowRendererGPU } from '../gpu/renderers';
import { World } from '../ecs/World';
import { LightComponent } from '../ecs/components';
import { getMaterialRegistry } from '../materials';

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
    worldSize: 400,
    heightScale: 125,
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
  private vegetationManager: VegetationManager | null = null;
  private biomeMaskGenerator: BiomeMaskGenerator | null = null;
  private plantRegistry: PlantRegistry | null = null;
  
  // Layer system
  private layerCompositor: TerrainLayerCompositor | null = null;
  private layers: TerrainLayer[] = [];
  private erosionMask: UnifiedGPUTexture | null = null;
  
  // Generated textures
  private heightmap: UnifiedGPUTexture | null = null;
  private normalMap: UnifiedGPUTexture | null = null;
  private islandMask: UnifiedGPUTexture | null = null;
  private flowMap: UnifiedGPUTexture | null = null;
  private biomeMask: UnifiedGPUTexture | null = null;
  
  // ECS World reference (for reading LightComponent)
  private _world: World | null = null;
  
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
    
    // Create layer compositor and register built-in layer generators
    this.layerCompositor = new TerrainLayerCompositor(this.ctx);
    this.layerCompositor.registerGenerator(new NoiseLayerGenerator(this.heightmapGenerator));
    this.layerCompositor.registerGenerator(new RockLayerGenerator(this.ctx));
    this.layerCompositor.registerGenerator(new IslandLayerGenerator(this.heightmapGenerator));
    this.layerCompositor.registerGenerator(new FlattenLayerGenerator());
    
    // Create biome mask generator
    this.biomeMaskGenerator = new BiomeMaskGenerator(this.ctx);
    
    // Create plant registry with default presets
    this.plantRegistry = new PlantRegistry();
    this.plantRegistry.loadDefaultPresets();
    
    // Create vegetation manager
    this.vegetationManager = new VegetationManager(this.ctx);
    this.vegetationManager.initialize();
    
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
   * Generate terrain with the current configuration.
   * 
   * This is the single unified generation pipeline:
   * 1. Generate base heightmap (warped fBm via HeightmapGenerator)
   * 2. If layers exist, composite them onto the base heightmap
   * 3. If simulateErosion is true, run hydraulic + thermal erosion
   * 4. Generate normal map
   * 5. CPU readback + vegetation reconnection
   *
   * @param simulateErosion  If true, runs erosion simulation. Defaults to false
   *                         for fast live updates (layer changes, noise tweaks).
   *                         Should only be true when the user explicitly presses Update.
   * @param progressCallback Optional progress reporting callback
   */
  async generate(
    simulateErosion: boolean = false,
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
      console.log('[TerrainManager] Generating with config (erosion=%s)', simulateErosion, genConfig);
      
      // Step 1: Generate base heightmap
      progressCallback?.('Generating heightmap...', 0);
      
      this.heightmap = this.heightmapGenerator!.generateHeightmap(
        genConfig.resolution,
        genConfig.noise,
        false, // No mipmaps — generated after compositing/erosion
      );
      
      // Give GPU time to process
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Heightmap generated', 15);
      
      // Step 2: Composite layers (if any enabled layers exist)
      const enabledLayers = this.layers.filter(l => l.enabled);
      if (enabledLayers.length > 0 && this.layerCompositor) {
        progressCallback?.('Compositing layers...', 20);
        
        const result = this.layerCompositor.composite(
          this.heightmap,
          enabledLayers,
          this.config.worldSize,
          genConfig.resolution,
        );
        
        // Base heightmap is no longer needed (compositor produced a new one)
        this.heightmap.destroy();
        this.heightmap = result.heightmap;
        this.erosionMask = result.erosionMask;
        
        await this.ctx.device.queue.onSubmittedWorkDone();
        progressCallback?.('Layers composited', 30);
        
        console.log(`[TerrainManager] Composited ${enabledLayers.length} layers`);
      }
      
      // Step 3: Apply erosion (only when explicitly requested)
      if (simulateErosion) {
        await this.runErosion(genConfig, progressCallback);
      }
      
      progressCallback?.('Generating normal map...', 85);
      
      // Step 4: Generate normal map
      this.normalMap = this.heightmapGenerator!.generateNormalMap(
        this.heightmap,
        this.config.worldSize,
        this.config.heightScale,
        genConfig.normalStrength
      );
      
      await this.ctx.device.queue.onSubmittedWorkDone();
      progressCallback?.('Complete', 100);
      
      // Step 5: Readback heightmap to CPU for collision/FPS camera
      await this.readbackHeightmap();
      
      // Step 6: Connect vegetation manager to terrain data + quadtree LOD info
      if (this.vegetationManager && this.plantRegistry && this.heightmap) {
        const qtConfig = this.renderer?.getQuadtree()?.getConfig();
        this.vegetationManager.connectToTerrain(
          this.plantRegistry,
          this.heightmap,
          this.biomeMask,
          this.config.worldSize,
          this.config.heightScale,
          qtConfig?.maxLodLevels ?? 10,
        );
      }
    } finally {
      this.isGenerating = false;
    }
  }
  
  /**
   * Run erosion simulation on the current heightmap.
   * Extracted as a private helper to avoid duplication.
   */
  private async runErosion(
    genConfig: TerrainGenerationConfig,
    progressCallback?: GenerationProgressCallback,
  ): Promise<void> {
    if (!this.heightmap) return;
    
    const wantHydraulic = genConfig.enableHydraulicErosion && genConfig.hydraulicIterations > 0;
    const wantThermal = genConfig.enableThermalErosion && genConfig.thermalIterations > 0;
    
    if (!wantHydraulic && !wantThermal) return;
    
    progressCallback?.('Initializing erosion...', 35);
    this.erosionSimulator!.initialize(this.heightmap);
    
    // Apply hydraulic erosion
    if (wantHydraulic) {
      const hydraulicTotal = genConfig.hydraulicIterations;
      const hydraulicBatch = Math.min(5, hydraulicTotal);
      const hydraulicParamsWithScale = {
        ...genConfig.hydraulicParams,
        heightScale: this.config.heightScale,
      };
      
      for (let i = 0; i < hydraulicTotal; i += hydraulicBatch) {
        const batch = Math.min(hydraulicBatch, hydraulicTotal - i);
        this.erosionSimulator!.applyHydraulicErosion(batch, hydraulicParamsWithScale);
        
        const progress = 35 + (i / hydraulicTotal) * 25;
        progressCallback?.(`Hydraulic erosion: ${i + batch}/${hydraulicTotal}`, progress);
        
        await this.ctx.device.queue.onSubmittedWorkDone();
      }
      console.debug(
        `[TerrainManager] Applied hydraulic erosion, total iterations: ${hydraulicTotal}`
      );
    }
    
    // Apply thermal erosion
    if (wantThermal) {
      const thermalTotal = genConfig.thermalIterations;
      const thermalBatch = Math.min(5, thermalTotal);
      
      for (let i = 0; i < thermalTotal; i += thermalBatch) {
        const batch = Math.min(thermalBatch, thermalTotal - i);
        this.erosionSimulator!.applyThermalErosion(batch, genConfig.thermalParams);
        
        const progress = 60 + (i / thermalTotal) * 20;
        progressCallback?.(`Thermal erosion: ${i + batch}/${thermalTotal}`, progress);
        
        await this.ctx.device.queue.onSubmittedWorkDone();
      }
      console.debug(
        `[TerrainManager] Applied thermal erosion, total iterations: ${thermalTotal}`
      );
    }
    
    // Get final eroded heightmap
    const erodedHeightmap = this.erosionSimulator!.getResultHeightmap();
    if (erodedHeightmap) {
      this.heightmap = erodedHeightmap;
    }
    
    // Store flow map for vegetation system
    this.flowMap = this.erosionSimulator!.getFlowMap();
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
    
    // Generate new terrain (regenerate always runs erosion)
    await this.generate(true, progressCallback);
  }
  
  /**
   * Pre-shadow vegetation preparation.
   * 
   * Runs CDLOD quadtree sync → GPU culling compute → ECS entity sync
   * for vegetation mesh instances. This must happen BEFORE the shadow pass
   * so that VegetationInstanceComponent entities have their GPU buffer
   * references (vegInstances, drawArgsBuffer) bound for
   * VariantRenderer.renderDepthOnly() to issue drawIndexedIndirect.
   * 
   * Called by GPUForwardPipeline.render() before any render passes execute.
   * The render() method below still calls the same functions, but the
   * vegetation manager's prepareFrame() + syncMeshEntities() are guarded
   * against double-execution within the same frame.
   * 
   * @param sceneVpMatrix - Scene camera view-projection matrix (for frustum culling)
   * @param cameraPosition - Scene camera world position
   */
  prepareVegetationForFrame(
    sceneVpMatrix: Float32Array,
    cameraPosition: [number, number, number],
  ): void {
    if (!this.vegetationManager?.isEnabled()) return;
    if (!this.renderer) return;

    // Sync vegetation tiles with CDLOD quadtree selection
    const lastSelection = this.renderer.getLastSelection();
    if (lastSelection && lastSelection.nodes.length > 0) {
      this.vegetationManager.syncWithCDLODSelection(lastSelection.nodes);
    }

    // Run GPU culling compute passes (submits a command buffer)
    const needsRender = this.vegetationManager.prepareFrame(
      sceneVpMatrix,
      cameraPosition,
    );

    // Sync culled buffer refs into ECS entities so the shadow pass can find them
    if (needsRender) {
      this.vegetationManager.syncMeshEntities();
    }
  }

  /**
   * Render grass blade shadow depth pass into the vegetation shadow map.
   * 
   * Must be called AFTER prepareVegetationForFrame() and BEFORE the main
   * render pass. The shadow map is then available via getVegetationShadowMap()
   * for sampling by grass-blade.wgsl and cdlod.wgsl.
   * 
   * @param encoder - Command encoder to record into
   * @param lightDirection - Normalized sun direction
   * @param cameraPosition - Scene camera world position
   * @returns Number of shadow draw calls
   */
  renderGrassShadowPass(
    encoder: GPUCommandEncoder,
    lightDirection: [number, number, number],
    cameraPosition: [number, number, number],
  ): number {
    if (!this.vegetationManager?.isEnabled()) return 0;
    return this.vegetationManager.renderGrassShadowPass(encoder, lightDirection, cameraPosition);
  }

  /**
   * Get the vegetation shadow map for external sampling.
   * Returns null if no grass shadow casters exist.
   */
  getVegetationShadowMap(): VegetationShadowMap | null {
    return this.vegetationManager?.getVegetationShadowMap() ?? null;
  }

  /**
   * Render the terrain
   */
  render(
    passEncoder: GPURenderPassEncoder,
    params: Omit<CDLODRenderParams, 'heightmapTexture' | 'normalMapTexture' | 'terrainSize' | 'heightScale' | 'island'>
  ): number {
    if (!this.renderer) {
      console.warn('TerrainManager not initialized');
      return 0;
    }
    
    const islandConfig = this.config.islandConfig || createDefaultIslandConfig();

    let drawCalls = this.renderer.render(passEncoder, {
      ...params,
      terrainSize: this.config.worldSize,
      heightScale: this.config.heightScale,
      heightmapTexture: this.heightmap || undefined,
      normalMapTexture: this.normalMap || undefined,
      biomeMaskTexture: this.biomeMask || undefined,
      vegetationDensityView: this.vegetationManager?.getDensityTextureView() ?? null,
      island: {
        enabled: islandConfig.enabled,
        seaFloorDepth: islandConfig.seaFloorDepth,
        maskTexture: this.islandMask,
      },
    });
    
    // Render vegetation on top of terrain (same render pass)
    if (this.vegetationManager?.isEnabled()) {
      const vpMatrix = params.viewProjectionMatrix as Float32Array;
      const sceneVpMatrix = params.sceneViewProjectionMatrix as Float32Array;
      const camPos = (params.sceneCameraPosition || params.cameraPosition) as Float32Array;
      const camPosArr: [number, number, number] = [camPos[0], camPos[1], camPos[2]];
      
      // Sync vegetation tiles with CDLOD quadtree selection
      // This gives vegetation the same frustum-culled, LOD-selected tiles as terrain
      const lastSelection = this.renderer?.getLastSelection();
      if (lastSelection && lastSelection.nodes.length > 0) {
        this.vegetationManager.syncWithCDLODSelection(lastSelection.nodes);
      }
      
      // Run GPU culling compute passes BEFORE the render pass uses drawIndirect
      const needsRender = this.vegetationManager.prepareFrame(
        sceneVpMatrix ? sceneVpMatrix : vpMatrix,
        camPosArr
      );
      if (needsRender) {
        // Update vegetation lighting from ECS LightComponent (includes weatherDimming).
        // Falls back to legacy updateLightFromScene if no World/LightComponent available.
        if (this._world) {
          const sunEntity = this._world.queryFirst('light');
          if (sunEntity) {
            const lightComp = sunEntity.getComponent<LightComponent>('light');
            if (lightComp && lightComp.lightType === 'directional' && lightComp.enabled) {
              this.vegetationManager.updateLightFromLightComponent(lightComp);
            }
          }
        }
        this.vegetationManager.setSceneEnvironment(params.sceneEnvironment ?? null);
        drawCalls += this.vegetationManager.render(passEncoder, vpMatrix, camPosArr);
      }
    }

    return drawCalls;
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
  
  /**
   * Set or clear the bounds overlay for terrain-conforming layer bounds visualization.
   * Pass null to disable the overlay.
   * Takes effect on next render frame.
   */
  setBoundsOverlay(bounds: { centerX: number; centerZ: number; halfExtentX: number; halfExtentZ: number; rotation: number; featherWidth: number } | null): void {
    this.renderer?.setBoundsOverlay(bounds);
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
  
  // ============ Biome Materials (Material Registry Integration) ============
  
  /**
   * Set a biome's material from the MaterialRegistry by ID.
   * Reads the MaterialDefinition, maps its texture slots to terrain texture types,
   * and loads all available textures (albedo, normal, ao, roughness) into the
   * biome texture arrays.
   * 
   * Also applies the material's albedo color as the biome fallback color.
   * 
   * @param biome Biome type (grass, rock, forest)
   * @param materialId Material registry ID (or null to clear)
   * @param tilingScale World-space tiling scale override (meters per tile)
   */
  async setBiomeMaterial(
    biome: BiomeType,
    materialId: string | null,
    tilingScale?: number
  ): Promise<void> {
    if (!this.renderer) {
      console.warn('[TerrainManager] Cannot set biome material - renderer not initialized');
      return;
    }

    const registry = getMaterialRegistry();
    
    if (!materialId) {
      // Clear all textures for this biome
      const allTypes: TextureType[] = ['albedo', 'normal', 'ao', 'roughness'];
      for (const type of allTypes) {
        this.renderer.clearBiomeTexture(biome, type);
      }
      console.log(`[TerrainManager] Cleared material for ${biome} biome`);
      return;
    }
    
    const material = registry.get(materialId);
    if (!material) {
      console.warn(`[TerrainManager] Material not found: ${materialId}`);
      return;
    }
    
    // Resolve texture paths from MaterialDefinition.textures.
    // The node editor's PBR node automatically syncs its texture paths
    // back to MaterialDefinition.textures via extractTextureRefs(),
    // so we only need to read from material.textures here.
    const resolvedPaths: Record<string, string | null> = {};
    
    // Map MaterialTextureSlot → terrain TextureType
    const slotMap: Array<{ slot: string; terrainType: TextureType }> = [
      { slot: 'baseColor', terrainType: 'albedo' },
      { slot: 'normal', terrainType: 'normal' },
      { slot: 'occlusion', terrainType: 'ao' },
      { slot: 'metallicRoughness', terrainType: 'roughness' },
      { slot: 'displacement', terrainType: 'displacement' },
      { slot: 'bump', terrainType: 'bump' },
    ];
    
    for (const { slot, terrainType } of slotMap) {
      const texRef = material.textures[slot as keyof typeof material.textures];
      if (texRef && texRef.type === 'asset' && texRef.assetPath) {
        resolvedPaths[terrainType] = texRef.assetPath;
      }
    }
    
    // Load resolved textures into biome arrays
    for (const { terrainType } of slotMap) {
      if (terrainType === 'bump') continue; // bump handled separately below
      const path = resolvedPaths[terrainType];
      if (path) {
        console.log(`[TerrainManager] Loading ${biome} ${terrainType} from material "${material.name}": ${path}`);
        await this.renderer.setBiomeTexture(biome, terrainType, path, tilingScale);
      } else {
        this.renderer.clearBiomeTexture(biome, terrainType);
      }
    }
    
    // Handle bump map: if no explicit normal map was loaded, use bump as a grayscale
    // normal alternative (the shader converts grayscale bump to tangent-space normals)
    if (!resolvedPaths['normal'] && resolvedPaths['bump']) {
      console.log(`[TerrainManager] Loading ${biome} bump→normal from material "${material.name}": ${resolvedPaths['bump']}`);
      await this.renderer.setBiomeTexture(biome, 'normal', resolvedPaths['bump']!, tilingScale);
    }
    
    // Apply material's albedo as the biome fallback color
    const colorKey = `${biome}Color` as 'grassColor' | 'rockColor' | 'forestColor';
    this.setMaterial({ [colorKey]: material.albedo as [number, number, number] });
    
    // Update tiling if provided
    if (tilingScale !== undefined) {
      this.renderer.setBiomeTiling(biome, tilingScale);
    }
    
    console.log(`[TerrainManager] Applied material "${material.name}" to ${biome} biome`);
  }
  
  // ============ Biome Textures (Low-Level) ============
  
  /**
   * Set biome texture from URL path (low-level, prefer setBiomeMaterial for registry integration)
   * Loads the texture and updates GPU bind group
   * 
   * @param biome Biome type (grass, rock, forest)
   * @param textureType Type of texture (albedo or normal)
   * @param url URL path to texture file
   * @param tilingScale World-space tiling scale (meters per tile)
   */
  async setBiomeTexture(
    biome: BiomeType,
    textureType: TextureType,
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
    biome: BiomeType,
    textureType: TextureType
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
    biome: 'grass' | 'rock' | 'forest',
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
    
    // Notify vegetation manager of updated biome mask
    this.vegetationManager?.updateTerrainData(undefined, this.biomeMask);
    
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
  
  /**
   * Get the vegetation manager for external control
   */
  getVegetationManager(): VegetationManager | null {
    return this.vegetationManager;
  }
  
  /**
   * Set the ECS World reference for vegetation variant mesh rendering.
   * Forwarded to VegetationManager → VegetationRenderer → VegetationMeshVariantRenderer.
   * Must be called once when the World is available (e.g., from Viewport or pipeline init).
   */
  setWorld(world: World): void {
    this._world = world;
    this.vegetationManager?.setWorld(world);
  }

  /**
   * Set the ShadowRendererGPU reference for shared depth-pass resources.
   * Passed through to the CDLODRendererGPU and VegetationManager.
   */
  setShadowRenderer(sr: ShadowRendererGPU): void {
    this.renderer?.setShadowRenderer(sr);
    // NOTE: Vegetation mesh shadow casting now handled by variant depth pipeline (ECS)
  }
  
  /**
   * Check if vegetation manager is available
   */
  hasVegetationManager(): boolean {
    return this.vegetationManager !== null;
  }
  
  // ============ Terrain Layers ============
  
  /**
   * Add a new terrain layer to the stack.
   * The layer order is automatically assigned to the end of the stack.
   * Call regenerate() after adding layers to apply them.
   *
   * @param type The layer type to create
   * @param overrides Optional overrides for the layer defaults
   * @returns The created layer
   */
  addLayer(type: TerrainLayerType, overrides?: Partial<TerrainLayer>): TerrainLayer {
    const order = this.layers.length;
    const layer = createTerrainLayer(type, { order, ...overrides });
    this.layers.push(layer);
    console.log(`[TerrainManager] Added ${type} layer: "${layer.name}" (id=${layer.id})`);
    return layer;
  }
  
  /**
   * Remove a layer by ID.
   * Invalidates the cached layer heightmap.
   */
  removeLayer(layerId: string): boolean {
    const idx = this.layers.findIndex(l => l.id === layerId);
    if (idx === -1) return false;
    
    this.layers.splice(idx, 1);
    this.layerCompositor?.invalidateLayer(layerId);
    
    // Reorder remaining layers
    this.layers.forEach((l, i) => { l.order = i; });
    
    console.log(`[TerrainManager] Removed layer: ${layerId}`);
    return true;
  }
  
  /**
   * Update a layer's parameters.
   * Invalidates the cached layer heightmap so it regenerates on next composite.
   */
  updateLayer(layerId: string, updates: Partial<TerrainLayer>): boolean {
    const layer = this.layers.find(l => l.id === layerId);
    if (!layer) return false;
    
    // Don't allow changing id or type
    const { id, type, ...safeUpdates } = updates as any;
    Object.assign(layer, safeUpdates);
    
    // Invalidate cached heightmap for this layer
    this.layerCompositor?.invalidateLayer(layerId);
    
    return true;
  }
  
  /**
   * Reorder a layer to a new position in the stack.
   */
  reorderLayer(layerId: string, newOrder: number): boolean {
    const idx = this.layers.findIndex(l => l.id === layerId);
    if (idx === -1) return false;
    
    const [layer] = this.layers.splice(idx, 1);
    const clampedOrder = Math.max(0, Math.min(newOrder, this.layers.length));
    this.layers.splice(clampedOrder, 0, layer);
    
    // Update order values
    this.layers.forEach((l, i) => { l.order = i; });
    
    return true;
  }
  
  /**
   * Get all layers (sorted by order).
   */
  getLayers(): ReadonlyArray<TerrainLayer> {
    return [...this.layers].sort((a, b) => a.order - b.order);
  }
  
  /**
   * Get a specific layer by ID.
   */
  getLayer(layerId: string): TerrainLayer | undefined {
    return this.layers.find(l => l.id === layerId);
  }
  
  /**
   * Get the number of layers.
   */
  getLayerCount(): number {
    return this.layers.length;
  }
  
  /**
   * Get the layer compositor (for advanced usage).
   */
  getLayerCompositor(): TerrainLayerCompositor | null {
    return this.layerCompositor;
  }
  
  /**
   * Get the erosion mask texture from the last composite run.
   * Values: 1.0 = fully erodable, 0.0 = protected by non-erodable layers.
   */
  getErosionMask(): UnifiedGPUTexture | null {
    return this.erosionMask;
  }
  
  /**
   * @deprecated Use generate(simulateErosion, progressCallback) instead.
   * Kept temporarily for backwards compatibility with callers that haven't migrated yet.
   */
  async generateWithLayers(
    progressCallback?: GenerationProgressCallback
  ): Promise<void> {
    return this.generate(false, progressCallback);
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    // Unregister shader from live editing
    unregisterWGSLShader('Terrain CDLOD');
    
    this.heightmapGenerator?.destroy();
    this.erosionSimulator?.destroy();
    this.layerCompositor?.destroy();
    this.renderer?.destroy();
    this.vegetationManager?.destroy();
    this.biomeMaskGenerator?.destroy();
    this.heightmap?.destroy();
    this.normalMap?.destroy();
    this.islandMask?.destroy();
    this.biomeMask?.destroy();
    // erosionMask is owned by layerCompositor — don't double-destroy
    
    this.heightmapGenerator = null;
    this.erosionSimulator = null;
    this.layerCompositor = null;
    this.layers = [];
    this.erosionMask = null;
    this.renderer = null;
    this.vegetationManager = null;
    this.biomeMaskGenerator = null;
    this.heightmap = null;
    this.normalMap = null;
    this.islandMask = null;
    this.biomeMask = null;
    this.isInitialized = false;
  }
}
