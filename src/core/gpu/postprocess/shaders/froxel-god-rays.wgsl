/**
 * froxel-god-rays.wgsl — Froxel-based volumetric scattering (directional light only)
 *
 * Phase 4 simplified froxel grid: computes per-froxel in-scattered light from
 * the directional sun/moon, using CSM shadow map sampling for automatic god rays
 * through terrain/geometry occlusion + cloud shadow map for cloud gaps.
 *
 * Two compute passes:
 *   Pass 1 (scatterPass): For each froxel, compute scattering + extinction
 *   Pass 2 (integratePass): Front-to-back integration along each column
 *
 * One render pass:
 *   Pass 3 (applyPass): Per-pixel lookup into integrated 3D texture, composite with scene
 */

// ========== Froxel Grid Constants ==========

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;
const PI: f32 = 3.14159265359;

// ========== Uniforms ==========

struct FroxelUniforms {
  // Camera
  inverseViewProj: mat4x4f,       // [0..63]
  cameraPosition: vec3f,           // [64..75]
  near: f32,                       // [76..79]
  far: f32,                        // [80..83]
  sunVisibility: f32,              // [84..87]
  _pad0: f32,                      // [88..91]
  _pad1: f32,                      // [92..95]
  // Sun
  sunDirection: vec3f,             // [96..107]
  sunIntensity: f32,               // [108..111]
  sunColor: vec3f,                 // [112..123]
  mieG: f32,                       // [124..127]   Mie scattering asymmetry (0.76)
  // Scattering coefficients
  betaR: vec3f,                    // [128..139]   Rayleigh scattering coeff
  betaM: f32,                      // [140..143]   Mie scattering coeff
  // Cloud shadow
  cloudsEnabled: f32,              // [144..147]
  cloudShadowBoundsMin: vec2f,    // [148..155]   XZ world bounds of cloud shadow map
  cloudShadowBoundsMax: vec2f,    // [156..163]   XZ world bounds of cloud shadow map
  // CSM
  csmEnabled: f32,                 // [164..167]
  _pad2: f32,                      // [168..171]
  _pad3: f32,                      // [172..175]
  _pad4: f32,                      // [176..179]
  // Viewport
  viewportWidth: f32,              // [180..183]
  viewportHeight: f32,             // [184..187]
  intensity: f32,                  // [188..191]   overall god ray intensity multiplier
}

// ========== Bindings — Scatter Pass ==========

@group(0) @binding(0) var<uniform> u: FroxelUniforms;
@group(0) @binding(1) var scatterTex: texture_storage_3d<rgba16float, write>;

// CSM shadow map (optional — only bound when CSM is enabled)
@group(0) @binding(2) var csmShadowArray: texture_depth_2d_array;
@group(0) @binding(3) var csmShadowSampler: sampler_comparison;
@group(0) @binding(4) var<uniform> csmUniforms: CSMUniformsCompact;

// Cloud shadow map (optional)
@group(0) @binding(5) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(6) var cloudShadowSampler: sampler;

// ========== CSM Uniforms (compact version for compute) ==========

struct CSMUniformsCompact {
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  cascadeSplits: vec4f,
  config: vec4f,     // x=cascadeCount, y=csmEnabled, z=blendFraction
  cameraForward: vec4f,
}

// ========== Depth Slicing (Exponential) ==========

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
}

fn depthToSlice(linearDepth: f32) -> f32 {
  return log(linearDepth / u.near) / log(u.far / u.near) * f32(FROXEL_DEPTH);
}

fn sliceThickness(slice: u32) -> f32 {
  let d0 = sliceToDepth(f32(slice));
  let d1 = sliceToDepth(f32(slice + 1u));
  return d1 - d0;
}

// ========== World Position from Froxel Coord ==========

fn froxelToWorld(coord: vec3u) -> vec3f {
  // UV from froxel XY
  let uv = (vec2f(coord.xy) + 0.5) / vec2f(f32(FROXEL_WIDTH), f32(FROXEL_HEIGHT));
  // NDC
  let ndcX = uv.x * 2.0 - 1.0;
  let ndcY = 1.0 - uv.y * 2.0; // Flip Y
  // Depth from slice (center of slice)
  let linearDepth = sliceToDepth(f32(coord.z) + 0.5);

  // Unproject a point at this UV with depth
  // We use the inverse VP matrix to go from clip to world
  // For the near-plane point:
  let clipNear = vec4f(ndcX, ndcY, 1.0, 1.0); // reversed-Z: near=1
  let clipFar  = vec4f(ndcX, ndcY, 0.0, 1.0); // reversed-Z: far=0
  let worldNear4 = u.inverseViewProj * clipNear;
  let worldFar4  = u.inverseViewProj * clipFar;
  let worldNear = worldNear4.xyz / worldNear4.w;
  let worldFar  = worldFar4.xyz / worldFar4.w;

  // Interpolate along the ray to the desired linear depth
  let rayDir = normalize(worldFar - worldNear);
  let totalDist = length(worldFar - worldNear);
  let t = linearDepth / u.far; // Approximate parametric t
  return worldNear + rayDir * linearDepth;
}

// ========== Phase Functions ==========

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

