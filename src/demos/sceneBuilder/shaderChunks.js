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
