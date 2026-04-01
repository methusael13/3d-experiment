/**
 * froxel-scattering.wgsl — Per-froxel light injection (Pass 2)
 *
 * For each froxel, accumulates in-scattered light from:
 *   1. Directional light (sun/moon) with CSM shadow + cloud shadow → god rays
 *   2. Point lights (from clustered light list) → glow spheres in fog
 *   3. Spot lights (from clustered light list + shadow atlas) → visible beams
 *   4. Ambient term (prevents pitch-black unlit fog)
 *
 * Scattering is decoupled from extinction: the density injection pass wrote
 * extinction; this pass reads it and computes in-scattered light using
 * artistically-controllable scattering coefficients.
 */

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;
const PI: f32 = 3.14159265359;
const MAX_LIGHTS_PER_FROXEL: u32 = 32u;

// ========== Uniforms ==========

struct ScatterUniforms {
  inverseViewProj: mat4x4f,       // [0..63]
  cameraPosition: vec3f,           // [64..75]
  near: f32,                       // [76..79]
  far: f32,                        // [80..83]
  sunVisibility: f32,              // [84..87]
  scatteringScale: f32,            // [88..91]
  mieG: f32,                       // [92..95]
  sunDirection: vec3f,             // [96..107]
  sunIntensity: f32,               // [108..111]
  sunColor: vec3f,                 // [112..123]
  ambientIntensity: f32,           // [124..127]
  ambientColor: vec3f,             // [128..139]
  cloudsEnabled: f32,              // [140..143]
  cloudShadowBoundsMin: vec2f,    // [144..151]
  cloudShadowBoundsMax: vec2f,    // [152..159]
  csmEnabled: f32,                 // [160..163]
  fogColorR: f32,                  // [164..167]
  fogColorG: f32,                  // [168..171]
  fogColorB: f32,                  // [172..175]
  lightCullingEnabled: f32,        // [176..179]
  _pad0: f32,                      // [180..183]
  _pad1: f32,                      // [184..187]
  _pad2: f32,                      // [188..191]
}

// CSM uniforms (compact for compute — same as Phase 4 froxel god rays)
struct CSMUniformsCompact {
  lightSpaceMatrix0: mat4x4f,
  lightSpaceMatrix1: mat4x4f,
  lightSpaceMatrix2: mat4x4f,
  lightSpaceMatrix3: mat4x4f,
  cascadeSplits: vec4f,
  config: vec4f,
  cameraForward: vec4f,
}

// ========== Light structs (must match lights.wgsl / LightBufferManager) ==========

struct PointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
}

struct SpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,
  cookieAtlasIndex: i32,
  cookieIntensity: f32,
  lightSpaceMatrix: mat4x4f,
}

struct LightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
}

// Clustered light list per froxel
struct FroxelLightList {
  pointCount: u32,
  spotCount: u32,
  pointIndices: array<u32, 16>,    // Max 16 point lights per froxel
  spotIndices: array<u32, 16>,     // Max 16 spot lights per froxel
}

// ========== Bindings ==========

// Group 0: Uniforms + density grid (read)
@group(0) @binding(0) var<uniform> u: ScatterUniforms;
@group(0) @binding(1) var densityGrid: texture_3d<f32>;
@group(0) @binding(2) var scatterGrid: texture_storage_3d<rgba16float, write>;

// Group 1: Shadow resources
@group(1) @binding(0) var csmShadowArray: texture_depth_2d_array;
@group(1) @binding(1) var csmShadowSampler: sampler_comparison;
@group(1) @binding(2) var<uniform> csmUniforms: CSMUniformsCompact;
@group(1) @binding(3) var cloudShadowMap: texture_2d<f32>;
@group(1) @binding(4) var cloudShadowSampler: sampler;

// Group 2: Light buffers + clustered assignment
@group(2) @binding(0) var<uniform> lightCounts: LightCounts;
@group(2) @binding(1) var<storage, read> pointLights: array<PointLightData>;
@group(2) @binding(2) var<storage, read> spotLights: array<SpotLightData>;
@group(2) @binding(3) var<storage, read> froxelLightLists: array<FroxelLightList>;
@group(2) @binding(4) var spotShadowAtlas: texture_depth_2d_array;
@group(2) @binding(5) var spotShadowSampler: sampler_comparison;

// ========== Depth Slicing ==========

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
}

