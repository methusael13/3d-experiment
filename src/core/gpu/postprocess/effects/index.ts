/**
 * Post-processing effects exports
 */

// Plugin-based effects (use with PostProcessPipeline)
export { SSAOEffect } from './SSAOEffect';
export type { SSAOEffectConfig } from './SSAOEffect';

export { CompositeEffect } from './CompositeEffect';
export type { CompositeEffectConfig } from './CompositeEffect';

export { AtmosphericFogEffect } from './AtmosphericFogEffect';
export type { AtmosphericFogConfig } from './AtmosphericFogEffect';

export { CloudCompositeEffect } from './CloudCompositeEffect';

export { GodRayEffect } from './GodRayEffect';
export type { GodRayConfig } from './GodRayEffect';

export { FroxelGodRayEffect } from './FroxelGodRayEffect';

// Re-export volumetric fog from its own module
export { VolumetricFogEffect } from '../../volumetric/VolumetricFogEffect';
export type { VolumetricFogConfig } from '../../volumetric/types';
