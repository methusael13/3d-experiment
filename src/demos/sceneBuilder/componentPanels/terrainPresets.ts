/**
 * Terrain Presets - Predefined terrain generation configurations
 * 
 * Note: resolution and worldSize are intentionally excluded as they
 * are project-specific and should be set independently by the user.
 */

import type { TerrainNoiseParams, TerrainErosionParams, TerrainMaterialParams } from '../../../core/sceneObjects/types';

/**
 * Terrain preset configuration (excludes resolution and worldSize)
 */
export interface TerrainPreset {
  /** Display name for the preset */
  name: string;
  /** Description of the terrain style */
  description: string;
  /** 
   * Reference world size for scaling height proportionally.
   * When applying a preset, heightScale is scaled by (currentWorldSize / referenceWorldSize).
   * This ensures presets look proportionally similar regardless of world size.
   */
  referenceWorldSize: number;
  /** Noise generation parameters */
  noise: Omit<TerrainNoiseParams, 'offset'>;
  /** Erosion simulation parameters */
  erosion: TerrainErosionParams;
  /** Material/texturing parameters */
  material: TerrainMaterialParams;
}

/**
 * Default preset - balanced terrain suitable for most uses
 */
export const DEFAULT_PRESET: TerrainPreset = {
  name: 'Default',
  description: 'Balanced terrain with moderate features',
  referenceWorldSize: 10,
  noise: {
    seed: 12345,
    scale: 1.0,
    octaves: 6,
    lacunarity: 2.0,
    persistence: 0.5,
    heightScale: 2.0,
    ridgeWeight: 0.5,
    warpStrength: 0.5,
    warpScale: 2.0,
    warpOctaves: 1,
    rotateOctaves: true,
    octaveRotation: 37,
  },
  erosion: {
    enabled: true,
    iterations: 100000,
    maxDropletLifetime: 64,
    inertia: 0.05,
    sedimentCapacity: 4.0,
    depositSpeed: 0.3,
    erodeSpeed: 0.3,
    evaporation: 0.01,
    gravity: 4.0,
    erosionRadius: 3,
    minSlope: 0.01,
    thermalEnabled: true,
    thermalIterations: 100,
    talusAngle: 0.5,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 0.0,
    rockLine: 0.6,
    snowLine: 0.8,
    maxGrassSlope: 0.6,
    maxSnowSlope: 0.4,
    waterColor: [0.2, 0.4, 0.6],
    grassColor: [0.3, 0.5, 0.2],
    rockColor: [0.4, 0.35, 0.3],
    snowColor: [0.95, 0.95, 0.97],
    dirtColor: [0.35, 0.25, 0.2],
  },
};

/**
 * Rolling Hills - Gentle, smooth terrain with minimal ridges
 */
export const ROLLING_HILLS_PRESET: TerrainPreset = {
  name: 'Rolling Hills',
  description: 'Gentle rolling hills with smooth slopes',
  referenceWorldSize: 10,
  noise: {
    seed: 42,
    scale: 1.0,
    octaves: 4,
    lacunarity: 2.0,
    persistence: 0.4,
    heightScale: 1.0,
    ridgeWeight: 0.1,
    warpStrength: 0.3,
    warpScale: 1.5,
    warpOctaves: 1,
    rotateOctaves: true,
    octaveRotation: 45,
  },
  erosion: {
    enabled: true,
    iterations: 50000,
    maxDropletLifetime: 64,
    inertia: 0.1,
    sedimentCapacity: 3.0,
    depositSpeed: 0.4,
    erodeSpeed: 0.2,
    evaporation: 0.015,
    gravity: 3.0,
    erosionRadius: 4,
    minSlope: 0.01,
    thermalEnabled: true,
    thermalIterations: 150,
    talusAngle: 0.4,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 0.0,
    rockLine: 0.8,
    snowLine: 0.95,
    maxGrassSlope: 0.7,
    maxSnowSlope: 0.3,
    waterColor: [0.2, 0.4, 0.6],
    grassColor: [0.35, 0.55, 0.25],
    rockColor: [0.45, 0.4, 0.35],
    snowColor: [0.95, 0.95, 0.97],
    dirtColor: [0.4, 0.3, 0.2],
  },
};

