/**
 * Froxel Volumetric Fog — Public exports
 *
 * Phase 6 of the volumetric clouds & god rays plan.
 * Full froxel-based volumetric fog with point/spot light support.
 */

// Types & config
export type {
  VolumetricFogConfig,
  FogVolumeDescriptor,
  SerializedVolumetricFogState,
} from './types';
export {
  DEFAULT_VOLUMETRIC_FOG_CONFIG,
  FROXEL_WIDTH,
  FROXEL_HEIGHT,
  FROXEL_DEPTH,
  FROXEL_COUNT,
  MAX_LIGHTS_PER_FROXEL,
  MAX_FOG_VOLUMES,
  FOG_VOLUME_GPU_STRIDE,
} from './types';

// Core infrastructure
export { FroxelGrid } from './FroxelGrid';

// Compute passes
export { FogDensityInjector } from './FogDensityInjector';
export { FroxelScatteringPass } from './FroxelScatteringPass';
export type {
  ScatteringSunData,
  ScatteringShadowResources,
  ScatteringLightResources,
} from './FroxelScatteringPass';
export { FroxelIntegrator } from './FroxelIntegrator';
export { FroxelTemporalFilter } from './FroxelTemporalFilter';
export { FroxelLightCuller } from './FroxelLightCuller';

// Post-process effect
export { VolumetricFogEffect } from './VolumetricFogEffect';
