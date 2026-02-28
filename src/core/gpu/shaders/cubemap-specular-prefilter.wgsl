// Cubemap Specular Pre-filter Shader for Reflection Probes
//
// Pre-filters a probe cubemap using GGX importance sampling to produce
// roughness-dependent mip levels. Adapted from the IBL specular prefilter
// with alpha-weighted sampling to handle sky holes (rgba 0,0,0,0).
//
// Each mip level corresponds to a roughness value:
//   mip 0: roughness ~0.0 (mirror — copied from base, not processed here)
//   mip 1: roughness ~0.2
//   mip N: roughness ~N/maxMip
//
// Samples the base cubemap (mip 0) as a cube texture and writes to a
// specific face+mip of the output cubemap via a 2D storage texture view.

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 6.28318530718;

// Number of samples — balance quality vs bake speed.
// 256 is sufficient for low-res probe cubemaps (64-256px faces).
const NUM_SAMPLES: u32 = 256u;

// ============================================================================
// Uniforms
// ============================================================================

struct PrefilterUniforms {
  roughness: f32,     // Current roughness level (0-1) for this mip
  faceIndex: u32,     // Cubemap face index (0-5)
  _pad: vec2u,
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: PrefilterUniforms;
@group(0) @binding(1) var srcCubemap: texture_cube<f32>;
@group(0) @binding(2) var srcSampler: sampler;
@group(0) @binding(3) var dstFace: texture_storage_2d<rgba16float, write>;

// ============================================================================
// Helper Functions
// ============================================================================

// Convert UV [0,1] and face index to world direction
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

// Van der Corput radical inverse
fn vanDerCorput(n: u32) -> f32 {
  var bits = n;
  bits = ((bits << 16u) | (bits >> 16u));
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

// Hammersley low-discrepancy sequence
fn hammersley(i: u32, N: u32) -> vec2f {
  return vec2f(f32(i) / f32(N), vanDerCorput(i));
}

// GGX importance sampling — returns half-vector in world space
fn importanceSampleGGX(Xi: vec2f, N: vec3f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let a2 = a * a;

  let phi = TWO_PI * Xi.x;
  let cosTheta = sqrt((1.0 - Xi.y) / (1.0 + (a2 - 1.0) * Xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);

  // Tangent-space half vector
  let H = vec3f(
    cos(phi) * sinTheta,
    sin(phi) * sinTheta,
    cosTheta
  );

  // TBN matrix to world space
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);

  return normalize(tangent * H.x + bitangent * H.y + N * H.z);
}

// GGX NDF for mip level selection
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

// ============================================================================
// Main — GGX Pre-filter with Alpha-Weighted Sampling
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let texSize = textureDimensions(dstFace);

  if (globalId.x >= texSize.x || globalId.y >= texSize.y) {
    return;
  }

  // UV for this output pixel
  let uv = vec2f(
    (f32(globalId.x) + 0.5) / f32(texSize.x),
    (f32(globalId.y) + 0.5) / f32(texSize.y)
  );

  // Normal = View = Reflection direction (N=V=R assumption for prefilter)
  let N = uvToDirection(uv, uniforms.faceIndex);
  let R = N;
  let V = R;

  let roughness = max(uniforms.roughness, 0.001);

  // Source cubemap resolution for mip level calculation
  let envSize = textureDimensions(srcCubemap);
  let resolution = f32(envSize.x);

  var colorAccum = vec3f(0.0);
  var alphaAccum = 0.0;
  var totalWeight = 0.0;

  for (var i = 0u; i < NUM_SAMPLES; i++) {
    let Xi = hammersley(i, NUM_SAMPLES);
    let H = importanceSampleGGX(Xi, N, roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);

    let NdotL = max(dot(N, L), 0.0);

    if (NdotL > 0.0) {
      let NdotH = max(dot(N, H), 0.0);
      let HdotV = max(dot(H, V), 0.0);

      // Mip level based on PDF to reduce aliasing
      let D = distributionGGX(NdotH, roughness);
      let pdf = D * NdotH / (4.0 * HdotV + 0.0001);
      let saTexel = 4.0 * PI / (6.0 * resolution * resolution);
      let saSample = 1.0 / (f32(NUM_SAMPLES) * pdf + 0.0001);
      let mipLevel = select(0.5 * log2(saSample / saTexel), 0.0, roughness < 0.01);

      // Sample probe cubemap at calculated mip level (base has all data at mip 0)
      let sampleColor = textureSampleLevel(srcCubemap, srcSampler, L, mipLevel);

      // Alpha-weighted accumulation:
      // Only geometry texels (alpha > 0) contribute to the blurred result.
      // Sky texels (alpha=0) are excluded from the color average.
      let weight = NdotL * sampleColor.a;
      colorAccum += sampleColor.rgb * weight;
      alphaAccum += sampleColor.a * NdotL;
      totalWeight += NdotL;
    }
  }

  var finalColor: vec3f;
  var finalAlpha: f32;

  if (alphaAccum > 0.001) {
    // Normalize color by alpha-weighted sum
    finalColor = colorAccum / alphaAccum;
    // Alpha = fraction of hemisphere covered by geometry
    finalAlpha = alphaAccum / totalWeight;
  } else {
    // No geometry in any sample direction — fully transparent
    finalColor = vec3f(0.0);
    finalAlpha = 0.0;
  }

  textureStore(dstFace, vec2i(globalId.xy), vec4f(finalColor, finalAlpha));
}