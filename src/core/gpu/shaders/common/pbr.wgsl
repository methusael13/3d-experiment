/**
 * PBR (Physically Based Rendering) Functions
 * 
 * Implements GGX microfacet BRDF with:
 * - Distribution function (GGX/Trowbridge-Reitz)
 * - Fresnel-Schlick approximation
 * - Geometry function (Smith GGX)
 * - Energy-conserving diffuse/specular blend
 */

const PI = 3.14159265359;
const EPSILON = 0.0001;

// ============ Helper Functions ============

/**
 * Fresnel-Schlick approximation
 * Calculates reflectance based on view angle
 */
fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

/**
 * Fresnel-Schlick with roughness term for IBL
 */
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  return F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

/**
 * GGX/Trowbridge-Reitz Normal Distribution Function
 * Models microfacet distribution based on roughness
 */
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + EPSILON);
}

/**
 * Geometry function (Smith's method with GGX)
 * Models self-shadowing of microfacets
 */
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  
  return NdotV / (NdotV * (1.0 - k) + k + EPSILON);
}

/**
 * Combined geometry function for view and light directions
 */
fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let ggx1 = geometrySchlickGGX(NdotV, roughness);
  let ggx2 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

// ============ Main PBR Function ============

/**
 * Calculate PBR direct lighting for a single directional light
 * 
 * @param N - Surface normal (normalized)
 * @param V - View direction (normalized)
 * @param L - Light direction (normalized, towards light)
 * @param albedo - Base color (linear space)
 * @param metallic - Metallic factor [0-1]
 * @param roughness - Roughness factor [0-1]
 * @param lightColor - Light color * intensity
 */
fn pbrDirectional(
  N: vec3f,
  V: vec3f,
  L: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  lightColor: vec3f
) -> vec3f {
  // Half vector
  let H = normalize(V + L);
  
  // Dot products
  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), EPSILON);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  
  // Skip if light is behind surface
  if (NdotL <= 0.0) {
    return vec3f(0.0);
  }
  
  // Clamp roughness to avoid numerical issues
  let clampedRoughness = clamp(roughness, 0.04, 1.0);
  
  // F0 = reflectance at normal incidence
  // Dielectrics: 0.04, Metals: albedo
  let F0 = mix(vec3f(0.04), albedo, metallic);
  
  // Cook-Torrance BRDF components
  let D = distributionGGX(NdotH, clampedRoughness);
  let G = geometrySmith(NdotV, NdotL, clampedRoughness);
  let F = fresnelSchlick(VdotH, F0);
  
  // Specular BRDF
  let numerator = D * G * F;
  let denominator = 4.0 * NdotV * NdotL + EPSILON;
  let specular = numerator / denominator;
  
  // Diffuse BRDF (Lambert with energy conservation)
  // Metals have no diffuse, controlled by metallic factor
  let kS = F;  // Specular reflection
  let kD = (vec3f(1.0) - kS) * (1.0 - metallic);  // Diffuse (energy conservation)
  
  let diffuse = kD * albedo / PI;
  
  // Final lighting
  return (diffuse + specular) * lightColor * NdotL;
}

/**
 * Hemisphere ambient approximation
 * Interpolates between sky and ground color based on normal Y
 */
fn hemisphereAmbient(N: vec3f, albedo: vec3f, ambient: f32) -> vec3f {
  let skyColor = vec3f(0.5, 0.7, 1.0);    // Light blue sky
  let groundColor = vec3f(0.3, 0.25, 0.2); // Brown ground
  let hemisphereColor = mix(groundColor, skyColor, N.y * 0.5 + 0.5);
  return albedo * hemisphereColor * ambient;
}

/**
 * Full PBR lighting with directional light + ambient
 */
fn pbrLighting(
  N: vec3f,
  V: vec3f,
  L: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  lightColor: vec3f,
  ambientIntensity: f32
) -> vec3f {
  let direct = pbrDirectional(N, V, L, albedo, metallic, roughness, lightColor);
  let ambient = hemisphereAmbient(N, albedo, ambientIntensity);
  return direct + ambient;
}

// ============ Normal Mapping ============

/**
 * Calculate TBN matrix from vertex data
 * Used to transform normal map samples to world space
 */
fn calculateTBN(worldNormal: vec3f, worldTangent: vec3f, bitangentSign: f32) -> mat3x3f {
  let N = normalize(worldNormal);
  let T = normalize(worldTangent);
  let B = cross(N, T) * bitangentSign;
  
  return mat3x3f(T, B, N);
}

/**
 * Perturb normal using normal map sample
 * 
 * @param TBN - Tangent-Bitangent-Normal matrix
 * @param normalSample - Sample from normal map (0-1 range)
 * @param normalScale - Normal map strength
 */
fn perturbNormal(TBN: mat3x3f, normalSample: vec3f, normalScale: f32) -> vec3f {
  // Convert from [0,1] to [-1,1]
  var tangentNormal = normalSample * 2.0 - 1.0;
  
  // Apply scale
  tangentNormal = vec3f(tangentNormal.xy * normalScale, tangentNormal.z);
  
  // Transform to world space
  return normalize(TBN * tangentNormal);
}

/**
 * Compute cotangent frame for normal mapping without pre-computed tangents
 * Based on Christian Schüler's approach
 */
fn cotangentFrame(N: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  // Get edge vectors
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  
  // Solve linear system
  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);
  
  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;
  
  // Construct scale-invariant frame
  let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
  return mat3x3f(T * invmax, B * invmax, N);
}

// ============ sRGB/Linear Conversion ============

/**
 * Convert sRGB color to linear color space
 */
fn srgbToLinear(srgb: vec3f) -> vec3f {
  let low = srgb / 12.92;
  let high = pow((srgb + 0.055) / 1.055, vec3f(2.4));
  return vec3f(
    select(high.x, low.x, srgb.x < 0.04045),
    select(high.y, low.y, srgb.y < 0.04045),
    select(high.z, low.z, srgb.z < 0.04045)
  );
}

/**
 * sRGB alpha channel (already linear, just pass through)
 */
fn srgbToLinearAlpha(srgba: vec4f) -> vec4f {
  return vec4f(srgbToLinear(srgba.rgb), srgba.a);
}
