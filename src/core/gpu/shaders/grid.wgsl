// Grid Shader - Renders grid lines and axis indicators
//
// Simple shader for rendering colored line primitives.
// Used for debug visualization of coordinate systems.

// ============================================================================
// Uniforms
// ============================================================================

struct GridUniforms {
  viewProjection: mat4x4f,
}

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

// ============================================================================
// Vertex Input/Output
// ============================================================================

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) color: vec3f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(input.position, 1.0);
  output.color = input.color;
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
