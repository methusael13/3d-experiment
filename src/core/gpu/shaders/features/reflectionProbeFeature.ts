import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Reflection Probe feature module — per-object cubemap probe for metallic objects.
 *
 * Samples a baked reflection probe cubemap that captures nearby geometry.
 * For pixels where the probe has no geometry (alpha ≈ 0, transparent black),
 * it falls through to the global IBL specular cubemap.
 *
 * This feature REPLACES both SSR and IBL specular for geometry pixels.
 * When active, SSR should NOT be included in the same variant.
 *
 * The probe cubemap + sampler are bound in the textures group (Group 2)
 * alongside PBR textures. This is per-entity data — the VariantRenderer
 * builds a custom Group 2 bind group per entity that includes both the
 * mesh's PBR textures and the probe's cubemap/sampler.
 */
export const reflectionProbeFeature: ShaderFeature = {
  id: 'reflection-probe',
  stage: 'fragment',

  dependencies: ['ibl'], // Needs IBL for fallback on sky pixels

  resources: [
    {
      name: RES.REFLECTION_PROBE_CUBEMAP,
      kind: 'texture',
      textureType: 'texture_cube<f32>',
      group: 'textures',
      provider: 'ReflectionProbeComponent',
    },
    {
      name: RES.REFLECTION_PROBE_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'ReflectionProbeComponent',
    },
  ],

  functions: `
// ============ Reflection Probe Functions ============

fn sampleReflectionProbeSpecular(
  N: vec3f,
  V: vec3f,
  metallicVal: f32,
  roughnessVal: f32,
  ao: f32,
  probeCubemap: texture_cube<f32>,
  probeSamp: sampler,
  iblSpec: texture_cube<f32>,
  iblCubeSamp: sampler,
  iblBrdf: texture_2d<f32>,
  iblLutSamp: sampler,
) -> vec3f {
  // Compute the replacement IBL specular term using probe cubemap
  // For pixels where probe has no geometry (alpha ~ 0), fall through to IBL specular
  let R = reflect(-V, N);
  let MAX_REFLECTION_LOD = 5.0;
  let mipLevel = roughnessVal * MAX_REFLECTION_LOD;

  // Sample both probe and IBL cubemaps
  let probeColor = textureSampleLevel(probeCubemap, probeSamp, R, mipLevel);
  let iblColor = textureSampleLevel(iblSpec, iblCubeSamp, R, mipLevel).rgb;

  // Blend between probe and IBL using probe alpha as coverage.
  // At mip 0, geometry texels have alpha=1 (full probe) and sky texels have alpha=0 (full IBL).
  // At higher mips, edge texels have fractional alpha from the alpha-weighted downsample,
  // producing a smooth transition instead of a hard seam.
  let probeCoverage = saturate(probeColor.a);
  let specularColor = mix(iblColor, probeColor.rgb, probeCoverage);

  // Apply same BRDF integration as IBL specular (Fresnel + BRDF LUT)
  let NdotV = max(dot(N, V), 0.0);
  let F0 = mix(vec3f(0.04), vec3f(1.0), metallicVal);
  let brdf = textureSampleLevel(iblBrdf, iblLutSamp, vec2f(NdotV, roughnessVal), 0.0).rg;
  let specular = specularColor * (F0 * brdf.x + brdf.y);

  return specular * ao;
}
`,

  // Injected into FRAGMENT_POST — after PBR lighting, replaces ONLY the IBL specular
  // component with probe-sampled reflection. Diffuse + direct lighting + shadows are preserved.
  // iblSpecularTerm_ was stored by iblFeature and already added to color.
  // We subtract it out and add the probe specular instead.
  fragmentPostInject: `
  // ---- Reflection Probe: replace IBL specular with probe specular ----
  {
    let probeSpecular = sampleReflectionProbeSpecular(
      N,
      V,
      metallic,
      roughness,
      ao,
      reflectionProbeCubemap,
      reflectionProbeSampler,
      iblSpecular,
      iblCubemapSampler,
      iblBrdfLut,
      iblLutSampler,
    );
    // Swap: remove IBL specular, add probe specular (preserves diffuse + shadows)
    color = color - iblSpecularTerm_ + probeSpecular;
  }
`,
};