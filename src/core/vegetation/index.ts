/**
 * Vegetation System
 * 
 * GPU-based vegetation generation and rendering system for terrain.
 * 
 * Currently implements:
 * - BiomeMaskGenerator: Creates biome probability textures from terrain data
 * 
 * Future additions:
 * - VegetationSpawner: GPU compute for instance position generation
 * - VegetationRenderer: Instanced billboard/mesh rendering
 * - PlantRegistry: Plant type definitions and management
 */

// Types
export type { BiomeParams, BiomeParamsGPU, BiomeChannel } from './types';
export {
  createDefaultBiomeParams,
  biomeParamsToGPU,
  BIOME_PARAMS_GPU_SIZE,
  BIOME_DISPLAY_COLORS,
} from './types';

// Generators
export { BiomeMaskGenerator } from './BiomeMaskGenerator';
