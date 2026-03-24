// CDLOD Terrain Rendering Shader
// Continuous Distance-Dependent Level of Detail terrain shader with morphing
// Designed to work with CDLODRendererGPU
// Features: Distance-based shading LOD, Parallax Occlusion Mapping (POM)

// Constants
const PI: f32 = 3.14159265359;
const DEFAULT_TERRAIN_ROUGHNESS: f32 = 1.0;

// Whether to use full PBR IBL regardless of distance
const FULL_PBR_IBL: bool = true;

// Anti-tiling method: 0 = none, 1 = noise_multi_scale_blending, 2 = hex_tiling
const TILING_TYPE: i32 = 2;

// Anti-tiling parameters
const ANTI_TILE_MACRO_SCALE: f32 = 0.13;       // Macro-scale UV multiplier (larger = more visible variation)
const ANTI_TILE_MACRO_BLEND: f32 = 0.35;       // How much macro-scale blends in (0-1)
const ANTI_TILE_NOISE_FREQ: f32 = 0.007;       // Noise UV distortion frequency (world-space)
const ANTI_TILE_NOISE_STRENGTH: f32 = 0.15;    // Noise UV distortion magnitude (in UV tile units)

// ============================================================================
// Uniform Structures
// ============================================================================

// Main uniforms (group 0, binding 0)
struct Uniforms {
  viewProjectionMatrix: mat4x4f,  // 0-15
  modelMatrix: mat4x4f,           // 16-31
  cameraPosition: vec3f,          // 32-34
  _pad0: f32,                     // 35
  terrainSize: f32,               // 36
  heightScale: f32,               // 37
  gridSize: f32,                  // 38
  debugMode: f32,                 // 39
  skirtDepth: f32,                // 40 - how far skirts extend downward
  // Procedural detail parameters
  detailFrequency: f32,           // 41 - base frequency in cycles/meter
  detailAmplitude: f32,           // 42 - max displacement in meters
  detailOctaves: f32,             // 43 - number of FBM octaves
  detailFadeStart: f32,           // 44 - distance where detail starts fading
  detailFadeEnd: f32,             // 45 - distance where detail is fully faded
  detailSlopeInfluence: f32,      // 46 - how much slope affects detail (0-1)
  displacementScale: f32,         // 47 - POM displacement height in world units
  // Island mode parameters + POM config
  islandEnabled: f32,             // 48 - 0 = disabled, 1 = enabled
  seaFloorDepth: f32,             // 49 - ocean floor depth (negative, e.g., -0.3)
  pomMinSteps: f32,               // 50 - minimum POM ray-march steps
  pomMaxSteps: f32,               // 51 - maximum POM ray-march steps
  // Bounds overlay parameters (for layer bounds visualization)
  boundsOverlayCenterX: f32,      // 52
  boundsOverlayCenterZ: f32,      // 53
  boundsOverlayHalfExtentX: f32,  // 54
  boundsOverlayHalfExtentZ: f32,  // 55
  boundsOverlayRotation: f32,     // 56 - rotation in radians
  boundsOverlayFeatherWidth: f32, // 57
  boundsOverlayEnabled: f32,      // 58 - 0 = disabled, 1 = enabled
  _pad4_overlay: f32,             // 59
}

// Material uniforms (group 0, binding 1)
struct Material {
  grassColor: vec4f,              // 0-3
  rockColor: vec4f,               // 4-7
  forestColor: vec4f,             // 8-11
  lightDir: vec3f,                // 12-14
  _pad1: f32,                     // 15
  lightColor: vec3f,              // 16-18
  _pad2: f32,                     // 19
  ambientIntensity: f32,          // 20
  _reserved_sel: f32,             // 21 - reserved (selection now via outline pass)
  shadowEnabled: f32,             // 22 - Enable/disable shadows
  shadowSoftness: f32,            // 23 - 0 = hard, 1 = soft PCF
  shadowRadius: f32,              // 24 - Shadow coverage radius
  shadowFadeStart: f32,           // 25 - Distance where shadow starts fading
  csmEnabled: f32,                // 26 - Enable CSM (1.0) vs single shadow map (0.0)
  _pad4: f32,                     // 27
  lightSpaceMatrix: mat4x4f,      // 28-43 - Shadow projection matrix
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> material: Material;
@group(0) @binding(2) var heightmap: texture_2d<f32>;
@group(0) @binding(3) var normalmap: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;
@group(0) @binding(5) var shadowMap: texture_depth_2d;
@group(0) @binding(6) var shadowSampler: sampler_comparison;
@group(0) @binding(7) var islandMask: texture_2d<f32>;
@group(0) @binding(8) var biomeMask: texture_2d<f32>;  // Biome weights: R=grass, G=rock, B=forest
@group(0) @binding(9) var vegetationDensityMap: texture_2d<f32>;  // Vegetation density: R = 0-1 (from VegetationDensityMapGenerator)

// ============================================================================
// Biome Texture Bindings (Group 1) - Texture Arrays
// ============================================================================

// Biome layer indices (used to index into texture arrays)
// 3 biomes sourced from biome mask: R=grass, G=rock, B=forest
const BIOME_GRASS: i32 = 0;
const BIOME_ROCK: i32 = 1;
const BIOME_FOREST: i32 = 2;

// Biome texture parameters uniform (matches BiomeTextureUniformData in types.ts)
// Simplified for 3 biomes (grass, rock, forest) — 6 vec4f = 96 bytes
struct BiomeTextureParams {
  // Enable flags (1.0 = enabled, 0.0 = disabled) - vec4f aligned
  // [grass, rock, forest, unused]
  albedoEnabled: vec4f,
  normalEnabled: vec4f,
  aoEnabled: vec4f,
  roughnessEnabled: vec4f,
  displacementEnabled: vec4f,
  // POM enable flags (material-authored opt-in for parallax occlusion mapping)
  pomEnabled: vec4f,
  
  // Tiling scales (world units per texture tile) - vec4f aligned
  // [grass, rock, forest, unused]
  tilingScales: vec4f,
}

// Biome texture arrays (3 layers: grass=0, rock=1, forest=2)
@group(1) @binding(0) var biomeAlbedoArray: texture_2d_array<f32>;
@group(1) @binding(1) var biomeNormalArray: texture_2d_array<f32>;
@group(1) @binding(2) var biomeAoArray: texture_2d_array<f32>;
@group(1) @binding(3) var biomeRoughnessArray: texture_2d_array<f32>;
@group(1) @binding(4) var biomeDisplacementArray: texture_2d_array<f32>;

// Sampler for biome textures
@group(1) @binding(5) var biomeSampler: sampler;

// Biome parameters uniform
@group(1) @binding(6) var<uniform> biomeParams: BiomeTextureParams;

// ============================================================================
// Environment Bindings (Group 3) - IBL + CSM for ambient lighting and shadows
// ============================================================================

// Full IBL from SceneEnvironment for PBR terrain shading
@group(3) @binding(2) var env_iblDiffuse: texture_cube<f32>;
@group(3) @binding(3) var env_iblSpecular: texture_cube<f32>;
@group(3) @binding(4) var env_brdfLut: texture_2d<f32>;
@group(3) @binding(5) var env_cubeSampler: sampler;
@group(3) @binding(6) var env_lutSampler: sampler;

// CSM (Cascaded Shadow Maps) bindings from SceneEnvironment
@group(3) @binding(7) var csmShadowArray: texture_depth_2d_array;
@group(3) @binding(8) var<uniform> csmUniforms: CSMUniforms;

// Multi-light buffers from SceneEnvironment (bindings 10-12)
@group(3) @binding(10) var<uniform> env_lightCounts: TerrainLightCounts;
@group(3) @binding(11) var<storage, read> env_pointLights: array<TerrainPointLightData>;
@group(3) @binding(12) var<storage, read> env_spotLights: array<TerrainSpotLightData>;
// Spot shadow atlas (bindings 13-14)
@group(3) @binding(13) var env_spotShadowAtlas: texture_depth_2d_array;
@group(3) @binding(14) var env_spotShadowSampler: sampler_comparison;

// Cloud shadow map (bindings 17-18) from SceneEnvironment
@group(3) @binding(17) var env_cloudShadowMap: texture_2d<f32>;
@group(3) @binding(18) var<uniform> env_cloudShadowUniforms: CloudShadowSceneUniforms;

// ============================================================================
// Group 2: Vegetation shadow map (grass blade shadows on terrain)
// ============================================================================
struct VegShadowUniforms {
  lightSpaceMatrix: mat4x4f,
  shadowCenter: vec2f,
  shadowRadius: f32,
  enabled: f32,
  texelSize: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
@group(2) @binding(0) var vegShadowMap: texture_depth_2d;
@group(2) @binding(1) var vegShadowSampler: sampler_comparison;
@group(2) @binding(2) var<uniform> vegShadow: VegShadowUniforms;

/**
 * Sample the vegetation shadow map (grass blade shadows on terrain).
 * Projects worldPos into the vegetation shadow map's light space and
 * performs 3×3 PCF. Returns 1.0 (fully lit) if shadow map is disabled
 * or the fragment is outside the shadow map bounds.
 */
fn sampleVegetationShadow(worldPos: vec3f) -> f32 {
  if (vegShadow.enabled < 0.5) { return 1.0; }
  
  let lsp = vegShadow.lightSpaceMatrix * vec4f(worldPos, 1.0);
  var sc = lsp.xyz / lsp.w;
  sc.x = sc.x * 0.5 + 0.5;
  sc.y = sc.y * -0.5 + 0.5;
  
  // Out-of-bounds check
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) {
    return 1.0;
  }
  
