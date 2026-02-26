import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Wetness feature module — fragment-stage darkening for objects partially
 * submerged in water.
 *
 * Uses a single vec4f uniform `wetnessParams` packed as:
 *   x = waterLineY  (world-space Y of water surface at this entity's position)
 *   y = wetnessFactor (0 = dry, 1 = fully wet)
 *   z = reserved
 *   w = reserved
 *
 * Fragment inject: below waterLineY, darkens albedo (×0.65) and reduces
 * roughness (×0.35) with a smoothstep blend zone for a soft transition.
 *
 * Per-object uniform resource (added to MaterialUniforms struct via
 * EXTRA_UNIFORM_FIELDS injection marker).
 */
export const wetnessFeature: ShaderFeature = {
  id: 'wetness',
  stage: 'fragment',

  resources: [
    {
      name: RES.WETNESS_PARAMS,
      kind: 'uniform',
      wgslType: 'vec4f',
      group: 'perObject',
      provider: 'WetnessComponent',
    },
  ],

  functions: `
// ============ Wetness Functions ============

fn applyWetness(
  inAlbedo: vec3f,
  inRoughness: f32,
  worldY: f32,
  waterLineY: f32,
  wetnessFactor: f32,
) -> vec3f {
  // No wetness effect if factor is zero
  if (wetnessFactor <= 0.0) {
    return inAlbedo;
  }

  // Blend zone: smoothstep from waterLineY - 0.3 to waterLineY + 0.1
  // This creates a soft wet/dry boundary rather than a hard line
  let blendLow = waterLineY - 0.3;
  let blendHigh = waterLineY + 0.1;
  let wetBlend = smoothstep(blendHigh, blendLow, worldY) * wetnessFactor;

  // Darken albedo: wet surfaces absorb more light
  let wetAlbedo = inAlbedo * mix(1.0, 0.65, wetBlend);

  return wetAlbedo;
}

fn applyWetnessRoughness(
  inRoughness: f32,
  worldY: f32,
  waterLineY: f32,
  wetnessFactor: f32,
) -> f32 {
  if (wetnessFactor <= 0.0) {
    return inRoughness;
  }

  let blendLow = waterLineY - 0.3;
  let blendHigh = waterLineY + 0.1;
  let wetBlend = smoothstep(blendHigh, blendLow, worldY) * wetnessFactor;

  // Reduce roughness: wet surfaces are shinier/more specular
  return mix(inRoughness, inRoughness * 0.35, wetBlend);
}
`,

  // Injected into FRAGMENT_PRE_LIGHTING marker — before PBR calculations
  // Modifies albedo and roughness so PBR lighting correctly reflects wet surface properties
  fragmentPreLightingInject: `
  // ---- Wetness Effect (pre-PBR) ----
  {
    let wWaterLineY = material.wetnessParams.x;
    let wWetnessFactor = material.wetnessParams.y;
    let wDebug = material.wetnessParams.z;
    if (wWetnessFactor > 0.0) {
      if (wDebug > 0.5) {
        // Debug mode: bright blue tint shows affected area
        let blendLow = wWaterLineY - 0.3;
        let blendHigh = wWaterLineY + 0.1;
        let wetBlend = smoothstep(blendHigh, blendLow, input.worldPosition.y) * wWetnessFactor;
        albedo = mix(albedo, vec3f(0.1, 0.3, 1.0), wetBlend * 0.7);
      } else {
        // Normal wetness: darken albedo + reduce roughness
        albedo = applyWetness(albedo, roughness, input.worldPosition.y, wWaterLineY, wWetnessFactor);
        roughness = applyWetnessRoughness(roughness, input.worldPosition.y, wWaterLineY, wWetnessFactor);
      }
    }
  }
`,
};