/**
 * Terrain Types
 * 
 * Type definitions for terrain rendering including biome texture splatting
 * and layer-based heightmap compositing.
 */

import { NoiseParams, createDefaultNoiseParams } from './HeightmapGenerator';

// ============================================================================
// Terrain Layer System Types
// ============================================================================

/**
 * Oriented rectangular bounds for a terrain layer in world XZ space.
 * Used to confine a layer's effect to a spatial region with feathered edges.
 */
export interface TerrainLayerBounds {
  /** World center X position */
  centerX: number;
  /** World center Z position */
  centerZ: number;
  /** Half-width along the local X axis (before rotation) */
  halfExtentX: number;
  /** Half-width along the local Z axis (before rotation) */
  halfExtentZ: number;
  /** Rotation angle in degrees around the Y axis */
  rotation: number;
  /** Soft-edge falloff distance in world units (0 = hard edge) */
  featherWidth: number;
}

/**
 * Height/slope-based blend curve modifier for terrain layers.
 * Modulates the layer's blendFactor based on the base heightmap's
 * normalized height and/or slope at each texel.
 */
export interface TerrainLayerBlendCurve {
  // ---- Height-based modulation ----
  /** Enable height-based blend modulation */
  heightEnabled: boolean;
  /** Normalized height where blend starts ramping up (e.g., 0.2) */
  heightMin: number;
  /** Normalized height where blend reaches full strength (e.g., 0.6) */
  heightMax: number;
  /** If true, invert: blend is stronger at LOW elevations */
  heightInvert: boolean;

  // ---- Slope-based modulation ----
  /** Enable slope-based blend modulation */
  slopeEnabled: boolean;
  /** Slope value (0=flat, 1=vertical) where blend starts ramping up */
  slopeMin: number;
  /** Slope value where blend reaches full strength */
  slopeMax: number;
  /** If true, invert: blend is stronger on FLAT areas */
  slopeInvert: boolean;
}

/** Default blend curve (disabled — no height/slope modulation) */
export function createDefaultBlendCurve(): TerrainLayerBlendCurve {
  return {
    heightEnabled: false,
    heightMin: 0.0,
    heightMax: 0.5,
    heightInvert: false,
    slopeEnabled: false,
    slopeMin: 0.0,
    slopeMax: 0.5,
    slopeInvert: false,
  };
}

/** Available terrain layer types */
export type TerrainLayerType = 'noise' | 'rock' | 'island' | 'flatten';

/** Blend modes for compositing layers onto the heightmap */
export type TerrainBlendMode = 'additive' | 'multiply' | 'replace' | 'max' | 'min';

/**
 * Rock layer parameters — procedural rock formations using ridged multi-fractal
 * noise with sedimentary strata banding and exponential bias.
 *
 * Instead of the old terrace/stepping approach, this produces jagged stratified
 * ridges and sharp protrusions resembling real rock outcrops:
 * - Ridged fBm base creates sharp peak/valley shapes
 * - Power sharpening forces noise into thin ridges
 * - Strata banding adds horizontal sedimentary layering
 * - Slope-dependent detail adds micro-cracks only on steep faces
 * - Exponential bias deepens cracks and exaggerates peaks
 */
export interface RockLayerParams {
  /** Base noise field for the rock formation shape (ridgeWeight should be high, e.g. 0.8) */
  noise: NoiseParams;
  /** Power exponent for sharpening ridges — higher = thinner, sharper peaks (1.0–5.0) */
  rockSharpness: number;
  /** Frequency of horizontal sedimentary banding via sin(height * freq) (5.0–50.0) */
  strataFrequency: number;
  /** How much strata banding modulates the protrusions (0.0–1.0) */
  strataStrength: number;
  /** Exponential bias: sign(H)*|H|^exp — deepens cracks, exaggerates peaks (1.0–3.0) */
  ridgeExponent: number;
  /** Frequency multiplier for high-frequency ridged detail overlay (2.0–20.0) */
  detailFrequency: number;
  /** Amplitude of the slope-dependent micro-detail layer (0.0–1.0) */
  detailStrength: number;
  /** Overall height multiplier for the rock layer output */
  heightScale: number;
}

/**
 * Island layer parameters — refactored from the legacy island mask system.
 * Generates a coastline-shaped mask that modulates the terrain height.
 */
export interface IslandLayerParams {
  /** Random seed for coastline variation */
  seed: number;
  /** Normalized island radius (0.3-0.5 typical) */
  islandRadius: number;
  /** Coastline noise frequency (3-8 typical) */
  coastNoiseScale: number;
  /** Coastline noise amplitude (0.1-0.3 typical) */
  coastNoiseStrength: number;
  /** Width of coast-to-seafloor transition (0.05-0.5 typical) */
  coastFalloff: number;
  /** Ocean floor depth below water level (negative, e.g. -0.3) */
  seaFloorDepth: number;
}

/**
 * Flatten layer parameters — forces terrain to a target height within bounds.
 * Useful for building pads, roads, or clearings.
 */
export interface FlattenLayerParams {
  /** Normalized target height to flatten to (in [-0.5, 0.5] range) */
  targetHeight: number;
}

/**
 * A single terrain layer in the compositing stack.
 * Each layer generates its own heightmap texture that is blended onto
 * the base heightmap by the TerrainLayerCompositor.
 */
export interface TerrainLayer {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Layer type determines which params and generator are used */
  type: TerrainLayerType;
  /** Whether this layer is active in the composite */
  enabled: boolean;
  /** Stack order — lower values are applied first */
  order: number;

  // ---- Blend ----
  /** How much this layer contributes (0 = invisible, 1 = full strength) */
  blendFactor: number;
  /** How the layer height is composited with the current accumulated height */
  blendMode: TerrainBlendMode;