  let bias = 0.0003;
  let ts = vegShadow.texelSize;
  
  // 3×3 PCF for soft vegetation shadows
  var shadow = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x) * ts, f32(y) * ts);
      shadow += textureSampleCompareLevel(vegShadowMap, vegShadowSampler, sc.xy + offset, sc.z - bias);
    }
  }
  return shadow / 9.0;
}

struct CloudShadowSceneUniforms {
  shadowCenter: vec2f,
  shadowRadius: f32,
  averageCoverage: f32,
}

fn sampleCloudShadowTerrain(worldPos: vec3f) -> f32 {
  let offset = vec2f(worldPos.x, worldPos.z) - env_cloudShadowUniforms.shadowCenter;
  let uv = offset / (env_cloudShadowUniforms.shadowRadius * 2.0) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
  return textureSampleLevel(env_cloudShadowMap, env_cubeSampler, uv, 0.0).r;
}

fn getOvercastShadowFade() -> f32 {
  return 1.0 - smoothstep(0.6, 0.9, env_cloudShadowUniforms.averageCoverage);
}

// ============================================================================
// CSM Uniform Structure (matches ShadowRendererGPU)
// ============================================================================

struct CSMUniforms {
  viewProjectionMatrices: array<mat4x4f, 4>,  // Light-space VP matrices for each cascade
  cascadeSplits: vec4f,                        // View-space depth splits
  // config: x=cascadeCount, y=csmEnabled, z=blendFraction, w=pad
  config: vec4f,
  // Camera forward direction for view-space depth: xyz = forward, w = 0
  cameraForward: vec4f,
}

// ============================================================================
// IBL Functions
// ============================================================================

// Sample diffuse irradiance from IBL cubemap for ambient lighting
// Returns pre-convolved irradiance for Lambert diffuse
// ============ Multi-Light Structures ============

struct TerrainPointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct TerrainSpotLightData {
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
};

struct TerrainLightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

fn terrainAttenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

fn terrainAttenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}

fn sampleTerrainSpotShadow(worldPos: vec3f, lightSpaceMatrix: mat4x4f, atlasIndex: i32) -> f32 {
  if (atlasIndex < 0) { return 1.0; }
  let lsp = lightSpaceMatrix * vec4f(worldPos, 1.0);
  let pc = lsp.xyz / lsp.w;
  let suv = pc.xy * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || pc.z > 1.0) { return 1.0; }
  let uv = vec2f(suv.x, 1.0 - suv.y);
  return textureSampleCompareLevel(env_spotShadowAtlas, env_spotShadowSampler, uv, atlasIndex, pc.z - 0.002);
}

fn computeTerrainMultiLight(worldPos: vec3f, normal: vec3f) -> vec3f {
  var totalLight = vec3f(0.0);

  let numPoint = min(env_lightCounts.numPoint, 64u);
  for (var i = 0u; i < numPoint; i++) {
    let light = env_pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = terrainAttenuateDistance(dist, light.range);
    totalLight += light.color * light.intensity * NdotL * atten;
  }

  let numSpot = min(env_lightCounts.numSpot, 32u);
  for (var i = 0u; i < numSpot; i++) {
    let light = env_spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    let L = toLight / max(dist, 0.001);
    let NdotL = max(dot(normal, L), 0.0);
    let atten = terrainAttenuateDistance(dist, light.range);
    let cosAngle = dot(-L, normalize(light.direction));
    let spotFalloff = terrainAttenuateSpotCone(cosAngle, light.innerCos, light.outerCos);
    let shadow = sampleTerrainSpotShadow(worldPos, light.lightSpaceMatrix, light.shadowAtlasIndex);
    totalLight += light.color * light.intensity * NdotL * atten * spotFalloff * shadow;
  }

  return totalLight;
}

fn sampleIBLDiffuse(worldNormal: vec3f) -> vec3f {
  return textureSampleLevel(env_iblDiffuse, env_cubeSampler, worldNormal, 0.0).rgb;
}

// ============================================================================
// Biome Texture Sampling Functions (Texture Array Version)
// ============================================================================

// Helper: Get albedo enabled flag for a biome layer (0-2: grass, rock, forest)
fn getBiomeAlbedoEnabled(layer: i32) -> f32 {
  return biomeParams.albedoEnabled[layer];
}

// Helper: Get normal enabled flag for a biome layer (0-2: grass, rock, forest)
fn getBiomeNormalEnabled(layer: i32) -> f32 {
  return biomeParams.normalEnabled[layer];
}

// Helper: Get AO enabled flag for a biome layer (0-2: grass, rock, forest)
fn getBiomeAoEnabled(layer: i32) -> f32 {
  return biomeParams.aoEnabled[layer];
}

// Helper: Get roughness enabled flag for a biome layer (0-2: grass, rock, forest)
fn getBiomeRoughnessEnabled(layer: i32) -> f32 {
  return biomeParams.roughnessEnabled[layer];
}

// Helper: Get displacement enabled flag for a biome layer (0-2: grass, rock, forest)
fn getBiomeDisplacementEnabled(layer: i32) -> f32 {
  return biomeParams.displacementEnabled[layer];
}

// Helper: Get POM enabled flag for a biome layer (0-2: grass, rock, forest)
// This is the material-authored opt-in: only biomes whose material has pomEnabled=true
// will go through the expensive POM ray-march path.
fn getBiomePomEnabled(layer: i32) -> f32 {
  return biomeParams.pomEnabled[layer];
}

// Helper: Check if POM should run for a biome layer.
// Requires BOTH: displacement texture loaded AND material pomEnabled flag set.
fn isBiomePomActive(layer: i32) -> bool {
  return getBiomeDisplacementEnabled(layer) > 0.5 && getBiomePomEnabled(layer) > 0.5;
}

// Helper: Get tiling scale for a biome layer (0-2: grass, rock, forest)
fn getBiomeTiling(layer: i32) -> f32 {
  return biomeParams.tilingScales[layer];
}

// Sample biome albedo from texture array with fallback to solid color
fn sampleBiomeAlbedoArray(
  layer: i32,
  worldUV: vec2f,
  fallbackColor: vec3f,
  uvDdx: vec2f, uvDdy: vec2f
) -> vec3f {
  let enabled = getBiomeAlbedoEnabled(layer);
  let texColor = textureSampleGrad(biomeAlbedoArray, biomeSampler, worldUV, layer, uvDdx, uvDdy).rgb;
  return select(fallbackColor, texColor, enabled > 0.5);
}

// Sample biome normal from texture array and unpack from [0,1] to [-1,1]
fn sampleBiomeNormalArray(
  layer: i32,
  worldUV: vec2f,
  uvDdx: vec2f, uvDdy: vec2f
) -> vec3f {
  let enabled = getBiomeNormalEnabled(layer);
  let texNormal = textureSampleGrad(biomeNormalArray, biomeSampler, worldUV, layer, uvDdx, uvDdy).rgb;
  let unpacked = texNormal * 2.0 - 1.0;
  let normalTangent = vec3f(unpacked.x, unpacked.y, unpacked.z);
  return select(vec3f(0.0, 1.0, 0.0), normalize(normalTangent), enabled > 0.5);
}

// Sample biome AO from texture array
fn sampleBiomeAoArray(
  layer: i32,
  worldUV: vec2f,
  uvDdx: vec2f, uvDdy: vec2f
) -> f32 {
  let enabled = getBiomeAoEnabled(layer);
  let texAo = textureSampleGrad(biomeAoArray, biomeSampler, worldUV, layer, uvDdx, uvDdy).r;
  return select(1.0, texAo, enabled > 0.5);
}

// Sample biome roughness from texture array
fn sampleBiomeRoughnessArray(
  layer: i32,
  worldUV: vec2f,
  uvDdx: vec2f, uvDdy: vec2f
) -> f32 {
  let enabled = getBiomeRoughnessEnabled(layer);
  let texRoughness = textureSampleGrad(biomeRoughnessArray, biomeSampler, worldUV, layer, uvDdx, uvDdy).r;
  return select(DEFAULT_TERRAIN_ROUGHNESS, texRoughness, enabled > 0.5);
}

