/**
 * Diffuse Irradiance Convolution Shader
 * 
 * Convolves a cubemap environment map to produce diffuse irradiance.
 * Performs hemisphere integration using importance sampling.
 * 
 * Output: 64x64 per face irradiance cubemap
 */

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;
const HALF_PI: f32 = 1.57079632679;

// Number of samples for convolution
// Higher = smoother but slower
const NUM_SAMPLES: u32 = 512u;

// ============================================================================
// Uniforms
// ============================================================================

struct ConvolutionUniforms {
  faceIndex: u32,
  _pad: vec3u,
}

@group(0) @binding(0) var<uniform> uniforms: ConvolutionUniforms;
@group(0) @binding(1) var envCubemap: texture_cube<f32>;
@group(0) @binding(2) var envSampler: sampler;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Helper Functions
// ============================================================================

// Convert UV and face index to world direction
fn uvToDirection(uv: vec2f, faceIndex: u32) -> vec3f {
  // Convert UV from [0,1] to [-1,1]
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  
  var dir: vec3f;
  switch (faceIndex) {
    case 0u: { dir = vec3f( 1.0, -v,   -u); }  // +X
    case 1u: { dir = vec3f(-1.0, -v,    u); }  // -X
    case 2u: { dir = vec3f(   u,  1.0,  v); }  // +Y
    case 3u: { dir = vec3f(   u, -1.0, -v); }  // -Y
    case 4u: { dir = vec3f(   u, -v,  1.0); }  // +Z
    default: { dir = vec3f(  -u, -v, -1.0); }  // -Z
  }
  
  return normalize(dir);
}

// Van der Corput sequence for low-discrepancy sampling
fn vanDerCorput(n: u32) -> f32 {
  var bits = n;
  bits = ((bits << 16u) | (bits >> 16u));
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10; // / 0x100000000
}

// Hammersley sequence for 2D low-discrepancy sampling
fn hammersley(i: u32, N: u32) -> vec2f {
  return vec2f(f32(i) / f32(N), vanDerCorput(i));
}

// Sample direction on hemisphere using cosine-weighted distribution
fn hemisphereCosineSample(Xi: vec2f, N: vec3f) -> vec3f {
  // Cosine-weighted hemisphere sampling
  let phi = TWO_PI * Xi.x;
  let cosTheta = sqrt(1.0 - Xi.y);
  let sinTheta = sqrt(Xi.y);
  
  // Tangent-space direction
  let H = vec3f(
    cos(phi) * sinTheta,
    sin(phi) * sinTheta,
    cosTheta
  );
  
  // Create TBN matrix to transform from tangent to world space
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);
  
  // Transform to world space
  return normalize(tangent * H.x + bitangent * H.y + N * H.z);
}

// ============================================================================
// Compute Shader - Diffuse Convolution
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) globalId: vec3u) {
  let texSize = textureDimensions(outputTexture);
  
  if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
    return;
  }
  
  // Get UV coordinates for this pixel
  let uv = vec2f(
    (f32(globalId.x) + 0.5) / f32(texSize.x),
    (f32(globalId.y) + 0.5) / f32(texSize.y)
  );
  
  // Get normal direction for this pixel on the cubemap face
  let N = uvToDirection(uv, uniforms.faceIndex);
  
  // Accumulate irradiance by sampling hemisphere
  var irradiance = vec3f(0.0);
  
  for (var i = 0u; i < NUM_SAMPLES; i++) {
    let Xi = hammersley(i, NUM_SAMPLES);
    let sampleDir = hemisphereCosineSample(Xi, N);
    
    // Sample environment map
    let envColor = textureSampleLevel(envCubemap, envSampler, sampleDir, 0.0).rgb;
    
    // For cosine-weighted sampling, each sample is already weighted by cos(theta)/PI
    // so we just accumulate
    irradiance += envColor;
  }
  
  // Average samples (cosine-weighted sampling already accounts for PDF)
  irradiance = irradiance / f32(NUM_SAMPLES);
  
  // Scale by PI because we're storing irradiance (not radiance)
  irradiance *= PI;
  
  textureStore(outputTexture, vec2i(globalId.xy), vec4f(irradiance, 1.0));
}
