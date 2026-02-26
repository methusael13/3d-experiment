import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * IBL (Image-Based Lighting) feature module.
 *
 * Replaces hemisphere ambient with environment map sampling:
 * - Diffuse irradiance cubemap
 * - Specular pre-filtered cubemap (mipmap roughness)
 * - BRDF integration LUT (split-sum approximation)
 *
 * When this feature is NOT active, the template falls back to hemisphereAmbient().
 */
export const iblFeature: ShaderFeature = {
  id: 'ibl',
  stage: 'fragment',

  resources: [
    {
      name: RES.IBL_DIFFUSE,
      kind: 'texture',
      textureType: 'texture_cube<f32>',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.IBL_SPECULAR,
      kind: 'texture',
      textureType: 'texture_cube<f32>',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.IBL_BRDF_LUT,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.IBL_CUBEMAP_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.IBL_LUT_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
  ],

  functions: `
// ============ IBL Functions ============

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  let oneMinusRoughness = vec3f(1.0 - roughness);
  return F0 + (max(oneMinusRoughness, F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn sampleIBL(
  N: vec3f,
  V: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  ao: f32
) -> vec3f {
  let NdotV = max(dot(N, V), 0.0);
  let F0 = mix(vec3f(0.04), albedo, metallic);
  let F = fresnelSchlickRoughness(NdotV, F0, roughness);

  // Diffuse IBL
  let irradiance = textureSample(iblDiffuse, iblCubemapSampler, N).rgb;
  let kD = (vec3f(1.0) - F) * (1.0 - metallic);
  let diffuse = irradiance * albedo * kD;

  // Specular IBL
  let R = reflect(-V, N);
  let MAX_REFLECTION_LOD = 5.0;
  let mipLevel = roughness * MAX_REFLECTION_LOD;
  let prefilteredColor = textureSampleLevel(iblSpecular, iblCubemapSampler, R, mipLevel).rgb;
  let brdf = textureSample(iblBrdfLut, iblLutSampler, vec2f(NdotV, roughness)).rg;
  let specular = prefilteredColor * (F0 * brdf.x + brdf.y);

  return (diffuse + specular) * ao;
}

fn iblAmbient(
  N: vec3f,
  V: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  ao: f32,
  ambientIntensity: f32
) -> vec3f {
  return sampleIBL(N, V, albedo, metallic, roughness, ao) * ambientIntensity;
}
`,

  // Override the hemisphere ambient with IBL
  fragmentInject: `
  ambient = iblAmbient(N, V, albedo, metallic, roughness, ao, globals.ambientIntensity);
`,
};