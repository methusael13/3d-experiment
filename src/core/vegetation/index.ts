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

// Generators
export { BiomeMaskGenerator } from './BiomeMaskGenerator';

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
