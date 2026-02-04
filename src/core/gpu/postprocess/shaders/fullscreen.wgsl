// Fullscreen Triangle Vertex Shader
// Uses a single triangle that covers the entire screen (more efficient than quad)
// No vertex buffer needed - vertices generated from vertex ID

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// Fullscreen triangle vertex shader
// Generates a single triangle that covers the entire viewport
// vertex 0: (-1, -1), uv (0, 1)
// vertex 1: (3, -1),  uv (2, 1) 
// vertex 2: (-1, 3),  uv (0, -1)
@vertex
fn vs_fullscreen(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  
  // Generate vertex positions for fullscreen triangle
  // This creates a triangle that extends past the viewport edges
  // but covers the entire visible area
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  
  output.position = vec4f(x, y, 0.0, 1.0);
  
  // UV coordinates (0,0 at top-left, 1,1 at bottom-right)
  // Note: Y is flipped because NDC has Y pointing up, but textures have Y pointing down
  output.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  
  return output;
}

// Simple passthrough fragment shader (for testing/copying)
@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

@fragment
fn fs_passthrough(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, input.uv);
}
