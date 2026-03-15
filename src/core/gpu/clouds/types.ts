/**
 * Cloud System Types
 * 
 * Configuration interfaces and constants for the volumetric cloud system.
 */

// ========== Cloud Configuration ==========

/**
 * Cloud system configuration exposed to UI and pipeline
 */
export interface CloudConfig {
  /** Master enable for the whole cloud system */
  enabled: boolean;

  /** Global cloud coverage (0 = clear, 1 = overcast) */
  coverage: number;

  /** Cloud type (0 = stratus/flat, 0.5 = stratocumulus, 1.0 = cumulus/puffy) */
  cloudType: number;

  /** Extinction coefficient (controls cloud density/opacity) */
  density: number;

  /** Cloud layer base altitude in meters */
  cloudBase: number;

  /** Cloud layer thickness in meters */
  cloudThickness: number;

  /** Wind speed in m/s (drives weather map scrolling) */
  windSpeed: number;

  /** Wind direction in degrees (azimuth, 0 = north) */
  windDirection: number;

  /** Enable cloud shadow map generation */
  cloudShadows: boolean;
}

/**
 * Default cloud configuration
 */
export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  enabled: false,
  coverage: 0.4,
  cloudType: 0.75,
  density: 0.04,
  cloudBase: 1500,
  cloudThickness: 2500,
  windSpeed: 5,
  windDirection: 45,
  cloudShadows: true,
};

// ========== Noise Texture Specs ==========

/** 3D base shape noise resolution (128³) */
export const SHAPE_NOISE_SIZE = 128;

/** 3D detail erosion noise resolution (32³) */
export const DETAIL_NOISE_SIZE = 32;

/** 2D weather map resolution */
export const WEATHER_MAP_SIZE = 512;

// ========== Cloud Uniform Layout ==========

/**
 * Size of the cloud ray march uniform buffer in bytes.
 * Must match the CloudUniforms struct in cloud-raymarch.wgsl.
 * 
 * Layout (256 bytes total):
 *   mat4x4f inverseViewProj   [0..63]
 *   vec3f   cameraPosition    [64..75]
 *   f32     time              [76..79]
 *   vec3f   sunDirection      [80..91]
 *   f32     sunIntensity      [92..95]
 *   vec3f   sunColor          [96..107]
 *   f32     coverage          [108..111]
 *   f32     cloudBase         [112..115]
 *   f32     cloudThickness    [116..119]
 *   f32     density           [120..123]
 *   f32     cloudType         [124..127]
 *   vec2f   weatherOffset     [128..135]
 *   f32     near              [136..139]
 *   f32     far               [140..143]
 *   vec2u   resolution        [144..151]
 *   f32     earthRadius       [152..155]
 *   f32     _pad0             [156..159]
 */
export const CLOUD_UNIFORM_SIZE = 160;

/** Cloud shadow map resolution */
export const CLOUD_SHADOW_MAP_SIZE = 1024;

/** Cloud shadow uniform buffer size in bytes (matches CloudShadowUniforms in cloud-shadow.wgsl) */
export const CLOUD_SHADOW_UNIFORM_SIZE = 64;

/** Cloud shadow scene uniform buffer size (for scene shader bindings) */
export const CLOUD_SHADOW_SCENE_UNIFORM_SIZE = 16;

/** Earth radius matching sky.wgsl */
export const EARTH_RADIUS = 6_360_000;
