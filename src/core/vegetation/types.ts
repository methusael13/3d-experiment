/**
 * Vegetation System Types
 * 
 * Central type definitions for the vegetation system including
 * biome parameters, plant types, and configuration.
 */

import type { UnifiedGPUTexture } from '../gpu';

// ==================== Vegetation Mesh Types ====================

/**
 * A vegetation mesh loaded from a GLTF model, containing one or more sub-meshes.
 * Previously in VegetationMeshRenderer.ts — moved here for shared access.
 */
export interface VegetationMesh {
  id: string;
  name: string;
  subMeshes: VegetationSubMesh[];
}

/**
 * A single sub-mesh within a vegetation mesh.
 */
export interface VegetationSubMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  // PBR textures (all optional — unset channels use material uniform values)
  baseColorTexture: UnifiedGPUTexture | null;
  normalTexture: UnifiedGPUTexture | null;
  metallicRoughnessTexture: UnifiedGPUTexture | null;
  occlusionTexture: UnifiedGPUTexture | null;
  emissiveTexture: UnifiedGPUTexture | null;
  windMultiplier: number;
}

// ==================== Render Mode ====================

/**
 * How a plant type should be rendered.
 * - 'billboard': Always rendered as camera-facing quads (atlas or billboard texture)
 * - 'mesh': Always rendered as 3D instanced mesh (GLTF model)
 * - 'hybrid': 3D mesh at close range, billboard at far range (distance-based transition)
 * - 'grass-blade': Procedural Bézier-curve grass blades
 * - 'procedural-rock': GPU-generated deformed icosphere rock meshes (per-plant seed)
 */
export type RenderMode = 'billboard' | 'mesh' | 'hybrid' | 'grass-blade' | 'procedural-rock';

// ==================== Model Reference ====================

/**
 * Reference to a 3D vegetation model from the Asset Library.
 * Used for 'mesh' and 'hybrid' render modes.
 */
export interface ModelReference {
  /** Asset ID from the Asset Library */
  assetId: string;
  /** Asset name for display */
  assetName: string;
  /** Path to the standard (non-UE) GLTF file */
  modelPath: string;
  /** Path to billboard BaseColor+Opacity texture (auto-billboard for hybrid mode) */
  billboardTexturePath: string | null;
  /** Path to billboard Normal texture (tangent-space RGB normal map) */
  billboardNormalPath: string | null;
  /** Path to billboard Translucency texture (grayscale, R channel used) */
  billboardTranslucencyPath: string | null;
  /** Number of mesh variants (from GLTF sub-meshes or multiple files) */
  variantCount: number;
  /** Names of each variant node (from glTF scene graph) */
  variantNames?: string[];
  /** Selected variant index, or -1 for combined/all meshes (default: -1) */
  selectedVariant?: number;
}

// ==================== Atlas & Texture Types ====================

/**
 * Region within a texture atlas (UV coordinates in pixels).
 */
export interface AtlasRegion {
  /** X offset in pixels */
  u: number;
  /** Y offset in pixels */
  v: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
}

/**
 * Normalized atlas region (0-1 UV coordinates).
 * Used in shaders for texture sampling.
 */
export interface AtlasRegionNormalized {
  /** U offset (0-1) */
  u: number;
  /** V offset (0-1) */
  v: number;
  /** Width (0-1) */
  width: number;
  /** Height (0-1) */
  height: number;
}

/**
 * Reference to a texture atlas asset with detected sprite regions.
 */
export interface AtlasReference {
  /** Asset ID from the Asset Library */
  assetId: string;
  /** Asset name for display */
  assetName: string;
  /** Path to the opacity map for region detection */
  opacityPath: string;
  /** Path to the base color texture */
  baseColorPath: string;
  /** Atlas dimensions */
  atlasSize: [number, number];
  /** Detected sprite regions */
  regions: AtlasRegion[];
}

// ==================== Procedural Rock Types ====================

/**
 * Number of LOD tiers for procedural rock meshes.
 * Each tier corresponds to a different icosphere subdivision level.
 */
export const ROCK_LOD_TIER_COUNT = 4;

/**
 * Icosphere subdivision level per LOD tier.
 * Index 0 = lowest detail (distant), index 3 = highest detail (closest).
 */
