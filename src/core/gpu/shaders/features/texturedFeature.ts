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

  functions: `
// Triplanar texture sampling — samples a 2D texture 3× using world-space XY/YZ/XZ projections,
// blends based on surface normal. Eliminates UV seams on spheres and arbitrary geometry.
fn triplanarSample(tex: texture_2d<f32>, samp: sampler, worldPos: vec3f, worldNormal: vec3f, scale: f32) -> vec4f {
  // Ensure the normal is unit length to keep weights consistent
  let n = abs(normalize(worldNormal));
  
  // Use smoothstep for very gradual transitions between projection planes.
  // Each axis weight ramps smoothly from 0 to 1 based on how dominant that axis is.
  var blend = vec3f(
    smoothstep(0.0, 0.5, n.x),
    smoothstep(0.0, 0.5, n.y),
    smoothstep(0.0, 0.5, n.z)
  );
  
  // Force weights to sum to 1.0
  let blendSum = blend.x + blend.y + blend.z;
  blend = blend / max(blendSum, 0.00001);

  // Scale UVs
  let uvX = worldPos.yz * scale;
  let uvY = worldPos.xz * scale;
  let uvZ = worldPos.xy * scale;

  // Sample
  let sampleX = textureSample(tex, samp, uvX);
  let sampleY = textureSample(tex, samp, uvY);
  let sampleZ = textureSample(tex, samp, uvZ);

  return sampleX * blend.x + sampleY * blend.y + sampleZ * blend.z;
}
`,

  // Injected at /*{{FRAGMENT_TEXTURE_SAMPLING}}*/ in the template
  fragmentInject: `
  // Triplanar mode flag
  let useTriplanar = material.triplanarMode > 0.5;
  let triScale = material.triplanarScale;

  // Base color texture
  if (hasBaseColorTex) {
    var texColor: vec4f;
    if (useTriplanar) {
      texColor = triplanarSample(baseColorTexture, baseColorSampler, input.worldPosition, N, triScale);
    } else {
      texColor = textureSample(baseColorTexture, baseColorSampler, input.uv);
    }
    albedo = srgbToLinear(texColor.rgb) * material.albedo;
    alpha = texColor.a;

    if (material.useAlphaCutoff > 0.5 && alpha < material.alphaCutoff) {
      discard;
    }
  }

  // Metallic-roughness texture
  if (hasMetallicRoughnessTex) {
    var mrSample: vec4f;
    if (useTriplanar) {
      mrSample = triplanarSample(metallicRoughnessTexture, metallicRoughnessSampler, input.worldPosition, N, triScale);
    } else {
      mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.uv);
    }
    roughness = material.roughness * mrSample.g;
    metallic = material.metallic * mrSample.b;
  }

  // Normal map (triplanar normal mapping is complex — use UV path only for normal maps)
  if (hasNormalTex) {
    let TBN = cotangentFrame(N, input.worldPosition, input.uv);
    let normalSample = textureSample(normalTexture, normalSampler, input.uv).xyz;
    var tangentNormal = normalSample * 2.0 - 1.0;
    tangentNormal = vec3f(tangentNormal.xy * material.normalScale, tangentNormal.z);
    N = normalize(TBN * tangentNormal);
  }

  // Occlusion texture
  if (hasOcclusionTex) {
    var aoSample: f32;
    if (useTriplanar) {
      aoSample = triplanarSample(occlusionTexture, occlusionSampler, input.worldPosition, N, triScale).r;
    } else {
      aoSample = textureSample(occlusionTexture, occlusionSampler, input.uv).r;
    }
    ao = 1.0 + material.occlusionStrength * (aoSample - 1.0);
  }

  // Emissive texture
  if (material.hasEmissiveTex > 0.5) {
    var emissiveSample: vec3f;
    if (useTriplanar) {
      emissiveSample = triplanarSample(emissiveTexture, emissiveSampler, input.worldPosition, N, triScale).rgb;
    } else {
      emissiveSample = textureSample(emissiveTexture, emissiveSampler, input.uv).rgb;
    }
    emissive = srgbToLinear(emissiveSample) * material.emissiveFactor;
  }
`,
};