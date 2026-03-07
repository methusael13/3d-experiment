import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Multi-Light Feature — adds point and spot light evaluation to PBR shaders.
 *
 * Declares:
 * - LightCounts uniform (environment group)
 * - PointLightData / SpotLightData storage buffers (environment group)
 * - Spot shadow atlas (depth_2d_array + comparison sampler) (environment group)
 * - Cookie atlas (texture_2d_array + sampler) (environment group)
 * - Attenuation helper functions
 * - evaluatePointLights() and evaluateSpotLights() functions with shadow + cookie
 *
 * Injects additional light contribution after the directional light in the
 * fragment shader via fragmentPostInject (additive to existing `color`).
 */
export const multiLightFeature: ShaderFeature = {
  id: 'multi-light',
  stage: 'fragment',

  resources: [
    // LightCounts uniform — { numPoint, numSpot, pad, pad }
    {
      name: RES.LIGHT_COUNTS,
      kind: 'uniform',
      group: 'environment',
      provider: 'LightingSystem',
    },
    // Point lights storage buffer
    {
      name: RES.POINT_LIGHTS_BUFFER,
      kind: 'storage',
      group: 'environment',
      provider: 'LightingSystem',
    },
    // Spot lights storage buffer
    {
      name: RES.SPOT_LIGHTS_BUFFER,
      kind: 'storage',
      group: 'environment',
      provider: 'LightingSystem',
    },
    // Spot shadow atlas depth texture array
    {
      name: RES.SPOT_SHADOW_ATLAS,
      kind: 'texture',
      textureType: 'texture_depth_2d_array',
      group: 'environment',
      provider: 'ShadowRendererGPU',
    },
    // Spot shadow comparison sampler (reuse shadow comparison sampler pattern)
    {
      name: RES.SPOT_SHADOW_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler_comparison',
      group: 'environment',
      provider: 'ShadowRendererGPU',
    },
    // Cookie atlas 2D texture array
    {
      name: RES.COOKIE_ATLAS,
      kind: 'texture',
      textureType: 'texture_2d<f32>',
      group: 'environment',
      provider: 'LightBufferManager',
    },
    // Cookie sampler
    {
      name: RES.COOKIE_SAMPLER,
      kind: 'sampler',
      samplerType: 'sampler',
      group: 'environment',
      provider: 'LightBufferManager',
    },
  ],

  // Struct definitions + attenuation + evaluation functions.
  // These are injected into the FUNCTIONS marker in the template,
  // AFTER the ENVIRONMENT_BINDINGS section (where the var declarations live).
  functions: `
// ---- Multi-Light Structs ----

struct PointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct SpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,
  cookieAtlasIndex: i32,
  cookieIntensity: f32,
  lightSpaceMatrix: mat4x4f,
};

struct LightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

// ---- Attenuation Helpers ----

fn attenuateDistance(dist: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = dist / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (dist * dist + 0.01);
  return window * invDist2;
}

fn attenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

// ---- Spot Shadow Sampling ----

fn sampleSpotShadow(worldPos: vec3f, lightSpaceMatrix: mat4x4f, atlasIndex: i32) -> f32 {
  if (atlasIndex < 0) { return 1.0; } // No shadow
  let lightSpacePos = lightSpaceMatrix * vec4f(worldPos, 1.0);
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  // Map from [-1,1] to [0,1] for UV, keep depth as-is (WebGPU depth is [0,1])
  let shadowUV = projCoords.xy * 0.5 + 0.5;
  let shadowDepth = projCoords.z;
  // Out-of-bounds check
  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0 || shadowDepth > 1.0) {
    return 1.0;
  }
  // Flip Y for texture coordinate convention
  let uv = vec2f(shadowUV.x, 1.0 - shadowUV.y);
  // PCF 2x2 comparison sample
  let bias = 0.002;
  let shadowVal = textureSampleCompareLevel(
    spotShadowAtlas,
    spotShadowSampler,
    uv,
    atlasIndex,
    shadowDepth - bias
  );
  return shadowVal;
}

// ---- Point Light Evaluation ----

fn evaluatePointLights(
  worldPos: vec3f,
  N: vec3f,
  V: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  ior: f32,
) -> vec3f {
  var result = vec3f(0.0);
  let count = lightCounts.numPoint;
  for (var i = 0u; i < count; i = i + 1u) {
    let light = pointLightsBuffer[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let atten = attenuateDistance(dist, light.range) * light.intensity;
    if (atten < 0.001) { continue; }
    let lightColor = light.color * atten;
    result += pbrDirectional(N, V, L, albedo, metallic, roughness, ior, lightColor);
  }
  return result;
}

// ---- Spot Light Evaluation (with shadow + cookie) ----

fn evaluateSpotLights(
  worldPos: vec3f,
  N: vec3f,
  V: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  ior: f32,
) -> vec3f {
  var result = vec3f(0.0);
  let count = lightCounts.numSpot;
  for (var i = 0u; i < count; i = i + 1u) {
    let light = spotLightsBuffer[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let distAtten = attenuateDistance(dist, light.range);
    // Cone attenuation
    let cosAngle = dot(-L, normalize(light.direction));
    let coneAtten = attenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
    var atten = distAtten * coneAtten * light.intensity;
    if (atten < 0.001) { continue; }

    // Spot shadow
    let shadowFactor = sampleSpotShadow(worldPos, light.lightSpaceMatrix, light.shadowAtlasIndex);
    atten *= shadowFactor;
    if (atten < 0.001) { continue; }

    // Cookie modulation (placeholder — cookieAtlas is currently a 2D texture, not array)
    // Full cookie array sampling will be enabled when cookie textures are loaded
    // For now, cookie has no effect (multiply by 1.0)

    let lightColor = light.color * atten;
    result += pbrDirectional(N, V, L, albedo, metallic, roughness, ior, lightColor);
  }
  return result;
}
`,

  // Inject multi-light contribution after the main PBR color computation.
  // This adds to the existing `color` variable (after directional + ambient + emissive).
  // Uses fragmentPostInject so it happens after clearcoat but before final output.
  fragmentPostInject: `
  // Multi-light contribution (point + spot)
  if (!isUnlit) {
    color += evaluatePointLights(input.worldPosition, N, V, albedo, metallic, roughness, abs(ior));
    color += evaluateSpotLights(input.worldPosition, N, V, albedo, metallic, roughness, abs(ior));
  }
`,
};