/**
 * Shared Environment Shader Functions
 * 
 * This file is concatenated with main shaders (terrain, water, objects) at build time.
 * Provides consistent IBL and shadow calculations across all renderers.
 * 
 * Bind Group 3 Layout (shared):
 * - binding(0): shadowMap - depth texture
 * - binding(1): shadowSampler - comparison sampler
 * - binding(2): iblDiffuse - diffuse irradiance cubemap
 * - binding(3): iblSpecular - specular prefiltered cubemap
 * - binding(4): brdfLut - BRDF integration LUT
 * - binding(5): iblCubeSampler - cubemap sampler
 * - binding(6): iblLutSampler - LUT sampler
 */

// ============ Environment Bind Group (Group 3) ============

@group(3) @binding(0) var env_shadowMap: texture_depth_2d;
@group(3) @binding(1) var env_shadowSampler: sampler_comparison;
@group(3) @binding(2) var env_iblDiffuse: texture_cube<f32>;
@group(3) @binding(3) var env_iblSpecular: texture_cube<f32>;
@group(3) @binding(4) var env_brdfLut: texture_2d<f32>;
@group(3) @binding(5) var env_cubeSampler: sampler;
@group(3) @binding(6) var env_lutSampler: sampler;

// ============ Constants ============

const ENV_PI: f32 = 3.14159265359;
const ENV_MAX_REFLECTION_LOD: f32 = 4.0; // Max mip level for specular cubemap

// ============ Fresnel Functions ============

/**
 * Fresnel-Schlick approximation
 * F0: surface reflectance at normal incidence
 * cosTheta: dot(N, V) or dot(N, H)
 */
fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
    return F0 + (1.0 - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

/**
 * Fresnel-Schlick with roughness term for IBL
 * Accounts for roughness in indirect specular
 */
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
    let smoothness = 1.0 - roughness;
    return F0 + (max(vec3f(smoothness), F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

// ============ IBL Functions ============

/**
 * Sample diffuse irradiance from IBL cubemap
 * Returns pre-convolved irradiance for Lambert diffuse
 */
fn sampleIBLDiffuse(worldNormal: vec3f) -> vec3f {
    return textureSample(env_iblDiffuse, env_cubeSampler, worldNormal).rgb;
}

/**
 * Sample specular radiance from IBL cubemap
 * roughness: 0=mirror, 1=diffuse (selects mip level)
 */
fn sampleIBLSpecular(reflectionDir: vec3f, roughness: f32) -> vec3f {
    let mipLevel = roughness * ENV_MAX_REFLECTION_LOD;
    return textureSampleLevel(env_iblSpecular, env_cubeSampler, reflectionDir, mipLevel).rgb;
}

/**
 * Sample BRDF integration LUT
 * NdotV: dot(normal, viewDir)
 * roughness: surface roughness
 * Returns (scale, bias) for split-sum approximation
 */
fn sampleBRDFLut(NdotV: f32, roughness: f32) -> vec2f {
    return textureSample(env_brdfLut, env_lutSampler, vec2f(NdotV, roughness)).rg;
}

/**
 * Complete IBL lighting calculation (diffuse + specular)
 * 
 * @param worldNormal - surface normal in world space
 * @param viewDir - normalized direction from surface to camera
 * @param albedo - surface base color
 * @param metallic - 0=dielectric, 1=metal
 * @param roughness - surface roughness
 * @param ao - ambient occlusion (1=no occlusion)
 * @return vec3f - combined ambient/IBL lighting
 */
fn calculateIBL(
    worldNormal: vec3f,
    viewDir: vec3f,
    albedo: vec3f,
    metallic: f32,
    roughness: f32,
    ao: f32
) -> vec3f {
    let NdotV = max(dot(worldNormal, viewDir), 0.0);
    
    // Calculate F0 (surface reflectance at normal incidence)
    // Dielectrics: 0.04, Metals: albedo
    let F0 = mix(vec3f(0.04), albedo, metallic);
    
    // Fresnel with roughness compensation
    let F = fresnelSchlickRoughness(NdotV, F0, roughness);
    
    // Energy conservation: kD + kS = 1
    let kS = F;
    let kD = (1.0 - kS) * (1.0 - metallic);
    
    // Diffuse IBL
    let irradiance = sampleIBLDiffuse(worldNormal);
    let diffuse = kD * irradiance * albedo;
    
    // Specular IBL (split-sum approximation)
    let R = reflect(-viewDir, worldNormal);
    let prefilteredColor = sampleIBLSpecular(R, roughness);
    let brdf = sampleBRDFLut(NdotV, roughness);
    let specular = prefilteredColor * (F * brdf.x + brdf.y);
    
    // Combine with ambient occlusion
    return (diffuse + specular) * ao;
}

/**
 * Simplified IBL for non-PBR surfaces (terrain, water)
 * Uses fixed roughness and metallic values
 */
fn calculateIBLSimple(
    worldNormal: vec3f,
    viewDir: vec3f,
    albedo: vec3f,
    roughness: f32
) -> vec3f {
    return calculateIBL(worldNormal, viewDir, albedo, 0.0, roughness, 1.0);
}

/**
 * Sample environment reflection for water/glass
 * Returns specular cubemap sample blended by Fresnel
 */
fn sampleEnvironmentReflection(
    worldNormal: vec3f,
    viewDir: vec3f,
    roughness: f32
) -> vec3f {
    let R = reflect(-viewDir, worldNormal);
    return sampleIBLSpecular(R, roughness);
}

// ============ Shadow Functions ============

/**
 * Calculate shadow using PCF (Percentage Closer Filtering)
 * 
 * @param shadowCoord - light-space position (after perspective divide)
 * @param bias - depth bias to prevent shadow acne
 * @return f32 - shadow factor (0=shadow, 1=lit)
 */
fn calculateShadowPCF(shadowCoord: vec4f, bias: f32) -> f32 {
    // Perspective divide
    let projCoord = shadowCoord.xyz / shadowCoord.w;
    
    // Transform from [-1,1] to [0,1] for UV lookup
    let uv = projCoord.xy * 0.5 + 0.5;
    // Flip Y for correct orientation
    let shadowUV = vec2f(uv.x, 1.0 - uv.y);
    
    // Check if outside shadow map bounds
    if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
        return 1.0; // Outside = lit
    }
    
    // Check if behind light
    if (projCoord.z > 1.0 || projCoord.z < 0.0) {
        return 1.0;
    }
    
    let currentDepth = projCoord.z - bias;
    
    // 2x2 PCF sampling
    let texelSize = 1.0 / vec2f(textureDimensions(env_shadowMap));
    var shadow: f32 = 0.0;
    
    for (var x: i32 = -1; x <= 1; x++) {
        for (var y: i32 = -1; y <= 1; y++) {
            let offset = vec2f(f32(x), f32(y)) * texelSize;
            shadow += textureSampleCompare(
                env_shadowMap,
                env_shadowSampler,
                shadowUV + offset,
                currentDepth
            );
        }
    }
    
    return shadow / 9.0; // 3x3 = 9 samples
}

/**
 * Simple shadow calculation (no PCF)
 */
fn calculateShadowSimple(shadowCoord: vec4f, bias: f32) -> f32 {
    let projCoord = shadowCoord.xyz / shadowCoord.w;
    let uv = projCoord.xy * 0.5 + 0.5;
    let shadowUV = vec2f(uv.x, 1.0 - uv.y);
    
    if (shadowUV.x < 0.0 || shadowUV.x > 1.0 || shadowUV.y < 0.0 || shadowUV.y > 1.0) {
        return 1.0;
    }
    
    if (projCoord.z > 1.0 || projCoord.z < 0.0) {
        return 1.0;
    }
    
    let currentDepth = projCoord.z - bias;
    return textureSampleCompare(env_shadowMap, env_shadowSampler, shadowUV, currentDepth);
}

/**
 * Shadow with distance fade
 * Fades shadow at far distances to avoid artifacts
 */
fn calculateShadowWithFade(
    shadowCoord: vec4f,
    bias: f32,
    distanceToCamera: f32,
    fadeStart: f32,
    fadeEnd: f32
) -> f32 {
    let shadow = calculateShadowPCF(shadowCoord, bias);
    let fadeFactor = saturate((fadeEnd - distanceToCamera) / (fadeEnd - fadeStart));
    return mix(1.0, shadow, fadeFactor);
}
