/**
 * Selection Outline Shader - Post-process fullscreen pass
 * 
 * Reads a selection mask texture (r8unorm) where 1.0 = selected, 0.0 = not selected.
 * Applies Sobel edge detection to find the boundary of the selected region.
 * Composites an orange outline onto the backbuffer where edges are detected.
 */

// Bind group 0
@group(0) @binding(0) var selectionMask: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var<uniform> params: OutlineParams;

struct OutlineParams {
  texelSize: vec2f,    // 1.0 / textureSize
  outlineWidth: f32,   // Outline thickness in pixels (1-3)
  _pad: f32,
  outlineColor: vec4f, // RGBA outline color
}

// Fullscreen triangle vertex shader
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  
  // Full-screen triangle (covers entire screen with single triangle)
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  
  output.position = vec4f(x, y, 0.0, 1.0);
  output.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  
  return output;
}

// Sample the selection mask at an offset (in pixels)
fn sampleMask(uv: vec2f, offsetPixels: vec2f) -> f32 {
  let sampleUV = uv + offsetPixels * params.texelSize;
  return textureSample(selectionMask, sceneSampler, sampleUV).r;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  let w = params.outlineWidth;
  
  // Sample the center pixel mask value
  let center = sampleMask(uv, vec2f(0.0, 0.0));
  
  // Sample 8 neighbors for Sobel-like edge detection
  // Scaled by outline width
  let tl = sampleMask(uv, vec2f(-w, -w));
  let t  = sampleMask(uv, vec2f( 0.0, -w));
  let tr = sampleMask(uv, vec2f( w, -w));
  let l  = sampleMask(uv, vec2f(-w,  0.0));
  let r  = sampleMask(uv, vec2f( w,  0.0));
  let bl = sampleMask(uv, vec2f(-w,  w));
  let b  = sampleMask(uv, vec2f( 0.0,  w));
  let br = sampleMask(uv, vec2f( w,  w));
  
  // Sobel operator for edge detection
  // Gx = [-1 0 1; -2 0 2; -1 0 1]
  // Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  let gx = (-tl - 2.0 * l - bl) + (tr + 2.0 * r + br);
  let gy = (-tl - 2.0 * t - tr) + (bl + 2.0 * b + br);
  
  let edgeMagnitude = sqrt(gx * gx + gy * gy);
  
  // Threshold: any edge is an outline pixel
  let isEdge = step(0.1, edgeMagnitude);
  
  // Only draw outline on pixels that are NOT inside the selection (outside edge)
  // OR on the border. This creates a clean external outline.
  // For internal + external outline, just use isEdge directly.
  let outlineAlpha = isEdge * params.outlineColor.a;
  
  // Output: premultiplied alpha blend (orange outline with alpha)
  return vec4f(params.outlineColor.rgb * outlineAlpha, outlineAlpha);
}