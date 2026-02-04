// SSAO Bilateral Blur Shader
// Edge-preserving blur that respects depth discontinuities

struct BlurParams {
  // xy: texel size (1/width, 1/height)
  // z: blur direction (0 = horizontal, 1 = vertical)
  // w: unused
  params: vec4f,
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
  let texelSize = blurParams.params.xy;
  let isVertical = blurParams.params.z > 0.5;
  
  // Blur direction
  let blurDir = select(
    vec2f(texelSize.x, 0.0), // horizontal
    vec2f(0.0, texelSize.y), // vertical
    isVertical
  );
  
  // Center sample
  let centerAO = textureSample(ssaoTexture, texSampler, uv).r;
  let centerDepth = textureSample(depthTexture, texSampler, uv).r;
  
  // Skip sky pixels
  if (centerDepth >= 0.9999 || centerDepth <= 0.0001) {
    return vec4f(1.0);
  }
  
  var result = centerAO * WEIGHTS[0];
  var totalWeight = WEIGHTS[0];
  
  // Depth threshold for edge detection
  let depthThreshold = 0.001;
  
  // Sample in both directions
  for (var i = 1; i < 5; i++) {
    let offset = blurDir * f32(i);
    
    // Positive direction
    let uvPos = uv + offset;
    let samplePosAO = textureSample(ssaoTexture, texSampler, uvPos).r;
    let samplePosDepth = textureSample(depthTexture, texSampler, uvPos).r;
    
    // Depth-aware weight
    let depthDiffPos = abs(centerDepth - samplePosDepth);
    let weightPos = WEIGHTS[i] * step(depthDiffPos, depthThreshold);
    
    result += samplePosAO * weightPos;
    totalWeight += weightPos;
    
    // Negative direction
    let uvNeg = uv - offset;
    let sampleNegAO = textureSample(ssaoTexture, texSampler, uvNeg).r;
    let sampleNegDepth = textureSample(depthTexture, texSampler, uvNeg).r;
    
    let depthDiffNeg = abs(centerDepth - sampleNegDepth);
    let weightNeg = WEIGHTS[i] * step(depthDiffNeg, depthThreshold);
    
    result += sampleNegAO * weightNeg;
    totalWeight += weightNeg;
  }
  
  // Normalize
  result = result / totalWeight;
  
  return vec4f(result, result, result, 1.0);
}