export const ROCK_SUBDIVISION_LEVELS = [0, 1, 2, 3] as const;

/**
 * Reference to a generated procedural rock mesh set.
 * Stores 4 LOD tiers of the same rock shape (same seed, different subdivision levels)
 * plus shared albedo + normal map textures.
 * 
 * This is the runtime GPU data — created by ProceduralRockMeshGenerator and
 * cached per plant type. Not serialized; regenerated from seed on scene load.
 */
export interface ProceduralRockRef {
  /** The seed used to generate this rock shape */
  seed: number;
  /** The fallback color baked into the albedo texture */
  bakedColor: [number, number, number];
  /** Rock meshes per LOD tier: [lod0_distant, lod1_far, lod2_mid, lod3_close] */
  lodMeshes: [VegetationMesh, VegetationMesh, VegetationMesh, VegetationMesh];
  /** Baked albedo + AO texture (128×128 rgba8, shared across all LOD tiers) */
  albedoTexture: UnifiedGPUTexture;
  /** Baked normal map texture (128×128 rgba8, shared across all LOD tiers) */
  normalTexture: UnifiedGPUTexture;
}

/**
 * Map a CDLOD tile lodLevel to a rock LOD tier index (0-3).
 * 
 * @param lodLevel - CDLOD quadtree level (0 = root/coarsest, N = leaf/finest)
 * @param maxLodLevels - Total number of LOD levels in the quadtree
 * @returns Rock LOD tier index: 3 = closest (subdiv 3), 0 = distant (subdiv 0)
 */
export function lodLevelToRockTier(lodLevel: number, maxLodLevels: number): number {
  const leafLevel = maxLodLevels - 1;
  const levelsFromLeaf = leafLevel - lodLevel;
  if (levelsFromLeaf <= 1) return 3;  // closest: subdiv 3 (642 verts)
  if (levelsFromLeaf <= 3) return 2;  // mid: subdiv 2 (162 verts)
  if (levelsFromLeaf <= 5) return 1;  // far: subdiv 1 (42 verts)
  return 0;                            // distant: subdiv 0 (12 verts)
}

// ==================== Plant Types ====================

/**
 * Definition of a plant type for vegetation spawning.
 */
export interface PlantType {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  
  // Visual properties
  /** Fallback color when no texture [R, G, B] (0-1) */
  color: [number, number, number];
  /** Reference to texture atlas (null = use color) — for billboard rendering */
  atlasRef: AtlasReference | null;
  /** Specific region in atlas to use (null = random from available) */
  atlasRegionIndex: number | null;
  
  // Rendering mode
  /** How this plant should render: billboard, mesh, or hybrid (3D close + billboard far) */
  renderMode: RenderMode;
  /** Reference to 3D model for mesh/hybrid rendering (null = billboard-only) */
  modelRef: ModelReference | null;
  /** Distance threshold for 3D→billboard transition in hybrid mode (world units) */
  billboardDistance: number;
  
  // Size in world units
  /** Minimum size [width, height] */
  minSize: [number, number];
  /** Maximum size [width, height] */
  maxSize: [number, number];
  
  // Spawn distribution
  /** Base spawn probability (0-1), used for shader-side probabilistic rejection */
  spawnProbability: number;
  /** Target instances per square meter. Grass: 20-50, wildflowers: 1-5, trees: 0.01-0.1 */
  densityMultiplier: number;
  /** Which biome channel this plant spawns in */
  biomeChannel: BiomeChannel;
  /** Minimum biome value required to spawn (0-1) */
  biomeThreshold: number;
  
  // Clustering
  /** Clustering strength (0 = uniform, 1 = highly clustered) */
  clusterStrength: number;
  /** Minimum spacing between instances (world units) */
  minSpacing: number;
  
