/**
 * Object Shader - PBR mesh rendering with texture support
 * 
 * Supports:
 * - Per-instance model matrices
 * - Full PBR lighting (GGX BRDF)
 * - Optional textures: baseColor, normal, metallicRoughness, occlusion, emissive
 * - Directional light + ambient hemisphere
 * - Shadow mapping
 * - Image-Based Lighting (IBL)
 * 
 * Bind Group Layout:
 * - Group 0: Global uniforms (camera, light, shadow params)
 * - Group 1: Per-mesh uniforms (model matrix, material)
 * - Group 2: PBR textures (baseColor, normal, metallicRoughness, occlusion, emissive)
 * - Group 3: Environment (shadow map + IBL cubemaps) - COMBINED to stay within 4 group limit
 */

// ============ Constants ============

const PI = 3.14159265359;
const EPSILON = 0.0001;

// ============ Uniforms ============

struct GlobalUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  lightDirection: vec3f,
  _pad1: f32,
  lightColor: vec3f,
  ambientIntensity: f32,
  lightSpaceMatrix: mat4x4f,  // For shadow mapping
  shadowEnabled: f32,         // 0 = disabled, 1 = enabled
  shadowBias: f32,            // Bias to prevent shadow acne
  _pad2: f32,
  _pad3: f32,
}

struct MaterialUniforms {
  // Base material properties (16 bytes)
  albedo: vec3f,
  metallic: f32,
  
  // More properties (16 bytes)
  roughness: f32,
  normalScale: f32,
  occlusionStrength: f32,
  alphaCutoff: f32,
  
  // Emissive (16 bytes)
  emissiveFactor: vec3f,
  useAlphaCutoff: f32,  // 1.0 = alphaMode is MASK, 0.0 = OPAQUE/BLEND
  
  // Texture flags packed into 16 bytes
  // hasBaseColorTex, hasNormalTex, hasMetallicRoughnessTex, hasOcclusionTex
  textureFlags: vec4f,
}

@group(0) @binding(0) var<uniform> globals: GlobalUniforms;

// Per-mesh uniforms (model matrix + material)
struct SingleModelUniforms {
  model: mat4x4f,
}

@group(1) @binding(0) var<uniform> singleModel: SingleModelUniforms;
@group(1) @binding(1) var<uniform> material: MaterialUniforms;

// ============ Textures (Group 2) ============

@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;
@group(2) @binding(2) var normalTexture: texture_2d<f32>;
@group(2) @binding(3) var normalSampler: sampler;
@group(2) @binding(4) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(5) var metallicRoughnessSampler: sampler;
@group(2) @binding(6) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(7) var occlusionSampler: sampler;
@group(2) @binding(8) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(9) var emissiveSampler: sampler;

// ============ Environment (Group 3) - Shadow Map + IBL Combined ============
// Combined into single group to stay within WebGPU's 4 bind group limit

// Shadow resources (bindings 0-1)
@group(3) @binding(0) var shadowMap: texture_depth_2d;
@group(3) @binding(1) var shadowSampler: sampler_comparison;

// IBL resources (bindings 2-6)
@group(3) @binding(2) var iblDiffuse: texture_cube<f32>;        // Diffuse irradiance cubemap
@group(3) @binding(3) var iblSpecular: texture_cube<f32>;       // Specular prefilter cubemap (with mips)
@group(3) @binding(4) var iblBrdfLut: texture_2d<f32>;          // BRDF integration LUT
@group(3) @binding(5) var iblCubemapSampler: sampler;           // Cubemap sampler
@group(3) @binding(6) var iblLutSampler: sampler;               // BRDF LUT sampler