// Sample biome displacement height from texture array (R channel, 0=low, 1=high)
// Uses textureSampleLevel to avoid uniform control flow issues
fn sampleBiomeDisplacement(
  layer: i32,
  worldUV: vec2f
) -> f32 {
  let enabled = getBiomeDisplacementEnabled(layer);
  let texDisp = textureSampleLevel(biomeDisplacementArray, biomeSampler, worldUV, layer, 0.0).r;
  return select(0.0, texDisp, enabled > 0.5);
}

// Blend 3 biome normals weighted by biome weights (grass, rock, forest)
fn blendBiomeNormals(
  grassNormal: vec3f, grassWeight: f32,
  rockNormal: vec3f, rockWeight: f32,
  forestNormal: vec3f, forestWeight: f32
) -> vec3f {
  let blended = grassNormal * grassWeight
              + rockNormal * rockWeight
              + forestNormal * forestWeight;
  return normalize(blended);
}

// Blend 3 biome AO values weighted by biome weights
fn blendBiomeAo(
  grassAo: f32, grassWeight: f32,
  rockAo: f32, rockWeight: f32,
  forestAo: f32, forestWeight: f32
) -> f32 {
  return grassAo * grassWeight
       + rockAo * rockWeight
       + forestAo * forestWeight;
}

// ============================================================================
// Biome Mask Sampling
// ============================================================================

fn sampleBiomeMaskWeights(uv: vec2f, uvDdx: vec2f, uvDdy: vec2f) -> vec3f {
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  let biome = textureSampleGrad(biomeMask, texSampler, clampedUV, uvDdx, uvDdy);
  return vec3f(biome.r, biome.g, biome.b);
}

// ============================================================================
// Bounds Overlay SDF
// ============================================================================

fn computeBoundsOverlayMask(worldXZ: vec2f) -> f32 {
  if (uniforms.boundsOverlayEnabled < 0.5) {
    return 0.0;
  }

  let center = vec2f(uniforms.boundsOverlayCenterX, uniforms.boundsOverlayCenterZ);
  let halfExtent = vec2f(uniforms.boundsOverlayHalfExtentX, uniforms.boundsOverlayHalfExtentZ);
  let rotation = uniforms.boundsOverlayRotation;
  let featherWidth = uniforms.boundsOverlayFeatherWidth;

  let cosR = cos(rotation);
  let sinR = sin(rotation);
  let offset = worldXZ - center;
  let local = vec2f(
    offset.x * cosR + offset.y * sinR,
    -offset.x * sinR + offset.y * cosR
  );

  let d = abs(local) - halfExtent;
  let outside = length(max(d, vec2f(0.0)));

  if (featherWidth <= 0.0) {
    return select(0.0, 1.0, outside <= 0.0);
  }
  return 1.0 - smoothstep(0.0, featherWidth, outside);
}

// ============================================================================
// PBR Functions for Terrain (GGX Cook-Torrance BRDF)
// ============================================================================

const PBR_EPSILON: f32 = 0.0001;

fn terrainFresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn terrainFresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  return F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn terrainDistributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + PBR_EPSILON);
}

fn terrainGeometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k + PBR_EPSILON);
}

fn terrainGeometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return terrainGeometrySchlickGGX(NdotV, roughness) * terrainGeometrySchlickGGX(NdotL, roughness);
}

// Full PBR directional light (Cook-Torrance BRDF) — NEAR tier only
fn terrainPBRDirectional(
  N: vec3f, V: vec3f, L: vec3f,
  albedo: vec3f, metallic: f32, roughness: f32,
  lightColor: vec3f
) -> vec3f {
  let H = normalize(V + L);
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), PBR_EPSILON);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  
  if (NdotL <= 0.0) { return vec3f(0.0); }
  
  let clampedRoughness = clamp(roughness, 0.04, 1.0);
  let F0 = mix(vec3f(0.04), albedo, metallic);
  
  let D = terrainDistributionGGX(NdotH, clampedRoughness);
  let G = terrainGeometrySmith(NdotV, NdotL, clampedRoughness);
  let F = terrainFresnelSchlick(VdotH, F0);
  
  let specular = (D * G * F) / (4.0 * NdotV * NdotL + PBR_EPSILON);
  let kS = F;
  let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
  let diffuse = kD * albedo / PI;
  
  return (diffuse + specular) * lightColor * NdotL;
}

// Full PBR IBL (diffuse + specular) — NEAR tier only
fn calculateTerrainPBRIBL(
  N: vec3f, V: vec3f,
  albedo: vec3f, metallic: f32, roughness: f32
) -> vec3f {
  let NdotV = max(dot(N, V), PBR_EPSILON);
  let F0 = mix(vec3f(0.04), albedo, metallic);
  
  // Diffuse IBL (use textureSampleLevel for non-uniform control flow safety)
  let irradiance = textureSampleLevel(env_iblDiffuse, env_cubeSampler, N, 0.0).rgb;
  let F_diff = terrainFresnelSchlickRoughness(NdotV, F0, roughness);
  let kD = (vec3f(1.0) - F_diff) * (1.0 - metallic);
  let diffuseIBL = kD * irradiance * albedo;
  
  // Specular IBL
  let R = reflect(-V, N);
  let maxMipLevel = 6.0;
  let specularColor = textureSampleLevel(env_iblSpecular, env_cubeSampler, R, roughness * maxMipLevel).rgb;
  let brdf = textureSampleLevel(env_brdfLut, env_lutSampler, vec2f(NdotV, roughness), 0.0).rg;
  let F_spec = terrainFresnelSchlickRoughness(NdotV, F0, roughness);
  let specularIBL = specularColor * (F_spec * brdf.x + brdf.y);
  
  return diffuseIBL + specularIBL;
}

// Simplified Lambert-only directional — FAR tier (no GGX, no Fresnel, no geometry term)
fn terrainLambertDirectional(
  N: vec3f, L: vec3f,
  albedo: vec3f,
  lightColor: vec3f
) -> vec3f {
  let NdotL = max(dot(N, L), 0.0);
  return albedo / PI * lightColor * NdotL;
}

// Simplified diffuse-only IBL — FAR tier (skip specular cubemap + BRDF LUT)
fn calculateTerrainDiffuseOnlyIBL(
  N: vec3f,
  albedo: vec3f
) -> vec3f {
  let irradiance = textureSampleLevel(env_iblDiffuse, env_cubeSampler, N, 0.0).rgb;
  return irradiance * albedo / PI;
}

fn calculateTerrainIBL(worldNormal: vec3f, albedo: vec3f) -> vec3f {
  let irradiance = sampleIBLDiffuse(worldNormal);
  return irradiance / PI * albedo;
}

// ============================================================================
// POM (Parallax Occlusion Mapping) Functions
// ============================================================================

// Perform steep parallax ray-march + binary refinement for a single biome layer.
// Returns the shifted worldUV after POM displacement.
// viewDirTS: view direction in tangent space (must point INTO the surface, i.e., towards negative Z)
// worldUV: original tiling UV for this biome
// layer: biome layer index (0-2)
// heightScale: displacement height scaled by distance fade
fn performPOM(
  viewDirTS: vec3f,
  worldUV: vec2f,
  layer: i32,
  heightScale: f32
) -> vec2f {
  // Skip if no displacement texture or zero scale
  if (getBiomeDisplacementEnabled(layer) < 0.5 || heightScale <= 0.0) {
    return worldUV;
  }
  
  // Adaptive step count: more steps at grazing angles
  let NdotV = abs(viewDirTS.z);
  let numSteps = i32(mix(uniforms.pomMaxSteps, uniforms.pomMinSteps, NdotV));
  let layerDepth = 1.0 / f32(numSteps);
  
  // Direction to march along (XY of view dir, scaled by height)
  // Clamp min z to 0.25 to prevent extreme UV offsets at grazing angles
  let p = viewDirTS.xy / max(abs(viewDirTS.z), 0.25) * heightScale;
  let deltaUV = p / f32(numSteps);
  
  // Linear search: march from top (depth=0) to bottom (depth=1)
  // Use textureSampleLevel(mip=0) instead of textureSample to satisfy uniform control flow
  var currentUV = worldUV;
  var currentDepth = 0.0;
  var currentHeight = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, currentUV, layer, 0.0).r;
  
  for (var i = 0; i < numSteps; i++) {
    if (currentDepth >= currentHeight) {
      break;
    }
    currentUV -= deltaUV;
    currentDepth += layerDepth;
    currentHeight = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, currentUV, layer, 0.0).r;
  }
  
  // Binary refinement (3 iterations) for precise intersection
  var prevUV = currentUV + deltaUV;
  var prevDepth = currentDepth - layerDepth;
  
  for (var j = 0; j < 3; j++) {
    let midUV = (currentUV + prevUV) * 0.5;
    let midDepth = (currentDepth + prevDepth) * 0.5;
    let midHeight = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, midUV, layer, 0.0).r;
    
    if (midDepth >= midHeight) {
      currentUV = midUV;
      currentDepth = midDepth;
    } else {
      prevUV = midUV;
      prevDepth = midDepth;
    }
  }
  
  return currentUV;
}

