/**
 * god-rays.wgsl — Screen-space radial blur god rays (volumetric light scattering)
 *
 * Projects the sun position to screen space, then performs a radial blur
 * from each pixel toward the sun. Sky pixels contribute light; occluders
 * (terrain, objects) and clouds block it. The result is an additive light
 * contribution blended into the scene.
 *
 * Runs as a post-process effect at order 130 (after cloud composite @125,
 * before atmospheric fog @150).
 *
 * Inputs:
 *   - Scene color (for reading scene luminance at sun position)
 *   - Scene depth (sky vs geometry discrimination)
 *   - Cloud texture (cloud transmittance for occlusion) — optional
 *
 * Output:
 *   - Additive god ray contribution composited into scene color
 */

struct GodRayUniforms {
  // Sun screen-space position (UV, 0-1 range)
  sunScreenPos: vec2f,
  // Intensity / exposure multiplier
  intensity: f32,
  // Number of radial blur samples (32, 64, or 128)
  numSamples: f32,
  // Sun color (HDR, pre-multiplied by sun intensity)
  sunColor: vec3f,
  // Decay factor per sample (exponential falloff along ray)
  decay: f32,
  // Near plane
  near: f32,
  // Far plane
  far: f32,
  // Sun visibility factor (0 = below horizon, 1 = fully visible)
  sunVisibility: f32,
  // Whether cloud texture is available (1.0 = yes, 0.0 = no)
  hasCloudTexture: f32,
  // Cloud texture dimensions (for manual LOD)
  cloudTexWidth: f32,
  cloudTexHeight: f32,
  // Weight: how much each sample contributes
  weight: f32,
  // Density: controls the length of rays
  density: f32,
}

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var cloudTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> u: GodRayUniforms;

// ========== Fullscreen Triangle ==========

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  let pos = positions[vertexIndex];
  var output: VertexOutput;
  output.position = vec4f(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  output.uv.y = 1.0 - output.uv.y; // Flip Y for texture sampling
  return output;
}

// ========== God Ray Radial Blur ==========

/// Check if a depth value represents sky (reversed-Z: sky is at 0.0)
fn isSkyPixel(depth: f32) -> f32 {
  // In reversed-Z, depth=0.0 is the far plane (sky)
  // Use a small threshold to catch near-zero values
  return step(depth, 0.0001);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;

  // Read original scene color
  let scene = textureSample(sceneColor, texSampler, uv);

  // Early out: if sun is below horizon, no god rays
  if (u.sunVisibility < 0.01) {
    return scene;
  }

  // Direction from this pixel toward the sun in screen space
  let toSun = u.sunScreenPos - uv;
  let numSamples = u.numSamples;
  let deltaUV = toSun * u.density / numSamples;

  var sampleUV = uv;
  var accumLight = vec3f(0.0);
  var currentDecay = 1.0;

  let depthSize = textureDimensions(depthTexture);

  // Radial blur: march from pixel toward sun, accumulating light
  for (var i = 0; i < 128; i++) {
    // Dynamic loop bound (WGSL requires compile-time for loop bound)
    if (f32(i) >= numSamples) { break; }

    sampleUV += deltaUV;

    // Clamp to valid UV range to avoid sampling outside texture
    let clampedUV = clamp(sampleUV, vec2f(0.001), vec2f(0.999));

    // Sample scene depth: sky pixels contribute light, geometry blocks it
    let depthCoord = vec2u(clampedUV * vec2f(depthSize));
    let depth = textureLoad(depthTexture, depthCoord, 0);
    let skyFactor = isSkyPixel(depth);

    // Sample cloud transmittance (if cloud texture is available)
    // Clouds partially occlude god rays — dense clouds block light
    var cloudOcclusion = 1.0;
    if (u.hasCloudTexture > 0.5) {
      let cloudSample = textureSample(cloudTexture, texSampler, clampedUV);
      // Cloud texture: A = transmittance (1.0 = clear sky, 0.0 = opaque cloud)
      cloudOcclusion = cloudSample.a;
    }

    // Accumulate: sky pixels that aren't blocked by clouds contribute light
    accumLight += skyFactor * cloudOcclusion * currentDecay * u.sunColor;

    // Exponential decay along the ray
    currentDecay *= u.decay;
  }

  // Final god ray contribution: normalize by sample count, apply intensity and weight
  let godRay = accumLight * u.weight * u.intensity * u.sunVisibility / numSamples;

  // Additive blend: god rays add light to the scene
  return vec4f(scene.rgb + godRay, scene.a);
}
