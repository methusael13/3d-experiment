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
    // Stratus/overcast: thin flat slab
    return smoothstep(0.0, 0.05, heightFrac) * smoothstep(1.0, 0.90, heightFrac);
  } else if (cloudType < 0.6) {
    // Stratocumulus: slightly lumpy layer, denser in the middle
    let base = smoothstep(0.0, 0.10, heightFrac) * smoothstep(1.0, 0.55, heightFrac);
    return base * (0.6 + 0.4 * smoothstep(0.15, 0.40, heightFrac));
  } else {
    // Cumulus: sharp bottom, dense middle, rounded puffy top
    let base = smoothstep(0.0, 0.15, heightFrac) * smoothstep(1.0, 0.35, heightFrac);
    let bulge = 0.5 + 0.5 * smoothstep(0.15, 0.45, heightFrac);
    return base * bulge;
  }
}

// ========== Simplified Cloud Density (for shadow map — no detail noise) ==========

fn sampleCloudDensity(worldXZ: vec2f, altitude: f32) -> f32 {
  let heightFrac = saturate((altitude - u.cloudBase) / u.cloudThickness);

  let hGrad = heightGradient(heightFrac, u.cloudType);
  if (hGrad < 0.001) { return 0.0; }

  // Weather map — no fract(), let the repeat sampler handle wrapping seamlessly
  let weatherUV = worldXZ * 0.00002 + u.weatherOffset + vec2f(500.0, 500.0);
  let weather = textureSampleLevel(weatherMap, noiseSampler, weatherUV, 0.0);
  let coverageVal = weather.r * u.coverage * 2.5;

  if (coverageVal < 0.05) { return 0.0; }

  // Base shape noise (simplified — use lower frequency for shadow map)
  // Offset to push 3D texture repeat boundaries far from world origin (matches cloud-raymarch.wgsl)
  let noisePos = vec3f(worldXZ.x + 50000.0, (altitude - u.cloudBase), worldXZ.y + 50000.0);
  let uvw = noisePos * 0.00025;
  let shape = textureSampleLevel(shapeNoise, noiseSampler, uvw, 0.0);
  // FBM weights must match cloud-raymarch.wgsl
  let shapeFBM = shape.r * 0.75 + shape.g * 0.15 + shape.b * 0.10;

  // Soft coverage using smoothstep (matches cloud-raymarch.wgsl)
  var density = shapeFBM * hGrad;
  let coverageThreshold = 1.0 - coverageVal;
  density = smoothstep(coverageThreshold - 0.35, coverageThreshold + 0.15, density);

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
