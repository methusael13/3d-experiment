/**
 * Post-processing module exports
 */

// Core infrastructure
export { PostProcessStack } from './PostProcessStack';
export type { PostProcessStackConfig, PostProcessTargets } from './PostProcessStack';

export { PostProcessPass } from './PostProcessPass';
export type { PostProcessInputs, PostProcessUniforms } from './PostProcessPass';

export { FullscreenQuad } from './FullscreenQuad';
export type { FullscreenPipelineOptions } from './FullscreenQuad';

// Effects
export { SSAOPass } from './effects/SSAOPass';
export type { SSAOConfig } from './effects/SSAOPass';
