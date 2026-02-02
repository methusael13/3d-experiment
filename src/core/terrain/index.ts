/**
 * Terrain module - CDLOD terrain rendering system
 * 
 * Provides quadtree-based LOD selection and rendering for large-scale terrains.
 */

export {
  TerrainQuadtree,
  TerrainNode,
  nodesToRenderData,
  createDefaultQuadtreeConfig,
  type AABB,
  type Frustum,
  type SelectionResult,
  type QuadtreeConfig,
  type NodeRenderData,
} from './TerrainQuadtree';

export {
  CDLODRenderer,
  createDefaultCDLODConfig,
  type CDLODRendererConfig,
} from './CDLODRenderer';

// WebGPU-based CDLOD renderer
export {
  CDLODRendererGPU,
  createDefaultCDLODGPUConfig,
  createDefaultTerrainMaterial,
  type CDLODGPUConfig,
  type TerrainMaterial,
  type CDLODRenderParams,
} from './CDLODRendererGPU';

// GPU-based heightmap generation
export {
  HeightmapGenerator,
  createDefaultNoiseParams,
  type NoiseParams,
  type NormalMapParams
} from './HeightmapGenerator';

// GPU-based erosion simulation
export {
  ErosionSimulator,
  createDefaultHydraulicParams,
  createDefaultThermalParams,
  type HydraulicErosionParams,
  type ThermalErosionParams,
} from './ErosionSimulator';

// High-level terrain manager
export {
  TerrainManager,
  createDefaultGenerationConfig,
  createDefaultTerrainManagerConfig,
  type TerrainGenerationConfig,
  type TerrainManagerConfig,
  type GenerationProgressCallback,
} from './TerrainManager';

// Terrain tile caching
export {
  TerrainTileCache,
  type TileKey,
  type TileData,
  type CacheStats,
} from './TerrainTileCache';

// Terrain streaming (on-demand tile generation)
export {
  TerrainStreamer,
  createDefaultStreamerConfig,
  type TerrainStreamerConfig,
  type StreamerStats,
} from './TerrainStreamer';

// GPU-driven frustum culling
export {
  GPUCullingPipeline,
  createDefaultCullingConfig,
  type GPUCullingConfig,
} from './GPUCullingPipeline';

// Heightmap mipmap generation for LOD
export {
  HeightmapMipmapGenerator,
  createDefaultMipmapConfig,
  type HeightmapMipChain,
  type MipmapConfig,
} from './HeightmapMipmapGenerator';
