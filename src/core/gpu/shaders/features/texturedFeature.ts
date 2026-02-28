import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Textured feature module — PBR texture sampling.
 *
 * Injects baseColor, normal map, metallic-roughness, occlusion, and emissive
 * texture sampling into the fragment shader. When this feature is NOT active,
 * the material uniform values are used directly (no-texture path).
 *
 * Texture resources are in the 'textures' bind group (Group 2).
 */
export const texturedFeature: ShaderFeature = {
  id: 'textured',
  stage: 'fragment',

  resources: [
    {
      name: RES.BASE_COLOR_TEX,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.BASE_COLOR_SAMP,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.NORMAL_TEX,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.NORMAL_SAMP,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.METALLIC_ROUGHNESS_TEX,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.METALLIC_ROUGHNESS_SAMP,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.OCCLUSION_TEX,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.OCCLUSION_SAMP,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.EMISSIVE_TEX,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'textures',
      provider: 'MeshComponent',
    },
    {
      name: RES.EMISSIVE_SAMP,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'textures',
      provider: 'MeshComponent',
    },
  ],

  functions: '', // No additional functions needed — uses template's srgbToLinear and cotangentFrame

  // Injected at /*{{FRAGMENT_TEXTURE_SAMPLING}}*/ in the template
  fragmentInject: `
  // Base color texture
  if (hasBaseColorTex) {
    let texColor = textureSample(baseColorTexture, baseColorSampler, input.uv);
    albedo = srgbToLinear(texColor.rgb) * material.albedo;
    alpha = texColor.a;

    if (material.useAlphaCutoff > 0.5 && alpha < material.alphaCutoff) {
      discard;
    }
  }

  // Metallic-roughness texture
  if (hasMetallicRoughnessTex) {
    let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.uv);
    roughness = material.roughness * mrSample.g;
    metallic = material.metallic * mrSample.b;
  }

  // Normal map
  if (hasNormalTex) {
    let TBN = cotangentFrame(N, input.worldPosition, input.uv);
    let normalSample = textureSample(normalTexture, normalSampler, input.uv).xyz;
    var tangentNormal = normalSample * 2.0 - 1.0;
    tangentNormal = vec3f(tangentNormal.xy * material.normalScale, tangentNormal.z);
    N = normalize(TBN * tangentNormal);
  }

  // Occlusion texture
  if (hasOcclusionTex) {
    let aoSample = textureSample(occlusionTexture, occlusionSampler, input.uv).r;
    ao = 1.0 + material.occlusionStrength * (aoSample - 1.0);
  }

  // Emissive texture
  if (material.hasEmissiveTex > 0.5) {
    let emissiveSample = textureSample(emissiveTexture, emissiveSampler, input.uv).rgb;
    emissive = srgbToLinear(emissiveSample) * material.emissiveFactor;
  }
`,
};