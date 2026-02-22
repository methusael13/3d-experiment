/**
 * Vegetation System
 * 
 * GPU-based vegetation generation and rendering system for terrain.
 * 
 * Currently implements:
 * - BiomeMaskGenerator: Creates biome probability textures from terrain data
 * - PlantRegistry: Plant type definitions and management
 * - AtlasRegionDetector: Detects sprite regions from opacity maps
 * 
 * Future additions:
 * - VegetationSpawner: GPU compute for instance position generation
 * - VegetationRenderer: Instanced billboard/mesh rendering
 */

// Types
export type {
  BiomeParams,
  BiomeParamsGPU,
  BiomeChannel,
  PlantType,
  RenderMode,
  ModelReference,
  AtlasRegion,
  AtlasRegionNormalized,
  AtlasReference,
  VegetationConfig,
  WindParams,
  BiomePlantConfig,
} from './types';
export {
  createDefaultBiomeParams,
  biomeParamsToGPU,
  BIOME_PARAMS_GPU_SIZE,
  BIOME_DISPLAY_COLORS,
  createDefaultPlantType,
  createDefaultVegetationConfig,
  createDefaultWindParams,
  DEFAULT_BIOME_CONFIGS,
  GRASSLAND_PLANT_PRESETS,
  FOREST_PLANT_PRESETS,
} from './types';

// Manager
export { VegetationManager } from './VegetationManager';

// Generators
export { BiomeMaskGenerator } from './BiomeMaskGenerator';

// Spawner
export { VegetationSpawner } from './VegetationSpawner';
export type { SpawnRequest, SpawnResult } from './VegetationSpawner';

// Renderers
export { VegetationRenderer } from './VegetationRenderer';
export type { VegetationTileData, PlantTileData } from './VegetationRenderer';
export { VegetationBillboardRenderer } from './VegetationBillboardRenderer';
export { VegetationMeshRenderer } from './VegetationMeshRenderer';
export type { VegetationMesh, VegetationSubMesh } from './VegetationMeshRenderer';

// Tile Cache
export { VegetationTileCache, DEFAULT_LOD_DENSITIES } from './VegetationTileCache';
export type { LODDensityConfig, TileCacheStats } from './VegetationTileCache';

// Culling Pipeline
export { VegetationCullingPipeline } from './VegetationCullingPipeline';
export type { CullResult } from './VegetationCullingPipeline';

// Plant Registry
export { PlantRegistry } from './PlantRegistry';
export type {
  PlantRegistryEvent,
  PlantRegistryListener,
  PlantRegistryData,
  PlantRegistryStats,
} from './PlantRegistry';

// Atlas Region Detection
export { AtlasRegionDetector, getAtlasRegionDetector, detectAtlasRegions } from './AtlasRegionDetector';
export type { DetectionConfig, DetectionResult } from './AtlasRegionDetector';
export { DEFAULT_DETECTION_CONFIG } from './AtlasRegionDetector';