  // LOD
  /** Maximum distance before fade out (world units) */
  maxDistance: number;
  /** LOD priority bias (higher = more important, render at greater distance) */
  lodBias: number;
  /** How much this plant is affected by global wind (0 = static/rock, 1 = full wind). Default: 1.0 */
  windInfluence: number;
  /** Whether this plant type casts shadows (only effective for mesh/hybrid render modes). Default: false */
  castShadows: boolean;
  /** Maximum distance from camera for shadow casting (meters). Plants beyond this won't cast shadows. Default: 50 */
  shadowCastDistance: number;
  /**
   * Maximum CDLOD quadtree level at which this plant spawns.
   * Uses quadtree convention: 0 = root (coarsest, farthest), N = leaf (finest, closest).
   * A value of 0 means the plant spawns even on the coarsest/farthest tile (e.g., large tree billboards).
   * A higher value means the plant only spawns on finer/closer tiles (e.g., grass).
   * Default: 0 (spawn on all visible tiles).
   */
  maxVegetationLOD: number;

  // ---- Grass Blade Shape Fields (only active when renderMode === 'grass-blade') ----
  /** Width of blade relative to height. Lower = thinner blades. Default: 0.025. Range: 0.01–0.08 */
  bladeWidthFactor: number;
  /** Non-linear taper exponent. Higher = sharper tip. 1.0=linear, 1.8=moderate, 3.0=very sharp. Default: 1.8 */
  bladeTaperPower: number;
  /** Central vein fold strength. 0=flat blade, 1=strong V-fold appearance. Default: 0.4 */
  veinFoldStrength: number;
  /** Subsurface scattering strength. 0=opaque, 1=fully translucent backlit. Default: 0.65 */
  sssStrength: number;

  // ---- Clumping Fields (only active when renderMode === 'grass-blade') ----
  /** Enable Voronoi-cell-based clumping for grass blades. Default: false */
  clumpEnabled: boolean;
  /** World-space Voronoi cell size for clumps (meters). Default: 2.0 */
  clumpCellSize: number;
  /** Jitter of Voronoi cell centers (0=grid, 1=fully random). Default: 0.5 */
  clumpJitter: number;
  /** Density falloff from clump center (0=uniform, 1=tight clusters). Default: 0.5 */
  clumpFalloff: number;
  /** Blade orientation mode within clumps. Default: 'outward' */
  clumpFacingMode: 'random' | 'outward' | 'inward';
  /** Random angle spread around facing direction (radians). Default: 0.8 */
  clumpAngleSpread: number;

  // ---- Procedural Rock Fields ----
  /** Shape seed for procedural rock generation. Each unique seed produces a different rock shape. Default: 42 */
  rockSeed: number;
  /**
   * Runtime-only reference to the generated procedural rock mesh set (4 LOD tiers + textures).
   * Null until user clicks "Generate". Not serialized — regenerated from rockSeed on scene load.
   */
  rockRef: ProceduralRockRef | null;
}

/**
 * Creates a default plant type with sensible values.
 */
export function createDefaultPlantType(id: string, name: string): PlantType {
  return {
    id,
    name,
    color: [0.3, 0.6, 0.2],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 100,
    minSize: [0.3, 0.5],
    maxSize: [0.5, 1.0],
    spawnProbability: 0.5,
    densityMultiplier: 4.0, // 4 instances/m² — reasonable default for generic plants
    biomeChannel: 'r',
    biomeThreshold: 0.3,
    clusterStrength: 0.3,
    minSpacing: 0.2,
    maxDistance: 200,
    lodBias: 1.0,
    windInfluence: 1.0,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    // Grass blade shape defaults
    bladeWidthFactor: 0.025,
    bladeTaperPower: 1.8,
    veinFoldStrength: 0.4,
    sssStrength: 0.65,
    // Clumping defaults
    clumpEnabled: false,
    clumpCellSize: 2.0,
    clumpJitter: 0.5,
    clumpFalloff: 0.5,
    clumpFacingMode: 'outward',
    clumpAngleSpread: 0.8,
    // Procedural rock
    rockSeed: 42,
    rockRef: null,
  };
}

// ==================== Vegetation Light Params ====================

/**
 * Light parameters for vegetation shading (from DirectionalLight).
 * Shared across all vegetation renderers (grass blades, billboards, mesh).
 */
export interface VegetationLightParams {
  /** Direction vector pointing towards the light source */
  sunDirection: [number, number, number];
  /** Computed effective sun/moon color (includes atmospheric tinting) */
  sunColor: [number, number, number];
  /** Sky hemisphere color for ambient lighting */
  skyColor: [number, number, number];
  /** Ground hemisphere color for ambient lighting */
  groundColor: [number, number, number];
  /** Sun intensity factor (0 at night moonlight, 1 during day) */
  sunIntensityFactor: number;
}