  // ---- Spatial bounds ----
  /** Oriented rect bounds in world XZ, or null for global (full terrain) */
  bounds: TerrainLayerBounds | null;

  // ---- Erosion interaction ----
  /** If false, the erosion simulator will not erode regions influenced by this layer */
  erodable: boolean;

  // ---- Blend curve (height/slope modulation) ----
  /** Optional height/slope-based blend modulation. If undefined, no modulation is applied. */
  blendCurve?: TerrainLayerBlendCurve;

  // ---- Per-type params (only the matching type field is used) ----
  noiseParams?: NoiseParams;
  rockParams?: RockLayerParams;
  islandParams?: IslandLayerParams;
  flattenParams?: FlattenLayerParams;
}

// ============================================================================
// Layer Defaults & Helpers
// ============================================================================

/** Default rock layer parameters */
export function createDefaultRockLayerParams(): RockLayerParams {
  return {
    noise: {
      ...createDefaultNoiseParams(),
      scaleX: 4,
      scaleY: 4,
      octaves: 5,
      persistence: 0.5,
      lacunarity: 2.2,
      warpStrength: 0.4,
      warpScale: 2.0,
      warpOctaves: 3,
      ridgeWeight: 0.8,      // Heavily ridged base — key for jagged shapes
      rotateOctaves: true,
      octaveRotation: 37.5,
    },
    rockSharpness: 2.5,       // Power sharpening — thin, sharp ridges
    strataFrequency: 20.0,    // Horizontal sedimentary banding
    strataStrength: 0.15,     // Subtle strata modulation
    ridgeExponent: 1.5,       // Exponential bias — deeper cracks, jutting peaks
    detailFrequency: 8.0,     // High-freq ridged overlay
    detailStrength: 0.3,      // Moderate micro-crack detail
    heightScale: 1.0,
  };
}

/** Default island layer parameters */
export function createDefaultIslandLayerParams(): IslandLayerParams {
  return {
    seed: 23860,
    islandRadius: 0.4,
    coastNoiseScale: 5,
    coastNoiseStrength: 0.2,
    coastFalloff: 0.3,
    seaFloorDepth: -0.3,
  };
}

/** Default flatten layer parameters */
export function createDefaultFlattenLayerParams(): FlattenLayerParams {
  return {
    targetHeight: 0.0,
  };
}

/** Auto-incrementing counter for unique layer IDs */
let layerIdCounter = 0;

/** Generate a unique layer ID */
export function generateLayerId(): string {
  return `layer_${Date.now()}_${layerIdCounter++}`;
}

/**
 * Create a new terrain layer with sensible defaults for the given type.
 */
export function createTerrainLayer(
  type: TerrainLayerType,
  overrides?: Partial<TerrainLayer>
): TerrainLayer {
  const base: TerrainLayer = {
    id: generateLayerId(),
    name: `${type.charAt(0).toUpperCase() + type.slice(1)} Layer`,
    type,
    enabled: true,
    order: 0,
    blendFactor: 1.0,
    blendMode: type === 'island' ? 'multiply' : 'additive',
    bounds: null,
    erodable: type !== 'rock', // Rock layers are non-erodable by default
  };

  // Attach default type-specific params
  switch (type) {
    case 'noise':
      base.noiseParams = createDefaultNoiseParams();
      break;
    case 'rock':
      base.rockParams = createDefaultRockLayerParams();
      break;
    case 'island':
      base.islandParams = createDefaultIslandLayerParams();
      break;
    case 'flatten':
      base.flattenParams = createDefaultFlattenLayerParams();
      break;
  }

  return { ...base, ...overrides };
}

/**
 * Maximum number of layers the compositor can handle in a single dispatch.
 * Limited by the number of texture bindings we can pass to the compute shader.
 * Layers beyond this count are processed in multiple passes.
 */
export const MAX_COMPOSITOR_LAYERS_PER_PASS = 8;

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
 * Packed for texture array sampling (64 bytes total = 4 vec4f).
 * 
 * Matches shader struct BiomeTextureParams (simplified for 3 biomes):
 * - albedoEnabled: vec4f [grass, rock, forest, unused]
 * - normalEnabled: vec4f [grass, rock, forest, unused]
 * - aoEnabled: vec4f [grass, rock, forest, unused]
 * - tilingScales: vec4f [grass, rock, forest, unused]
 */
export interface BiomeTextureUniformData {
  // Albedo enable flags (1.0 = enabled, 0.0 = disabled)
  albedoEnabled: [number, number, number, number]; // [grass, rock, forest, unused]
  
  // Normal map enable flags
  normalEnabled: [number, number, number, number]; // [grass, rock, forest, unused]
  
  // AO map enable flags
  aoEnabled: [number, number, number, number]; // [grass, rock, forest, unused]
  
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
    
    // AO map enable flags [grass, rock, forest, unused]
    aoEnabled: [
      params.grassTexture?.maps.ao ? 1.0 : 0.0,
      params.rockTexture?.maps.ao ? 1.0 : 0.0,
      params.forestTexture?.maps.ao ? 1.0 : 0.0,
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
 * Layout matches shader struct BiomeTextureParams (64 bytes = 16 floats)
 */
export function biomeTextureUniformToFloat32Array(data: BiomeTextureUniformData): Float32Array {
  return new Float32Array([
    // albedoEnabled: vec4f [grass, rock, forest, unused]
    ...data.albedoEnabled,
    // normalEnabled: vec4f [grass, rock, forest, unused]  
    ...data.normalEnabled,
    // aoEnabled: vec4f [grass, rock, forest, unused]
    ...data.aoEnabled,
    // tilingScales: vec4f [grass, rock, forest, unused]
    ...data.tilingScales,
  ]);
}
