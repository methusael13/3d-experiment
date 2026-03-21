/**
 * cloud-composite.wgsl — Composites volumetric cloud texture into scene color
 *
 * Reads the cloud ray march result (RGB = scattered light, A = transmittance)
 * and composites it with the scene color, respecting scene depth.
 *
 * Phase 3: The cloud texture is now at half resolution. This shader performs
 * a bilateral upscale using scene depth as the edge-preserving weight, so
 * cloud edges align cleanly with geometry boundaries.
 *
 * Clouds render behind opaque geometry but in front of the sky.
 */

struct CompositeUniforms {
  inverseViewProj: mat4x4f,  // [0..63]  For reconstructing world-space view direction (cirrus)
  near: f32,                  // [64]
  far: f32,                   // [68]
  cloudTexWidth: f32,         // [72]
  cloudTexHeight: f32,        // [76]
  cirrusOpacity: f32,         // [80]
  cirrusWindOffsetX: f32,     // [84]
  cirrusWindOffsetY: f32,     // [88]
  _pad: f32,                  // [92]
}

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var cloudTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: CompositeUniforms;

// ========== Fullscreen Triangle ==========

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (covers [-1, 1] in clip space)
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

// ========== Depth Utilities ==========

/// Reversed-Z linearization: near maps to 1.0, far maps to 0.0
fn linearizeDepthReversedZ(depth: f32, near: f32, far: f32) -> f32 {
  // Reversed-Z: depth=1.0 at near, depth=0.0 at far
  // For sky pixels, depth ≈ 0.0 (far plane)
  if (depth == 0.0) {
    return far; // Sky / infinite distance
  }
  return near * far / (far * depth + near * (1.0 - depth));
}

// ========== Bilateral Upscale ==========

/// Bilateral upscale: samples 4 nearest half-res texels, weighted by depth similarity.
/// This preserves sharp edges at geometry boundaries while smoothly upscaling clouds.
fn bilateralUpscale(uv: vec2f, centerDepth: f32) -> vec4f {
  let cloudSize = vec2f(uniforms.cloudTexWidth, uniforms.cloudTexHeight);
  let texelSize = 1.0 / cloudSize;

  // Position in the half-res texture (continuous)
  let halfResPos = uv * cloudSize - 0.5;
  let baseCoord = floor(halfResPos);
  let frac = halfResPos - baseCoord;

  // Sample 4 nearest neighbors in the cloud texture
  var totalWeight = 0.0;
  var totalColor = vec4f(0.0);

  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      let offset = vec2f(f32(dx), f32(dy));
      let sampleCoord = baseCoord + offset;

      // Clamp to valid range
      let clampedCoord = clamp(sampleCoord, vec2f(0.0), cloudSize - 1.0);
      let sampleUV = (clampedCoord + 0.5) / cloudSize;

      // Sample cloud
      let cloudSample = textureSample(cloudTexture, texSampler, sampleUV);

      // Bilinear weight
      let bilinearWeight = mix(1.0 - frac.x, frac.x, f32(dx)) *
                           mix(1.0 - frac.y, frac.y, f32(dy));

      // Transmittance-aware weight: prevent blending cloud texels (low transmittance)
      // with empty sky texels (transmittance=1). The cloud mask (1 - transmittance)
      // ensures that empty/sky samples get nearly zero weight when mixed with cloud
      // samples, eliminating the stippled dots at cloud boundaries.
      let cloudPresence = 1.0 - cloudSample.a; // 0 = sky, 1 = opaque cloud
      let transmittanceWeight = max(cloudPresence, 0.05); // floor at 0.05 so sky isn't totally zeroed
      let weight = max(bilinearWeight * transmittanceWeight, 0.001);

      totalColor += cloudSample * weight;
      totalWeight += weight;
    }
  }

  return totalColor / max(totalWeight, 0.0001);
}

// ========== Procedural Cirrus Noise (Phase 5) ==========
// Inline hash-based noise for thin, streaky cirrus clouds at high altitude.
// No separate texture needed — ~0.05ms cost (single texture-free FBM per sky pixel).

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  // Smooth interpolation (Hermite)
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i + vec2f(0.0, 0.0)), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}

