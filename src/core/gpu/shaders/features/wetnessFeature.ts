import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Wetness feature module — physically-based wet surface simulation for objects
 * partially submerged in water.
 *
 * Uses a single vec4f uniform `wetnessParams` packed as:
 *   x = waterLineY  (world-space Y of water surface at this entity's position)
 *   y = wetnessFactor (0 = dry, 1 = fully wet)
 *   z = debug flag (1 = blue tint visualization)
 *   w = reserved
 *
 * Three physically-motivated effects:
 *   1. Saturation-preserving darkening via power curve (wet surfaces trap light,
 *      making remaining reflected light appear more saturated)
 *   2. Noise-perturbed water line for organic capillary wicking
 *   3. IOR boost toward water film IOR (n≈1.33→1.5 effective) for dielectric glisten
 *      + aggressive roughness reduction for mirror-like wet sheen
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

// Simple hash for wicking noise — deterministic pseudo-random from 2D input
fn wetnessHash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D value noise for organic wicking pattern
fn wetnessNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f); // smoothstep interpolation

  let a = wetnessHash(i);
  let b = wetnessHash(i + vec2f(1.0, 0.0));
  let c = wetnessHash(i + vec2f(0.0, 1.0));
  let d = wetnessHash(i + vec2f(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Multi-octave wicking noise — simulates capillary absorption patterns
fn wickingNoise(worldXZ: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.6;
  var freq = 1.0;
  var pos = worldXZ;

  // 3 octaves for rich detail
  for (var i = 0; i < 3; i++) {
    value += amp * (wetnessNoise(pos * freq) * 2.0 - 1.0);
    amp *= 0.5;
    freq *= 2.3;
    // Rotate each octave slightly to reduce axis alignment
    pos = vec2f(pos.x * 0.866 - pos.y * 0.5, pos.x * 0.5 + pos.y * 0.866);
  }
  return value; // Range approximately [-1, 1]
}

// Compute wet blend factor with noise-perturbed boundary.
// Fully branchless to maintain uniform control flow for textureSample.
fn computeWetBlend(
  worldPos: vec3f,
  waterLineY: f32,
  wetnessFactor: f32,
) -> f32 {
  // Capillary wicking: perturb the Y comparison with spatial noise
  // Scale 6.0 gives roughly 1 wicking feature per ~16cm — good for leather/fabric
  let wicking = wickingNoise(worldPos.xz * 6.0) * 0.2; // ±0.2 world units variation

  let effectiveY = worldPos.y + wicking;

  // Blend zone: wider range for softer transition with wicking
  let blendLow = waterLineY - 0.4;
  let blendHigh = waterLineY + 0.15;
  return smoothstep(blendHigh, blendLow, effectiveY) * wetnessFactor;
}

// Saturation-preserving darkening — wet surfaces trap light, making
// the remaining reflected light look more saturated and deeper.
// Uses power-curve darkening instead of flat multiplication.
fn applyWetAlbedo(inAlbedo: vec3f, wetBlend: f32) -> vec3f {
  // Compute luminance for saturation manipulation
  let lum = dot(inAlbedo, vec3f(0.2126, 0.7152, 0.0722));

  // Boost saturation: wet surfaces show richer color as light is trapped
  // Mix toward the original color (away from gray) to increase saturation
  let satBoost = 1.0 + wetBlend * 0.35;
  let saturated = mix(vec3f(lum), inAlbedo, satBoost);

  // Power-curve darkening: preserves color relationships better than multiplication
  // Exponent > 1 darkens, with stronger effect on brighter values
  let darkExponent = 1.0 + wetBlend * 0.9;
  let darkened = pow(max(saturated, vec3f(0.001)), vec3f(darkExponent));

  // Additional overall darkening factor (wet surfaces absorb more light)
  return darkened * mix(1.0, 0.7, wetBlend);
}

// Wet roughness: thin water film makes surfaces much smoother/glossier
fn applyWetRoughness(inRoughness: f32, wetBlend: f32) -> f32 {
  // Aggressive roughness reduction — water film creates mirror-like surface
  // Blend toward 0.1 minimum (not 0.0 to avoid singularities)
  let wetRoughness = mix(inRoughness, max(inRoughness * 0.2, 0.08), wetBlend);
  return wetRoughness;
}

// Wet F0 boost: thin water film (n≈1.33) over the material surface.
// For dielectrics, this increases effective reflectance (glisten effect).
// We approximate this by raising the metallic value for non-metals,
// which increases F0 in the standard PBR metallic-roughness workflow.
// Only affects dielectrics (metals already have F0 = albedo).
fn applyWetMetallic(inMetallic: f32, wetBlend: f32) -> f32 {
  // Push non-metal F0 from ~0.04 toward ~0.15 by raising metallic
  // The (1.0 - inMetallic) factor ensures metals are unaffected
  let wetMetallic = mix(inMetallic, max(inMetallic, 0.2), wetBlend * 0.6 * (1.0 - inMetallic));
  return wetMetallic;
}
`,

  // Injected into FRAGMENT_PRE_LIGHTING marker — before PBR calculations.
  // Modifies albedo, roughness, and IOR so PBR lighting correctly reflects wet surface properties.
  // IMPORTANT: Fully branchless (uses select/mix) to maintain uniform control flow
  // for downstream textureSample calls (IBL, shadow, etc.).
  fragmentPreLightingInject: `
  // ---- Wetness Effect (pre-PBR) — branchless ----
  {
    let wWaterLineY = material.wetnessParams.x;
    let wWetnessFactor = material.wetnessParams.y;
    let wDebug = material.wetnessParams.z;

    // Always compute wetBlend (branchless — no early return in computeWetBlend)
    let wetBlend = computeWetBlend(input.worldPosition, wWaterLineY, wWetnessFactor);

    // Compute both debug and normal wet albedo, select based on uniform debug flag
    let debugAlbedo = mix(albedo, vec3f(0.1, 0.3, 1.0), wetBlend * 0.7);
    let wetAlbedo = applyWetAlbedo(albedo, wetBlend);
    albedo = select(wetAlbedo, debugAlbedo, wDebug > 0.5);

    // Roughness and IOR only change in non-debug mode; use select to keep branchless
    let wetRough = applyWetRoughness(roughness, wetBlend);
    roughness = select(wetRough, roughness, wDebug > 0.5);

    // Metallic boost for dielectric glisten (thin water film F0 increase)
    let wetMet = applyWetMetallic(metallic, wetBlend);
    metallic = select(wetMet, metallic, wDebug > 0.5);
  }
`,
};