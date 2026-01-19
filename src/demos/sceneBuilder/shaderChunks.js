/**
 * Shared GLSL code chunks for shader composition
 * Usage: Import chunks and interpolate into shader template literals
 */

/**
 * Simplex noise functions for procedural animation
 * Based on Ashima Arts' webgl-noise
 */
export const simplexNoise = `
// Simplex noise helpers
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/**
 * Wind uniform declarations
 * Required uniforms that must be set by the renderer
 */
export const windUniforms = `
// Wind uniforms (global)
uniform int uWindEnabled;
uniform float uWindTime;
uniform float uWindStrength;
uniform vec2 uWindDirection;
uniform float uWindTurbulence;

// Wind uniforms (per-mesh)
uniform int uWindType; // 0=none, 1=leaf, 2=branch

// Wind uniforms (per-object)
uniform float uWindInfluence;
uniform float uWindStiffness;
uniform float uWindAnchorHeight;
uniform vec2 uWindPhysicsDisplacement; // Physics-based displacement from spring sim
`;

/**
 * Wind displacement calculation function
 * Uses physics-based primary motion + procedural secondary/flutter
 * Requires: windUniforms, simplexNoise (snoise not currently used but available)
 */
export const windDisplacement = `
// Calculate wind displacement using physics-based simulation
vec3 calcWindDisplacement(vec3 worldPos, float heightFactor) {
  if (uWindEnabled == 0 || uWindType == 0 || heightFactor <= 0.0) {
    return vec3(0.0);
  }
  
  vec3 displacement = vec3(0.0);
  
  // ============================================
  // PHYSICS-BASED PRIMARY MOTION
  // Uses spring simulation displacement from CPU
  // This gives momentum, overshoot, and natural settling
  // ============================================
  float physicsScale = heightFactor * heightFactor; // Quadratic height scaling
  displacement.x = uWindPhysicsDisplacement.x * physicsScale;
  displacement.z = uWindPhysicsDisplacement.y * physicsScale;
  
  // Slight vertical droop when bent (physics-based)
  float bendAmount = length(uWindPhysicsDisplacement);
  displacement.y = -bendAmount * 0.1 * physicsScale;
  
  // ============================================
  // LAYER 2: Secondary oscillation (procedural detail)
  // Adds faster motion on top of physics base
  // ============================================
  if (uWindType >= 1) {
    float secondaryFreq = 1.5 + uWindTurbulence * 0.5;
    float secondaryPhase = uWindTime * secondaryFreq * 6.28318;
    
    // Position-based offset for variation
    float branchOffset = dot(worldPos, vec3(0.7, 0.3, 0.5)) * 2.0;
    float secondaryWave = sin(secondaryPhase + branchOffset);
    
    // Scale secondary motion by physics displacement (more wind = more secondary)
    float secondaryScale = clamp(bendAmount * 2.0, 0.0, 1.0);
    float secondaryAmp = 0.05 * heightFactor * secondaryScale;
    
    vec3 windDir3D = vec3(uWindDirection.x, 0.0, uWindDirection.y);
    vec3 perpDir = vec3(-windDir3D.z, 0.0, windDir3D.x);
    
    displacement += windDir3D * secondaryWave * secondaryAmp;
    displacement += perpDir * secondaryWave * secondaryAmp * 0.4;
  }
  
  // ============================================
  // LAYER 3: Leaf flutter (leaves only)
  // High frequency detail - small amplitude
  // ============================================
  if (uWindType == 1) {
    float flutterFreq = 0.2 + uWindTurbulence * 3.0;
    
    // Multiple flutter waves
    vec3 flutterCoord = worldPos * 1.5;
    float flutter1 = sin(uWindTime * flutterFreq * 6.28318 + flutterCoord.x * 3.0 + flutterCoord.z * 2.0);
    float flutter2 = sin(uWindTime * (flutterFreq * 1.3) * 6.28318 + flutterCoord.z * 4.0);
    
    // Scale flutter by physics displacement (more wind = more flutter)
    float flutterScale = clamp(bendAmount * 3.0, 0.0, 1.0);
    float flutterAmp = 0.03 * flutterScale;
    
    displacement.x += flutter1 * flutterAmp;
    displacement.y += flutter2 * 0.3 * flutterAmp;
    displacement.z += flutter1 * 0.8 * flutterAmp;
  }
  
  return displacement;
}
`;

/**
 * Wind height factor calculation
 * Determines how much wind affects a vertex based on its world-space height
 */
export const windHeightFactor = `
// Calculate height factor for wind (vertices above anchor move more)
float calcWindHeightFactor(vec4 worldPos, float anchorHeight) {
  float heightAboveAnchor = max(0.0, worldPos.y - anchorHeight);
  float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
  return heightFactor * heightFactor; // Quadratic falloff
}
`;

/**
 * Complete wind vertex shader chunk
 * Combines all wind-related code for easy inclusion
 * Requires: uModel uniform to be defined
 */
export const windVertexChunk = `
${simplexNoise}
${windUniforms}
${windDisplacement}
${windHeightFactor}

// Apply wind to world position
vec3 applyWind(vec3 localPos, mat4 modelMatrix) {
  vec4 worldPos = modelMatrix * vec4(localPos, 1.0);
  float heightFactor = calcWindHeightFactor(worldPos, uWindAnchorHeight);
  return calcWindDisplacement(worldPos.xyz, heightFactor);
}
`;

/**
 * Terrain blend uniform declarations
 * For depth-based intersection blending
 */
export const terrainBlendUniforms = `
// Terrain blend uniforms
uniform int uTerrainBlendEnabled;
uniform float uTerrainBlendDistance; // World units for blend zone
uniform sampler2D uSceneDepthTexture;
uniform vec2 uScreenSize;
uniform float uNearPlane;
uniform float uFarPlane;
`;

/**
 * HDR sampling uniform declarations
 */
export const hdrUniforms = `
// HDR uniforms
uniform sampler2D uHdrTexture;
uniform int uHasHdr;
uniform float uHdrExposure;
`;

/**
 * HDR sampling functions for IBL
 * Includes equirectangular projection and diffuse irradiance approximation
 */
export const hdrFunctions = `
const float PI = 3.14159265359;

