import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Shadow feature module — injects shadow map sampling (single + CSM).
 *
 * Replaces the sampleShadow() / sampleCSMShadow() / sampleSingleShadow()
 * functions that were baked into object.wgsl.
 *
 * Environment resources: shadowMap, shadowSampler, csmShadowArray, csmUniforms
 */
export const shadowFeature: ShaderFeature = {
  id: 'shadow',
  stage: 'fragment',

  resources: [
    {
      name: RES.SHADOW_MAP,
      kind: 'texture',
      textureType: 'texture_depth_2d',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.SHADOW_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler_comparison',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.CSM_SHADOW_ARRAY,
      kind: 'texture',
      textureType: 'texture_depth_2d_array',
      group: 'environment',
      provider: 'SceneEnvironment',
    },
    {
      name: RES.CSM_UNIFORMS,
      kind: 'uniform',
      wgslType: 'mat4x4f', // Placeholder — actual struct is CSMUniforms
      group: 'environment',
      provider: 'SceneEnvironment',
    },
  ],

  functions: `
// ============ Shadow Functions ============
// Note: CSMUniforms struct is defined in the environment bindings section
// (emitted by ShaderComposer.buildEnvironmentBindings before this block).

fn sampleSingleShadow(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));

  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = globals.shadowBias;
  let slopeBias = 0.002;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);

  let shadowValue = textureSampleCompare(shadowMap, shadowSampler, clampedUV, clampedDepth);

  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;

  return mix(1.0, shadowValue, inBounds);
}

fn selectCascade(viewDepth: f32) -> i32 {
  let cascadeCount = i32(csmUniforms.config.x);
  if (viewDepth < csmUniforms.cascadeSplits.x) { return 0; }
  if (viewDepth < csmUniforms.cascadeSplits.y && cascadeCount > 1) { return 1; }
  if (viewDepth < csmUniforms.cascadeSplits.z && cascadeCount > 2) { return 2; }
  if (cascadeCount > 3) { return 3; }
  return cascadeCount - 1;
}

fn sampleCascadeShadow(worldPos: vec4f, cascade: i32, normal: vec3f, lightDir: vec3f) -> f32 {
  let lightSpacePos = csmUniforms.viewProjectionMatrices[cascade] * worldPos;
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));

  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let cascadeBias = 0.001 * (1.0 + f32(cascade) * 0.5);
  let shadowBias = cascadeBias + clamp(slopeFactor, 0.0, 5.0) * cascadeBias * 2.0;
  let biasedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);

  let cascadeSize = textureDimensions(csmShadowArray);
  let texelSize = vec2f(1.0 / f32(cascadeSize.x), 1.0 / f32(cascadeSize.y));

  var shadowVal = 0.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      let offset = vec2f(f32(x), f32(y)) * texelSize;
      let sampleUV = clamp(clampedUV + offset, vec2f(0.001), vec2f(0.999));
      shadowVal += textureSampleCompareLevel(csmShadowArray, shadowSampler, sampleUV, cascade, biasedDepth);
    }
  }
  shadowVal /= 9.0;

  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;

  return mix(1.0, shadowVal, inBounds);
}

fn sampleCSMShadow(worldPos: vec4f, viewDepth: f32, normal: vec3f, lightDir: vec3f) -> f32 {
  let cascade = selectCascade(viewDepth);
  let cascadeCount = i32(csmUniforms.config.x);

  var cascadeSplit = csmUniforms.cascadeSplits.x;
  if (cascade == 1) { cascadeSplit = csmUniforms.cascadeSplits.y; }
  else if (cascade == 2) { cascadeSplit = csmUniforms.cascadeSplits.z; }
  else if (cascade == 3) { cascadeSplit = csmUniforms.cascadeSplits.w; }

  let shadow0 = sampleCascadeShadow(worldPos, cascade, normal, lightDir);

  let blendRegion = cascadeSplit * csmUniforms.config.z;
  let blendStart = cascadeSplit - blendRegion;

  if (viewDepth > blendStart && cascade < cascadeCount - 1) {
    let shadow1 = sampleCascadeShadow(worldPos, cascade + 1, normal, lightDir);
    let blendFactor = smoothstep(blendStart, cascadeSplit, viewDepth);
    return mix(shadow0, shadow1, blendFactor);
  }

  return shadow0;
}

fn sampleShadow(lightSpacePos: vec4f, worldPos: vec3f, normal: vec3f, lightDir: vec3f) -> f32 {
  if (globals.shadowEnabled < 0.5) {
    return 1.0;
  }

  if (globals.csmEnabled > 0.5) {
    let cameraFwd = normalize(csmUniforms.cameraForward.xyz);
    let viewDepth = abs(dot(worldPos - globals.cameraPosition, cameraFwd));
    return sampleCSMShadow(vec4f(worldPos, 1.0), viewDepth, normal, lightDir);
  } else {
    return sampleSingleShadow(lightSpacePos, normal, lightDir);
  }
}
`,

  fragmentInject: `
  shadow = sampleShadow(input.lightSpacePos, input.worldPosition, N, L);
`,
};