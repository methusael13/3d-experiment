/**
 * Object Shadow Pass Shader
 * 
 * Depth-only vertex shader for rendering objects to shadow map.
 * Uses the same vertex layout as the main object shader for consistency.
 */

// Shadow pass uniform buffer
struct ShadowUniforms {
  lightSpaceMatrix: mat4x4f,
}

// Per-object model matrix
struct ModelUniforms {
  modelMatrix: mat4x4f,
}

@group(0) @binding(0) var<uniform> shadow: ShadowUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

// Vertex input - same layout as main object shader
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

@vertex
fn vs_shadow(input: VertexInput) -> @builtin(position) vec4f {
  // Transform to world space, then to light space
  let worldPos = model.modelMatrix * vec4f(input.position, 1.0);
  return shadow.lightSpaceMatrix * worldPos;
}
