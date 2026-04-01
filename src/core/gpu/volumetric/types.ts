/**
 * Froxel Volumetric Fog — Types & Configuration
 *
 * Defines the configuration interfaces and constants for the froxel-based
 * volumetric fog system (Phase 6 of volumetric clouds plan).
 */

// ========== Froxel Grid Constants ==========

export const FROXEL_WIDTH = 160;
export const FROXEL_HEIGHT = 90;
export const FROXEL_DEPTH = 64;

/** Total froxel count */
export const FROXEL_COUNT = FROXEL_WIDTH * FROXEL_HEIGHT * FROXEL_DEPTH;

/** Maximum lights per froxel for clustered assignment */
export const MAX_LIGHTS_PER_FROXEL = 32;

// ========== Configuration ==========

/**
 * Global volumetric fog settings — exposed to UI and serialized with scene.
 */
export interface VolumetricFogConfig {
  /** Master enable for volumetric fog */
  enabled: boolean;

  // Height fog (matches AtmosphericFogEffect for seamless transition)
  /** Base height where fog is densest (world Y) */
  fogHeight: number;
  /** How quickly fog thins above fogHeight (0.005–1) */
  fogHeightFalloff: number;
  /** Base fog density (extinction coefficient at fogHeight) */
  fogBaseDensity: number;
  /** Fog color tint (RGB 0–1) */
  fogColor: [number, number, number];

  // Scattering
  /** Mie scattering asymmetry parameter (0 = isotropic, 0.8 = strong forward) */
  mieG: number;
  /** Scattering coefficient scale (artistic control, decoupled from extinction) */
  scatteringScale: number;
  /** Ambient fog illumination multiplier (prevents pitch-black unlit fog) */
  ambientFogIntensity: number;

  // 3D noise for heterogeneous fog
  /** Enable 3D noise modulation */
  noiseEnabled: boolean;
  /** Noise frequency scale (world units → noise UV) */
  noiseScale: number;
  /** Noise strength (0 = no effect, 1 = full modulation) */
  noiseStrength: number;

  // Temporal
  /** Enable temporal reprojection for smooth results */
  temporalEnabled: boolean;
  /** History blend factor (0.9–0.98 typical, higher = more stable but ghosty) */
  temporalBlend: number;
}

export const DEFAULT_VOLUMETRIC_FOG_CONFIG: VolumetricFogConfig = {
  enabled: false,
  fogHeight: 0,
  fogHeightFalloff: 0.02,
  fogBaseDensity: 0.015,
  fogColor: [0.85, 0.88, 0.92],
  mieG: 0.76,
  scatteringScale: 1.0,
  ambientFogIntensity: 0.05,
  noiseEnabled: true,
  noiseScale: 0.02,
  noiseStrength: 0.8,
  temporalEnabled: true,
  temporalBlend: 0.95,
};

/**
 * Local fog volume emitter — placed as ECS component on entities.
 */
export interface FogVolumeDescriptor {
  shape: 'sphere' | 'box' | 'cylinder';
  /** Base density inside volume */
  density: number;
  /** Edge falloff (0 = hard edge, 1 = soft fade) */
  falloff: number;
  /** Optional color tint (RGB 0–1, default white) */
  color?: [number, number, number];
  /** Optional noise scale for non-uniform interior */
  noiseScale?: number;
}

/**
 * GPU-side fog volume data (uploaded each frame for compute shader).
 * 64 bytes per volume (matches WGSL struct).
 */
export const FOG_VOLUME_GPU_STRIDE = 64; // bytes
export const MAX_FOG_VOLUMES = 32;

/**
 * Serializable volumetric fog state for scene files.
 */
export interface SerializedVolumetricFogState {
  config: VolumetricFogConfig;
}
