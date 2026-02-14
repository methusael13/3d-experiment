// CDLOD Terrain Rendering Shader
// Continuous Distance-Dependent Level of Detail terrain shader with morphing
// Designed to work with CDLODRendererGPU

// Constants
const PI: f32 = 3.14159265359;

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
  _pad1: f32,                     // 47
  // Island mode parameters
  islandEnabled: f32,             // 48 - 0 = disabled, 1 = enabled
  seaFloorDepth: f32,             // 49 - ocean floor depth (negative, e.g., -0.3)
  _pad2: f32,                     // 50
  _pad3: f32,                     // 51
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
  isSelected: f32,                // 21
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

// ============================================================================
// Biome Texture Bindings (Group 1) - Texture Arrays
// ============================================================================

// Biome layer indices (used to index into texture arrays)
// 3 biomes sourced from biome mask: R=grass, G=rock, B=forest
const BIOME_GRASS: i32 = 0;
const BIOME_ROCK: i32 = 1;
const BIOME_FOREST: i32 = 2;

// Biome texture parameters uniform (matches BiomeTextureUniformData in types.ts)
// Simplified for 3 biomes (grass, rock, forest)
struct BiomeTextureParams {
  // Enable flags (1.0 = enabled, 0.0 = disabled) - vec4f aligned
  // [grass, rock, forest, unused]
  albedoEnabled: vec4f,
  normalEnabled: vec4f,
  aoEnabled: vec4f,
  
  // Tiling scales (world units per texture tile) - vec4f aligned
  // [grass, rock, forest, unused]
  tilingScales: vec4f,
}

// Biome texture arrays (3 layers: grass=0, rock=1, forest=2)
@group(1) @binding(0) var biomeAlbedoArray: texture_2d_array<f32>;
@group(1) @binding(1) var biomeNormalArray: texture_2d_array<f32>;
@group(1) @binding(2) var biomeAoArray: texture_2d_array<f32>;

// Sampler for biome textures
@group(1) @binding(3) var biomeSampler: sampler;

// Biome parameters uniform
@group(1) @binding(4) var<uniform> biomeParams: BiomeTextureParams;

// ============================================================================
// Environment Bindings (Group 3) - IBL + CSM for ambient lighting and shadows
// ============================================================================

// Terrain only uses diffuse IBL from SceneEnvironment (non-metallic surface)
// Specular IBL (env_iblSpecular, env_brdfLut) not needed for diffuse terrain
// NOTE: Other bindings (0,1,3,4,6) exist in SceneEnvironment but are unused here
@group(3) @binding(2) var env_iblDiffuse: texture_cube<f32>;
@group(3) @binding(5) var env_cubeSampler: sampler;

// CSM (Cascaded Shadow Maps) bindings from SceneEnvironment
@group(3) @binding(7) var csmShadowArray: texture_depth_2d_array;
@group(3) @binding(8) var<uniform> csmUniforms: CSMUniforms;

// ============================================================================
// CSM Uniform Structure (matches ShadowRendererGPU)
// ============================================================================

struct CSMUniforms {
  viewProjectionMatrices: array<mat4x4f, 4>,  // Light-space VP matrices for each cascade
  cascadeSplits: vec4f,                        // View-space depth splits
  cascadeCount: f32,                           // Number of active cascades (2-4)
  blendFraction: f32,                          // Fraction of cascade to blend (0.05-0.2)
  shadowBias: f32,                             // Base shadow bias
  _pad: f32,
}

// ============================================================================
// IBL Functions
// ============================================================================