// ============ Vertex Shader ============

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) uv: vec2f,
  @location(3) lightSpacePos: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Transform position to world space
  let worldPos = singleModel.model * vec4f(input.position, 1.0);
  output.worldPosition = worldPos.xyz;
  
  // Transform to clip space
  output.clipPosition = globals.viewProjection * worldPos;
  
  // Transform normal to world space (assuming uniform scale)
  let normalMatrix = mat3x3f(
    singleModel.model[0].xyz,
    singleModel.model[1].xyz,
    singleModel.model[2].xyz
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  
  output.uv = input.uv;
  
  // Transform to light space for shadow mapping
  let worldPos4 = vec4f(output.worldPosition, 1.0);
  output.lightSpacePos = globals.lightSpaceMatrix * worldPos4;
  
  return output;
}

// ============ PBR Functions ============

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + EPSILON);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  
  return NdotV / (NdotV * (1.0 - k) + k + EPSILON);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let ggx1 = geometrySchlickGGX(NdotV, roughness);
  let ggx2 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

fn pbrDirectional(
  N: vec3f,
  V: vec3f,
  L: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  lightColor: vec3f
) -> vec3f {
  let H = normalize(V + L);
  
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), EPSILON);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  
  if (NdotL <= 0.0) {
    return vec3f(0.0);
  }
  
  let clampedRoughness = clamp(roughness, 0.04, 1.0);
  let F0 = mix(vec3f(0.04), albedo, metallic);
  
  let D = distributionGGX(NdotH, clampedRoughness);
  let G = geometrySmith(NdotV, NdotL, clampedRoughness);
  let F = fresnelSchlick(VdotH, F0);
  
  let numerator = D * G * F;
  let denominator = 4.0 * NdotV * NdotL + EPSILON;
  let specular = numerator / denominator;
  
  let kS = F;
  let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
  
  let diffuse = kD * albedo / PI;
  
  return (diffuse + specular) * lightColor * NdotL;
}

fn hemisphereAmbient(N: vec3f, albedo: vec3f, ambient: f32) -> vec3f {
  let skyColor = vec3f(0.5, 0.7, 1.0);
  let groundColor = vec3f(0.3, 0.25, 0.2);
  let hemisphereColor = mix(groundColor, skyColor, N.y * 0.5 + 0.5);
  return albedo * hemisphereColor * ambient;
}

// ============ IBL Functions ============
// Image-Based Lighting using pre-computed environment maps