/**
 * Alpine Mountains - Sharp ridges, dramatic peaks with snow
 */
export const ALPINE_MOUNTAINS_PRESET: TerrainPreset = {
  name: 'Alpine Mountains',
  description: 'Sharp mountain ridges with snowy peaks',
  referenceWorldSize: 10,
  noise: {
    seed: 8675309,
    scale: 1.0,
    octaves: 8,
    lacunarity: 2.2,
    persistence: 0.55,
    heightScale: 4.0,
    ridgeWeight: 0.8,
    warpStrength: 0.6,
    warpScale: 2.5,
    warpOctaves: 2,
    rotateOctaves: true,
    octaveRotation: 33,
  },
  erosion: {
    enabled: true,
    iterations: 200000,
    maxDropletLifetime: 80,
    inertia: 0.03,
    sedimentCapacity: 6.0,
    depositSpeed: 0.25,
    erodeSpeed: 0.4,
    evaporation: 0.008,
    gravity: 5.0,
    erosionRadius: 3,
    minSlope: 0.005,
    thermalEnabled: true,
    thermalIterations: 200,
    talusAngle: 0.6,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 0.0,
    rockLine: 0.4,
    snowLine: 0.6,
    maxGrassSlope: 0.5,
    maxSnowSlope: 0.5,
    waterColor: [0.15, 0.35, 0.55],
    grassColor: [0.25, 0.45, 0.2],
    rockColor: [0.35, 0.32, 0.28],
    snowColor: [0.98, 0.98, 1.0],
    dirtColor: [0.3, 0.22, 0.15],
  },
};

/**
 * Desert Dunes - Smooth curves with warm sandy colors
 */
export const DESERT_DUNES_PRESET: TerrainPreset = {
  name: 'Desert Dunes',
  description: 'Smooth sand dunes with warm colors',
  referenceWorldSize: 10,
  noise: {
    seed: 1001,
    scale: 1.0,
    octaves: 5,
    lacunarity: 2.5,
    persistence: 0.35,
    heightScale: 1.5,
    ridgeWeight: 0.0,
    warpStrength: 0.8,
    warpScale: 3.0,
    warpOctaves: 2,
    rotateOctaves: true,
    octaveRotation: 40,
  },
  erosion: {
    enabled: false,
    iterations: 10000,
    maxDropletLifetime: 32,
    inertia: 0.15,
    sedimentCapacity: 2.0,
    depositSpeed: 0.5,
    erodeSpeed: 0.1,
    evaporation: 0.03,
    gravity: 2.0,
    erosionRadius: 5,
    minSlope: 0.02,
    thermalEnabled: true,
    thermalIterations: 300,
    talusAngle: 0.35,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 1.0, // No grass
    rockLine: 0.9,
    snowLine: 1.0, // No snow
    maxGrassSlope: 0.1,
    maxSnowSlope: 0.1,
    waterColor: [0.3, 0.5, 0.7],
    grassColor: [0.75, 0.65, 0.45], // Sandy grass color
    rockColor: [0.6, 0.5, 0.35],
    snowColor: [0.95, 0.9, 0.8],
    dirtColor: [0.8, 0.7, 0.5], // Main sand color
  },
};

/**
 * Rocky Badlands - High erosion, dramatic rocky features
 */