// Sample diffuse irradiance from IBL cubemap for ambient lighting
// Returns pre-convolved irradiance for Lambert diffuse
fn sampleIBLDiffuse(worldNormal: vec3f) -> vec3f {
  return textureSample(env_iblDiffuse, env_cubeSampler, worldNormal).rgb;
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

// Helper: Get tiling scale for a biome layer (0-2: grass, rock, forest)
fn getBiomeTiling(layer: i32) -> f32 {
  return biomeParams.tilingScales[layer];
}

// Sample biome albedo from texture array with fallback to solid color
// layer: biome layer index (0-2: grass, rock, forest)
// worldXZ: world position for UV calculation
// fallbackColor: solid color to use when texture not enabled
fn sampleBiomeAlbedoArray(
  layer: i32,
  worldXZ: vec2f,
  fallbackColor: vec3f
) -> vec3f {
  let tiling = getBiomeTiling(layer);
  let worldUV = worldXZ / tiling;
  let enabled = getBiomeAlbedoEnabled(layer);
  
  // Sample texture array (always sample to maintain uniform control flow)
  let texColor = textureSample(biomeAlbedoArray, biomeSampler, worldUV, layer).rgb;
  // Select between texture and fallback based on enabled flag
  return select(fallbackColor, texColor, enabled > 0.5);
}

// Sample biome normal from texture array and unpack from [0,1] to [-1,1]
// Returns Y-up tangent space normal, or (0,1,0) if not enabled
// layer: biome layer index (0-2: grass, rock, forest)
// worldXZ: world position for UV calculation
fn sampleBiomeNormalArray(
  layer: i32,
  worldXZ: vec2f
) -> vec3f {
  let tiling = getBiomeTiling(layer);
  let worldUV = worldXZ / tiling;
  let enabled = getBiomeNormalEnabled(layer);
  
  // Sample normal map array (always sample for uniform control flow)
  let texNormal = textureSample(biomeNormalArray, biomeSampler, worldUV, layer).rgb;
  // Unpack from [0,1] to [-1,1] (standard normal map encoding)
  let unpacked = texNormal * 2.0 - 1.0;
  // Ensure Y-up convention (some normal maps have Y inverted)
  let normalTangent = vec3f(unpacked.x, unpacked.y, unpacked.z);
  // Return flat normal if not enabled
  return select(vec3f(0.0, 1.0, 0.0), normalize(normalTangent), enabled > 0.5);
}

// Sample biome AO (ambient occlusion) from texture array
// Returns AO value (0 = fully occluded, 1 = no occlusion), or 1.0 if not enabled
// layer: biome layer index (0-2: grass, rock, forest)
// worldXZ: world position for UV calculation
fn sampleBiomeAoArray(
  layer: i32,
  worldXZ: vec2f
) -> f32 {
  let tiling = getBiomeTiling(layer);
  let worldUV = worldXZ / tiling;
  let enabled = getBiomeAoEnabled(layer);
  
  // Sample AO map array (always sample for uniform control flow)
  // AO is stored in the R channel (grayscale texture)
  let texAo = textureSample(biomeAoArray, biomeSampler, worldUV, layer).r;
  // Return 1.0 (no occlusion) if not enabled
  return select(1.0, texAo, enabled > 0.5);
}

// Blend 3 biome normals weighted by biome weights (grass, rock, forest)
// Uses simple weighted average for terrain blending
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

// Blend 3 biome AO values weighted by biome weights (grass, rock, forest)
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

// Sample biome mask at UV coordinates
// Returns vec3(grassWeight, rockWeight, forestWeight) from the biome mask texture
// Biome mask: R=grass, G=rock, B=forest (generated by BiomeMaskGenerator)
fn sampleBiomeMaskWeights(uv: vec2f) -> vec3f {
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  let biome = textureSample(biomeMask, texSampler, clampedUV);
  return vec3f(biome.r, biome.g, biome.b);
}

// Simplified IBL for terrain - diffuse only (terrain is non-metallic)
// Uses diffuse cubemap to replace flat ambient color
fn calculateTerrainIBL(worldNormal: vec3f, albedo: vec3f) -> vec3f {
  // Sample diffuse irradiance (already convolved for hemisphere)
  let irradiance = sampleIBLDiffuse(worldNormal);
  // Apply moderate intensity for natural outdoor lighting
  return irradiance / PI * albedo;
}

// ============================================================================
// Vertex Structures
// ============================================================================

struct VertexInput {
  // Per-vertex attributes
  @location(0) gridPosition: vec2f,  // Grid position (-0.5 to 0.5)
  @location(1) uv: vec2f,            // UV coordinates (0 to 1)
  @location(6) isSkirt: f32,         // 1.0 for skirt vertices, 0.0 otherwise
  
  // Per-instance attributes
  @location(2) nodeOffset: vec2f,    // Node center XZ in world space
  @location(3) nodeScale: f32,       // World units per grid vertex
  @location(4) nodeMorph: f32,       // Morph factor (0-1)
  @location(5) nodeLOD: f32,         // LOD level
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
  @location(7) lightSpacePos: vec4f,  // Position in light/shadow space
}

// ============================================================================
// Noise Functions for Procedural Detail (with Analytical Derivatives)
// ============================================================================

// Hash function for noise generation (deterministic pseudo-random)
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D gradient noise (value noise with smooth interpolation)
fn gradientNoise2D(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  
  // Quintic Hermite interpolation for C2 continuity (smoother than smoothstep)
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  
  // Sample corners
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  
  // Bilinear interpolation with smooth u
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0; // Range [-1, 1]
}

// 2D gradient noise WITH derivatives - returns vec3(value, dvalue/dx, dvalue/dy)
fn gradientNoise2DWithDerivatives(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  
  // Quintic Hermite interpolation: u = 6t^5 - 15t^4 + 10t^3
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  // Derivative of quintic: du/dt = 30t^4 - 60t^3 + 30t^2 = 30t^2(t-1)^2
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  
  // Sample corners (mapped from [0,1] to [-1,1])
  let a = hash2(i) * 2.0 - 1.0;
  let b = hash2(i + vec2f(1.0, 0.0)) * 2.0 - 1.0;
  let c = hash2(i + vec2f(0.0, 1.0)) * 2.0 - 1.0;
  let d = hash2(i + vec2f(1.0, 1.0)) * 2.0 - 1.0;
  
  // Bilinear interpolation coefficients
  // value = a + (b-a)*ux + (c-a)*uy + (a-b-c+d)*ux*uy
  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;
  
  // Value
  let value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  
  // Derivatives using chain rule
  // dv/dx = k1 * du.x + k3 * du.x * u.y
  // dv/dy = k2 * du.y + k3 * u.x * du.y
  let dvdx = du.x * (k1 + k3 * u.y);
  let dvdy = du.y * (k2 + k3 * u.x);
  
  return vec3f(value, dvdx, dvdy);
}

// Fractional Brownian Motion (FBM) - multi-octave noise (value only, for vertex shader)
fn fbm(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  
  for (var i = 0; i < octaves; i++) {
    value += amplitude * gradientNoise2D(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= 0.5;  // Persistence
    frequency *= 2.0;  // Lacunarity
    // Rotate slightly each octave to reduce axis-aligned artifacts
    pos = vec2f(pos.x * 0.866 - pos.y * 0.5, pos.x * 0.5 + pos.y * 0.866);
  }
  
  return value / totalAmplitude;  // Normalize to [-1, 1]
}

// FBM with analytical derivatives - returns vec3(value, dv/dx, dv/dy)
// Used in fragment shader to compute detail normals
fn fbmWithDerivatives(p: vec2f, octaves: i32) -> vec3f {
  var value = 0.0;
  var deriv = vec2f(0.0);
  var amplitude = 0.5;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;
  
  // Rotation matrix for octave variation (30 degrees)
  let cos30 = 0.866;
  let sin30 = 0.5;
  
  // Track cumulative rotation for derivative transformation
  var rotCos = 1.0;
  var rotSin = 0.0;
  
  for (var i = 0; i < octaves; i++) {
    let scaledPos = pos * frequency;
    let noiseResult = gradientNoise2DWithDerivatives(scaledPos);
    
    value += amplitude * noiseResult.x;
    
    // Transform derivatives back through rotation and frequency scaling
    // The derivative in rotated space needs to be rotated back
    let localDeriv = vec2f(noiseResult.y, noiseResult.z) * frequency;
    // Rotate derivative back to original coordinate system
    let rotatedDeriv = vec2f(
      localDeriv.x * rotCos + localDeriv.y * rotSin,
      -localDeriv.x * rotSin + localDeriv.y * rotCos
    );
    deriv += amplitude * rotatedDeriv;
    
    totalAmplitude += amplitude;
    amplitude *= 0.5;  // Persistence
    frequency *= 2.0;  // Lacunarity
    
    // Rotate position for next octave
    pos = vec2f(pos.x * cos30 - pos.y * sin30, pos.x * sin30 + pos.y * cos30);
    
    // Update cumulative rotation
    let newRotCos = rotCos * cos30 - rotSin * sin30;
    let newRotSin = rotCos * sin30 + rotSin * cos30;
    rotCos = newRotCos;
    rotSin = newRotSin;
  }
  
  // Normalize
  return vec3f(value, deriv.x, deriv.y) / totalAmplitude;
}

// Calculate procedural detail height displacement (for vertex shader)
// Uses slope-dependent noise: rolling clumps on flat, vertical striations on steep
fn getProceduralDetail(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> f32 {
  // Early out if detail is disabled
  if (uniforms.detailAmplitude <= 0.0) {
    return 0.0;
  }
  
  // Calculate distance-based fade
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  
  // Early out if fully faded
  if (fadeFactor <= 0.0) {
    return 0.0;
  }
  
  // ===== Slope-Based Noise Selection =====
  // Flat areas: low-frequency rolling noise (grass/dirt clumps)
  // Steep areas: high-frequency noise (rocky details)
  
  // Blend factor: 0 = flat (use rolling), 1 = steep (use rocky)
  let slopeBlendLow = 0.25;  // Below this = fully flat noise
  let slopeBlendHigh = 0.55; // Above this = fully steep noise
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  // Apply detailSlopeInfluence to control how much slope affects noise type
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  
  // Flat noise: lower frequency, fewer octaves, smoother "rolling" character
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatCoord = worldXZ * flatFreq;
  let flatNoise = fbm(flatCoord, 2);  // Only 2 octaves for smooth rolling
  
  // Steep noise: higher frequency, more octaves, sharper details
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepCoord = worldXZ * steepFreq;
  let steepNoise = fbm(steepCoord, max(i32(uniforms.detailOctaves), 4));  // At least 4 octaves for rocky detail
  
  // Blend between flat and steep noise based on slope
  let noiseValue = mix(flatNoise, steepNoise, blendFactor);
  
  // Amplitude modulation: steep areas get slightly more amplitude
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  
  // Apply amplitude, fade, and modulation
  return noiseValue * uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
}

// Calculate procedural detail normal perturbation (for fragment shader)
// Returns the detail normal in tangent space (Y-up)
// Uses same slope-based noise blending as getProceduralDetail() for consistency
fn getProceduralDetailNormal(worldXZ: vec2f, distanceToCamera: f32, slope: f32) -> vec3f {
  // Default to flat normal if detail is disabled
  if (uniforms.detailAmplitude <= 0.0) {
    return vec3f(0.0, 1.0, 0.0);
  }
  
  // Calculate distance-based fade
  let fadeRange = uniforms.detailFadeEnd - uniforms.detailFadeStart;
  let fadeFactor = 1.0 - clamp((distanceToCamera - uniforms.detailFadeStart) / max(fadeRange, 0.001), 0.0, 1.0);
  
  // Return flat normal if fully faded
  if (fadeFactor <= 0.0) {
    return vec3f(0.0, 1.0, 0.0);
  }
  
  // ===== Slope-Based Noise Selection (matches getProceduralDetail) =====
  let slopeBlendLow = 0.25;
  let slopeBlendHigh = 0.55;
  let slopeBlend = smoothstep(slopeBlendLow, slopeBlendHigh, slope);
  let blendFactor = slopeBlend * uniforms.detailSlopeInfluence;
  
  // Flat noise: lower frequency, fewer octaves
  let flatFreq = uniforms.detailFrequency * 0.4;
  let flatCoord = worldXZ * flatFreq;
  let flatResult = fbmWithDerivatives(flatCoord, 2);
  
  // Steep noise: higher frequency, more octaves
  let steepFreq = uniforms.detailFrequency * 1.8;
  let steepCoord = worldXZ * steepFreq;
  let steepResult = fbmWithDerivatives(steepCoord, max(i32(uniforms.detailOctaves), 4));
  
  // Blend derivatives based on slope
  // Note: derivatives need to be scaled by their respective frequencies
  let flatDeriv = vec2f(flatResult.y, flatResult.z) * flatFreq;
  let steepDeriv = vec2f(steepResult.y, steepResult.z) * steepFreq;
  let blendedDeriv = mix(flatDeriv, steepDeriv, blendFactor);
  
  // Amplitude modulation (matches getProceduralDetail)
  let amplitudeModulation = mix(0.8, 1.2, blendFactor);
  
  // Scale derivatives by amplitude and fade
  let scale = uniforms.detailAmplitude * fadeFactor * amplitudeModulation;
  let dhdx = blendedDeriv.x * scale;
  let dhdz = blendedDeriv.y * scale;
  
  // Compute normal from height gradient: n = normalize(-dh/dx, 1, -dh/dz)
  return normalize(vec3f(-dhdx, 1.0, -dhdz));
}

// ============================================================================
// Helper Functions
// ============================================================================

// Convert world XZ position to heightmap UV coordinates
fn worldToUV(worldXZ: vec2f) -> vec2f {
  // Terrain is centered at origin, so offset by half terrain size
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  return (worldXZ - terrainOrigin) / uniforms.terrainSize;
}

// Sample island mask at UV coordinates using textureLoad (r32float is unfilterable)
// Returns 0-1, where 1 = land, 0 = ocean
fn sampleIslandMask(uv: vec2f) -> f32 {
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  // Get texture dimensions
  let dims = textureDimensions(islandMask);
  
  // Convert UV to texel coordinates (floating point)
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  
  // Get integer texel coordinates for the 4 corners
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = clamp(texel00 + vec2i(1, 0), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  let texel01 = clamp(texel00 + vec2i(0, 1), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  let texel11 = clamp(texel00 + vec2i(1, 1), vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  
  // Sample the 4 corners
  let m00 = textureLoad(islandMask, texel00, 0).r;
  let m10 = textureLoad(islandMask, texel10, 0).r;
  let m01 = textureLoad(islandMask, texel01, 0).r;
  let m11 = textureLoad(islandMask, texel11, 0).r;
  
  // Bilinear interpolation
  let frac = fract(texelF);
  let m0 = mix(m00, m10, frac.x);
  let m1 = mix(m01, m11, frac.x);
  return mix(m0, m1, frac.y);
}

// Sample height from heightmap texture using textureLoad (r32float is unfilterable)
fn sampleHeightAt(texCoord: vec2i, mipLevel: i32) -> f32 {
  // Clamp to texture dimensions
  let dims = textureDimensions(heightmap, mipLevel);
  let clampedCoord = clamp(texCoord, vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  return textureLoad(heightmap, clampedCoord, mipLevel).r;
}

// Sample height with manual bilinear interpolation (since r32float is unfilterable)
fn sampleHeightSmooth(worldXZ: vec2f, lodLevel: f32) -> f32 {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  // Get mip level as integer (floor for the current mip)
  let mipLevel = i32(lodLevel);
  let dims = textureDimensions(heightmap, mipLevel);
  
  // Convert UV to texel coordinates (floating point)
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  
  // Get integer texel coordinates for the 4 corners
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = texel00 + vec2i(1, 0);
  let texel01 = texel00 + vec2i(0, 1);
  let texel11 = texel00 + vec2i(1, 1);
  
  // Sample the 4 corners
  let h00 = sampleHeightAt(texel00, mipLevel);
  let h10 = sampleHeightAt(texel10, mipLevel);
  let h01 = sampleHeightAt(texel01, mipLevel);
  let h11 = sampleHeightAt(texel11, mipLevel);
  
  // Bilinear interpolation weights
  let frac = fract(texelF);
  
  // Interpolate along X, then along Y
  let h0 = mix(h00, h10, frac.x);
  let h1 = mix(h01, h11, frac.x);
  return mix(h0, h1, frac.y);
}

// Sample normal from normal map texture at specified LOD level
fn sampleNormalWorld(worldXZ: vec2f, lodLevel: f32) -> vec3f {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  // Normal map is stored as rgba8snorm which is already in [-1,1] range
  // No conversion needed
  let normalSample = textureSampleLevel(normalmap, texSampler, clampedUV, lodLevel).rgb;
  // Ensure Y is up-facing (some normal maps store Y inverted)
  return normalize(vec3f(normalSample.x, normalSample.y, normalSample.z));
}

// Calculate terrain normal from height samples (fallback if normal map not available)
fn calculateNormalFromHeight(worldXZ: vec2f, sampleDist: f32, mipLevel: f32) -> vec3f {
  // Use sampleHeightSmooth for height lookups
  let hL = sampleHeightSmooth(worldXZ + vec2f(-sampleDist, 0.0), mipLevel);
  let hR = sampleHeightSmooth(worldXZ + vec2f(sampleDist, 0.0), mipLevel);
  let hD = sampleHeightSmooth(worldXZ + vec2f(0.0, -sampleDist), mipLevel);
  let hU = sampleHeightSmooth(worldXZ + vec2f(0.0, sampleDist), mipLevel);
  
  let dx = (hR - hL) / (2.0 * sampleDist);
  let dz = (hU - hD) / (2.0 * sampleDist);
  
  return normalize(vec3f(-dx, 1.0, -dz));
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Calculate world XZ position from grid position and instance data
  var worldXZ = input.gridPosition * input.nodeScale * (uniforms.gridSize - 1.0) + input.nodeOffset;
  
  // ===== CDLOD Morphing =====
  // Vertices at "odd" positions in the parent grid need to morph
  // to the midpoint between their "even" neighbors when transitioning.
  
  let parentScale = input.nodeScale * 2.0;
  
  // Determine if this vertex is at an odd position in parent grid
  let parentGridPos = worldXZ / parentScale;
  let fracPart = fract(parentGridPos + 0.5);
  
  // Odd positions are those at 0.5 in fractional space
  let oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0);
  let oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0);
  
  // Apply morph factor to odd vertices
  let morphX = oddX * input.nodeMorph;
  let morphZ = oddZ * input.nodeMorph;
  
  // Snap to parent grid positions for morphing
  let snappedXZ = floor(worldXZ / parentScale + 0.5) * parentScale;
  
  // Morph world position
  let morphedXZ = vec2f(
    mix(worldXZ.x, snappedXZ.x, morphX),
    mix(worldXZ.y, snappedXZ.y, morphZ)
  );
  
  // Sample height from heightmap texture at the appropriate LOD mipmap level
  // Heightmap stores NORMALIZED values in range [-0.5, 0.5]
  var normalizedHeight = sampleHeightSmooth(morphedXZ, input.nodeLOD);
  
  // Apply island mask if enabled - blend terrain height with sea floor
  if (uniforms.islandEnabled > 0.5) {
    let uv = worldToUV(morphedXZ);
    let mask = sampleIslandMask(uv);
    // mask: 1 = land (use terrain height), 0 = ocean (use sea floor depth)
    normalizedHeight = mix(uniforms.seaFloorDepth, normalizedHeight, mask);
  }
  
  // Apply heightScale to convert normalized height to world units
  // [-0.5, 0.5] * heightScale → [-heightScale/2, +heightScale/2]
  var height = normalizedHeight * uniforms.heightScale;
  
  // Sample normal from normal map texture at the appropriate LOD mipmap level
  let normal = sampleNormalWorld(morphedXZ, input.nodeLOD);
  
  // Calculate slope from normal (0 = flat, 1 = vertical)
  let slope = 1.0 - normal.y;
  
  // Calculate distance from camera to this vertex (for detail fading)
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(morphedXZ - cameraXZ);
  
  // Add procedural detail for close-up viewing (fills in missing heightmap resolution)
  let proceduralDetail = getProceduralDetail(morphedXZ, distanceToCamera, slope);
  height = height + proceduralDetail;
  
  // Final world position
  var finalHeight: f32;
  
  // Debug mode: flat plane (no height displacement) to visualize heightmap
  if (uniforms.debugMode > 0.5) {
    finalHeight = 0.0;
  } else {
    finalHeight = height;  // Already scaled to world units (with procedural detail)
    
    // For skirt vertices, offset Y downward to create vertical strips
    // that hide gaps between LOD patches
    if (input.isSkirt > 0.5) {
      // Skirt depth scales with the node scale for consistent coverage
      let skirtOffset = input.nodeScale * (uniforms.gridSize - 1.0) * 0.15;
      finalHeight = height - skirtOffset;
    }
  }
  
  let worldPos = vec3f(morphedXZ.x, finalHeight, morphedXZ.y);
  
  // Transform to clip space
  let mvp = uniforms.viewProjectionMatrix * uniforms.modelMatrix;
  output.clipPosition = mvp * vec4f(worldPos, 1.0);
  
  // Transform world position
  let worldPos4 = uniforms.modelMatrix * vec4f(worldPos, 1.0);
  output.worldPosition = worldPos4.xyz;
  
  // Transform to light space for shadow mapping
  output.lightSpacePos = material.lightSpaceMatrix * worldPos4;
  
  // Calculate texture coordinate
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  output.texCoord = (morphedXZ - terrainOrigin) / uniforms.terrainSize;
  output.localUV = input.uv;
  
  // Normal in world space
  output.normal = normalize((uniforms.modelMatrix * vec4f(normal, 0.0)).xyz);
  
  // Calculate slope
  output.slope = 1.0 - normal.y;
  
  // Pass through LOD data
  output.lodLevel = input.nodeLOD;
  output.morphFactor = input.nodeMorph;
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

// ============================================================================
// Shadow Sampling Functions
// ============================================================================

// Sample shadow map with comparison (hard shadows)
// Note: WGSL requires uniform control flow - we must always sample.
// Bounds checking is done via clamp and blend instead of early return.
fn sampleShadowHard(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  // WebGPU: NDC has Y pointing up, but texture UV has Y pointing down (origin top-left)
  // So we need to flip Y: shadowUV.y = 1 - (ndc.y * 0.5 + 0.5) = 0.5 - ndc.y * 0.5
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Clamp UV to valid range (must always sample at valid coords)
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  
  // Apply slope-dependent receiver-side bias to prevent self-shadowing artifacts
  // This accounts for:
  // 1. Procedural detail in main terrain that shadow map doesn't have
  // 2. LOD differences between shadow map (LOD 0) and visible terrain
  // 3. Floating point precision at steep angles (high sun elevation)
  // 4. Larger texel coverage on slopes (main source of artifacts)
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL; // tan(acos(NdotL))
  let baseBias = 0.0003;
  let slopeBias = 0.002;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  
  // Always sample shadow map (uniform control flow)
  let shadowValue = textureSampleCompare(shadowMap, shadowSampler, clampedUV, clampedDepth);
  
  // Check if outside shadow map bounds AFTER sampling
  // If outside bounds, return 1.0 (no shadow)
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  
  // Return shadow value if in bounds, 1.0 (no shadow) if out of bounds
  return mix(1.0, shadowValue, inBounds);
}

// Sample shadow map with PCF (soft shadows)
// Note: WGSL requires uniform control flow - we must always sample.
// Bounds checking is done via clamp and blend instead of early return.
fn sampleShadowPCF(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f, kernelSize: i32) -> f32 {
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  // WebGPU: NDC has Y pointing up, but texture UV has Y pointing down (origin top-left)
  // So we need to flip Y: shadowUV.y = 1 - (ndc.y * 0.5 + 0.5) = 0.5 - ndc.y * 0.5
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Apply slope-dependent receiver-side bias to prevent self-shadowing artifacts
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL; // tan(acos(NdotL))
  let baseBias = 0.0003;
  let slopeBias = 0.002;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let biasedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  
  let shadowMapSize = textureDimensions(shadowMap);
  let texelSize = vec2f(1.0 / f32(shadowMapSize.x), 1.0 / f32(shadowMapSize.y));
  
  // PCF kernel sampling - always sample (uniform control flow)
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
  
  // Check if outside shadow map bounds AFTER sampling
  // If outside bounds, return 1.0 (no shadow)
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  
  // Return shadow value if in bounds, 1.0 (no shadow) if out of bounds
  return mix(1.0, shadowValue, inBounds);
}

// ============================================================================
// CSM Shadow Sampling Functions
// ============================================================================

// Select the appropriate cascade based on view-space depth
fn selectCascade(viewDepth: f32) -> i32 {
  let cascadeCount = i32(csmUniforms.cascadeCount);
  // Compare against cascade split distances
  if (viewDepth < csmUniforms.cascadeSplits.x) { return 0; }
  if (viewDepth < csmUniforms.cascadeSplits.y && cascadeCount > 1) { return 1; }
  if (viewDepth < csmUniforms.cascadeSplits.z && cascadeCount > 2) { return 2; }
  if (cascadeCount > 3) { return 3; }
  return cascadeCount - 1;
}

// Sample a single cascade shadow map with PCF
fn sampleCascadeShadow(worldPos: vec4f, cascade: i32, normal: vec3f, lightDir: vec3f) -> f32 {
  // Transform to light space for this cascade
  let lightSpacePos = csmUniforms.viewProjectionMatrices[cascade] * worldPos;
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Clamp UV to valid range
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  
  // Calculate bias (higher cascades need more bias due to lower resolution coverage)
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let cascadeBias = csmUniforms.shadowBias * (1.0 + f32(cascade) * 0.5);
  let shadowBias = cascadeBias + clamp(slopeFactor, 0.0, 5.0) * cascadeBias * 2.0;
  let biasedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  
  // Get cascade texture dimensions
  let cascadeSize = textureDimensions(csmShadowArray);
  let texelSize = vec2f(1.0 / f32(cascadeSize.x), 1.0 / f32(cascadeSize.y));
  
  // 3x3 PCF sampling for soft shadows
  // Use textureSampleCompareLevel to avoid uniform control flow requirement
  // (textureSampleCompare requires uniform control flow, but cascade index is per-pixel)
  var shadow = 0.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      let offset = vec2f(f32(x), f32(y)) * texelSize;
      let sampleUV = clamp(clampedUV + offset, vec2f(0.001), vec2f(0.999));
      shadow += textureSampleCompareLevel(csmShadowArray, shadowSampler, sampleUV, cascade, biasedDepth);
    }
  }
  shadow /= 9.0;
  
  // Check bounds
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  
  return mix(1.0, shadow, inBounds);
}

// Sample CSM with cascade blending for smooth transitions
fn sampleCSMShadow(worldPos: vec4f, viewDepth: f32, normal: vec3f, lightDir: vec3f) -> f32 {
  let cascade = selectCascade(viewDepth);
  let cascadeCount = i32(csmUniforms.cascadeCount);
  
  // Get cascade split for current cascade
  var cascadeSplit = csmUniforms.cascadeSplits.x;
  if (cascade == 1) { cascadeSplit = csmUniforms.cascadeSplits.y; }
  else if (cascade == 2) { cascadeSplit = csmUniforms.cascadeSplits.z; }
  else if (cascade == 3) { cascadeSplit = csmUniforms.cascadeSplits.w; }
  
  // Sample current cascade
  let shadow0 = sampleCascadeShadow(worldPos, cascade, normal, lightDir);
  
  // Check if we're in blend region with next cascade
  let blendRegion = cascadeSplit * csmUniforms.blendFraction;
  let blendStart = cascadeSplit - blendRegion;
  
  if (viewDepth > blendStart && cascade < cascadeCount - 1) {
    // Blend with next cascade
    let shadow1 = sampleCascadeShadow(worldPos, cascade + 1, normal, lightDir);
    let blendFactor = smoothstep(blendStart, cascadeSplit, viewDepth);
    return mix(shadow0, shadow1, blendFactor);
  }
  
  return shadow0;
}

// Calculate shadow factor with distance-based fade
// Supports both single shadow map and CSM modes
fn calculateShadow(lightSpacePos: vec4f, worldPos: vec3f, normal: vec3f, lightDir: vec3f) -> f32 {
  // Calculate distance from camera for fade
  let cameraXZ = uniforms.cameraPosition.xz;
  let fragXZ = worldPos.xz;
  let distanceFromCamera = length(fragXZ - cameraXZ);
  
  // Fade shadow at the edge of shadow radius
  let fadeStart = material.shadowRadius * 0.8;
  let fadeEnd = material.shadowRadius;
  let fadeFactor = 1.0 - smoothstep(fadeStart, fadeEnd, distanceFromCamera);
  
  var shadowValue = 1.0;
  
  // Choose shadow method based on CSM enabled flag
  if (material.csmEnabled > 0.5) {
    // Use CSM (Cascaded Shadow Maps)
    // Calculate view-space depth for cascade selection
    let viewDepth = distanceFromCamera;  // Approximate view depth with camera distance
    shadowValue = sampleCSMShadow(vec4f(worldPos, 1.0), viewDepth, normal, lightDir);
  } else {
    // Use single shadow map
    // Always sample both methods for uniform control flow
    let hardShadow = sampleShadowHard(lightSpacePos, normal, lightDir);
    let softShadow = sampleShadowPCF(lightSpacePos, normal, lightDir, 3);
    shadowValue = mix(hardShadow, softShadow, material.shadowSoftness);
  }
  
  // Apply fade and enable flag
  let enabledFactor = step(0.5, material.shadowEnabled);
  let finalFadeFactor = fadeFactor * enabledFactor;
  
  return mix(1.0, shadowValue, finalFadeFactor);
}

// ============================================================================
// Fragment Shader
// ============================================================================

// Build a TBN (Tangent-Bitangent-Normal) matrix for transforming tangent-space
// normals to world space. For terrain, we construct tangent along the world X-axis
// and derive bitangent from the cross product.
// worldNormal: the terrain normal in world space (Y-up)
// Returns: mat3x3f where column 0 = tangent, column 1 = bitangent, column 2 = normal
fn buildTerrainTBN(worldNormal: vec3f) -> mat3x3f {
  // For terrain, tangent generally follows world X-axis
  // We use cross product to compute a tangent perpendicular to the normal
  let worldUp = vec3f(0.0, 1.0, 0.0);
  
  // Compute tangent: perpendicular to normal, in the XZ plane
  // If normal is nearly vertical, tangent defaults to world X-axis
  var tangent = cross(worldUp, worldNormal);
  let tangentLen = length(tangent);
  if (tangentLen < 0.001) {
    // Normal is nearly straight up/down, use X-axis as tangent
    tangent = vec3f(1.0, 0.0, 0.0);
  } else {
    tangent = tangent / tangentLen; // normalize
  }
  
  // Compute bitangent: perpendicular to both normal and tangent
  let bitangent = normalize(cross(worldNormal, tangent));
  
  // TBN matrix: transforms from tangent space to world space
  // Column-major: TBN * tangentSpaceNormal = worldSpaceNormal
  return mat3x3f(tangent, bitangent, worldNormal);
}

// Blend two normals using Reoriented Normal Mapping (RNM)
// This properly combines the base normal with a detail normal
// baseN: the base/macro normal from heightmap
// detailN: the detail/micro normal from procedural noise
fn blendNormalsRNM(baseN: vec3f, detailN: vec3f) -> vec3f {
  // Reoriented Normal Mapping technique
  // Ref: https://blog.selfshadow.com/publications/blending-in-detail/
  let t = baseN + vec3f(0.0, 0.0, 1.0);
  let u = detailN * vec3f(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}

// Alternative: UDN (Unreal Developer Network) blending - simpler but less accurate
fn blendNormalsUDN(baseN: vec3f, detailN: vec3f) -> vec3f {
  return normalize(vec3f(baseN.xy + detailN.xy, baseN.z));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Get base normal from vertex shader (from normal map)
  let baseNormal = normalize(input.normal);
  
  // Debug mode: show heightmap as grayscale on flat plane
  if (uniforms.debugMode > 0.5) {
    // Reconstruct world XZ from texCoord (texCoord goes 0-1 over terrain)
    let worldXZ = input.texCoord * uniforms.terrainSize - vec2f(uniforms.terrainSize * 0.5);
    
    // Sample heightmap at this fragment's location
    // Heightmap stores NORMALIZED values in range [-0.5, 0.5]
    let height = sampleHeightSmooth(worldXZ, input.lodLevel);
    
    // Convert normalized height [-0.5, 0.5] to display range [0, 1]
    let normalizedHeight = clamp(height + 0.5, 0.0, 1.0);
    
    // Add tile boundary visualization (red lines)
    let edgeThreshold = 0.02;
    var patchEdge = 0.0;
    if (input.localUV.x < edgeThreshold || input.localUV.x > 1.0 - edgeThreshold ||
        input.localUV.y < edgeThreshold || input.localUV.y > 1.0 - edgeThreshold) {
      patchEdge = 1.0;
    }
    
    // Show heightmap as pure grayscale
    var debugColor = vec3f(normalizedHeight);
    
    // Mix with red tile boundary
    debugColor = mix(debugColor, vec3f(1.0, 0.0, 0.0), patchEdge * 0.5);
    
    return vec4f(debugColor, 1.0);
  }
  
  // ===== Compute Detail Normal from Procedural Noise =====
  // Get world XZ position for noise sampling
  let worldXZ = input.worldPosition.xz;
  
  // Calculate distance from camera for detail fade
  let cameraXZ = uniforms.cameraPosition.xz;
  let distanceToCamera = length(worldXZ - cameraXZ);
  
  // Get the detail normal from procedural FBM (in world space, Y-up)
  let detailNormal = getProceduralDetailNormal(worldXZ, distanceToCamera, input.slope);
  
  // Blend base normal with detail normal
  // The detail normal is already in world space (Y-up tangent space for terrain)
  // We use the simpler UDN blend since our base normal may have arbitrary orientation
  // For terrain with mostly vertical-ish normals, this works well
  let blendedNormal = blendNormalsUDN(baseNormal, detailNormal);
  
  // Normal terrain rendering
  // Heights are in range [-heightScale/2, +heightScale/2] (centered at Y=0)
  // Divide by heightScale to get [-0.5, +0.5], then add 0.5 to normalize to [0, 1]
  let normalizedHeight = (input.worldPosition.y / max(uniforms.heightScale, 1.0)) + 0.5;
  let slope = input.slope;
  
  // ===== Sample Biome Weights from Biome Mask Texture =====
  // Biome mask is generated by BiomeMaskGenerator based on height, slope, flow
  // R = grass probability, G = rock probability, B = forest probability
  let biomeWeights = sampleBiomeMaskWeights(input.texCoord);
  var grassWeight = biomeWeights.x;
  var rockWeight = biomeWeights.y;
  var forestWeight = biomeWeights.z;
  
  // Normalize weights to ensure they sum to 1
  let totalWeight = grassWeight + rockWeight + forestWeight;
  if (totalWeight > 0.001) {
    grassWeight /= totalWeight;
    rockWeight /= totalWeight;
    forestWeight /= totalWeight;
  } else {
    // Fallback if biome mask is all black
    grassWeight = 1.0;
    rockWeight = 0.0;
    forestWeight = 0.0;
  }
  
  // ===== Sample Biome Textures (Albedo) from Texture Arrays =====
  // Sample albedo textures with fallback to material colors (3 biomes)
  let grassAlbedoColor = sampleBiomeAlbedoArray(BIOME_GRASS, worldXZ, material.grassColor.rgb);
  let rockAlbedoColor = sampleBiomeAlbedoArray(BIOME_ROCK, worldXZ, material.rockColor.rgb);
  let forestAlbedoColor = sampleBiomeAlbedoArray(BIOME_FOREST, worldXZ, material.forestColor.rgb);
  
  // Blend albedo from sampled textures (or fallback colors)
  var albedo = grassAlbedoColor * grassWeight
             + rockAlbedoColor * rockWeight
             + forestAlbedoColor * forestWeight;
  
  // ===== Sample Biome Normal Maps from Texture Arrays =====
  // Sample normal textures for each biome (3 biomes) - these are in tangent space
  let grassBiomeNormalTS = sampleBiomeNormalArray(BIOME_GRASS, worldXZ);
  let rockBiomeNormalTS = sampleBiomeNormalArray(BIOME_ROCK, worldXZ);
  let forestBiomeNormalTS = sampleBiomeNormalArray(BIOME_FOREST, worldXZ);
  
  // ===== Sample Biome AO (Ambient Occlusion) from Texture Arrays =====
  let grassAo = sampleBiomeAoArray(BIOME_GRASS, worldXZ);
  let rockAo = sampleBiomeAoArray(BIOME_ROCK, worldXZ);
  let forestAo = sampleBiomeAoArray(BIOME_FOREST, worldXZ);
  
  // Blend AO values weighted by biome presence
  let biomeAo = blendBiomeAo(grassAo, grassWeight, rockAo, rockWeight, forestAo, forestWeight);
  
  // Build TBN matrix to transform biome normals from tangent space to world space
  // This ensures proper normal blending on steep slopes
  let TBN = buildTerrainTBN(blendedNormal);
  
  // Transform each biome normal from tangent space to world space
  let grassBiomeNormal = normalize(TBN * grassBiomeNormalTS);
  let rockBiomeNormal = normalize(TBN * rockBiomeNormalTS);
  let forestBiomeNormal = normalize(TBN * forestBiomeNormalTS);
  
  // Blend biome normals weighted by biome presence (now in world space)
  let biomeDetailNormal = blendBiomeNormals(
    grassBiomeNormal, grassWeight,
    rockBiomeNormal, rockWeight,
    forestBiomeNormal, forestWeight
  );
  
  // ===== Blend Base Normal with Biome Detail Normals =====
  // First blend base heightmap normal with procedural detail normal (existing)
  // Then blend with biome texture normals for additional detail
  // Sum all normal enable flags to check if any biome normal is active (3 biomes)
  let hasAnyBiomeNormal = getBiomeNormalEnabled(BIOME_GRASS) + getBiomeNormalEnabled(BIOME_ROCK) 
                        + getBiomeNormalEnabled(BIOME_FOREST);
  
  // If any biome normal maps are enabled, use the TBN-transformed world-space normals
  var finalBlendedNormal = blendedNormal;
  if (hasAnyBiomeNormal > 0.0) {
    // Biome normals are already transformed to world space via TBN
    // Use weighted blend to combine base terrain normal with biome detail
    // This preserves the macro terrain shape while adding biome micro-detail
    finalBlendedNormal = normalize(blendedNormal * 0.5 + biomeDetailNormal * 0.5);
  }
  
  // Use final blended normal for lighting
  let normal = finalBlendedNormal;
  
  // Simple directional lighting with shadows
  let lightDir = normalize(material.lightDir);
  let NdotL = max(dot(normal, lightDir), 0.0);
  
  // Calculate shadow (with slope-dependent bias for artifact-free slopes)
  let shadow = calculateShadow(input.lightSpacePos, input.worldPosition, normal, lightDir);
  
  // ===== Ambient Lighting: IBL or Flat =====
  // Use IBL diffuse irradiance if available (from SceneEnvironment Group 3)
  // IBL provides physically-based ambient that varies with normal direction
  let iblAmbient = calculateTerrainIBL(normal, albedo);
  
  // Flat ambient fallback (scaled by material intensity)
  let flatAmbient = albedo * material.ambientIntensity;
  
  // Blend between IBL and flat ambient (IBL takes precedence if available)
  // IBL is considered "available" if it produces non-black values
  let iblStrength = length(iblAmbient);
  let useIBL = step(0.001, iblStrength);  // 1 if IBL has content, 0 if black
  let ambientColor = mix(flatAmbient, iblAmbient, useIBL);
  
  // Apply biome AO to ambient lighting (AO primarily affects indirect/ambient light)
  let aoAmbientColor = ambientColor * biomeAo;
  
  // Apply shadow to diffuse component only (ambient is always visible)
  let diffuse = NdotL * material.lightColor.rgb * shadow;
  
  var finalColor = aoAmbientColor + albedo * diffuse;
  
  // Selection highlight
  if (material.isSelected > 0.5) {
    finalColor = mix(finalColor, vec3f(1.0, 0.6, 0.3), 0.1);
  }

  // Debug: visualize shadow UV coordinates
  let debugUV = 0.0;
  if (debugUV > 0.5) {
    let projCoords = input.lightSpacePos.xyz / input.lightSpacePos.w;
    let shadowUV = projCoords.xy * 0.5 + 0.5;
    return vec4f(shadowUV.x, shadowUV.y, projCoords.z, 1.0);
  }

  return vec4f(finalColor, 1.0);
}