// Fresnel-Schlick with roughness term for IBL
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  // More accurate for rough surfaces - lerps towards white at grazing angles
  let oneMinusRoughness = vec3f(1.0 - roughness);
  return F0 + (max(oneMinusRoughness, F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

// Sample IBL for ambient lighting (diffuse + specular)
// Uses split-sum approximation with pre-filtered environment maps
fn sampleIBL(
  N: vec3f,           // Surface normal
  V: vec3f,           // View direction  
  albedo: vec3f,      // Base color
  metallic: f32,      // Metallic factor
  roughness: f32,     // Roughness factor
  ao: f32             // Ambient occlusion
) -> vec3f {
  let NdotV = max(dot(N, V), 0.0);
  
  // F0 is the reflectance at normal incidence (0°)
  // Dielectric: 0.04, Metal: uses albedo color
  let F0 = mix(vec3f(0.04), albedo, metallic);
  
  // Fresnel term with roughness compensation
  let F = fresnelSchlickRoughness(NdotV, F0, roughness);
  
  // ============ Diffuse IBL ============
  // Sample pre-convolved diffuse irradiance cubemap
  let irradiance = textureSample(iblDiffuse, iblCubemapSampler, N).rgb;
  
  // kD is the diffuse contribution (energy not reflected specularly)
  // Metals have no diffuse component (kD = 0 when metallic = 1)
  let kD = (vec3f(1.0) - F) * (1.0 - metallic);
  let diffuse = irradiance * albedo * kD;
  
  // ============ Specular IBL ============
  // Reflection direction for sampling prefiltered environment
  let R = reflect(-V, N);
  
  // Sample prefiltered specular map
  // Mip level is based on roughness (0 = mirror, higher = rougher)
  // Using 5 mip levels (0-5), so multiply roughness by 5
  let MAX_REFLECTION_LOD = 5.0;
  let mipLevel = roughness * MAX_REFLECTION_LOD;
  let prefilteredColor = textureSampleLevel(iblSpecular, iblCubemapSampler, R, mipLevel).rgb;
  
  // Sample BRDF LUT for split-sum approximation
  // x = scale factor for F0, y = bias term
  let brdf = textureSample(iblBrdfLut, iblLutSampler, vec2f(NdotV, roughness)).rg;
  
  // Final specular: prefiltered * (F0 * scale + bias)
  let specular = prefilteredColor * (F0 * brdf.x + brdf.y);
  
  // Combine diffuse and specular with ambient occlusion
  return (diffuse + specular) * ao;
}

// IBL-only ambient (no hemisphere fallback)
fn iblAmbient(
  N: vec3f,
  V: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  ao: f32,
  ambientIntensity: f32
) -> vec3f {
  return sampleIBL(N, V, albedo, metallic, roughness, ao) * ambientIntensity;
}

// sRGB to linear conversion
fn srgbToLinear(srgb: vec3f) -> vec3f {
  // Per-component conversion using select
  let low = srgb / 12.92;
  let high = pow((srgb + 0.055) / 1.055, vec3f(2.4));
  return vec3f(
    select(high.x, low.x, srgb.x < 0.04045),
    select(high.y, low.y, srgb.y < 0.04045),
    select(high.z, low.z, srgb.z < 0.04045)
  );
}

// ============ Shadow Functions ============

// Sample shadow map with slope-dependent bias
fn sampleShadow(lightSpacePos: vec4f, normal: vec3f, lightDir: vec3f) -> f32 {
  // Check if shadows are enabled
  if (globals.shadowEnabled < 0.5) {
    return 1.0;
  }
  
  // Perspective divide to get NDC coordinates
  let projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform from NDC [-1,1] to texture UV [0,1]
  // WebGPU: NDC has Y pointing up, but texture UV has Y pointing down
  let shadowUV = vec2f(projCoords.x * 0.5 + 0.5, 0.5 - projCoords.y * 0.5);
  
  // Clamp UV to valid range (must always sample at valid coords)
  let clampedUV = clamp(shadowUV, vec2f(0.001), vec2f(0.999));
  
  // Apply slope-dependent bias to prevent shadow acne
  let NdotL = max(dot(normal, lightDir), 0.001);
  let slopeFactor = sqrt(1.0 - NdotL * NdotL) / NdotL;
  let baseBias = globals.shadowBias;
  let slopeBias = 0.002;
  let shadowBias = baseBias + clamp(slopeFactor, 0.0, 5.0) * slopeBias;
  let clampedDepth = clamp(projCoords.z - shadowBias, 0.0, 1.0);
  
  // Sample shadow map with comparison
  let shadowValue = textureSampleCompare(shadowMap, shadowSampler, clampedUV, clampedDepth);
  
  // Check if outside shadow map bounds
  let inBoundsX = step(0.0, shadowUV.x) * step(shadowUV.x, 1.0);
  let inBoundsY = step(0.0, shadowUV.y) * step(shadowUV.y, 1.0);
  let inBoundsZ = step(0.0, projCoords.z) * step(projCoords.z, 1.0);
  let inBounds = inBoundsX * inBoundsY * inBoundsZ;
  
  // Return shadow value if in bounds, 1.0 (no shadow) if out of bounds
  return mix(1.0, shadowValue, inBounds);
}

// Compute cotangent frame for normal mapping without pre-computed tangents
fn cotangentFrame(N: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  
  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);
  
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  
  let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
  return mat3x3f(T * invmax, B * invmax, N);
}

// ============ Fragment Shader (No IBL) ============

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Extract texture flags: x=baseColor, y=normal, z=metallicRoughness, w=occlusion
  let hasBaseColorTex = material.textureFlags.x > 0.5;
  let hasNormalTex = material.textureFlags.y > 0.5;
  let hasMetallicRoughnessTex = material.textureFlags.z > 0.5;
  let hasOcclusionTex = material.textureFlags.w > 0.5;
  
  // Get base albedo (from texture or uniform)
  var albedo = material.albedo;
  var alpha = 1.0;
  
  if (hasBaseColorTex) {
    let texColor = textureSample(baseColorTexture, baseColorSampler, input.uv);
    // Convert sRGB texture to linear
    albedo = srgbToLinear(texColor.rgb) * material.albedo;
    alpha = texColor.a;
    
    // Alpha cutoff ONLY for MASK materials (alphaMode === 'MASK')
    // OPAQUE and BLEND materials should NOT discard based on alpha
    if (material.useAlphaCutoff > 0.5 && alpha < material.alphaCutoff) {
      discard;
    }
  }
  
  // Get metallic and roughness (from texture or uniform)
  var metallic = material.metallic;
  var roughness = material.roughness;
  
  if (hasMetallicRoughnessTex) {
    // glTF spec: R = unused, G = roughness, B = metallic
    let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.uv);
    roughness = material.roughness * mrSample.g;
    metallic = material.metallic * mrSample.b;
  }
  
  // Get normal (from texture or vertex)
  var N = normalize(input.worldNormal);
  
  if (hasNormalTex) {
    // Always compute TBN and normal-mapped result
    let TBN = cotangentFrame(N, input.worldPosition, input.uv);
    let normalSample = textureSample(normalTexture, normalSampler, input.uv).xyz;
    var tangentNormal = normalSample * 2.0 - 1.0;
    tangentNormal = vec3f(tangentNormal.xy * material.normalScale, tangentNormal.z);
    let mappedN = normalize(TBN * tangentNormal);
    
    // Check if screen-space derivatives are large enough for reliable TBN calculation
    // At large distances, derivatives become very small and cotangentFrame becomes unstable
    // We already computed dpdx/dpdy inside cotangentFrame, so compute check here too
    let dp1 = dpdx(input.worldPosition);
    let dp2 = dpdy(input.worldPosition);
    let derivativeMagnitude = max(dot(dp1, dp1), dot(dp2, dp2));
    
    // Blend between mapped normal and vertex normal based on derivative magnitude
    // This avoids non-uniform control flow issues with dpdx/dpdy
    let useMapping = step(0.000001, derivativeMagnitude);
    N = mix(N, mappedN, useMapping);
  }
  
  // Get occlusion (from texture or default)
  var ao = 1.0;
  if (hasOcclusionTex) {
    let aoSample = textureSample(occlusionTexture, occlusionSampler, input.uv).r;
    ao = 1.0 + material.occlusionStrength * (aoSample - 1.0);
  }
  
  // Get emissive (from texture or uniform) - Note: no separate emissive flag, use emissiveFactor != 0
  var emissive = material.emissiveFactor;
  
  // Calculate lighting
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);
  
  // Calculate shadow factor
  let shadow = sampleShadow(input.lightSpacePos, N, L);
  
  // Direct lighting (affected by shadow)
  let direct = pbrDirectional(N, V, L, albedo, metallic, roughness, globals.lightColor) * shadow;
  
  // Ambient lighting with occlusion (not affected by shadow)
  let ambient = hemisphereAmbient(N, albedo, globals.ambientIntensity) * ao;
  
  // Final color
  let color = direct + ambient + emissive;
  
  // Output linear HDR - tonemapping and gamma applied in composite pass
  return vec4f(color, alpha);
}

