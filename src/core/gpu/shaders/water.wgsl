// Water Rendering Shader v2
// High-quality water with atmospheric reflections, sharp sun highlights, and organic waves
// Based on techniques from shadertoy.com/view/Ms2SD1

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;
const DRAG_MULT: f32 = 0.28;  // How much waves pull on the water position
const WAVE_ITERATIONS_VS: i32 = 8;   // Vertex shader iterations (for displacement)
const WAVE_ITERATIONS_FS: i32 = 24;  // Fragment shader iterations (for normals)

// ============================================================================
// Uniform Structures
// ============================================================================

struct Uniforms {
  viewProjectionMatrix: mat4x4f,  // 0-15 (64 bytes)
  modelMatrix: mat4x4f,           // 16-31 (64 bytes)
  cameraPositionTime: vec4f,      // 32-35: xyz = camera position, w = time
  params: vec4f,                  // 36-39: x = terrainSize, y = waterLevel, z = heightScale, w = sunIntensity
}

struct WaterMaterial {
  sunDirection: vec4f,            // 0-3: xyz = normalized sun dir, w = unused
  scatterColor: vec4f,            // 4-7: subsurface scattering color (deep water tint)
  foamColor: vec4f,               // 8-11: shoreline foam color
  params1: vec4f,                 // 12-15: x = waveScale, y = foamThreshold, z = fresnelPower, w = opacity
  params2: vec4f,                 // 16-19: x = ambientIntensity, y = depthFalloff, z = unused, w = unused
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> material: WaterMaterial;
@group(0) @binding(2) var depthTexture: texture_depth_2d;
@group(0) @binding(3) var texSampler: sampler;

// ============================================================================
// Vertex Structures
// ============================================================================

struct VertexInput {
  @location(0) position: vec2f,   // XZ position on unit quad [-0.5, 0.5]
  @location(1) uv: vec2f,         // UV coordinates [0, 1]
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) texCoord: vec2f,
  @location(2) viewDir: vec3f,
  @location(3) distanceToCamera: f32,
}

// ============================================================================
// Exponential Wave with Position Drag
// ============================================================================

// Single wave octave - returns (height, derivative)
fn waveDx(position: vec2f, direction: vec2f, frequency: f32, timeShift: f32) -> vec2f {
  let x = dot(direction, position) * frequency + timeShift;
  let wave = exp(sin(x) - 1.0);  // Sharp peaks, range ~[0, 1]
  let dx = wave * cos(x);         // Derivative for position drag
  return vec2f(wave, -dx);
}

// Sum multiple wave octaves with position dragging
fn getWaves(inputPos: vec2f, iterations: i32, time: f32) -> f32 {
  var pos = inputPos;
  let wavePhaseShift = length(inputPos) * 0.1;  // Avoid identical phases
  var iter = 0.0;
  var frequency = 1.0;
  var timeMultiplier = 2.0;
  var weight = 1.0;
  var sumOfValues = 0.0;
  var sumOfWeights = 0.0;
  
  for (var i = 0; i < iterations; i++) {
    // Pseudo-random wave direction from iteration
    let p = vec2f(sin(iter), cos(iter));
    
    // Calculate wave value and derivative
    let res = waveDx(pos, p, frequency, time * timeMultiplier + wavePhaseShift);
    
    // Position drag - each wave affects sampling position for subsequent waves
    pos += p * res.y * weight * DRAG_MULT;
    
    // Accumulate weighted result
    sumOfValues += res.x * weight;
    sumOfWeights += weight;
    
    // Modify parameters for next octave
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;  // Large prime-ish number for randomness
  }
  
  return sumOfValues / sumOfWeights;
}