// POM self-shadow: cast a second ray from the POM intersection toward the light.
// Returns shadow factor (0 = fully shadowed, 1 = fully lit).
fn pomSelfShadow(
  lightDirTS: vec3f,
  worldUV: vec2f,
  layer: i32,
  heightScale: f32,
  currentHeight: f32
) -> f32 {
  if (getBiomeDisplacementEnabled(layer) < 0.5 || heightScale <= 0.0) {
    return 1.0;
  }
  
  // March toward light, check if any height occludes
  let numSteps = 8;
  // Clamp min z to 0.25 to prevent extreme UV offsets at grazing angles
  let p = lightDirTS.xy / max(abs(lightDirTS.z), 0.25) * heightScale;
  let deltaUV = p / f32(numSteps);
  let layerDepth = 1.0 / f32(numSteps);
  
  var sampleUV = worldUV;
  var sampleDepth = currentHeight;
  
  for (var i = 0; i < numSteps; i++) {
    sampleUV += deltaUV;
    sampleDepth -= layerDepth;
    let h = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, sampleUV, layer, 0.0).r;
    if (h < sampleDepth) {
      // An occluder found — shadow
      return 0.0;
    }
  }
  
  return 1.0;
}

// ============================================================================
// Vertex Structures
// ============================================================================

struct VertexInput {
  // Per-vertex attributes
  @location(0) gridPosition: vec2f,
  @location(1) uv: vec2f,
  @location(6) isSkirt: f32,
  
  // Per-instance attributes
  @location(2) nodeOffset: vec2f,
  @location(3) nodeScale: f32,
  @location(4) nodeMorph: f32,
  @location(5) nodeLOD: f32,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) texCoord: vec2f,
  @location(2) localUV: vec2f,
  @location(3) normal: vec3f,
  @location(4) slope: f32,
  @location(5) lodLevel: f32,
  @location(6) morphFactor: f32,
  @location(7) lightSpacePos: vec4f,
}

