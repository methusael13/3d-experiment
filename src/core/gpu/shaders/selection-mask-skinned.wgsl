/**
 * Selection Mask Shader (Skinned Variant) - Renders selected skinned objects
 * to a binary mask texture with bone-matrix-based vertex skinning.
 *
 * Same as selection-mask.wgsl but adds:
 * - Skin vertex buffer (slot 1) with joint indices + weights
 * - Bone matrices storage buffer (Group 2, binding 0)
 * - computeSkinMatrix() for skeletal animation
 *
 * Uses depth-equal test against the main depth buffer so only visible
 * selected pixels are marked.
 */

struct GlobalUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
}

struct ModelUniforms {
  model: mat4x4f,
}

@group(0) @binding(0) var<uniform> globals: GlobalUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;
@group(2) @binding(0) var<storage, read> boneMatrices: array<mat4x4f>;

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(5) jointIndices: vec4u,   // from skin buffer slot 1
  @location(6) jointWeights: vec4f,   // from skin buffer slot 1
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
}

fn computeSkinMatrix(joints: vec4u, weights: vec4f) -> mat4x4f {
  return boneMatrices[joints.x] * weights.x
       + boneMatrices[joints.y] * weights.y
       + boneMatrices[joints.z] * weights.z
       + boneMatrices[joints.w] * weights.w;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let skinMat = computeSkinMatrix(input.jointIndices, input.jointWeights);
  let skinnedPos = (skinMat * vec4f(input.position, 1.0)).xyz;
  let worldPos = model.model * vec4f(skinnedPos, 1.0);
  output.clipPosition = globals.viewProjection * worldPos;
  return output;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