/// Cirrus FBM: 4 octaves of value noise producing thin, stretched wisps.
/// UV is stretched 3× in X to create the characteristic elongated cirrus streaks.
fn cirrusFBM(uv: vec2f) -> f32 {
  let stretchedUV = vec2f(uv.x * 3.0, uv.y); // Elongate horizontally
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var i = 0; i < 4; i++) {
    value += amplitude * valueNoise(stretchedUV * frequency);
    frequency *= 2.2;
    amplitude *= 0.45;
  }
  // Remap to produce thin wisps: sharpen the contrast
  return smoothstep(0.35, 0.65, value);
}

// ========== Fragment ==========

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;

  let scene = textureSample(sceneColor, texSampler, uv);

  // Bilateral upscale from half-res cloud texture
  let texSize = textureDimensions(depthTexture);
  let depthCoord = vec2u(uv * vec2f(texSize));
  let depth = textureLoad(depthTexture, depthCoord, 0);
  let linearDepth = linearizeDepthReversedZ(depth, uniforms.near, uniforms.far);

  let cloud = bilateralUpscale(uv, linearDepth);

  let cloudColor = cloud.rgb;
  let cloudTransmittance = cloud.a;

  // Clouds should only appear behind geometry (sky pixels), not in front of objects.
  let isSky = step(uniforms.far * 0.95, linearDepth);

  // ── Cirrus layer (Phase 5) ──────────────────────────────────────────
  // Rendered BEFORE volumetric clouds so volumetric clouds correctly occlude cirrus.
  // Thin, high-altitude (8,000–12,000m) ice cloud wisps.
  // Uses world-space view direction XZ so cirrus is anchored to the sky dome,
  // not stuck to the screen.
  var cirrusContribution = vec3f(0.0);
  var cirrusAlpha = 0.0;
  if (uniforms.cirrusOpacity > 0.001 && isSky > 0.5) {
    // Reconstruct world-space view direction from screen UV via inverseViewProj
    let ndc = vec2f(uv.x * 2.0 - 1.0, -(uv.y * 2.0 - 1.0)); // flip Y for clip space
    let clipFar = vec4f(ndc.x, ndc.y, 1.0, 1.0);
    let worldFar = uniforms.inverseViewProj * clipFar;
    let worldDir = normalize(worldFar.xyz / worldFar.w);

    // Project view direction onto the cirrus dome at ~10,000m altitude
    // Use direction XZ / Y to get a spherical projection that stays stable
    // when the camera rotates. Divide by abs(Y)+epsilon to flatten near horizon.
    let denom = max(abs(worldDir.y), 0.05);
    let cirrusBaseUV = worldDir.xz / denom;

    let windOffset = vec2f(uniforms.cirrusWindOffsetX, uniforms.cirrusWindOffsetY);
    // Scale: multiply to control pattern size (larger = finer detail)
    let cirrusUV = cirrusBaseUV * 0.5 + windOffset;
    let noise = cirrusFBM(cirrusUV);
    cirrusAlpha = noise * uniforms.cirrusOpacity;

    // Fade out near horizon to avoid stretching artifacts
    let horizonFade = smoothstep(0.02, 0.15, worldDir.y);
    cirrusAlpha *= horizonFade;

    // Cirrus is bright white (ice crystals), slightly tinted by sky
    cirrusContribution = vec3f(0.9, 0.92, 0.95) * cirrusAlpha * 0.5;
  }

  // ── Composite order: scene → cirrus → volumetric clouds ────────────
  // Cirrus goes behind volumetric clouds (higher altitude)
  var result = scene.rgb;

  // 1. Add cirrus to sky pixels (behind everything)
  result = result + cirrusContribution * isSky;

  // 2. Composite volumetric clouds on top (they occlude cirrus behind them)
  result = result * mix(1.0, cloudTransmittance, isSky) + cloudColor * isSky;

  return vec4f(result, scene.a);
}
