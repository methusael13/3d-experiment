import type { ShaderFeature } from '../composition/types';
import { shadowFeature } from './shadowFeature';
import { iblFeature } from './iblFeature';
import { texturedFeature } from './texturedFeature';
import { windFeature } from './windFeature';
import { wetnessFeature } from './wetnessFeature';
import { ssrFeature } from './ssrFeature';
import { reflectionProbeFeature } from './reflectionProbeFeature';

export { shadowFeature } from './shadowFeature';
export { iblFeature } from './iblFeature';
export { texturedFeature } from './texturedFeature';
export { windFeature } from './windFeature';
export { wetnessFeature } from './wetnessFeature';
export { ssrFeature } from './ssrFeature';
export { reflectionProbeFeature } from './reflectionProbeFeature';

/**
 * Feature registry — maps feature ID to its ShaderFeature definition.
 * New features are registered here to be discoverable by the ShaderComposer.
 */
export const featureRegistry = new Map<string, ShaderFeature>([
  [shadowFeature.id, shadowFeature],
  [iblFeature.id, iblFeature],
  [texturedFeature.id, texturedFeature],
  [windFeature.id, windFeature],
  [wetnessFeature.id, wetnessFeature],
  [ssrFeature.id, ssrFeature],
  [reflectionProbeFeature.id, reflectionProbeFeature],
]);

/**
 * Look up a feature by ID. Throws if not found.
 */
export function getFeature(id: string): ShaderFeature {
  const feature = featureRegistry.get(id);
  if (!feature) {
    throw new Error(`[ShaderFeatures] Unknown feature ID: "${id}"`);
  }
  return feature;
}

/**
 * Register a new shader feature at runtime.
 */
export function registerFeature(feature: ShaderFeature): void {
  if (featureRegistry.has(feature.id)) {
    console.warn(
      `[ShaderFeatures] Overwriting existing feature: "${feature.id}"`,
    );
  }
  featureRegistry.set(feature.id, feature);
}