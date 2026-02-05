// SSAO Bilateral Blur Shader
// Edge-preserving blur that respects depth discontinuities

// ============ Fullscreen Quad Vertex Shader ============

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (3 vertices cover entire screen)
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

// ============ Uniforms ============

struct BlurParams {
  // xy: texel size (1/width, 1/height)
  // z: blur direction (0 = horizontal, 1 = vertical)
  // w: viewport width (for textureLoad)
  params: vec4f,
  // x: viewport height
  // yzw: unused
  params2: vec4f,
}

@group(0) @binding(0) var ssaoTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> blurParams: BlurParams;

// Gaussian weights for 9-tap blur
const WEIGHTS: array<f32, 5> = array<f32, 5>(
  0.227027,  // center
  0.1945946, // offset 1
  0.1216216, // offset 2
  0.054054,  // offset 3
  0.016216   // offset 4
);

@fragment
fn fs_blur(@location(0) uv: vec2f) -> @location(0) vec4f {
  let isVertical = blurParams.params.z > 0.5;
  let viewportSize = vec2f(blurParams.params.w, blurParams.params2.x);
  
  // Convert UV to pixel coordinates
  let pixelCoord = vec2i(uv * viewportSize);
  
  // Blur direction in pixels
  let blurDir = select(
    vec2i(1, 0), // horizontal
    vec2i(0, 1), // vertical
    isVertical
  );
  
  // Center sample using textureLoad (uniform control flow)
  let centerAO = textureLoad(ssaoTexture, pixelCoord, 0).r;
  let centerDepth = textureLoad(depthTexture, pixelCoord, 0).r;
  
  // Check for sky pixels - but DON'T early return to maintain uniform control flow
  let isSky = centerDepth >= 0.9999 || centerDepth <= 0.0001;
  
  // Initialize result with center sample
  var result = centerAO * WEIGHTS[0];
  var totalWeight = WEIGHTS[0];
  
  // Depth threshold for edge detection
  let depthThreshold = 0.001;
  
  // Sample in both directions (only if not sky)
  if (!isSky) {
    for (var i = 1; i < 5; i++) {
      let offset = blurDir * i;
      
      // Positive direction
      let coordPos = pixelCoord + offset;
      let samplePosAO = textureLoad(ssaoTexture, coordPos, 0).r;
      let samplePosDepth = textureLoad(depthTexture, coordPos, 0).r;
      
      // Depth-aware weight
      let depthDiffPos = abs(centerDepth - samplePosDepth);
      let weightPos = WEIGHTS[i] * step(depthDiffPos, depthThreshold);
      
      result += samplePosAO * weightPos;
      totalWeight += weightPos;
      
      // Negative direction
      let coordNeg = pixelCoord - offset;
      let sampleNegAO = textureLoad(ssaoTexture, coordNeg, 0).r;
      let sampleNegDepth = textureLoad(depthTexture, coordNeg, 0).r;
      
      let depthDiffNeg = abs(centerDepth - sampleNegDepth);
      let weightNeg = WEIGHTS[i] * step(depthDiffNeg, depthThreshold);
      
      result += sampleNegAO * weightNeg;
      totalWeight += weightNeg;
    }
  }
  
  // Normalize
  result = result / totalWeight;
  
  // Return white for sky pixels, blurred result otherwise
  let finalResult = select(result, 1.0, isSky);
  
  return vec4f(finalResult, finalResult, finalResult, 1.0);
}
