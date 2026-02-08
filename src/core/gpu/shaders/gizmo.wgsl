// Gizmo Shader - Renders unlit colored geometry for transform gizmos
//
// Simple shader for rendering colored primitives with model matrix support.
// Used for translate, rotate, and scale gizmos in the scene editor.

// ============================================================================
// Uniforms
// ============================================================================

struct GizmoUniforms {
  viewProjection: mat4x4f,
  model: mat4x4f,
  color: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: GizmoUniforms;

// ============================================================================
// Vertex Input/Output
// ============================================================================

struct VertexInput {
  @location(0) position: vec3f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = uniforms.viewProjection * uniforms.model * vec4f(input.position, 1.0);
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return uniforms.color;
}
