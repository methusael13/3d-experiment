/**
 * cloud-composite.wgsl — Composites volumetric cloud texture into scene color
 *
 * Reads the cloud ray march result (RGB = scattered light, A = transmittance)
 * and composites it with the scene color, respecting scene depth.
 *
 * Clouds render behind opaque geometry but in front of the sky.
 */

struct CompositeUniforms {
  near: f32,
  far: f32,
  _pad0: f32,
  _pad1: f32,
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

// ========== Fragment ==========

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;

  let scene = textureSample(sceneColor, texSampler, uv);
  let cloud = textureSample(cloudTexture, texSampler, uv);
  // Depth is texture_depth_2d — must use textureLoad (not textureSample)
  let texSize = textureDimensions(depthTexture);
  let depthCoord = vec2u(uv * vec2f(texSize));
  let depth = textureLoad(depthTexture, depthCoord, 0);

  let cloudColor = cloud.rgb;
  let cloudTransmittance = cloud.a;

  // Linearize depth (reversed-Z)
  let linearDepth = linearizeDepthReversedZ(depth, uniforms.near, uniforms.far);

  // Clouds should only appear behind geometry (sky pixels), not in front of objects.
  // Sky pixels have depth=0 in reversed-Z, which linearizes to far plane distance.
  // Any geometry closer than ~95% of the far plane should occlude clouds.
  let isSky = step(uniforms.far * 0.95, linearDepth);  // 1.0 if linearDepth >= far*0.95 (sky)

  // For sky pixels: composite clouds. For geometry: keep scene color.
  // Blend: scene * transmittance + cloudColor (where clouds are visible)
  let compositedColor = scene.rgb * mix(1.0, cloudTransmittance, isSky) + cloudColor * isSky;

  return vec4f(compositedColor, scene.a);
}