fn froxelToWorld(coord: vec3u) -> vec3f {
  let uv = (vec2f(coord.xy) + 0.5) / vec2f(f32(FROXEL_WIDTH), f32(FROXEL_HEIGHT));
  let ndcX = uv.x * 2.0 - 1.0;
  let ndcY = 1.0 - uv.y * 2.0;
  let linearDepth = sliceToDepth(f32(coord.z) + 0.5);

  let clipNear = vec4f(ndcX, ndcY, 1.0, 1.0);
  let clipFar  = vec4f(ndcX, ndcY, 0.0, 1.0);
  let worldNear4 = u.inverseViewProj * clipNear;
  let worldFar4  = u.inverseViewProj * clipFar;
  let worldNear = worldNear4.xyz / worldNear4.w;
  let worldFar  = worldFar4.xyz / worldFar4.w;

  let rayDir = normalize(worldFar - worldNear);
  return worldNear + rayDir * linearDepth;
}

// ========== Phase Functions ==========

fn isotropicPhase() -> f32 {
  return 1.0 / (4.0 * PI);
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

// Dual-lobe phase: blend forward HG + isotropic for shadow shaft visibility
fn dualLobePhase(cosTheta: f32, g: f32) -> f32 {
  let forwardPhase = henyeyGreenstein(cosTheta, g);
  let iso = isotropicPhase();
  // 70% forward scatter + 30% isotropic ensures shadow contrast in all views
  return forwardPhase * 0.7 + iso * 0.3;
}

fn rayleighPhase(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
}

// ========== Attenuation (matches lights.wgsl) ==========

fn attenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

fn attenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

// ========== Shadow Sampling ==========

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

fn sampleCSMShadow(worldPos: vec3f) -> f32 {
  if (u.csmEnabled < 0.5) { return 1.0; }

  let cascadeCount = u32(csmUniforms.config.x);
  let cameraFwd = csmUniforms.cameraForward.xyz;
  let viewDepth = abs(dot(worldPos - u.cameraPosition, cameraFwd));

  var cascadeIdx = cascadeCount - 1u;
  for (var i = 0u; i < cascadeCount; i++) {
    if (viewDepth < getCSMSplit(i)) {
      cascadeIdx = i;
      break;
    }
  }

  let lsm = getCSMLightSpaceMatrix(cascadeIdx);
  let lsPos = lsm * vec4f(worldPos, 1.0);
  var sc = lsPos.xyz / lsPos.w;
  sc.x = sc.x * 0.5 + 0.5;
  sc.y = sc.y * -0.5 + 0.5;

  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) {
    return 1.0;
  }

  return textureSampleCompareLevel(csmShadowArray, csmShadowSampler, sc.xy, i32(cascadeIdx), sc.z - 0.002);
}

fn sampleCloudShadow(worldPos: vec3f) -> f32 {
  if (u.cloudsEnabled < 0.5) { return 1.0; }

  let range = u.cloudShadowBoundsMax - u.cloudShadowBoundsMin;
  let shadowUV = (worldPos.xz - u.cloudShadowBoundsMin) / range;

  // Feather at bounds edges to avoid hard rectangular cutoff
  let feather = 0.05;
  let edgeFade = min(
    min(smoothstep(0.0, feather, shadowUV.x), smoothstep(1.0, 1.0 - feather, shadowUV.x)),
    min(smoothstep(0.0, feather, shadowUV.y), smoothstep(1.0, 1.0 - feather, shadowUV.y))
  );

  if (shadowUV.x < -0.01 || shadowUV.x > 1.01 || shadowUV.y < -0.01 || shadowUV.y > 1.01) {
    return 1.0;
  }

  let cloudVal = textureSampleLevel(cloudShadowMap, cloudShadowSampler, clamp(shadowUV, vec2f(0.0), vec2f(1.0)), 0.0).r;
  return mix(1.0, cloudVal, edgeFade);
}

fn sampleSpotShadow(worldPos: vec3f, light: SpotLightData) -> f32 {
  if (light.shadowAtlasIndex < 0) { return 1.0; }

  let lsPos = light.lightSpaceMatrix * vec4f(worldPos, 1.0);
  var sc = lsPos.xyz / lsPos.w;
  sc.x = sc.x * 0.5 + 0.5;
  sc.y = sc.y * -0.5 + 0.5;

  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) {
    return 1.0;
  }

  return textureSampleCompareLevel(spotShadowAtlas, spotShadowSampler, sc.xy, light.shadowAtlasIndex, sc.z - 0.003);
}

