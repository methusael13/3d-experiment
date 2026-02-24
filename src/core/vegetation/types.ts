/**
 * Vegetation System Types
 * 
 * Central type definitions for the vegetation system including
 * biome parameters, plant types, and configuration.
 */

// ==================== Render Mode ====================

/**
 * How a plant type should be rendered.
 * - 'billboard': Always rendered as camera-facing quads (atlas or billboard texture)
 * - 'mesh': Always rendered as 3D instanced mesh (GLTF model)
 * - 'hybrid': 3D mesh at close range, billboard at far range (distance-based transition)
 */
export type RenderMode = 'billboard' | 'mesh' | 'hybrid' | 'grass-blade';

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
  /** Path to billboard Normal+Translucency texture */
  billboardNormalPath: string | null;
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
  /** Base spawn probability (0-1) */
  spawnProbability: number;
  /** Per-plant density multiplier (1.0 = normal, >1 = denser, <1 = sparser) */
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
  /**
   * Maximum CDLOD quadtree level at which this plant spawns.
   * Uses quadtree convention: 0 = root (coarsest, farthest), N = leaf (finest, closest).
   * A value of 0 means the plant spawns even on the coarsest/farthest tile (e.g., large tree billboards).
   * A higher value means the plant only spawns on finer/closer tiles (e.g., grass).
   * Default: 0 (spawn on all visible tiles).
   */
  maxVegetationLOD: number;
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.3,
    clusterStrength: 0.3,
    minSpacing: 0.2,
    maxDistance: 200,
    lodBias: 1.0,
    maxVegetationLOD: 8, // Default: only spawn on the 2 closest LOD levels (8 and 9 out of 0-9)
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
export const GRASSLAND_PLANT_PRESETS: PlantType[] = [
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.3,
    clusterStrength: 0.4,
    minSpacing: 0.2,
    maxDistance: 200,
    lodBias: 1.0,
    maxVegetationLOD: 8,
  },
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.2,
    clusterStrength: 0.2,
    minSpacing: 0.1,
    maxDistance: 100,
    lodBias: 0.8,
    maxVegetationLOD: 8,
  },
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.7,
    minSpacing: 0.3,
    maxDistance: 150,
    lodBias: 1.2,
    maxVegetationLOD: 8,
  },
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.6,
    minSpacing: 0.35,
    maxDistance: 150,
    lodBias: 1.2,
    maxVegetationLOD: 8,
  },
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'r',
    biomeThreshold: 0.6,
    clusterStrength: 0.3,
    minSpacing: 1.0,
    maxDistance: 300,
    lodBias: 1.5,
    maxVegetationLOD: 8,
  },
];

/**
 * Default forest edge plant presets.
 */
export const FOREST_PLANT_PRESETS: PlantType[] = [
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'b',
    biomeThreshold: 0.3,
    clusterStrength: 0.5,
    minSpacing: 0.4,
    maxDistance: 200,
    lodBias: 1.0,
    maxVegetationLOD: 8,
  },
  {
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
    densityMultiplier: 1.0,
    biomeChannel: 'b',
    biomeThreshold: 0.25,
    clusterStrength: 0.3,
    minSpacing: 0.2,
    maxDistance: 150,
    lodBias: 0.9,
    maxVegetationLOD: 8,
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
