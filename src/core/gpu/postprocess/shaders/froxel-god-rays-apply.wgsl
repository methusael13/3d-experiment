/**
 * froxel-god-rays-apply.wgsl — Applies froxel volumetric scattering to scene
 *
 * Fullscreen post-process pass that reads the integrated froxel 3D texture
 * and composites the accumulated in-scattered light + transmittance with
 * the scene color buffer.
 *
 * For each pixel:
 *   1. Read scene depth → compute linear depth
 *   2. Convert to froxel UVW (screen UV + depth slice)
 *   3. Sample integrated 3D texture (trilinear)
 *   4. Apply: finalColor = sceneColor * transmittance + inScatter
 */

struct ApplyUniforms {
  near: f32,
  far: f32,
  viewportWidth: f32,
  viewportHeight: f32,
}

const FROXEL_DEPTH: f32 = 64.0;

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var integratedGrid: texture_3d<f32>;
@group(0) @binding(3) var trilinearSampler: sampler;
@group(0) @binding(4) var<uniform> applyU: ApplyUniforms;

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
  output.uv.y = 1.0 - output.uv.y;
  return output;
}

fn linearizeDepthReversedZ(depth: f32, near: f32, far: f32) -> f32 {
  if (depth == 0.0) { return far; }
  return near * far / (far * depth + near * (1.0 - depth));
}

fn depthToSlice(linearDepth: f32, near: f32, far: f32) -> f32 {
  return log(linearDepth / near) / log(far / near) * FROXEL_DEPTH;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let scene = textureSample(sceneColor, trilinearSampler, uv);

  // Read scene depth
  let depthSize = textureDimensions(depthTexture);
  let depthCoord = vec2u(uv * vec2f(depthSize));
  let rawDepth = textureLoad(depthTexture, depthCoord, 0);
  let linearDepth = linearizeDepthReversedZ(rawDepth, applyU.near, applyU.far);

  // Convert to froxel UVW
  let sliceF = depthToSlice(linearDepth, applyU.near, applyU.far);
  let w = clamp(sliceF / FROXEL_DEPTH, 0.0, 0.999);

  // Sample integrated froxel grid (trilinear)
  let fogSample = textureSampleLevel(integratedGrid, trilinearSampler, vec3f(uv.x, uv.y, w), 0.0);
  let inScatter = fogSample.rgb;
  let transmittance = fogSample.a;

  // Composite: scene fades by transmittance, fog light adds on top
  return vec4f(scene.rgb * transmittance + inScatter, scene.a);
}