// Gerstner wave for vertex displacement (physically-based)
fn gerstnerWave(pos: vec2f, dir: vec2f, steepness: f32, wavelength: f32, time: f32) -> vec3f {
  let k = 2.0 * PI / wavelength;
  let c = sqrt(9.8 / k);
  let d = normalize(dir);
  let f = k * (dot(d, pos) - c * time);
  let a = steepness / k;
  
  return vec3f(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

// Vertex displacement using Gerstner waves
fn getVertexDisplacement(worldXZ: vec2f, time: f32, waveScale: f32) -> vec3f {
  var disp = vec3f(0.0);
  
  // Large primary swell
  disp += gerstnerWave(worldXZ * 0.02, vec2f(1.0, 0.3), 0.3 * waveScale, 60.0, time);
  // Secondary cross swell
  disp += gerstnerWave(worldXZ * 0.02, vec2f(-0.5, 0.7), 0.2 * waveScale, 40.0, time * 1.1);
  // Medium waves
  disp += gerstnerWave(worldXZ * 0.05, vec2f(0.3, -0.8), 0.15 * waveScale, 25.0, time * 0.9);
  
  return disp;
}

// ============================================================================
// Normal Calculation (using exponential waves for detail)
// ============================================================================

fn getNormal(pos: vec2f, epsilon: f32, time: f32, iterations: i32) -> vec3f {
  let h = getWaves(pos, iterations, time);
  let hx = getWaves(pos + vec2f(epsilon, 0.0), iterations, time);
  let hz = getWaves(pos + vec2f(0.0, epsilon), iterations, time);
  
  // Calculate tangent vectors
  let tangentX = vec3f(epsilon, hx - h, 0.0);
  let tangentZ = vec3f(0.0, hz - h, epsilon);
  
  return normalize(cross(tangentZ, tangentX));
}

// ============================================================================
// Atmosphere Approximation (fast, from reference)
// ============================================================================

fn cheapAtmosphere(rayDir: vec3f, sunDir: vec3f) -> vec3f {
  // Trick to avoid division by zero at horizon
  let special1 = 1.0 / (rayDir.y * 1.0 + 0.1);
  let special2 = 1.0 / (sunDir.y * 11.0 + 1.0);
  
  let raySunDot = pow(abs(dot(sunDir, rayDir)), 2.0);
  let sunDot = pow(max(0.0, dot(sunDir, rayDir)), 8.0);
  let mie = sunDot * special1 * 0.2;
  
  // Sun color shifts orange at low angles
  let sunColor = mix(vec3f(1.0), max(vec3f(0.0), vec3f(1.0) - vec3f(5.5, 13.0, 22.4) / 22.4), special2);
  let blueSky = vec3f(5.5, 13.0, 22.4) / 22.4 * sunColor;
  var blueSky2 = max(vec3f(0.0), blueSky - vec3f(5.5, 13.0, 22.4) * 0.002 * (special1 + -6.0 * sunDir.y * sunDir.y));
  blueSky2 *= special1 * (0.24 + raySunDot * 0.24);
  
  // Increase brightness near horizon
  return blueSky2 * (1.0 + 1.0 * pow(1.0 - rayDir.y, 3.0));
}

// Sun disk and glow
fn getSun(rayDir: vec3f, sunDir: vec3f, intensity: f32) -> f32 {
  let sunDot = max(0.0, dot(rayDir, sunDir));
  // Very sharp sun disk
  let disk = pow(sunDot, 720.0) * 210.0;
  // Softer glow around sun
  let glow = pow(sunDot, 8.0) * 0.5;
  return (disk + glow) * intensity;
}

// ============================================================================
// Simple hash for foam noise
// ============================================================================

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  
  return mix(
    mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x),
    mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}

fn foamNoise(p: vec2f, time: f32) -> f32 {
  var n = 0.0;
  n += noise(p * 0.5 + time * 0.1) * 0.5;
  n += noise(p * 1.0 - time * 0.15) * 0.3;
  n += noise(p * 2.0 + time * 0.2) * 0.2;
  return n;
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  let terrainSize = uniforms.params.x;
  let waterLevel = uniforms.params.y;
  let time = uniforms.cameraPositionTime.w;
  let cameraPosition = uniforms.cameraPositionTime.xyz;
  let waveScale = material.params1.x;
  
  // Scale unit quad to terrain size
  let worldXZ = input.position * terrainSize;
  
  // Get Gerstner displacement for vertex animation
  let disp = getVertexDisplacement(worldXZ, time, waveScale);
  
  // Final world position
  let worldPos = uniforms.modelMatrix * vec4f(
    worldXZ.x + disp.x,
    waterLevel + disp.y,
    worldXZ.y + disp.z,
    1.0
  );
  
  output.clipPosition = uniforms.viewProjectionMatrix * worldPos;
  output.worldPosition = worldPos.xyz;
  output.texCoord = input.uv;
  output.viewDir = normalize(cameraPosition - worldPos.xyz);
  output.distanceToCamera = length(cameraPosition - worldPos.xyz);
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let waterLevel = uniforms.params.y;
  let heightScale = uniforms.params.z;
  let sunIntensity = uniforms.params.w;
  let time = uniforms.cameraPositionTime.w;
  let waveScale = material.params1.x;
  let foamThreshold = material.params1.y;
  let fresnelPower = material.params1.z;
  let opacity = material.params1.w;
  let ambientIntensity = material.params2.x;
  let depthFalloff = material.params2.y;
  
  let sunDir = normalize(material.sunDirection.xyz);
  let viewDir = normalize(input.viewDir);
  
  // ===== Wave Normal Calculation =====
  // Use exponential waves with position drag for detailed normals
  let normalScale = 0.01;  // Scale world position for wave sampling
  var N = getNormal(input.worldPosition.xz * normalScale, 0.01, time, WAVE_ITERATIONS_FS);
  
  // Smooth normals with distance (avoid noise at distance)
  let distFactor = min(1.0, sqrt(input.distanceToCamera * 0.001) * 0.8);
  N = normalize(mix(N, vec3f(0.0, 1.0, 0.0), distFactor));
  
  // ===== Fresnel =====
  let NdotV = max(0.0, dot(N, viewDir));
  let fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, fresnelPower);
  
  // ===== Reflection =====
  var R = normalize(reflect(-viewDir, N));
  R.y = abs(R.y);  // Ensure reflection points upward
  
  // Sky reflection
  let skyColor = cheapAtmosphere(R, sunDir);
  let sunReflection = getSun(R, sunDir, sunIntensity);
  let reflection = skyColor + vec3f(1.0, 0.95, 0.9) * sunReflection;
  
  // ===== Subsurface Scattering =====
  // Approximate light penetrating and scattering through water
  let depthFactor = (input.worldPosition.y - waterLevel + 1.0) / 2.0;  // Normalize to ~[0,1]
  let scattering = material.scatterColor.rgb * (0.2 + depthFactor * 0.3);
  
  // ===== Water Depth (for shore effects) =====
  let sceneDepth = textureLoad(depthTexture, vec2i(input.clipPosition.xy), 0);
  let waterDepth = input.clipPosition.z / input.clipPosition.w;
  let depthDiff = max(sceneDepth - waterDepth, 0.0) * heightScale * 10.0;
  let shoreBlend = 1.0 - exp(-depthDiff * depthFalloff);
  
  // ===== Shore Foam =====
  let foamPattern = foamNoise(input.worldPosition.xz * 0.3, time);
  let shoreFoam = smoothstep(foamThreshold, 0.0, depthDiff) * foamPattern;
  
  // ===== Final Color Composition =====
  // Blend reflection and scattering based on fresnel
  var finalColor = fresnel * reflection + (1.0 - fresnel * 0.5) * scattering;
  
  // Add ambient
  finalColor += vec3f(0.02, 0.04, 0.06) * ambientIntensity;
  
  // Mix in shore foam
  finalColor = mix(finalColor, material.foamColor.rgb, shoreFoam * 0.8);
  
  // ===== Alpha =====
  // More opaque at depth, more transparent at shores
  let alpha = mix(opacity * 0.4, opacity, shoreBlend) + fresnel * 0.2;
  
  return vec4f(finalColor, clamp(alpha, 0.0, 0.95));
}
