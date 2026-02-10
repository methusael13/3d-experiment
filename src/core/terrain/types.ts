/**
 * Terrain Types
 * 
 * Type definitions for terrain rendering including biome texture splatting.
 */

// ============================================================================
// Biome Texture Types
// ============================================================================

/** Biome identifiers matching MaterialParams color fields */
export type BiomeType = 'grass' | 'rock' | 'snow' | 'dirt' | 'beach';

/**
 * Reference to a texture asset with its map paths.
 * Derived from Quixel-style asset JSON metadata.
 */
export interface BiomeTextureSet {
  /** Asset library ID */
  assetId: string;
  
  /** Display name */
  assetName: string;
  
  /** Base folder path for the asset */
  basePath: string;
  
  /** Physical size in meters (from Quixel JSON, e.g., 2 = 2x2m) */
  physicalSize: number;
  
  /** User-adjustable tiling scale multiplier (default 1.0 = use physicalSize) */
  tilingScale: number;
  
  /** Paths to texture maps (relative to basePath or absolute) */
  maps: {
    /** Albedo/basecolor texture path */
    basecolor?: string;
    
    /** Normal map texture path */
    normal?: string;
    
    /** Roughness map texture path (future use) */
    roughness?: string;
    
    /** AO map texture path (future use) */
    ao?: string;
  };
}

/**
 * Material parameters for terrain rendering.
 * Extends existing color-based params with optional textures.
 */
export interface TerrainMaterialParams {
  // Height/slope thresholds
  snowLine: number;
  rockLine: number;
  maxGrassSlope: number;
  beachMaxHeight: number;
  beachMaxSlope: number;
  
  // Fallback colors (RGB 0-1)
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  snowColor: [number, number, number];
  dirtColor: [number, number, number];
  beachColor: [number, number, number];
  
  // Optional texture sets per biome
  grassTexture?: BiomeTextureSet;
  rockTexture?: BiomeTextureSet;
  snowTexture?: BiomeTextureSet;
  dirtTexture?: BiomeTextureSet;
  beachTexture?: BiomeTextureSet;
}

/**
 * GPU uniform data for biome texture parameters.
 * Packed for texture array sampling (80 bytes total = 5 vec4f).
 * 
 * Matches shader struct BiomeTextureParams:
 * - albedoEnabled: vec4f [grass, rock, snow, dirt]
 * - normalEnabled: vec4f [grass, rock, snow, dirt]
 * - beachFlags: vec4f [albedoEnabled, normalEnabled, pad, pad]
 * - tilingScales: vec4f [grass, rock, snow, dirt]
 * - beachTiling: vec4f [beach, pad, pad, pad]
 */
export interface BiomeTextureUniformData {
  // Albedo enable flags (1.0 = enabled, 0.0 = disabled) - first 4 biomes
  albedoEnabled: [number, number, number, number]; // [grass, rock, snow, dirt]
  
  // Normal map enable flags - first 4 biomes
  normalEnabled: [number, number, number, number]; // [grass, rock, snow, dirt]
  
  // Beach flags (5th biome) - [albedoEnabled, normalEnabled, pad, pad]
  beachFlags: [number, number, number, number];
  
  // Tiling scales for first 4 biomes (world units per texture tile)
  tilingScales: [number, number, number, number]; // [grass, rock, snow, dirt]
  
  // Beach tiling - [beach, pad, pad, pad]
  beachTiling: [number, number, number, number];
}

/**
 * Default terrain material parameters
 */
export const DEFAULT_TERRAIN_MATERIAL: TerrainMaterialParams = {
  snowLine: 0.8,
  rockLine: 0.6,
  maxGrassSlope: 0.4,
  beachMaxHeight: 0.1,
  beachMaxSlope: 0.3,
  
  grassColor: [0.2, 0.4, 0.1],
  rockColor: [0.4, 0.35, 0.3],
  snowColor: [0.95, 0.95, 0.97],
  dirtColor: [0.35, 0.25, 0.15],
  beachColor: [0.76, 0.7, 0.5],
};

/**
 * Helper to get tiling scale from texture set, defaulting to 2.0m
 */
function getTilingScale(texture?: BiomeTextureSet): number {
  return texture ? texture.physicalSize * texture.tilingScale : 2.0;
}

/**
 * Helper to create BiomeTextureUniformData from material params
 */
export function createBiomeTextureUniform(params: TerrainMaterialParams): BiomeTextureUniformData {
  return {
    // Albedo enable flags for first 4 biomes [grass, rock, snow, dirt]
    albedoEnabled: [
      params.grassTexture ? 1.0 : 0.0,
      params.rockTexture ? 1.0 : 0.0,
      params.snowTexture ? 1.0 : 0.0,
      params.dirtTexture ? 1.0 : 0.0,
    ],
    
    // Normal map enable flags for first 4 biomes [grass, rock, snow, dirt]
    normalEnabled: [
      params.grassTexture?.maps.normal ? 1.0 : 0.0,
      params.rockTexture?.maps.normal ? 1.0 : 0.0,
      params.snowTexture?.maps.normal ? 1.0 : 0.0,
      params.dirtTexture?.maps.normal ? 1.0 : 0.0,
    ],
    
    // Beach flags [albedoEnabled, normalEnabled, pad, pad]
    beachFlags: [
      params.beachTexture ? 1.0 : 0.0,
      params.beachTexture?.maps.normal ? 1.0 : 0.0,
      0, 0,
    ],
    
    // Tiling scales for first 4 biomes [grass, rock, snow, dirt]
    tilingScales: [
      getTilingScale(params.grassTexture),
      getTilingScale(params.rockTexture),
      getTilingScale(params.snowTexture),
      getTilingScale(params.dirtTexture),
    ],
    
    // Beach tiling [beach, pad, pad, pad]
    beachTiling: [
      getTilingScale(params.beachTexture),
      0, 0, 0,
    ],
  };
}

/**
 * Convert BiomeTextureUniformData to Float32Array for GPU upload
 * Layout matches shader struct BiomeTextureParams (80 bytes = 20 floats)
 */
export function biomeTextureUniformToFloat32Array(data: BiomeTextureUniformData): Float32Array {
  return new Float32Array([
    // albedoEnabled: vec4f [grass, rock, snow, dirt]
    ...data.albedoEnabled,
    // normalEnabled: vec4f [grass, rock, snow, dirt]  
    ...data.normalEnabled,
    // beachFlags: vec4f [albedoEnabled, normalEnabled, pad, pad]
    ...data.beachFlags,
    // tilingScales: vec4f [grass, rock, snow, dirt]
    ...data.tilingScales,
    // beachTiling: vec4f [beach, pad, pad, pad]
    ...data.beachTiling,
  ]);
}
