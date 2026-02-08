/**
 * BRDF Lookup Table Generator (Split-Sum Approximation)
 * 
 * Pre-computes the BRDF integration for the split-sum approximation.
 * The LUT is indexed by (NdotV, roughness) and stores (scale, bias) for
 * the Fresnel term: F0 * scale + bias
 * 
 * This only needs to be generated once at startup as it's independent
 * of the environment map.
 * 
 * Output: 512x512 RGBA16Float texture (using RG channels only)
 *   R = scale factor for F0
 *   G = bias term
 *   B, A = unused (rgba16float required for storage texture compatibility)
 */

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Number of samples for integration
const NUM_SAMPLES: u32 = 1024u;

// ============================================================================
// Uniforms
// ============================================================================

// Note: Using rgba16float because rg16float doesn't support storage textures
@group(0) @binding(0) var outputTexture: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Helper Functions
// ============================================================================

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

// GGX importance sampling (returns half vector in tangent space)
fn importanceSampleGGX(Xi: vec2f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let a2 = a * a;
  
  let phi = TWO_PI * Xi.x;
  let cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a2 - 1.0) * Xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  
  return vec3f(
    cos(phi) * sinTheta,
    sin(phi) * sinTheta,
    cosTheta
  );
}

// Geometry function for Smith's method (Schlick-GGX)
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  // Use different k for IBL (k = roughness^2 / 2)
  let a = roughness;
  let k = (a * a) / 2.0;
  
  return NdotV / (NdotV * (1.0 - k) + k);
}

// Smith's geometry function
fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let ggx1 = geometrySchlickGGX(NdotV, roughness);
  let ggx2 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

// ============================================================================
// Compute Shader - BRDF LUT Integration
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) globalId: vec3u) {
  let texSize = textureDimensions(outputTexture);
  
  if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
    return;
  }
  
  // UV coordinates correspond to (NdotV, roughness)
  let NdotV = (f32(globalId.x) + 0.5) / f32(texSize.x);
  let roughness = (f32(globalId.y) + 0.5) / f32(texSize.y);
  
  // Clamp to avoid edge cases
  let clampedNdotV = max(NdotV, 0.001);
  let clampedRoughness = max(roughness, 0.001);
  
  // View vector in tangent space (N = [0, 0, 1])
  let V = vec3f(
    sqrt(1.0 - clampedNdotV * clampedNdotV),  // sin(theta)
    0.0,
    clampedNdotV  // cos(theta)
  );
  
  // Normal in tangent space
  let N = vec3f(0.0, 0.0, 1.0);
  
  var scale = 0.0;  // F0 scale factor
  var bias = 0.0;   // Bias term
  
  for (var i = 0u; i < NUM_SAMPLES; i++) {
    let Xi = hammersley(i, NUM_SAMPLES);
    let H = importanceSampleGGX(Xi, clampedRoughness);
    
    // Reflect V around H to get L
    let L = normalize(2.0 * dot(V, H) * H - V);
    
    let NdotL = max(L.z, 0.0);
    let NdotH = max(H.z, 0.0);
    let VdotH = max(dot(V, H), 0.0);
    
    if (NdotL > 0.0) {
      let G = geometrySmith(clampedNdotV, NdotL, clampedRoughness);
      
      // G_Vis = G * VdotH / (NdotH * NdotV)
      let G_Vis = (G * VdotH) / (NdotH * clampedNdotV + 0.0001);
      
      // Fresnel term: F = F0 + (1 - F0) * (1 - VdotH)^5
      // We want to factor this as: F0 * scale + bias
      // scale = 1 - (1 - VdotH)^5 = contribution from F0
      // bias = (1 - VdotH)^5 = contribution independent of F0
      let Fc = pow(1.0 - VdotH, 5.0);
      
      scale += (1.0 - Fc) * G_Vis;
      bias += Fc * G_Vis;
    }
  }
  
  // Average over samples
  scale = scale / f32(NUM_SAMPLES);
  bias = bias / f32(NUM_SAMPLES);
  
  textureStore(outputTexture, vec2i(globalId.xy), vec4f(scale, bias, 0.0, 0.0));
}