vec2 dirToEquirect(vec3 dir) {
  float phi = atan(dir.z, dir.x);
  float theta = asin(clamp(dir.y, -1.0, 1.0));
  return vec2(phi / (2.0 * PI) + 0.5, theta / PI + 0.5);
}

vec3 sampleHDR(vec3 dir, float exposure) {
  vec2 uv = dirToEquirect(dir);
  vec3 hdrColor = texture(uHdrTexture, uv).rgb * exposure;
  // Reinhard tone mapping
  return hdrColor / (hdrColor + vec3(1.0));
}

// Sample HDR in multiple directions for diffuse irradiance approximation
vec3 sampleHDRDiffuse(vec3 normal, float exposure) {
  // Main direction
  vec3 result = sampleHDR(normal, exposure) * 0.5;
  
  // Sample in offset directions for softer ambient
  vec3 tangent = normalize(cross(normal, abs(normal.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0)));
  vec3 bitangent = cross(normal, tangent);
  
  // 4 offset samples at 45 degrees
  result += sampleHDR(normalize(normal + tangent * 0.7), exposure) * 0.125;
  result += sampleHDR(normalize(normal - tangent * 0.7), exposure) * 0.125;
  result += sampleHDR(normalize(normal + bitangent * 0.7), exposure) * 0.125;
  result += sampleHDR(normalize(normal - bitangent * 0.7), exposure) * 0.125;
  
  return result;
}
`;

/**
 * Shadow uniform declarations
 */
export const shadowUniforms = `
// Shadow uniforms
uniform highp sampler2D uShadowMap;
uniform int uShadowEnabled;
`;

/**
 * Shadow calculation functions
 * Includes depth unpacking and PCF filtering
 */
export const shadowFunctions = `
// Unpack depth from RGBA8
float unpackDepth(vec4 rgba) {
  const vec4 bitShift = vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0);
  return dot(rgba, bitShift);
}

// PCF shadow sampling with manual depth comparison
float calcShadow(vec4 lightSpacePos, vec3 normal, vec3 lightDir) {
  // Perspective divide
  vec3 projCoords = lightSpacePos.xyz / lightSpacePos.w;
  
  // Transform to [0,1] range
  projCoords = projCoords * 0.5 + 0.5;
  
  // Check if outside shadow map
  if (projCoords.z > 1.0 || projCoords.x < 0.0 || projCoords.x > 1.0 || 
      projCoords.y < 0.0 || projCoords.y > 1.0) {
    return 1.0; // No shadow outside map
  }
  
  // Slope-scaled bias
  float NdotL = max(dot(normal, lightDir), 0.0);
  float bias = 0.0005 + 0.002 * (1.0 - NdotL);
  
  float currentDepth = projCoords.z;
  
  // PCF: sample 3x3 around current position
  float shadow = 0.0;
  vec2 texelSize = vec2(1.0 / 2048.0);
  
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec4 packedDepth = texture(uShadowMap, projCoords.xy + vec2(x, y) * texelSize);
      float sampledDepth = unpackDepth(packedDepth);
      shadow += (currentDepth - bias) > sampledDepth ? 0.0 : 1.0;
    }
  }
  shadow /= 9.0;
  
  return shadow;
}
`;

/**
 * Lighting uniform declarations (common for sun mode)
 */
export const lightingUniforms = `
// Lighting uniforms
uniform vec3 uLightDir;
uniform float uAmbientIntensity;
uniform vec3 uLightColor;
uniform int uLightMode; // 0 = sun, 1 = HDR
`;

/**
 * Terrain blend functions for fragment shader
 * Samples scene depth and computes blend factor at intersections
 */
export const terrainBlendFunctions = `
// Linearize depth from depth buffer [0,1] to view-space Z
float linearizeDepth(float depth) {
  float z = depth * 2.0 - 1.0; // Back to NDC
  return (2.0 * uNearPlane * uFarPlane) / (uFarPlane + uNearPlane - z * (uFarPlane - uNearPlane));
}

// Calculate terrain blend factor based on depth difference
// Returns 1.0 at intersection, fading to 0.0 at blendDistance
float calcTerrainBlendFactor(float fragmentDepth) {
  if (uTerrainBlendEnabled == 0) {
    return 0.0;
  }
  
  // Sample scene depth at current fragment position
  vec2 screenUV = gl_FragCoord.xy / uScreenSize;
  float sceneDepth = texture(uSceneDepthTexture, screenUV).r;
  
  // Linearize both depths
  float linearScene = linearizeDepth(sceneDepth);
  float linearFragment = linearizeDepth(fragmentDepth);
  
  // Calculate depth difference (positive = fragment behind scene)
  float depthDiff = abs(linearScene - linearFragment);
  
  // Blend factor: 1.0 at intersection, 0.0 beyond blend distance
  float blendFactor = 1.0 - smoothstep(0.0, uTerrainBlendDistance, depthDiff);
  
  return blendFactor;
}

// Apply terrain blend to fragment color
// Fades alpha based on proximity to other surfaces
vec4 applyTerrainBlend(vec4 color, float fragmentDepth) {
  float blend = calcTerrainBlendFactor(fragmentDepth);
  
  // Soft fade at intersections
  color.a *= (1.0 - blend * 0.8);
  
  return color;
}
`;