fn rayleighPhase(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// ========== Shadow Sampling (Simplified for Compute) ==========

fn getCSMSplit(idx: u32) -> f32 {
  switch (idx) {
    case 0u: { return csmUniforms.cascadeSplits.x; }
    case 1u: { return csmUniforms.cascadeSplits.y; }
    case 2u: { return csmUniforms.cascadeSplits.z; }
    default: { return csmUniforms.cascadeSplits.w; }
  }
}

fn getCSMLightSpaceMatrix(idx: u32) -> mat4x4f {
  switch (idx) {
    case 0u: { return csmUniforms.lightSpaceMatrix0; }
    case 1u: { return csmUniforms.lightSpaceMatrix1; }
    case 2u: { return csmUniforms.lightSpaceMatrix2; }
    default: { return csmUniforms.lightSpaceMatrix3; }
  }
}

fn sampleCSMShadowCompute(worldPos: vec3f) -> f32 {
  if (u.csmEnabled < 0.5) { return 1.0; }

  let cascadeCount = u32(csmUniforms.config.x);
  let cameraFwd = csmUniforms.cameraForward.xyz;
  let viewDepth = abs(dot(worldPos - u.cameraPosition, cameraFwd));

  // Select cascade
  var cascadeIdx = cascadeCount - 1u;
  for (var i = 0u; i < cascadeCount; i++) {
    if (viewDepth < getCSMSplit(i)) {
      cascadeIdx = i;
      break;
    }
  }

  // Get light space matrix
  let lsm = getCSMLightSpaceMatrix(cascadeIdx);

  let lsPos = lsm * vec4f(worldPos, 1.0);
  var sc = lsPos.xyz / lsPos.w;
  sc.x = sc.x * 0.5 + 0.5;
  sc.y = sc.y * -0.5 + 0.5;

  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) {
    return 1.0;
  }

  // Single sample comparison (no PCF for performance in compute)
  return textureSampleCompareLevel(
    csmShadowArray, csmShadowSampler,
    sc.xy, i32(cascadeIdx), sc.z - 0.002
  );
}

fn sampleCloudShadowCompute(worldPos: vec3f) -> f32 {
  if (u.cloudsEnabled < 0.5) { return 1.0; }

  // Map world XZ to cloud shadow UV
  let range = u.cloudShadowBoundsMax - u.cloudShadowBoundsMin;
  let shadowUV = (worldPos.xz - u.cloudShadowBoundsMin) / range;

  if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
    return 1.0;
  }

  return textureSampleLevel(cloudShadowMap, cloudShadowSampler, shadowUV, 0.0).r;
}

// ========== Scatter Compute Pass ==========

@compute @workgroup_size(8, 8, 1)
fn scatterPass(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT || gid.z >= FROXEL_DEPTH) { return; }

  // Early out if sun is below horizon
  if (u.sunVisibility < 0.01) {
    textureStore(scatterTex, gid, vec4f(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let worldPos = froxelToWorld(gid);
  let viewDir = normalize(worldPos - u.cameraPosition);

  // Atmospheric density (exponential height falloff)
  let altitude = worldPos.y;
  let densityR = exp(-max(altitude, 0.0) / 7994.0); // Rayleigh scale height
  let densityM = exp(-max(altitude, 0.0) / 1200.0);  // Mie scale height

  // Extinction: combined Rayleigh + Mie
  let extinctionR = u.betaR * densityR;
  let extinctionM = vec3f(u.betaM * densityM * 1.1);
  let totalExtinction = (extinctionR.x + extinctionR.y + extinctionR.z) / 3.0 + extinctionM.x;

  // Shadow test
  let csmShadow = sampleCSMShadowCompute(worldPos);
  let cloudShadow = sampleCloudShadowCompute(worldPos);
  let visibility = csmShadow * cloudShadow;

  // Phase functions
  let cosTheta = dot(viewDir, u.sunDirection);
  let phaseR = rayleighPhase(cosTheta);
  let phaseM = henyeyGreenstein(cosTheta, u.mieG);

  // In-scattered light from sun
  let scattering = u.sunColor * u.sunIntensity * u.sunVisibility * visibility * u.intensity *
    (u.betaR * densityR * phaseR + vec3f(u.betaM * densityM * phaseM));

  textureStore(scatterTex, gid, vec4f(scattering, totalExtinction));
}

// ========== Integration Compute Pass ==========
// Separate entry point — dispatched as a second compute pass
// Reads scatterTex (now as read), writes to integratedTex

@group(1) @binding(0) var scatterTexRead: texture_3d<f32>;
@group(1) @binding(1) var integratedTex: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn integratePass(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT) { return; }

  var accumScatter = vec3f(0.0);
  var accumTransmittance = 1.0;

  for (var z = 0u; z < FROXEL_DEPTH; z++) {
    let data = textureLoad(scatterTexRead, vec3u(gid.x, gid.y, z), 0);
    let scattering = data.rgb;
    let extinction = data.a;

    let thickness = sliceThickness(z);
    let sliceT = exp(-extinction * thickness);

    // Energy-conserving integration
    let integScatter = scattering * (1.0 - sliceT) / max(extinction, 0.00001);

    accumScatter += accumTransmittance * integScatter;
    accumTransmittance *= sliceT;

    textureStore(integratedTex, vec3u(gid.x, gid.y, z),
                 vec4f(accumScatter, accumTransmittance));
  }
}