// ============ No-Texture Variant (No IBL) ============
// Simplified variant when no textures are bound (faster for primitives)

@fragment
fn fs_notex(input: VertexOutput) -> @location(0) vec4f {
  let N = normalize(input.worldNormal);
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);
  
  // Calculate shadow factor
  let shadow = sampleShadow(input.lightSpacePos, N, L);
  
  // Direct lighting (affected by shadow)
  let direct = pbrDirectional(
    N, V, L,
    material.albedo,
    material.metallic,
    material.roughness,
    globals.lightColor
  ) * shadow;
  
  // Ambient lighting (not affected by shadow)
  let ambient = hemisphereAmbient(N, material.albedo, globals.ambientIntensity);
  
  let color = direct + ambient + material.emissiveFactor;
  
  return vec4f(color, 1.0);
}

// ============ IBL-Enabled Variants ============
// These variants use Image-Based Lighting for ambient instead of simple hemisphere

@fragment
fn fs_main_ibl(input: VertexOutput) -> @location(0) vec4f {
  // Extract texture flags: x=baseColor, y=normal, z=metallicRoughness, w=occlusion
  let hasBaseColorTex = material.textureFlags.x > 0.5;
  let hasNormalTex = material.textureFlags.y > 0.5;
  let hasMetallicRoughnessTex = material.textureFlags.z > 0.5;
  let hasOcclusionTex = material.textureFlags.w > 0.5;
  
  // Get base albedo (from texture or uniform)
  var albedo = material.albedo;
  var alpha = 1.0;
  
  if (hasBaseColorTex) {
    let texColor = textureSample(baseColorTexture, baseColorSampler, input.uv);
    albedo = srgbToLinear(texColor.rgb) * material.albedo;
    alpha = texColor.a;
    
    if (material.useAlphaCutoff > 0.5 && alpha < material.alphaCutoff) {
      discard;
    }
  }
  
  // Get metallic and roughness (from texture or uniform)
  var metallic = material.metallic;
  var roughness = material.roughness;
  
  if (hasMetallicRoughnessTex) {
    let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.uv);
    roughness = material.roughness * mrSample.g;
    metallic = material.metallic * mrSample.b;
  }
  
  // Get normal (from texture or vertex)
  var N = normalize(input.worldNormal);
  
  if (hasNormalTex) {
    let TBN = cotangentFrame(N, input.worldPosition, input.uv);
    let normalSample = textureSample(normalTexture, normalSampler, input.uv).xyz;
    var tangentNormal = normalSample * 2.0 - 1.0;
    tangentNormal = vec3f(tangentNormal.xy * material.normalScale, tangentNormal.z);
    let mappedN = normalize(TBN * tangentNormal);
    
    let dp1 = dpdx(input.worldPosition);
    let dp2 = dpdy(input.worldPosition);
    let derivativeMagnitude = max(dot(dp1, dp1), dot(dp2, dp2));
    let useMapping = step(0.000001, derivativeMagnitude);
    N = mix(N, mappedN, useMapping);
  }
  
  // Get occlusion (from texture or default)
  var ao = 1.0;
  if (hasOcclusionTex) {
    let aoSample = textureSample(occlusionTexture, occlusionSampler, input.uv).r;
    ao = 1.0 + material.occlusionStrength * (aoSample - 1.0);
  }
  
  var emissive = material.emissiveFactor;
  
  // Calculate lighting
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);
  
  // Calculate shadow factor
  let shadow = sampleShadow(input.lightSpacePos, N, L);
  
  // Direct lighting (affected by shadow)
  let direct = pbrDirectional(N, V, L, albedo, metallic, roughness, globals.lightColor) * shadow;
  
  // IBL ambient lighting (replaces hemisphere ambient)
  let ambient = iblAmbient(N, V, albedo, metallic, roughness, ao, globals.ambientIntensity);
  
  let color = direct + ambient + emissive;
  
  return vec4f(color, alpha);
}

@fragment
fn fs_notex_ibl(input: VertexOutput) -> @location(0) vec4f {
  let N = normalize(input.worldNormal);
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);
  
  // Calculate shadow factor
  let shadow = sampleShadow(input.lightSpacePos, N, L);
  
  // Direct lighting (affected by shadow)
  let direct = pbrDirectional(
    N, V, L,
    material.albedo,
    material.metallic,
    material.roughness,
    globals.lightColor
  ) * shadow;
  
  // IBL ambient lighting (replaces hemisphere ambient)
  let ambient = iblAmbient(
    N, V,
    material.albedo,
    material.metallic,
    material.roughness,
    1.0,  // no AO texture
    globals.ambientIntensity
  );
  
  let color = direct + ambient + material.emissiveFactor;
  
  return vec4f(color, 1.0);
}
