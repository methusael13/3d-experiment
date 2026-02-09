/**
 * Vegetation System Types
 * 
 * Central type definitions for the vegetation system including
 * biome parameters, plant types, and configuration.
 */

/**
 * Parameters controlling biome mask generation from terrain data.
 * These determine how heightmap, slope, and water flow influence
 * which biome types appear at each location.
 */
export interface BiomeParams {
  // Influence weights
  heightInfluence: number;      // How much height affects biome (0-1)
  slopeInfluence: number;       // How much slope affects biome (0-1)
  flowInfluence: number;        // How much water flow affects biome (0-1)
  
  // Random variation
  seed: number;                 // Noise variation seed
  
  // Grassland biome thresholds (R channel)
  grassHeightMin: number;       // Min normalized height for grass
  grassHeightMax: number;       // Max normalized height for grass
  grassSlopeMax: number;        // Max slope for grass (steeper = less grass)
  
  // Rock/cliff biome thresholds (G channel)
  rockSlopeMin: number;         // Min slope for rock appearance
  
  // Forest edge biome thresholds (B channel)
  forestFlowMin: number;        // Min flow for forest
  forestFlowMax: number;        // Max flow (above = flooded, no forest)
  forestHeightMin: number;      // Min height for forest
  forestHeightMax: number;      // Max height for forest
  
  // Global modifiers
  defaultFlowValue: number;     // Default flow when no flow map (0-1)
}

/**
 * Creates default biome parameters suitable for grassland terrain.
 */
export function createDefaultBiomeParams(): BiomeParams {
  return {
    // Influence weights
    heightInfluence: 1.0,
    slopeInfluence: 1.0,
    flowInfluence: 1.0,
    
    // Random variation
    seed: 12345,
    
    // Grassland (R channel): moderate height, low slope, optimal flow
    grassHeightMin: 0.05,       // Just above sea level
    grassHeightMax: 0.6,        // Below snow line
    grassSlopeMax: 0.5,         // Not too steep
    
    // Rock (G channel): steep slopes
    rockSlopeMin: 0.4,          // Moderate to steep slopes
    
    // Forest (B channel): good water, moderate terrain
    forestFlowMin: 0.25,        // Needs decent water flow
    forestFlowMax: 0.85,        // Not flooded
    forestHeightMin: 0.1,       // Above beach
    forestHeightMax: 0.5,       // Not too high
    
    // Global
    defaultFlowValue: 0.5,      // Default when no flow map
  };
}

/**
 * GPU-compatible uniform structure for biome mask shader.
 * Must match the struct layout in biome-mask.wgsl.
 * 
 * Total size: 64 bytes (16 floats × 4 bytes)
 */
export interface BiomeParamsGPU {
  heightInfluence: number;
  slopeInfluence: number;
  flowInfluence: number;
  seed: number;
  
  grassHeightMin: number;
  grassHeightMax: number;
  grassSlopeMax: number;
  rockSlopeMin: number;
  
  forestFlowMin: number;
  forestFlowMax: number;
  forestHeightMin: number;
  forestHeightMax: number;
  
  defaultFlowValue: number;
  _padding1: number;
  _padding2: number;
  _padding3: number;
}

/**
 * Convert BiomeParams to GPU-compatible format with padding.
 */
export function biomeParamsToGPU(params: BiomeParams): BiomeParamsGPU {
  return {
    heightInfluence: params.heightInfluence,
    slopeInfluence: params.slopeInfluence,
    flowInfluence: params.flowInfluence,
    seed: params.seed,
    
    grassHeightMin: params.grassHeightMin,
    grassHeightMax: params.grassHeightMax,
    grassSlopeMax: params.grassSlopeMax,
    rockSlopeMin: params.rockSlopeMin,
    
    forestFlowMin: params.forestFlowMin,
    forestFlowMax: params.forestFlowMax,
    forestHeightMin: params.forestHeightMin,
    forestHeightMax: params.forestHeightMax,
    
    defaultFlowValue: params.defaultFlowValue,
    _padding1: 0,
    _padding2: 0,
    _padding3: 0,
  };
}

/**
 * Size of BiomeParamsGPU in bytes for uniform buffer allocation.
 */
export const BIOME_PARAMS_GPU_SIZE = 64; // 16 floats × 4 bytes

/**
 * Biome channel mapping for vegetation spawning.
 */
export type BiomeChannel = 'r' | 'g' | 'b' | 'a';

/**
 * Display colors for biome visualization.
 */
export const BIOME_DISPLAY_COLORS = {
  grassland: [0.3, 0.7, 0.2] as const,  // Green
  rock: [0.5, 0.5, 0.5] as const,       // Gray
  forest: [0.1, 0.4, 0.15] as const,    // Dark green
  reserved: [0.0, 0.0, 0.0] as const,   // Black (unused)
} as const;