/** Default vegetation light params (daytime white sun) */
export const DEFAULT_VEGETATION_LIGHT: VegetationLightParams = {
  sunDirection: [0.3, 0.8, 0.2],
  sunColor: [1.0, 1.0, 0.95],
  skyColor: [0.4, 0.6, 1.0],
  groundColor: [0.3, 0.25, 0.2],
  sunIntensityFactor: 1.0,
};

// ==================== Vegetation Configuration ====================

/**
 * Global vegetation system configuration.
 */
export interface VegetationConfig {
  /** Master enable/disable */
  enabled: boolean;
  /** Global density multiplier (0-2) */
  globalDensity: number;
  /** Enable wind animation */
  windEnabled: boolean;
  /** Debug visualization mode */
  debugMode: boolean;
  /** Global spawn seed for deterministic placement (shared by all plant types) */
  spawnSeed: number;
  /** Maximum distance from camera for vegetation shadow casting (meters). Default: 200 */
  shadowCastDistance: number;
  /** Enable analytical ground darkening under vegetation (density map stamping). Default: false */
  groundDarkening: boolean;
}

/**
 * Creates default vegetation configuration.
 */
export function createDefaultVegetationConfig(): VegetationConfig {
  return {
    enabled: true,
    globalDensity: 1.0,
    windEnabled: true,
    debugMode: false,
    spawnSeed: 42,
    shadowCastDistance: 200,
    groundDarkening: false,
  };
}

/**
 * Wind animation parameters.
 */
export interface WindParams {
  /** Wind direction (XZ plane, normalized) */
  direction: [number, number];
  /** Wind strength (0-1) */
  strength: number;
  /** Base oscillation frequency */
  frequency: number;
  /** Local gust strength variation */
  gustStrength: number;
  /** Spatial frequency of gusts */
  gustFrequency: number;
}

/**
 * Creates default wind parameters.
 */
export function createDefaultWindParams(): WindParams {
  return {
    direction: [1, 0],
    strength: 0.3,
    frequency: 1.0,
    gustStrength: 0.2,
    gustFrequency: 0.5,
  };
}

// ==================== Biome Plant Configuration ====================

/**
 * Configuration for plants within a specific biome.
 */
export interface BiomePlantConfig {
  /** Biome channel (r, g, b, a) */
  biomeChannel: BiomeChannel;
  /** Display name for the biome */
  biomeName: string;
  /** Color for visualization */
  displayColor: [number, number, number];
  /** Plants assigned to this biome */
  plants: PlantType[];
}

/**
 * Default biome configurations.
 */
export const DEFAULT_BIOME_CONFIGS: Record<BiomeChannel, Omit<BiomePlantConfig, 'plants'>> = {
  r: {
    biomeChannel: 'r',
    biomeName: 'Grassland',
    displayColor: [0.3, 0.7, 0.2],
  },
  g: {
    biomeChannel: 'g',
    biomeName: 'Rock/Cliff',
    displayColor: [0.5, 0.5, 0.5],
  },
  b: {
    biomeChannel: 'b',
    biomeName: 'Forest Edge',
    displayColor: [0.1, 0.4, 0.15],
  },
  a: {
    biomeChannel: 'a',
    biomeName: 'Reserved',
    displayColor: [0.0, 0.0, 0.0],
  },
};

// ==================== Default Plant Presets ====================

/**
 * Default grassland plant presets.
 */
/** Default grass blade + clump fields for plant presets that don't use them */
const _defaultBladeClumpFields = {
  bladeWidthFactor: 0.025,
  bladeTaperPower: 1.8,
  veinFoldStrength: 0.4,
  sssStrength: 0.65,
  clumpEnabled: false as const,
  clumpCellSize: 2.0,
  clumpJitter: 0.5,
  clumpFalloff: 0.5,
  clumpFacingMode: 'outward' as const,
  clumpAngleSpread: 0.8,
};

