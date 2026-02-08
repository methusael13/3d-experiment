/**
 * Specular Prefilter Shader (Split-Sum Approximation)
 * 
 * Pre-filters an environment map for specular IBL using GGX importance sampling.
 * Generates multiple mip levels where each level corresponds to a roughness value.
 * 
 * Output: 128x128 base with 6 mip levels (roughness 0 to 1)
 * Mip 0: roughness ~0.0 (mirror)
 * Mip 5: roughness ~1.0 (diffuse-like)
 */

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Number of samples for prefiltering
// Higher = smoother but slower
const NUM_SAMPLES: u32 = 1024u;

// ============================================================================
// Uniforms
// ============================================================================

struct PrefilterUniforms {
  roughness: f32,           // Current roughness level (0-1)
  faceIndex: u32,           // Cubemap face index (0-5)
  _pad: vec2u,
}

@group(0) @binding(0) var<uniform> uniforms: PrefilterUniforms;
@group(0) @binding(1) var envCubemap: texture_cube<f32>;
@group(0) @binding(2) var envSampler: sampler;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Helper Functions
// ============================================================================

// Convert UV and face index to world direction
fn uvToDirection(uv: vec2f, faceIndex: u32) -> vec3f {
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

// Van der Corput sequence
fn vanDerCorput(n: u32) -> f32 {
  var bits = n;
  bits = ((bits << 16u) | (bits >> 16u));
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

// Hammersley sequence
fn hammersley(i: u32, N: u32) -> vec2f {
  return vec2f(f32(i) / f32(N), vanDerCorput(i));
}

// GGX/Trowbridge-Reitz importance sampling
// Returns a half-vector in tangent space sampled according to GGX distribution
fn importanceSampleGGX(Xi: vec2f, N: vec3f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let a2 = a * a;
  
  // Sample spherical coordinates according to GGX distribution
  let phi = TWO_PI * Xi.x;
  let cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a2 - 1.0) * Xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  
  // Tangent-space half vector
  let H = vec3f(
    cos(phi) * sinTheta,
    sin(phi) * sinTheta,
    cosTheta
  );
  
  // Create TBN matrix
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);
  
  // Transform to world space
  return normalize(tangent * H.x + bitangent * H.y + N * H.z);
}

// GGX normal distribution function
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

// ============================================================================
// Compute Shader - Specular Prefilter
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) globalId: vec3u) {
  let texSize = textureDimensions(outputTexture);
  
  if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
    return;
  }
  
  // Get UV coordinates
  let uv = vec2f(
    (f32(globalId.x) + 0.5) / f32(texSize.x),
    (f32(globalId.y) + 0.5) / f32(texSize.y)
  );
  
  // Get reflection direction (N = V = R assumption for prefilter)
  let N = uvToDirection(uv, uniforms.faceIndex);
  let R = N;
  let V = R;
  
  // Clamp roughness to avoid singularity at 0
  let roughness = max(uniforms.roughness, 0.001);
  
  var prefilteredColor = vec3f(0.0);
  var totalWeight = 0.0;
  
  // Calculate the resolution of the source cubemap for mip level selection
  let envSize = textureDimensions(envCubemap);
  let resolution = f32(envSize.x);
  
  for (var i = 0u; i < NUM_SAMPLES; i++) {
    let Xi = hammersley(i, NUM_SAMPLES);
    let H = importanceSampleGGX(Xi, N, roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);
    
    let NdotL = max(dot(N, L), 0.0);
    
    if (NdotL > 0.0) {
      let NdotH = max(dot(N, H), 0.0);
      let HdotV = max(dot(H, V), 0.0);
      
      // Calculate mip level based on roughness and PDF
      // This reduces aliasing for rough surfaces
      let D = distributionGGX(NdotH, roughness);
      let pdf = D * NdotH / (4.0 * HdotV + 0.0001);
      
      let saTexel = 4.0 * PI / (6.0 * resolution * resolution);
      let saSample = 1.0 / (f32(NUM_SAMPLES) * pdf + 0.0001);
      let mipLevel = select(0.5 * log2(saSample / saTexel), 0.0, roughness == 0.0);
      
      // Sample with calculated mip level to reduce aliasing
      let envColor = textureSampleLevel(envCubemap, envSampler, L, mipLevel).rgb;
      
      prefilteredColor += envColor * NdotL;
      totalWeight += NdotL;
    }
  }
  
  // Normalize by total weight
  if (totalWeight > 0.0) {
    prefilteredColor = prefilteredColor / totalWeight;
  }
  
  textureStore(outputTexture, vec2i(globalId.xy), vec4f(prefilteredColor, 1.0));
}
