/**
 * Terrain Types
 * 
 * Type definitions for terrain rendering including biome texture splatting.
 */

// ============================================================================
// Biome Texture Types
// ============================================================================

/** Biome identifiers matching shader constants (3 biomes from biome mask) */
export type BiomeType = 'grass' | 'rock' | 'forest';

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
 * Uses biome mask texture for weight calculation (grass=R, rock=G, forest=B).
 * Extends existing color-based params with optional textures.
 */
export interface TerrainMaterialParams {
  // Fallback colors (RGB 0-1) for each biome
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  forestColor: [number, number, number];
  
  // Optional texture sets per biome (grass, rock, forest)
  grassTexture?: BiomeTextureSet;
  rockTexture?: BiomeTextureSet;
  forestTexture?: BiomeTextureSet;
  
  // Legacy fields kept for backwards compatibility with Material uniform struct
  // These are no longer used for biome weight calculation (biome mask handles that)
  snowLine?: number;
  rockLine?: number;
  maxGrassSlope?: number;
  beachMaxHeight?: number;
  beachMaxSlope?: number;
  snowColor?: [number, number, number];
  dirtColor?: [number, number, number];  // Alias for forestColor
  beachColor?: [number, number, number];
}

/**
 * GPU uniform data for biome texture parameters.
 * Packed for texture array sampling (48 bytes total = 3 vec4f).
 * 
 * Matches shader struct BiomeTextureParams (simplified for 3 biomes):
 * - albedoEnabled: vec4f [grass, rock, forest, unused]
 * - normalEnabled: vec4f [grass, rock, forest, unused]
 * - tilingScales: vec4f [grass, rock, forest, unused]
 */
export interface BiomeTextureUniformData {
  // Albedo enable flags (1.0 = enabled, 0.0 = disabled)
  albedoEnabled: [number, number, number, number]; // [grass, rock, forest, unused]
  
  // Normal map enable flags
  normalEnabled: [number, number, number, number]; // [grass, rock, forest, unused]
  
  // Tiling scales for biomes (world units per texture tile)
  tilingScales: [number, number, number, number]; // [grass, rock, forest, unused]
}

/**
 * Default terrain material parameters
 */
export const DEFAULT_TERRAIN_MATERIAL: TerrainMaterialParams = {
  grassColor: [0.2, 0.4, 0.1],
  rockColor: [0.4, 0.35, 0.3],
  forestColor: [0.35, 0.25, 0.15],
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
    // Albedo enable flags [grass, rock, forest, unused]
    albedoEnabled: [
      params.grassTexture ? 1.0 : 0.0,
      params.rockTexture ? 1.0 : 0.0,
      params.forestTexture ? 1.0 : 0.0,
      0.0,  // unused
    ],
    
    // Normal map enable flags [grass, rock, forest, unused]
    normalEnabled: [
      params.grassTexture?.maps.normal ? 1.0 : 0.0,
      params.rockTexture?.maps.normal ? 1.0 : 0.0,
      params.forestTexture?.maps.normal ? 1.0 : 0.0,
      0.0,  // unused
    ],
    
    // Tiling scales [grass, rock, forest, unused]
    tilingScales: [
      getTilingScale(params.grassTexture),
      getTilingScale(params.rockTexture),
      getTilingScale(params.forestTexture),
      0.0,  // unused
    ],
  };
}

/**
 * Convert BiomeTextureUniformData to Float32Array for GPU upload
 * Layout matches shader struct BiomeTextureParams (48 bytes = 12 floats)
 */
export function biomeTextureUniformToFloat32Array(data: BiomeTextureUniformData): Float32Array {
  return new Float32Array([
    // albedoEnabled: vec4f [grass, rock, forest, unused]
    ...data.albedoEnabled,
    // normalEnabled: vec4f [grass, rock, forest, unused]  
    ...data.normalEnabled,
    // tilingScales: vec4f [grass, rock, forest, unused]
    ...data.tilingScales,
  ]);
}
