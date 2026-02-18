/**
 * Selection Mask Shader - Renders selected objects to a binary mask texture
 * 
 * Uses the same vertex layout as object.wgsl but outputs a flat white (1.0)
 * for any rendered pixel. Used with depth-equal test against the main depth
 * buffer so only visible selected pixels are marked.
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

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = model.model * vec4f(input.position, 1.0);
  output.clipPosition = globals.viewProjection * worldPos;
  return output;
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}