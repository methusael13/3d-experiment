/**
 * Post-processing module exports
 */

// Core infrastructure (legacy)
export { PostProcessStack } from './PostProcessStack';
export type { PostProcessStackConfig, PostProcessTargets } from './PostProcessStack';

export { PostProcessPass } from './PostProcessPass';
export type { PostProcessInputs, PostProcessUniforms } from './PostProcessPass';

export { FullscreenQuad } from './FullscreenQuad';
export type { FullscreenPipelineOptions } from './FullscreenQuad';

// Plugin-based pipeline (new)
export { PostProcessPipeline } from './PostProcessPipeline';
export type { 
  PostProcessEffect, 
  BaseEffect, 
  EffectContext, 
  EffectUniforms, 
  StandardInput 
} from './PostProcessPipeline';

export { BufferPool } from './BufferPool';

// Plugin-based effects (use with PostProcessPipeline)
export { SSAOEffect } from './effects/SSAOEffect';
export type { SSAOEffectConfig } from './effects/SSAOEffect';

export { CompositeEffect } from './effects/CompositeEffect';
export type { CompositeEffectConfig } from './effects/CompositeEffect';
