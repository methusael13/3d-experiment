// Debug View Shader — Fullscreen visualization of depth or normals buffers
// Renders on top of the scene to the backbuffer

struct DebugViewParams {
  // x = mode (0 = off, 1 = depth, 2 = normals, 3 = SSR), y = near, z = far, w = unused
  params: vec4f,
}

@group(0) @binding(0) var<uniform> debugView: DebugViewParams;
@group(0) @binding(1) var depthTexture: texture_depth_2d;
@group(0) @binding(2) var normalsTexture: texture_2d<f32>;
@group(0) @binding(3) var ssrTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  output.position = vec4f(x, y, 0.0, 1.0);
  output.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Linearize reversed-Z depth
fn linearizeDepthReversed(d: f32, near: f32, far: f32) -> f32 {
  return near * far / (near + d * (far - near));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let mode = i32(debugView.params.x);
  let near = debugView.params.y;
  let far = debugView.params.z;
  let texSize = vec2f(f32(textureDimensions(depthTexture).x), f32(textureDimensions(depthTexture).y));
  let texCoord = vec2i(input.uv * texSize);

  if (mode == 1) {
    // Depth visualization: linearized, remapped to grayscale
    let rawDepth = textureLoad(depthTexture, texCoord, 0);
    if (rawDepth < 0.0001) {
      return vec4f(0.0, 0.0, 0.2, 1.0); // Sky = dark blue
    }
    let linearDepth = linearizeDepthReversed(rawDepth, near, far);
    // Remap: 0m = white, 500m+ = black
    let normalized = 1.0 - saturate(linearDepth / 500.0);
    return vec4f(vec3f(normalized), 1.0);
  }

  if (mode == 2) {
    // Normals visualization
    let rawDepth = textureLoad(depthTexture, texCoord, 0);
    if (rawDepth < 0.0001) {
      return vec4f(0.0, 0.0, 0.0, 1.0); // Sky = black
    }
    
    // Try G-buffer normals first
    let packed = textureLoad(normalsTexture, texCoord, 0);
    let normalLength = length(packed.xyz);
    
    if (normalLength > 0.01) {
      // G-buffer has data: packed normals are in [0,1], display directly as RGB
      return vec4f(packed.xyz, 1.0);
    }
    
    // Fallback: reconstruct from depth derivatives
    let width = texSize.x;
    let height = texSize.y;
    let uv = input.uv;
    let texelSize = vec2f(1.0 / width, 1.0 / height);
    
    let depthR = textureLoad(depthTexture, vec2i(vec2f(texCoord) + vec2f(1.0, 0.0)), 0);
    let depthU = textureLoad(depthTexture, vec2i(vec2f(texCoord) + vec2f(0.0, -1.0)), 0);
    
    // Simple view-space position reconstruction (approximate)
    let centerLinear = linearizeDepthReversed(rawDepth, near, far);
    let rightLinear = linearizeDepthReversed(depthR, near, far);
    let upLinear = linearizeDepthReversed(depthU, near, far);
    
    let dx = rightLinear - centerLinear;
    let dy = upLinear - centerLinear;
    
    // Approximate world-space normal from depth gradients
    let normal = normalize(vec3f(-dx * 100.0, 1.0, -dy * 100.0));
    
    // Display as color: remap [-1,1] to [0,1]
    return vec4f(normal * 0.5 + 0.5, 1.0);
  }

  if (mode == 3) {
    // SSR visualization: show SSR texture directly
    let ssrSample = textureLoad(ssrTexture, texCoord, 0);
    let ssrColor = ssrSample.rgb;
    let confidence = ssrSample.a;
    
    if (confidence < 0.01) {
      return vec4f(0.0, 0.0, 0.0, 1.0); // No SSR = black
    }
    
    // Show SSR color weighted by confidence
    return vec4f(ssrColor * confidence, 1.0);
  }

  // Mode 0 = off, shouldn't reach here
  return vec4f(0.0, 0.0, 0.0, 0.0);
}