export const GRASSLAND_PLANT_PRESETS: PlantType[] = [
  {
    ..._defaultBladeClumpFields,
    id: 'tall-grass',
    name: 'Tall Grass',
    color: [0.3, 0.6, 0.2],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 50,
    minSize: [0.3, 0.5],
    maxSize: [0.5, 1.2],
    spawnProbability: 0.6,
    densityMultiplier: 25.0,
    biomeChannel: 'r',
    biomeThreshold: 0.3,
    clusterStrength: 0.4,
    minSpacing: 0.1,
    maxDistance: 200,
    lodBias: 1.0,
    windInfluence: 1.0,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
  {
    ..._defaultBladeClumpFields,
    id: 'short-grass',
    name: 'Short Grass Clump',
    color: [0.4, 0.5, 0.2],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 50,
    minSize: [0.2, 0.15],
    maxSize: [0.3, 0.3],
    spawnProbability: 0.8,
    densityMultiplier: 30.0,
    biomeChannel: 'r',
    biomeThreshold: 0.2,
    clusterStrength: 0.2,
    minSpacing: 0.05,
    maxDistance: 100,
    lodBias: 0.8,
    windInfluence: 1.0,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
  {
    ..._defaultBladeClumpFields,
    id: 'wildflower-yellow',
    name: 'Yellow Wildflower',
    color: [0.9, 0.8, 0.2],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 50,
    minSize: [0.15, 0.2],
    maxSize: [0.25, 0.4],
    spawnProbability: 0.15,
    densityMultiplier: 3.0,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.7,
    minSpacing: 0.3,
    maxDistance: 150,
    lodBias: 1.2,
    windInfluence: 0.8,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
  {
    ..._defaultBladeClumpFields,
    id: 'wildflower-purple',
    name: 'Purple Wildflower',
    color: [0.6, 0.3, 0.7],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 50,
    minSize: [0.12, 0.18],
    maxSize: [0.22, 0.35],
    spawnProbability: 0.1,
    densityMultiplier: 2.0,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.6,
    minSpacing: 0.35,
    maxDistance: 150,
    lodBias: 1.2,
    windInfluence: 0.8,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
  {
    ..._defaultBladeClumpFields,
    id: 'small-shrub',
    name: 'Small Shrub',
    color: [0.25, 0.4, 0.2],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 80,
    minSize: [0.4, 0.3],
    maxSize: [0.8, 0.6],
    spawnProbability: 0.05,
    densityMultiplier: 0.2,
    biomeChannel: 'r',
    biomeThreshold: 0.6,
    clusterStrength: 0.3,
    minSpacing: 1.0,
    maxDistance: 300,
    lodBias: 1.5,
    windInfluence: 0.5,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
];

/**
 * Default forest edge plant presets.
 */
export const FOREST_PLANT_PRESETS: PlantType[] = [
  {
    ..._defaultBladeClumpFields,
    id: 'fern',
    name: 'Fern',
    color: [0.2, 0.45, 0.15],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 100,
    minSize: [0.3, 0.25],
    maxSize: [0.6, 0.5],
    spawnProbability: 0.5,
    densityMultiplier: 4.0,
    biomeChannel: 'b',
    biomeThreshold: 0.3,
    clusterStrength: 0.5,
    minSpacing: 0.4,
    maxDistance: 200,
    lodBias: 1.0,
    windInfluence: 0.7,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
  {
    ..._defaultBladeClumpFields,
    id: 'forest-grass',
    name: 'Forest Grass',
    color: [0.2, 0.4, 0.15],
    atlasRef: null,
    atlasRegionIndex: null,
    renderMode: 'billboard',
    modelRef: null,
    billboardDistance: 50,
    minSize: [0.2, 0.3],
    maxSize: [0.4, 0.6],
    spawnProbability: 0.4,
    densityMultiplier: 15.0,
    biomeChannel: 'b',
    biomeThreshold: 0.25,
    clusterStrength: 0.3,
    minSpacing: 0.1,
    maxDistance: 150,
    lodBias: 0.9,
    windInfluence: 1.0,
    castShadows: false,
    shadowCastDistance: 50,
    maxVegetationLOD: 8,
    rockSeed: 42,
    rockRef: null,
  },
];

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
    rockSlopeMin: 0.2,          // Moderate to steep slopes (post-normalization)
    
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