// ============================================================================
// Noise Functions for Procedural Detail (with Analytical Derivatives)
// ============================================================================

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn gradientNoise2D(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

fn gradientNoise2DWithDerivatives(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = hash2(i) * 2.0 - 1.0;
  let b = hash2(i + vec2f(1.0, 0.0)) * 2.0 - 1.0;
  let c = hash2(i + vec2f(0.0, 1.0)) * 2.0 - 1.0;
  let d = hash2(i + vec2f(1.0, 1.0)) * 2.0 - 1.0;
  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;
  let value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  let dvdx = du.x * (k1 + k3 * u.y);
  let dvdy = du.y * (k2 + k3 * u.x);
  return vec3f(value, dvdx, dvdy);
}

fn fbm(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * gradientNoise2D(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
    pos = vec2f(pos.x * 0.866 - pos.y * 0.5, pos.x * 0.5 + pos.y * 0.866);
  }
  return value / totalAmplitude;
}

fn fbmWithDerivatives(p: vec2f, octaves: i32) -> vec3f {
  var value = 0.0;
  var deriv = vec2f(0.0);
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  let cos30 = 0.866;
  let sin30 = 0.5;
  var rotCos = 1.0;
  var rotSin = 0.0;
  for (var i = 0; i < octaves; i++) {
    let scaledPos = pos * frequency;
    let noiseResult = gradientNoise2DWithDerivatives(scaledPos);
    value += amplitude * noiseResult.x;
    let localDeriv = vec2f(noiseResult.y, noiseResult.z) * frequency;
    let rotatedDeriv = vec2f(
      localDeriv.x * rotCos + localDeriv.y * rotSin,
      -localDeriv.x * rotSin + localDeriv.y * rotCos
    );
    deriv += amplitude * rotatedDeriv;
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
    pos = vec2f(pos.x * cos30 - pos.y * sin30, pos.x * sin30 + pos.y * cos30);
    let newRotCos = rotCos * cos30 - rotSin * sin30;
    let newRotSin = rotCos * sin30 + rotSin * cos30;
    rotCos = newRotCos;
    rotSin = newRotSin;
  }
  return vec3f(value, deriv.x, deriv.y) / totalAmplitude;
}

fn getProceduralDetail(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> f32 {
  if (uniforms.detailAmplitude <= 0.0) { return 0.0; }
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  if (fadeFactor <= 0.0) { return 0.0; }
  let slopeBlendLow = 0.25;
  let slopeBlendHigh = 0.55;
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatNoise = fbm(worldXZ * flatFreq, 2);
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepNoise = fbm(worldXZ * steepFreq, max(i32(uniforms.detailOctaves), 4));
  let noiseValue = mix(flatNoise, steepNoise, blendFactor);
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  return noiseValue * uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
}

fn getProceduralDetailNormal(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> vec3f {
  if (uniforms.detailAmplitude <= 0.0) { return vec3f(0.0, 1.0, 0.0); }
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  if (fadeFactor <= 0.0) { return vec3f(0.0, 1.0, 0.0); }
  let slopeBlendLow = 0.25;
  let slopeBlendHigh = 0.55;
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatResult = fbmWithDerivatives(worldXZ * flatFreq, 2);
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepResult = fbmWithDerivatives(worldXZ * steepFreq, max(i32(uniforms.detailOctaves), 4));
  let flatDeriv = vec2f(flatResult.y, flatResult.z) * flatFreq;
  let steepDeriv = vec2f(steepResult.y, steepResult.z) * steepFreq;
  let blendedDeriv = mix(flatDeriv, steepDeriv, blendFactor);
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  let scale = uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
  let dhdx = blendedDeriv.x * scale;
  let dhdz = blendedDeriv.y * scale;
  return normalize(vec3f(-dhdx, 1.0, -dhdz));
}

// ============================================================================
// Anti-Tiling Functions
// ============================================================================

// Per-biome tiling result: contains all UV data needed for texture sampling.
// Encapsulates tiling-method-specific computations so fs_main stays clean.
// When adding new tiling methods (e.g., hex_tiling), only this struct and
// computeBiomeTilingUVs() need to change.
struct BiomeTilingUVs {
  // Detail-scale UVs (used for all texture types: albedo, normal, AO, roughness, displacement)
  grassUV: vec2f,
  rockUV: vec2f,
  forestUV: vec2f,
  // Detail-scale UV gradients (for textureSampleGrad)
  grassDdx: vec2f, grassDdy: vec2f,
  rockDdx: vec2f, rockDdy: vec2f,
  forestDdx: vec2f, forestDdy: vec2f,
  // Macro-scale UVs and gradients (used only for albedo anti-tile blend)
  grassMacroUV: vec2f, grassMacroDdx: vec2f, grassMacroDdy: vec2f,
  rockMacroUV: vec2f, rockMacroDdx: vec2f, rockMacroDdy: vec2f,
  forestMacroUV: vec2f, forestMacroDdx: vec2f, forestMacroDdy: vec2f,
}

// Compute all biome tiling UVs from world position.
// This is the single entry point for tiling strategy — when switching to
// hex_tiling (TILING_TYPE=2), modify this function's internals only.
// Must be called in uniform control flow (before non-uniform branches like POM).
fn computeBiomeTilingUVs(worldXZ: vec2f) -> BiomeTilingUVs {
  var result: BiomeTilingUVs;
  
  // Noise UV distortion (breaks grid alignment for TILING_TYPE=1)
  var noiseOffset = vec2f(0.0);
  if (TILING_TYPE == 1) {
    let noiseCoord = worldXZ * ANTI_TILE_NOISE_FREQ;
    let nx = gradientNoise2D(noiseCoord);
    let ny = gradientNoise2D(noiseCoord + vec2f(31.7, 47.3));
    noiseOffset = vec2f(nx, ny) * ANTI_TILE_NOISE_STRENGTH;
  }
  
  // Detail-scale UVs (base tiling + noise distortion)
  result.grassUV = worldXZ / getBiomeTiling(BIOME_GRASS) + noiseOffset;
  result.rockUV = worldXZ / getBiomeTiling(BIOME_ROCK) + noiseOffset;
  result.forestUV = worldXZ / getBiomeTiling(BIOME_FOREST) + noiseOffset;
  
  // UV gradients (must be computed in uniform control flow)
  result.grassDdx = dpdx(result.grassUV); result.grassDdy = dpdy(result.grassUV);
  result.rockDdx = dpdx(result.rockUV); result.rockDdy = dpdy(result.rockUV);
  result.forestDdx = dpdx(result.forestUV); result.forestDdy = dpdy(result.forestUV);
  
  // Macro-scale UVs for multi-scale albedo blend
  result.grassMacroUV = result.grassUV * ANTI_TILE_MACRO_SCALE;
  result.rockMacroUV = result.rockUV * ANTI_TILE_MACRO_SCALE;
  result.forestMacroUV = result.forestUV * ANTI_TILE_MACRO_SCALE;
  result.grassMacroDdx = result.grassDdx * ANTI_TILE_MACRO_SCALE;
  result.grassMacroDdy = result.grassDdy * ANTI_TILE_MACRO_SCALE;
  result.rockMacroDdx = result.rockDdx * ANTI_TILE_MACRO_SCALE;
  result.rockMacroDdy = result.rockDdy * ANTI_TILE_MACRO_SCALE;
  result.forestMacroDdx = result.forestDdx * ANTI_TILE_MACRO_SCALE;
  result.forestMacroDdy = result.forestDdy * ANTI_TILE_MACRO_SCALE;
  
  return result;
}

// ---- Hex-tiling helpers (TILING_TYPE == 2) ----
// Based on "Procedural Stochastic Textures by Tiling and Blending" (Heitz & Neyret, 2018)
// Simplified variant: 3 hex cells, per-cell random rotation, smooth barycentric blend.

// 2D hash returning vec2 in [0,1)
fn hexHash2(p: vec2f) -> vec2f {
  var q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

// Rotate UV by angle (radians)
fn rotateUV(uv: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
}

// Hex-tile sample: samples texture at 3 overlapping hex cells with random rotation,
// blends by smooth barycentric weights. Completely eliminates grid repetition.
fn sampleBiomeAlbedoHexTiled(
  layer: i32,
  baseUV: vec2f,
  fallbackColor: vec3f,
  uvDdx: vec2f, uvDdy: vec2f
) -> vec3f {
  let enabled = getBiomeAlbedoEnabled(layer);
  if (enabled < 0.5) { return fallbackColor; }
  
  // Hex grid: transform UV to skewed hex coordinates
  let skew = mat2x2f(1.0, 0.0, -0.57735027, 1.15470054); // 1/sqrt(3), 2/sqrt(3)
  let hexUV = skew * baseUV;
  let hexCell = floor(hexUV);
  let hexFrac = fract(hexUV);
  
  // Determine which triangle of the hex cell we're in, pick 3 vertices
  let inUpper = select(0.0, 1.0, hexFrac.x + hexFrac.y > 1.0);
  let v0 = hexCell + vec2f(inUpper, inUpper);
  let v1 = hexCell + vec2f(1.0, 0.0);
  let v2 = hexCell + vec2f(0.0, 1.0);
  
  // Barycentric weights (smooth)
  var w = vec3f(0.0);
  if (inUpper > 0.5) {
    w = vec3f(hexFrac.x + hexFrac.y - 1.0, 1.0 - hexFrac.x, 1.0 - hexFrac.y);
  } else {
    w = vec3f(1.0 - hexFrac.x - hexFrac.y, hexFrac.x, hexFrac.y);
  }
  // Smooth step to reduce blending zone artifacts
  w = w * w * (3.0 - 2.0 * w);
  w = w / (w.x + w.y + w.z);
  
  // Per-vertex random rotation angle (0 to 2π)
  let r0 = hexHash2(v0).x * 2.0 * PI;
  let r1 = hexHash2(v1).x * 2.0 * PI;
  let r2 = hexHash2(v2).x * 2.0 * PI;
  
  // Sample at 3 rotated UVs (using textureSampleGrad for correct mipmapping)
  let uv0 = rotateUV(baseUV, r0);
  let uv1 = rotateUV(baseUV, r1);
  let uv2 = rotateUV(baseUV, r2);
  
  // Rotate gradients too for correct mip selection
  let ddx0 = rotateUV(uvDdx, r0); let ddy0 = rotateUV(uvDdy, r0);
  let ddx1 = rotateUV(uvDdx, r1); let ddy1 = rotateUV(uvDdy, r1);
  let ddx2 = rotateUV(uvDdx, r2); let ddy2 = rotateUV(uvDdy, r2);
  
  let c0 = textureSampleGrad(biomeAlbedoArray, biomeSampler, uv0, layer, ddx0, ddy0).rgb;
  let c1 = textureSampleGrad(biomeAlbedoArray, biomeSampler, uv1, layer, ddx1, ddy1).rgb;
  let c2 = textureSampleGrad(biomeAlbedoArray, biomeSampler, uv2, layer, ddx2, ddy2).rgb;
  
  return c0 * w.x + c1 * w.y + c2 * w.z;
}

// Sample biome albedo with anti-tiling: blends detail-scale + macro-scale samples
// to break up visible repetition on large terrains.
fn sampleBiomeAlbedoAntiTiled(
  layer: i32,
  detailUV: vec2f,
  macroUV: vec2f,
  fallbackColor: vec3f,
  uvDdx: vec2f, uvDdy: vec2f,
  macroDdx: vec2f, macroDdy: vec2f
) -> vec3f {
  let enabled = getBiomeAlbedoEnabled(layer);
  if (enabled < 0.5) { return fallbackColor; }
  
  // Hex-tiling path (3× samples, best quality)
  if (TILING_TYPE == 2) {
    return sampleBiomeAlbedoHexTiled(layer, detailUV, fallbackColor, uvDdx, uvDdy);
  }
  
  // Detail scale (normal tiling)
  let detailColor = textureSampleGrad(biomeAlbedoArray, biomeSampler, detailUV, layer, uvDdx, uvDdy).rgb;
  
  // Noise + multi-scale path
  if (TILING_TYPE == 1) {
    let macroColor = textureSampleGrad(biomeAlbedoArray, biomeSampler, macroUV, layer, macroDdx, macroDdy).rgb;
    let macroLum = dot(macroColor, vec3f(0.299, 0.587, 0.114));
    let variation = mix(1.0, macroLum / max(dot(fallbackColor, vec3f(0.299, 0.587, 0.114)), 0.1), ANTI_TILE_MACRO_BLEND);
    return detailColor * clamp(variation, 0.6, 1.4);
  }
  
  // TILING_TYPE == 0: no anti-tiling
  return detailColor;
}

// ============================================================================
// Helper Functions
// ============================================================================

fn worldToUV(worldXZ: vec2f) -> vec2f {
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  return (worldXZ - terrainOrigin) / uniforms.terrainSize;
}

fn sampleIslandMask(uv: vec2f) -> f32 {
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  let dims = textureDimensions(islandMask);
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = clamp(texel00 + vec2i(1, 0), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  let texel01 = clamp(texel00 + vec2i(0, 1), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  let texel11 = clamp(texel00 + vec2i(1, 1), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  let m00 = textureLoad(islandMask, texel00, 0).r;
  let m10 = textureLoad(islandMask, texel10, 0).r;
  let m01 = textureLoad(islandMask, texel01, 0).r;
  let m11 = textureLoad(islandMask, texel11, 0).r;
  let frac_uv = fract(texelF);
  let m0 = mix(m00, m10, frac_uv.x);
  let m1 = mix(m01, m11, frac_uv.x);
  return mix(m0, m1, frac_uv.y);
}

fn sampleHeightAt(texCoord: vec2i, mipLevel: i32) -> f32 {
  let dims = textureDimensions(heightmap, mipLevel);
  let clampedCoord = clamp(texCoord, vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  return textureLoad(heightmap, clampedCoord, mipLevel).r;
}

fn sampleHeightSmooth(worldXZ: vec2f, lodLevel: f32) -> f32 {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  let mipLevel = i32(lodLevel);
  let dims = textureDimensions(heightmap, mipLevel);
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = texel00 + vec2i(1, 0);
  let texel01 = texel00 + vec2i(0, 1);
  let texel11 = texel00 + vec2i(1, 1);
  let h00 = sampleHeightAt(texel00, mipLevel);
  let h10 = sampleHeightAt(texel10, mipLevel);
  let h01 = sampleHeightAt(texel01, mipLevel);
  let h11 = sampleHeightAt(texel11, mipLevel);
  let frac_uv = fract(texelF);
  let h0 = mix(h00, h10, frac_uv.x);
  let h1 = mix(h01, h11, frac_uv.x);
  return mix(h0, h1, frac_uv.y);
}

fn sampleNormalWorld(worldXZ: vec2f, lodLevel: f32) -> vec3f {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  let normalSample = textureSampleLevel(normalmap, texSampler, clampedUV, lodLevel).rgb;
  return normalize(vec3f(normalSample.x, normalSample.y, normalSample.z));
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  var worldXZ = input.gridPosition * input.nodeScale * (uniforms.gridSize - 1.0) + input.nodeOffset;
  
  let parentScale = input.nodeScale * 2.0;
  let parentGridPos = worldXZ / parentScale;
  let fracPart = fract(parentGridPos + 0.5);
  let oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0);
  let oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0);
  let morphX = oddX * input.nodeMorph;
  let morphZ = oddZ * input.nodeMorph;
  let snappedXZ = floor(worldXZ / parentScale + 0.5) * parentScale;
  let morphedXZ = vec2f(
    mix(worldXZ.x, snappedXZ.x, morphX),
    mix(worldXZ.y, snappedXZ.y, morphZ)
  );
  
  var normalizedHeight = sampleHeightSmooth(morphedXZ, input.nodeLOD);
  
  if (uniforms.islandEnabled > 0.5) {
    let uv = worldToUV(morphedXZ);
    let mask = sampleIslandMask(uv);
    normalizedHeight = mix(uniforms.seaFloorDepth, normalizedHeight, mask);
  }
  
  var height = normalizedHeight * uniforms.heightScale;
  let normal = sampleNormalWorld(morphedXZ, input.nodeLOD);
  let slope = 1.0 - normal.y;
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(morphedXZ - cameraXZ);
  let proceduralDetail = getProceduralDetail(morphedXZ, distanceToCamera, slope);
  height = height + proceduralDetail;
  
  var finalHeight: f32;
  if (uniforms.debugMode > 0.5) {
    finalHeight = 0.0;
  } else {
    finalHeight = height;
    if (input.isSkirt > 0.5) {
      let skirtOffset = input.nodeScale * (uniforms.gridSize - 1.0) * 0.15;
      finalHeight = height - skirtOffset;
    }
  }
  
  let worldPos = vec3f(morphedXZ.x, finalHeight, morphedXZ.y);
  let mvp = uniforms.viewProjectionMatrix * uniforms.modelMatrix;
  output.clipPosition = mvp * vec4f(worldPos, 1.0);
  let worldPos4 = uniforms.modelMatrix * vec4f(worldPos, 1.0);
  output.worldPosition = worldPos4.xyz;
  output.lightSpacePos = material.lightSpaceMatrix * worldPos4;
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  output.texCoord = (morphedXZ - terrainOrigin) / uniforms.terrainSize;
  output.localUV = input.uv;
  output.normal = normalize((uniforms.modelMatrix * vec4f(normal, 0.0)).xyz);
  output.slope = 1.0 - normal.y;
  output.lodLevel = input.nodeLOD;
  output.morphFactor = input.nodeMorph;
  
  return output;
}

// ============================================================================
// Fragment Shader Helper: TBN
// ============================================================================

fn buildTerrainTBN(worldNormal: vec3f) -> mat3x3f {
  let worldUp = vec3f(0.0, 1.0, 0.0);
  var tangent = cross(worldUp, worldNormal);
  let tangentLen = length(tangent);
  if (tangentLen < 0.001) {
    tangent = vec3f(1.0, 0.0, 0.0);
  } else {
    tangent = tangent / tangentLen;
  }
  let bitangent = normalize(cross(worldNormal, tangent));
  return mat3x3f(tangent, bitangent, worldNormal);
}

fn blendNormalsUDN(baseN: vec3f, detailN: vec3f) -> vec3f {
  return normalize(vec3f(baseN.xy + detailN.xy, baseN.z));
}

// ============================================================================
// Shadow Sampling Functions (unchanged)
// ============================================================================

fn sampleShadowHard(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = 0.0003;
  let slopeBias = 0.0006;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  let shadowValue = textureSampleCompare(shadowMap, shadowSampler, clampedUV, clampedDepth);
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  return mix(1.0, shadowValue, inBounds);
}

fn sampleShadowPCF(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f, kernelSize: i32) -> f32 {
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = 0.0003;
  let slopeBias = 0.0006;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let biasedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  let shadowMapSize = textureDimensions(shadowMap);
  let texelSize = vec2f(1.0 / f32(shadowMapSize.x), 1.0 / f32(shadowMapSize.y));
  var shadow = 0.0;
  let halfKernel = kernelSize / 2;
  var samples = 0.0;
  for (var x = -halfKernel; x <= halfKernel; x++) {
    for (var y = -halfKernel; y <= halfKernel; y++) {
      let offset = vec2f(f32(x), f32(y)) * texelSize;
      let sampleUV = clamp(shadowUV + offset, vec2f(0.001), vec2f(0.999));
      shadow += textureSampleCompare(shadowMap, shadowSampler, sampleUV, biasedDepth);
      samples += 1.0;
    }
  }
  let shadowValue = shadow / samples;
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  return mix(1.0, shadowValue, inBounds);
}

// ============================================================================
// CSM Shadow Sampling Functions
// ============================================================================

fn selectCascade(viewDepth: f32) -> i32 {
  let cascadeCount = i32(csmUniforms.config.x);
  if (viewDepth < csmUniforms.cascadeSplits.x) { return 0; }
  if (viewDepth < csmUniforms.cascadeSplits.y && cascadeCount > 1) { return 1; }
  if (viewDepth < csmUniforms.cascadeSplits.z && cascadeCount > 2) { return 2; }
  if (cascadeCount > 3) { return 3; }
  return cascadeCount - 1;
}

fn getCascadeSplit(cascade: i32) -> f32 {
  if (cascade == 0) { return csmUniforms.cascadeSplits.x; }
  if (cascade == 1) { return csmUniforms.cascadeSplits.y; }
  if (cascade == 2) { return csmUniforms.cascadeSplits.z; }
  return csmUniforms.cascadeSplits.w;
}

fn projectToCascade(worldPos: vec4f, cascade: i32, normal: vec3f, lightDir: vec3f) -> vec4f {
  let lightSpacePos = csmUniforms.viewProjectionMatrices[cascade] * worldPos;
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  let cascadeSize = textureDimensions(csmShadowArray);
  let texelDepth = 1.0 / f32(cascadeSize.x);
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = texelDepth * 0.5;
  let slopeBias_val = texelDepth * 2.0;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias_val;
  let biasedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  return vec4f(shadowUV, biasedDepth, inBounds);
}

fn sampleCascadeHard(cascade: i32, shadowUV: vec2f, biasedDepth: f32) -> f32 {
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  return textureSampleCompareLevel(csmShadowArray, shadowSampler, clampedUV, cascade, biasedDepth);
}

fn sampleCascadePCF(cascade: i32, shadowUV: vec2f, biasedDepth: f32) -> f32 {
  let cascadeSize = textureDimensions(csmShadowArray);
  let texelSize = vec2f(1.0 / f32(cascadeSize.x), 1.0 / f32(cascadeSize.y));
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  var shadow = 0.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      let offset = vec2f(f32(x), f32(y)) * texelSize;
      let sampleUV = clamp(clampedUV + offset, vec2f(0.001), vec2f(0.999));
      shadow += textureSampleCompareLevel(csmShadowArray, shadowSampler, sampleUV, cascade, biasedDepth);
    }
  }
  return shadow / 9.0;
}

fn sampleCascadeShadow(cascade: i32, shadowUV: vec2f, biasedDepth: f32) -> f32 {
  let hardShadow = sampleCascadeHard(cascade, shadowUV, biasedDepth);
  let softShadow = sampleCascadePCF(cascade, shadowUV, biasedDepth);
  return mix(hardShadow, softShadow, material.shadowSoftness);
}

fn sampleCSMShadow(worldPos: vec4f, viewDepth: f32, normal: vec3f, lightDir: vec3f) -> f32 {
  let startCascade = selectCascade(viewDepth);
  let cascadeCount = i32(csmUniforms.config.x);
  var validCascade = -1;
  var validProj = vec4f(0.0);
  if (startCascade <= 0 && 0 < cascadeCount && validCascade < 0) {
    let proj = projectToCascade(worldPos, 0, normal, lightDir);
    if (proj.w > 0.5) { validCascade = 0; validProj = proj; }
  }
  if (startCascade <= 1 && 1 < cascadeCount && validCascade < 0) {
    let proj = projectToCascade(worldPos, 1, normal, lightDir);
    if (proj.w > 0.5) { validCascade = 1; validProj = proj; }
  }
  if (startCascade <= 2 && 2 < cascadeCount && validCascade < 0) {
    let proj = projectToCascade(worldPos, 2, normal, lightDir);
    if (proj.w > 0.5) { validCascade = 2; validProj = proj; }
  }
  if (startCascade <= 3 && 3 < cascadeCount && validCascade < 0) {
    let proj = projectToCascade(worldPos, 3, normal, lightDir);
    if (proj.w > 0.5) { validCascade = 3; validProj = proj; }
  }
  if (validCascade < 0) { return 1.0; }
  let shadow0 = sampleCascadeShadow(validCascade, validProj.xy, validProj.z);
  let cascadeSplit = getCascadeSplit(validCascade);
  let blendRegion = cascadeSplit * csmUniforms.config.z;
  let blendStart = cascadeSplit - blendRegion;
  if (viewDepth > blendStart && validCascade < cascadeCount - 1) {
    let nextCascade = validCascade + 1;
    let nextProj = projectToCascade(worldPos, nextCascade, normal, lightDir);
    if (nextProj.w > 0.5) {
      let shadow1 = sampleCascadeShadow(nextCascade, nextProj.xy, nextProj.z);
      let blendFactor = smoothstep(blendStart, cascadeSplit, viewDepth);
      return mix(shadow0, shadow1, blendFactor);
    }
  }
  return shadow0;
}

fn calculateShadow(lightSpacePos: vec4f, worldPos: vec3f, normal: vec3f, lightDir: vec3f) -> f32 {
  let cameraXZ = uniforms.cameraPosition.xz;
  let fragXZ = worldPos.xz;
  let distanceFromCamera = length(fragXZ - cameraXZ);
  let fadeStart = material.shadowRadius * 0.8;
  let fadeEnd = material.shadowRadius;
  let fadeFactor = 1.0 - smoothstep(fadeStart, fadeEnd, distanceFromCamera);
  var shadowValue = 1.0;
  if (material.csmEnabled > 0.5) {
    let cameraFwd = normalize(csmUniforms.cameraForward.xyz);
    let viewDepth = abs(dot(worldPos - uniforms.cameraPosition, cameraFwd));
    shadowValue = sampleCSMShadow(vec4f(worldPos, 1.0), viewDepth, normal, lightDir);
  } else {
    let hardShadow = sampleShadowHard(lightSpacePos, normal, lightDir);
    let softShadow = sampleShadowPCF(lightSpacePos, normal, lightDir, 3);
    shadowValue = mix(hardShadow, softShadow, material.shadowSoftness);
  }
  let cloudShadow = sampleCloudShadowTerrain(worldPos);
  shadowValue = shadowValue * cloudShadow;
  shadowValue = shadowValue * sampleVegetationShadow(worldPos);
  let overcastFade = getOvercastShadowFade();
  let enabledFactor = step(0.5, material.shadowEnabled);
  let finalFadeFactor = fadeFactor * enabledFactor * overcastFade;
  return mix(1.0, shadowValue, finalFadeFactor);
}

// ============================================================================
// Fragment Shader
// ============================================================================

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) normals: vec4f,
}

@fragment
fn fs_main(input: VertexOutput) -> FragmentOutput {
  var fragOutput: FragmentOutput;
  let baseNormal = normalize(input.normal);
  
  // Debug mode
  if (uniforms.debugMode > 0.5) {
    let worldXZ = input.texCoord * uniforms.terrainSize - vec2f(uniforms.terrainSize * 0.5);
    let height = sampleHeightSmooth(worldXZ, input.lodLevel);
    let normalizedHeight = clamp(height + 0.5, 0.0, 1.0);
    let edgeThreshold = 0.02;
    var patchEdge = 0.0;
    if (input.localUV.x < edgeThreshold || input.localUV.x > 1.0 - edgeThreshold ||
        input.localUV.y < edgeThreshold || input.localUV.y > 1.0 - edgeThreshold) {
      patchEdge = 1.0;
    }
    var debugColor = vec3f(normalizedHeight);
    debugColor = mix(debugColor, vec3f(1.0, 0.0, 0.0), patchEdge * 0.5);
    fragOutput.color = vec4f(debugColor, 1.0);
    fragOutput.normals = vec4f(0.0, 0.0, 0.0, 0.0);
    return fragOutput;
  }
  
  // ===== Compute distances and LOD tier =====
  let worldXZ = input.worldPosition.xz;
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(worldXZ - cameraXZ);
  
  // Distance-based shading LOD: two-tier system
  // nearFactor: 1.0 = full near tier, 0.0 = full far tier
  let nearFactor = 1.0 - smoothstep(uniforms.detailFadeStart, uniforms.detailFadeEnd, distanceToCamera);
  let isNearTier = nearFactor > 0.01;
  
  // Procedural detail normal (same for both tiers as it's vertex-level detail)
  let detailNormal = getProceduralDetailNormal(worldXZ, distanceToCamera, input.slope);
  let blendedNormal = blendNormalsUDN(baseNormal, detailNormal);
  
  // ===== Precompute UV derivatives (must be in uniform control flow, before non-uniform branches) =====
  let tcDdx = dpdx(input.texCoord);
  let tcDdy = dpdy(input.texCoord);
  
  // ===== Biome weights =====
  let biomeWeights = sampleBiomeMaskWeights(input.texCoord, tcDdx, tcDdy);
  var grassWeight = biomeWeights.x;
  var rockWeight = biomeWeights.y;
  var forestWeight = biomeWeights.z;
  let totalWeight = grassWeight + rockWeight + forestWeight;
  if (totalWeight > 0.001) {
    grassWeight /= totalWeight;
    rockWeight /= totalWeight;
    forestWeight /= totalWeight;
  } else {
    grassWeight = 1.0;
    rockWeight = 0.0;
    forestWeight = 0.0;
  }
  
  // ===== Compute tiling UVs per biome (encapsulates all anti-tiling strategy) =====
  let tiling = computeBiomeTilingUVs(worldXZ);
  var grassUV = tiling.grassUV;
  var rockUV = tiling.rockUV;
  var forestUV = tiling.forestUV;
  let grassUVDdx = tiling.grassDdx; let grassUVDdy = tiling.grassDdy;
  let rockUVDdx = tiling.rockDdx; let rockUVDdy = tiling.rockDdy;
  let forestUVDdx = tiling.forestDdx; let forestUVDdy = tiling.forestDdy;
  
  // ===== POM: Parallax Occlusion Mapping (NEAR TIER ONLY) =====
  // Compute view direction in tangent space for POM
  if (isNearTier) {
    let TBN_pom = buildTerrainTBN(blendedNormal);
    let V_world = normalize(uniforms.cameraPosition - input.worldPosition);
    // Transform view direction to tangent space (transpose of TBN = inverse for orthonormal basis)
    let V_tangent = normalize(vec3f(
      dot(V_world, TBN_pom[0]),
      dot(V_world, TBN_pom[1]),
      dot(V_world, TBN_pom[2])
    ));
    
    // Fade POM height to 0 as distance approaches detailFadeStart
    let pomHeightScale = uniforms.displacementScale * nearFactor;
    
    // Perform POM per biome (skip if biome has no displacement, POM not enabled, or zero weight)
    if (grassWeight > 0.01 && isBiomePomActive(BIOME_GRASS)) {
      grassUV = performPOM(V_tangent, grassUV, BIOME_GRASS, pomHeightScale);
    }
    if (rockWeight > 0.01 && isBiomePomActive(BIOME_ROCK)) {
      rockUV = performPOM(V_tangent, rockUV, BIOME_ROCK, pomHeightScale);
    }
    if (forestWeight > 0.01 && isBiomePomActive(BIOME_FOREST)) {
      forestUV = performPOM(V_tangent, forestUV, BIOME_FOREST, pomHeightScale);
    }
  }
  
  // ===== Sample biome textures using (potentially POM-shifted) UVs =====
  // Albedo always sampled (needed by both tiers) — uses anti-tiled multi-scale blend
  let grassAlbedoColor = sampleBiomeAlbedoAntiTiled(BIOME_GRASS, grassUV, tiling.grassMacroUV, material.grassColor.rgb, grassUVDdx, grassUVDdy, tiling.grassMacroDdx, tiling.grassMacroDdy);
  let rockAlbedoColor = sampleBiomeAlbedoAntiTiled(BIOME_ROCK, rockUV, tiling.rockMacroUV, material.rockColor.rgb, rockUVDdx, rockUVDdy, tiling.rockMacroDdx, tiling.rockMacroDdy);
  let forestAlbedoColor = sampleBiomeAlbedoAntiTiled(BIOME_FOREST, forestUV, tiling.forestMacroUV, material.forestColor.rgb, forestUVDdx, forestUVDdy, tiling.forestMacroDdx, tiling.forestMacroDdy);
  var albedo = grassAlbedoColor * grassWeight
             + rockAlbedoColor * rockWeight
             + forestAlbedoColor * forestWeight;
  
  // ===== Declare variables for both tiers =====
  var normal = blendedNormal;
  var biomeAo = 1.0;
  var terrainRoughness = DEFAULT_TERRAIN_ROUGHNESS;  // Default for far tier
  
  // ===== NEAR TIER: Full detail (biome normals, AO, roughness, POM) =====
  if (isNearTier) {
    // Sample normal maps with POM-shifted UVs
    let grassBiomeNormalTS = sampleBiomeNormalArray(BIOME_GRASS, grassUV, grassUVDdx, grassUVDdy);
    let rockBiomeNormalTS = sampleBiomeNormalArray(BIOME_ROCK, rockUV, rockUVDdx, rockUVDdy);
    let forestBiomeNormalTS = sampleBiomeNormalArray(BIOME_FOREST, forestUV, forestUVDdx, forestUVDdy);
    
    // Sample AO with POM-shifted UVs
    let grassAo = sampleBiomeAoArray(BIOME_GRASS, grassUV, grassUVDdx, grassUVDdy);
    let rockAo = sampleBiomeAoArray(BIOME_ROCK, rockUV, rockUVDdx, rockUVDdy);
    let forestAo = sampleBiomeAoArray(BIOME_FOREST, forestUV, forestUVDdx, forestUVDdy);
    let nearBiomeAo = blendBiomeAo(grassAo, grassWeight, rockAo, rockWeight, forestAo, forestWeight);
    
    // Sample roughness with POM-shifted UVs
    let grassRoughness = sampleBiomeRoughnessArray(BIOME_GRASS, grassUV, grassUVDdx, grassUVDdy);
    let rockRoughness = sampleBiomeRoughnessArray(BIOME_ROCK, rockUV, rockUVDdx, rockUVDdy);
    let forestRoughness = sampleBiomeRoughnessArray(BIOME_FOREST, forestUV, forestUVDdx, forestUVDdy);
    let nearRoughness = grassRoughness * grassWeight
                      + rockRoughness * rockWeight
                      + forestRoughness * forestWeight;
    
    // Transform biome normals to world space via TBN
    let TBN = buildTerrainTBN(blendedNormal);
    let grassBiomeNormal = normalize(TBN * grassBiomeNormalTS);
    let rockBiomeNormal = normalize(TBN * rockBiomeNormalTS);
    let forestBiomeNormal = normalize(TBN * forestBiomeNormalTS);
    let biomeDetailNormal = blendBiomeNormals(
      grassBiomeNormal, grassWeight,
      rockBiomeNormal, rockWeight,
      forestBiomeNormal, forestWeight
    );
    
    // Blend base normal with biome detail normals
    let hasAnyBiomeNormal = getBiomeNormalEnabled(BIOME_GRASS) + getBiomeNormalEnabled(BIOME_ROCK) 
                          + getBiomeNormalEnabled(BIOME_FOREST);
    var nearNormal = blendedNormal;
    if (hasAnyBiomeNormal > 0.0) {
      nearNormal = normalize(blendedNormal * 0.5 + biomeDetailNormal * 0.5);
    }
    
    // Blend near/far based on nearFactor
    // Near tier normal, AO, roughness fade into far tier values
    normal = normalize(mix(blendedNormal, nearNormal, nearFactor));
    biomeAo = mix(1.0, nearBiomeAo, nearFactor);
    terrainRoughness = mix(DEFAULT_TERRAIN_ROUGHNESS, nearRoughness, nearFactor);
  }
  // FAR TIER: normal = blendedNormal (heightmap only), biomeAo = 1.0, terrainRoughness = 0.5
  
  // ===== Lighting =====
  let terrainMetallic = 0.0;
  let lightDir = normalize(material.lightDir);
  let V = normalize(uniforms.cameraPosition - input.worldPosition);
  let shadow = calculateShadow(input.lightSpacePos, input.worldPosition, normal, lightDir);
  
  // ===== Two-tier shading =====
  var directColor: vec3f;
  var ambientColor: vec3f;
  
  if (FULL_PBR_IBL || (isNearTier && nearFactor > 0.99)) {
    // Pure near tier: full PBR
    directColor = terrainPBRDirectional(normal, V, lightDir, albedo, terrainMetallic, terrainRoughness, material.lightColor.rgb) * shadow;
    let rawPBRIBL = calculateTerrainPBRIBL(normal, V, albedo, terrainMetallic, terrainRoughness);
    let pbrIBLAmbient = rawPBRIBL * material.ambientIntensity;
    let flatAmbient = albedo * material.ambientIntensity;
    let iblStrength = length(rawPBRIBL);
    let useIBL = step(0.001, iblStrength);
    ambientColor = mix(flatAmbient, pbrIBLAmbient, useIBL);
  } else if (!isNearTier) {
    // Pure far tier: Lambert only (no GGX, no Fresnel, no geometry term)
    directColor = terrainLambertDirectional(normal, lightDir, albedo, material.lightColor.rgb) * shadow;
    let diffuseIBL = calculateTerrainDiffuseOnlyIBL(normal, albedo);
    let diffuseIBLAmbient = diffuseIBL * material.ambientIntensity;
    let flatAmbient = albedo * material.ambientIntensity;
    let iblStrength = length(diffuseIBL);
    let useIBL = step(0.001, iblStrength);
    ambientColor = mix(flatAmbient, diffuseIBLAmbient, useIBL);
  } else {
    // Transition zone: blend near PBR and far Lambert
    let nearDirect = terrainPBRDirectional(normal, V, lightDir, albedo, terrainMetallic, terrainRoughness, material.lightColor.rgb) * shadow;
    let farDirect = terrainLambertDirectional(normal, lightDir, albedo, material.lightColor.rgb) * shadow;
    directColor = mix(farDirect, nearDirect, nearFactor);
    
    let nearIBL = calculateTerrainPBRIBL(normal, V, albedo, terrainMetallic, terrainRoughness);
    let farIBL = calculateTerrainDiffuseOnlyIBL(normal, albedo);
    let blendedIBL = mix(farIBL, nearIBL, nearFactor);
    let iblAmbient = blendedIBL * material.ambientIntensity;
    let flatAmbient = albedo * material.ambientIntensity;
    let iblStrength = length(blendedIBL);
    let useIBL = step(0.001, iblStrength);
    ambientColor = mix(flatAmbient, iblAmbient, useIBL);
  }
  
  // Apply biome AO to ambient
  let aoAmbientColor = ambientColor * biomeAo;
  
  // Multi-light contribution
  let multiLight = computeTerrainMultiLight(input.worldPosition, normal) * albedo;

  var finalColor = aoAmbientColor + (directColor * shadow) + multiLight;
  
  // ===== POM Self-Shadow (NEAR TIER ONLY) =====
  if (isNearTier && uniforms.displacementScale > 0.0) {
    let TBN_shadow = buildTerrainTBN(blendedNormal);
    let L_tangent = normalize(vec3f(
      dot(lightDir, TBN_shadow[0]),
      dot(lightDir, TBN_shadow[1]),
      dot(lightDir, TBN_shadow[2])
    ));
    let pomHeightScale = uniforms.displacementScale * nearFactor;
    var pomShadow = 1.0;
    // Weighted POM shadow across biomes (only for biomes with POM enabled)
    if (grassWeight > 0.01 && isBiomePomActive(BIOME_GRASS)) {
      let h = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, grassUV, BIOME_GRASS, 0.0).r;
      pomShadow = min(pomShadow, mix(1.0, pomSelfShadow(L_tangent, grassUV, BIOME_GRASS, pomHeightScale, h), grassWeight));
    }
    if (rockWeight > 0.01 && isBiomePomActive(BIOME_ROCK)) {
      let h = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, rockUV, BIOME_ROCK, 0.0).r;
      pomShadow = min(pomShadow, mix(1.0, pomSelfShadow(L_tangent, rockUV, BIOME_ROCK, pomHeightScale, h), rockWeight));
    }
    if (forestWeight > 0.01 && isBiomePomActive(BIOME_FOREST)) {
      let h = 1.0 - textureSampleLevel(biomeDisplacementArray, biomeSampler, forestUV, BIOME_FOREST, 0.0).r;
      pomShadow = min(pomShadow, mix(1.0, pomSelfShadow(L_tangent, forestUV, BIOME_FOREST, pomHeightScale, h), forestWeight));
    }
    finalColor *= mix(1.0, pomShadow, nearFactor * 0.7); // Soften POM shadow intensity
  }
  
  // ===== Vegetation Density Ground Darkening =====
  let vegDensity = textureSampleGrad(vegetationDensityMap, texSampler, input.texCoord, tcDdx, tcDdy).r;
  if (vegDensity > 0.001) {
    let sunElevation = max(dot(lightDir, vec3f(0.0, 1.0, 0.0)), 0.0);
    let darkeningAmount = mix(0.1, 0.7, sunElevation);
    let vegShadow_val = mix(1.0, darkeningAmount, vegDensity * vegDensity);
    finalColor *= vegShadow_val;
  }
  
  // ===== Bounds Overlay =====
  let boundsOverlayMask = computeBoundsOverlayMask(worldXZ);
  if (boundsOverlayMask > 0.001) {
    let overlayColor = vec3f(0.2, 0.8, 1.0);
    let overlayOpacity = boundsOverlayMask * 0.30;
    finalColor = mix(finalColor, overlayColor, overlayOpacity);
  }

  fragOutput.color = vec4f(finalColor, 1.0);
  fragOutput.normals = vec4f(normal * 0.5 + 0.5, 0.0);
  return fragOutput;
}
