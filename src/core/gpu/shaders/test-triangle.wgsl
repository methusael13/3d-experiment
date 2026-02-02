// Test Triangle Shader
// Minimal shader for verifying WebGPU pipeline setup

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Hardcoded triangle vertices
  var positions = array<vec2f, 3>(
    vec2f( 0.0,  0.5),   // Top
    vec2f(-0.5, -0.5),   // Bottom left
    vec2f( 0.5, -0.5)    // Bottom right
  );
  
  var colors = array<vec3f, 3>(
    vec3f(1.0, 0.0, 0.0),   // Red
    vec3f(0.0, 1.0, 0.0),   // Green
    vec3f(0.0, 0.0, 1.0)    // Blue
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.color = colors[vertexIndex];
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