export const ROCKY_BADLANDS_PRESET: TerrainPreset = {
  name: 'Rocky Badlands',
  description: 'Heavily eroded rocky terrain',
  referenceWorldSize: 10,
  noise: {
    seed: 666,
    scale: 1.0,
    octaves: 7,
    lacunarity: 2.3,
    persistence: 0.6,
    heightScale: 2.5,
    ridgeWeight: 0.6,
    warpStrength: 0.7,
    warpScale: 2.0,
    warpOctaves: 2,
    rotateOctaves: true,
    octaveRotation: 31,
  },
  erosion: {
    enabled: true,
    iterations: 300000,
    maxDropletLifetime: 96,
    inertia: 0.02,
    sedimentCapacity: 8.0,
    depositSpeed: 0.2,
    erodeSpeed: 0.5,
    evaporation: 0.005,
    gravity: 6.0,
    erosionRadius: 2,
    minSlope: 0.003,
    thermalEnabled: true,
    thermalIterations: 250,
    talusAngle: 0.7,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 0.3,
    rockLine: 0.2,
    snowLine: 1.0, // No snow
    maxGrassSlope: 0.3,
    maxSnowSlope: 0.2,
    waterColor: [0.25, 0.35, 0.45],
    grassColor: [0.35, 0.4, 0.25],
    rockColor: [0.5, 0.4, 0.32],
    snowColor: [0.9, 0.88, 0.85],
    dirtColor: [0.45, 0.35, 0.25],
  },
};

/**
 * Volcanic Island - Dramatic slopes with dark volcanic rock
 */
export const VOLCANIC_ISLAND_PRESET: TerrainPreset = {
  name: 'Volcanic Island',
  description: 'Dramatic volcanic terrain with dark rock',
  referenceWorldSize: 10,
  noise: {
    seed: 2012,
    scale: 1.0,
    octaves: 6,
    lacunarity: 2.0,
    persistence: 0.5,
    heightScale: 3.5,
    ridgeWeight: 0.9,
    warpStrength: 0.4,
    warpScale: 1.5,
    warpOctaves: 1,
    rotateOctaves: true,
    octaveRotation: 35,
  },
  erosion: {
    enabled: true,
    iterations: 150000,
    maxDropletLifetime: 64,
    inertia: 0.04,
    sedimentCapacity: 5.0,
    depositSpeed: 0.3,
    erodeSpeed: 0.35,
    evaporation: 0.01,
    gravity: 5.0,
    erosionRadius: 3,
    minSlope: 0.008,
    thermalEnabled: true,
    thermalIterations: 180,
    talusAngle: 0.55,
  },
  material: {
    waterLevel: 0.0,
    grassLine: 0.15,
    rockLine: 0.3,
    snowLine: 0.85,
    maxGrassSlope: 0.5,
    maxSnowSlope: 0.4,
    waterColor: [0.1, 0.3, 0.5],
    grassColor: [0.2, 0.35, 0.15],
    rockColor: [0.2, 0.18, 0.16], // Dark volcanic rock
    snowColor: [0.9, 0.9, 0.92],
    dirtColor: [0.25, 0.2, 0.15],
  },
};

/**
 * All available terrain presets
 */
export const TERRAIN_PRESETS: Record<string, TerrainPreset> = {
  'default': DEFAULT_PRESET,
  'rolling-hills': ROLLING_HILLS_PRESET,
  'alpine-mountains': ALPINE_MOUNTAINS_PRESET,
  'desert-dunes': DESERT_DUNES_PRESET,
  'rocky-badlands': ROCKY_BADLANDS_PRESET,
  'volcanic-island': VOLCANIC_ISLAND_PRESET,
};

/**
 * Get preset by key
 */
export function getTerrainPreset(key: string): TerrainPreset | undefined {
  return TERRAIN_PRESETS[key];
}

/**
 * Get all preset keys
 */
export function getTerrainPresetKeys(): string[] {
  return Object.keys(TERRAIN_PRESETS);
}

/**
 * Get preset display name
 */
export function getPresetDisplayName(key: string): string {
  return TERRAIN_PRESETS[key]?.name ?? key;
}
