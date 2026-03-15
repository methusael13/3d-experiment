/**
 * cloud-shadow.wgsl — Cloud shadow map generation compute shader
 *
 * Projects cloud density along the sun direction onto a 2D texture.
 * The result is a top-down transmittance map that scene shaders sample
 * to apply soft cloud shadows on terrain, objects, and water.
 *
 * Output: rgba16float (only R channel used = transmittance, 1 = fully lit, 0 = fully shadowed)
 * Resolution: 1024×1024
 */

struct CloudShadowUniforms {
  sunDirection: vec3f,            // [0..11]
  extinctionCoeff: f32,           // [12..15]
  cloudBase: f32,                 // [16..19]
  cloudThickness: f32,            // [20..23]
  coverage: f32,                  // [24..27]
  cloudType: f32,                 // [28..31]
  weatherOffset: vec2f,           // [32..39]
  shadowCenter: vec2f,            // [40..47]  world XZ center of shadow map
  shadowRadius: f32,              // [48..51]  half-extent of shadow map in world units
  resolution: u32,                // [52..55]
  earthRadius: f32,               // [56..59]
  _pad0: f32,                     // [60..63]
}

@group(0) @binding(0) var<uniform> u: CloudShadowUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var shapeNoise: texture_3d<f32>;
@group(0) @binding(3) var weatherMap: texture_2d<f32>;
@group(0) @binding(4) var noiseSampler: sampler;

// ========== Constants ==========

const SHADOW_SAMPLES = 8;

// ========== Utility ==========

fn remap(value: f32, oldMin: f32, oldMax: f32, newMin: f32, newMax: f32) -> f32 {
  return newMin + (saturate((value - oldMin) / (oldMax - oldMin))) * (newMax - newMin);
}

// ========== Height Gradient (matches cloud-raymarch.wgsl) ==========

fn heightGradient(heightFrac: f32, cloudType: f32) -> f32 {
  if (cloudType < 0.25) {
    return smoothstep(0.0, 0.05, heightFrac) * smoothstep(1.0, 0.95, heightFrac);
  } else if (cloudType < 0.6) {
    return smoothstep(0.0, 0.08, heightFrac) * smoothstep(1.0, 0.7, heightFrac);
  } else {
    return smoothstep(0.0, 0.1, heightFrac) * smoothstep(1.0, 0.6, heightFrac);
  }
}

// ========== Simplified Cloud Density (for shadow map — no detail noise) ==========

fn sampleCloudDensity(worldXZ: vec2f, altitude: f32) -> f32 {
  let heightFrac = saturate((altitude - u.cloudBase) / u.cloudThickness);

  let hGrad = heightGradient(heightFrac, u.cloudType);
  if (hGrad < 0.001) { return 0.0; }

  // Weather map
  let weatherUV = fract(worldXZ * 0.00002 + u.weatherOffset);
  let weather = textureSampleLevel(weatherMap, noiseSampler, weatherUV, 0.0);
  let coverageVal = weather.r * u.coverage * 2.5;

  if (coverageVal < 0.05) { return 0.0; }

  // Base shape noise (simplified — use lower frequency for shadow map)
  let noisePos = vec3f(worldXZ.x, (altitude - u.cloudBase), worldXZ.y);
  let uvw = noisePos * 0.0004;
  let shape = textureSampleLevel(shapeNoise, noiseSampler, uvw, 0.0);
  let shapeFBM = shape.r * 0.625 + shape.g * 0.25 + shape.b * 0.125;

  var density = shapeFBM * hGrad;
  density = saturate(remap(density, 1.0 - coverageVal, 1.0, 0.0, 1.0));

  return max(0.0, density);
}

// ========== Main ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let res = u.resolution;
  if (globalId.x >= res || globalId.y >= res) {
    return;
  }

  // Map pixel to world XZ within shadow bounds
  let uv = (vec2f(globalId.xy) + 0.5) / f32(res);
  let worldXZ = u.shadowCenter + (uv * 2.0 - 1.0) * u.shadowRadius;

  // March through cloud layer along sun direction, accumulating optical depth
  var shadowTransmittance = 1.0;
  let stepHeight = u.cloudThickness / f32(SHADOW_SAMPLES);

  for (var i = 0; i < SHADOW_SAMPLES; i++) {
    let sampleAlt = u.cloudBase + (f32(i) + 0.5) / f32(SHADOW_SAMPLES) * u.cloudThickness;

    // Offset the XZ sample position along the sun direction projected to XZ
    // This accounts for the sun angle — shadows are offset horizontally
    let heightAboveBase = sampleAlt - u.cloudBase;
    let sunDirXZ = vec2f(u.sunDirection.x, u.sunDirection.z);
    let sunDirY = max(u.sunDirection.y, 0.1); // prevent division by tiny numbers
    let xzOffset = sunDirXZ * (heightAboveBase / sunDirY);
    let sampleXZ = worldXZ + xzOffset;

    let density = sampleCloudDensity(sampleXZ, sampleAlt);
    shadowTransmittance *= exp(-density * u.extinctionCoeff * stepHeight);
  }

  textureStore(outputTexture, globalId.xy, vec4f(shadowTransmittance, 0.0, 0.0, 0.0));
}