// ========== Main Compute ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT || gid.z >= FROXEL_DEPTH) { return; }

  // Read density from injection pass
  let densityData = textureLoad(densityGrid, gid, 0);
  let extinction = densityData.a;

  // Skip empty froxels
  if (extinction < 0.00001) {
    textureStore(scatterGrid, gid, vec4f(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let worldPos = froxelToWorld(gid);
  let viewDir = normalize(worldPos - u.cameraPosition);

  // Froxel depth range for multi-sample shadow averaging
  let sliceNear = sliceToDepth(f32(gid.z));
  let sliceFar  = sliceToDepth(f32(gid.z) + 1.0);
  let sliceThickness = sliceFar - sliceNear;

  // Scattering is decoupled from extinction for artistic control
  let scatterCoeff = extinction * u.scatteringScale;
  let fogColor = vec3f(u.fogColorR, u.fogColorG, u.fogColorB);

  var totalScattering = vec3f(0.0);

  // ── Directional light (sun/moon) ──
  if (u.sunVisibility > 0.01) {
    // Multi-sample CSM shadow within the froxel volume to avoid
    // repeating object silhouette at each depth slice boundary.
    var shadowAccum = 0.0;
    let NUM_SHADOW_SAMPLES = 4u;
    for (var s = 0u; s < NUM_SHADOW_SAMPLES; s++) {
      // Distribute samples evenly through the froxel depth with half-texel offset
      let t = (f32(s) + 0.5) / f32(NUM_SHADOW_SAMPLES);
      let samplePos = worldPos + viewDir * (t - 0.5) * sliceThickness;
      shadowAccum += sampleCSMShadow(samplePos);
    }
    let csmShadow = shadowAccum / f32(NUM_SHADOW_SAMPLES);
    let cloudShadow = sampleCloudShadow(worldPos);
    let visibility = csmShadow * cloudShadow;

    let cosTheta = dot(viewDir, u.sunDirection);
    // Dual-lobe phase: forward HG + isotropic ensures shadow shafts visible from all angles
    let phaseM = dualLobePhase(cosTheta, u.mieG);

    // Clamp sun contribution to prevent washing out shadow contrast
    // Higher cap (8.0) allows cloud god rays to be more prominent
    let sunRadiance = min(u.sunIntensity * u.sunVisibility * phaseM, 8.0);

    // Mie scattering with fog color tint
    let sunScatter = u.sunColor * sunRadiance * visibility *
      fogColor * scatterCoeff;
    totalScattering += sunScatter;
  }

  // ── Point & Spot lights (from clustered assignment) ──
  if (u.lightCullingEnabled > 0.5) {
    let froxelIndex = gid.x + gid.y * FROXEL_WIDTH + gid.z * FROXEL_WIDTH * FROXEL_HEIGHT;
    let lightList = froxelLightLists[froxelIndex];

    // Point lights
    let numPoint = min(lightList.pointCount, 16u);
    for (var i = 0u; i < numPoint; i++) {
      let lightIdx = lightList.pointIndices[i];
      if (lightIdx >= lightCounts.numPoint) { continue; }
      let light = pointLights[lightIdx];

      let toLight = light.position - worldPos;
      let dist = length(toLight);
      let lightDir = toLight / max(dist, 0.001);

      let attenuation = attenuateDistance(dist, light.range);
      if (attenuation < 0.001) { continue; }

      // Isotropic phase for point lights (uniform scatter in all directions)
      let phase = isotropicPhase();

      let lightScatter = light.color * light.intensity * attenuation *
        phase * scatterCoeff * fogColor;
      totalScattering += lightScatter;
    }

    // Spot lights
    let numSpot = min(lightList.spotCount, 16u);
    for (var i = 0u; i < numSpot; i++) {
      let lightIdx = lightList.spotIndices[i];
      if (lightIdx >= lightCounts.numSpot) { continue; }
      let light = spotLights[lightIdx];

      let toLight = light.position - worldPos;
      let dist = length(toLight);
      let lightDir = toLight / max(dist, 0.001);

      let attenuation = attenuateDistance(dist, light.range);
      if (attenuation < 0.001) { continue; }

      let cosAngle = dot(-lightDir, light.direction);
      let spotFactor = attenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
      if (spotFactor < 0.001) { continue; }

      // Multi-sample shadow within froxel depth to avoid repeating silhouette
      var spotShadowAccum = 0.0;
      for (var ss = 0u; ss < 4u; ss++) {
        let st = (f32(ss) + 0.5) / 4.0;
        let spotSamplePos = worldPos + viewDir * (st - 0.5) * sliceThickness;
        spotShadowAccum += sampleSpotShadow(spotSamplePos, light);
      }
      let shadowFactor = spotShadowAccum / 4.0;

      // Mild forward scatter for spot beams
      let cosTheta = dot(viewDir, lightDir);
      let phase = henyeyGreenstein(cosTheta, 0.5);

      let lightScatter = light.color * light.intensity * attenuation *
        spotFactor * shadowFactor * phase * scatterCoeff * fogColor;
      totalScattering += lightScatter;
    }
  }

  // ── Ambient term (prevents pitch-black fog in unlit areas) ──
  let ambientScatter = u.ambientColor * u.ambientIntensity * scatterCoeff *
    fogColor * isotropicPhase();
  totalScattering += ambientScatter;

  textureStore(scatterGrid, gid, vec4f(totalScattering, extinction));
}
