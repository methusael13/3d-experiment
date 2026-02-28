import type { ShaderFeature } from '../composition/types';

/**
 * SSR (Screen Space Reflections) feature module — per-object SSR sampling for
 * metallic opaque objects.
 *
 * Reads the previous frame's SSR texture (1-frame lag, acceptable for subtle
 * metallic reflections) and blends it into the final color at FRAGMENT_POST.
 *
 * The SSR texture is a screen-space rgba16float texture:
 *   RGB = reflected scene color
 *   A   = confidence (0 = no SSR, 1 = full SSR hit)
 *
 * Blending is weighted by:
 *   - metallic value (only metallic surfaces get SSR)
 *   - roughness (smooth = sharp SSR, rough = fade out SSR)
 *   - Fresnel approximation (more SSR at glancing angles)
 *   - SSR confidence (alpha channel)
 *
 * The texture is bound in the textures group (Group 2) and supplied by the
 * VariantRenderer from SSRPass.getPreviousSSRTexture().
 */
export const ssrFeature: ShaderFeature = {
  id: 'ssr',
  stage: 'fragment',

  dependencies: ['ibl'],  // SSR sampling reuses iblLutSampler for bilinear filtering

  resources: [
    {
      name: 'ssrPrevFrameTexture',
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'environment',
      provider: 'SSRPass (previous frame)',
    },
  ],

  functions: `
// ============ SSR Sampling Functions ============

// SSR result struct: carries both the reflected color and the blend weight
struct SSRResult {
  color: vec3f,
  strength: f32,
}

fn sampleSSRForObject(
  clipPos: vec4f,
  N: vec3f,
  V: vec3f,
  metallicVal: f32,
  roughnessVal: f32,
  ssrTex: texture_2d<f32>,
  ssrSamp: sampler,
) -> SSRResult {
  var result: SSRResult;
  result.color = vec3f(0.0);
  result.strength = 0.0;

  // Only apply SSR to metallic surfaces
  if (metallicVal < 0.1) {
    return result;
  }

  // SSR fades with roughness — sharp reflections only on smooth surfaces
  // roughness 0.0 = perfect mirror (full SSR), roughness 0.5 = barely visible, roughness 1.0 = no SSR
  let roughnessFade = 1.0 - smoothstep(0.0, 0.5, roughnessVal);
  if (roughnessFade < 0.01) {
    return result;
  }

  // Screen UV from clip position
  let screenSize = vec2f(f32(textureDimensions(ssrTex).x), f32(textureDimensions(ssrTex).y));
  let screenUV = clipPos.xy / screenSize;

  // Bounds check
  if (screenUV.x < 0.0 || screenUV.x > 1.0 || screenUV.y < 0.0 || screenUV.y > 1.0) {
    return result;
  }

  // Sample previous frame's SSR texture with bilinear filtering
  let ssrSample = textureSampleLevel(ssrTex, ssrSamp, screenUV, 0.0);
  let ssrColor = ssrSample.rgb;
  let ssrConfidence = ssrSample.a;

  if (ssrConfidence < 0.01) {
    return result;
  }

  // Fresnel-weighted blend: more SSR at glancing angles (Schlick approximation)
  let NdotV = max(dot(N, V), 0.0);
  let F0 = mix(0.04, 1.0, metallicVal);
  let fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

  // Final SSR blend weight: confidence × metallic × fresnel × roughness fade
  result.strength = saturate(ssrConfidence * metallicVal * fresnel * roughnessFade);
  result.color = ssrColor;

  return result;
}
`,

  // Injected into FRAGMENT_POST marker — after PBR lighting, before final output
  // SSR REPLACES IBL specular (lerp) rather than adding on top to avoid double-counting.
  // iblSpecularTerm_ is set by iblFeature and contains the IBL specular contribution
  // already included in `color`. We subtract it out proportional to SSR strength and
  // add the SSR reflection instead.
  fragmentPostInject: `
  // ---- SSR for metallic objects (previous frame, 1-frame lag) ----
  {
    let ssrResult = sampleSSRForObject(
      input.clipPosition,
      N,
      V,
      metallic,
      roughness,
      ssrPrevFrameTexture,
      iblLutSampler,
    );
    if (ssrResult.strength > 0.001) {
      // Replace IBL specular with SSR reflection (lerp by SSR strength)
      // Remove the IBL specular that was already added to color, replace with SSR
      color = color - iblSpecularTerm_ * ssrResult.strength + ssrResult.color * ssrResult.strength;
    }
  }
`,
};