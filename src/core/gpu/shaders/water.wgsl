// Water Rendering Shader
// Stylized water surface with animated waves, Fresnel effect, and depth-based transparency
// Designed to render after terrain as a transparent overlay

// ============================================================================
// Uniform Structures
// ============================================================================

struct Uniforms {
  viewProjectionMatrix: mat4x4f,  // 0-15
  modelMatrix: mat4x4f,           // 16-31
  cameraPosition: vec3f,          // 32-34
  time: f32,                      // 35 - animation time in seconds
  terrainSize: f32,               // 36 - size of terrain in world units
  waterLevel: f32,                // 37 - Y position of water surface
  heightScale: f32,               // 38 - terrain height scale for depth calc
  _pad0: f32,                     // 39
}

struct WaterMaterial {
  waterColor: vec4f,              // 0-3 (rgb + alpha)
  deepColor: vec4f,               // 4-7 (color at max depth)
  lightDir: vec3f,                // 8-10
  waveScale: f32,                 // 11 - scale of wave animation
  lightColor: vec3f,              // 12-14
  specularPower: f32,             // 15 - shininess for specular
  foamColor: vec3f,               // 16-18
  foamThreshold: f32,             // 19 - depth threshold for foam
  ambientIntensity: f32,          // 20
  opacity: f32,                   // 21 - base opacity
  fresnelPower: f32,              // 22 - fresnel exponent
  depthFalloff: f32,              // 23 - how quickly water becomes opaque with depth
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
  @location(3) normal: vec3f,
}

// ============================================================================
// Wave Functions
// ============================================================================

// Gerstner wave function - creates realistic ocean-like waves
fn gerstnerWave(pos: vec2f, dir: vec2f, steepness: f32, wavelength: f32, time: f32) -> vec3f {
  let k = 2.0 * 3.14159 / wavelength;
  let c = sqrt(9.8 / k);  // Wave speed from gravity
  let d = normalize(dir);
  let f = k * (dot(d, pos) - c * time);
  let a = steepness / k;
  
  return vec3f(
    d.x * a * cos(f),
    a * sin(f),
    d.y * a * cos(f)
  );
}

// Calculate wave displacement and normal at a position
fn calculateWaves(worldXZ: vec2f, time: f32, waveScale: f32) -> vec4f {
  var displacement = vec3f(0.0);
  
  // Multiple wave layers with different directions, wavelengths, and steepness
  // Wave 1: Primary swell
  displacement += gerstnerWave(worldXZ, vec2f(1.0, 0.3), 0.15 * waveScale, 30.0, time);
  
  // Wave 2: Secondary swell
  displacement += gerstnerWave(worldXZ, vec2f(-0.5, 0.7), 0.1 * waveScale, 20.0, time * 1.1);
  
  // Wave 3: Cross wave
  displacement += gerstnerWave(worldXZ, vec2f(0.3, -0.8), 0.08 * waveScale, 15.0, time * 0.9);
  
  // Wave 4: Small ripples
  displacement += gerstnerWave(worldXZ, vec2f(0.8, 0.6), 0.04 * waveScale, 8.0, time * 1.3);
  
  // Wave 5: Tiny detail waves
  displacement += gerstnerWave(worldXZ, vec2f(-0.6, -0.4), 0.02 * waveScale, 4.0, time * 1.5);
  
  return vec4f(displacement, 0.0);
}

// Calculate wave normal from displacement derivatives
fn calculateWaveNormal(worldXZ: vec2f, time: f32, waveScale: f32) -> vec3f {
  let epsilon = 0.1;
  
  // Sample wave heights at nearby points
  let h0 = calculateWaves(worldXZ, time, waveScale).y;
  let hx = calculateWaves(worldXZ + vec2f(epsilon, 0.0), time, waveScale).y;
  let hz = calculateWaves(worldXZ + vec2f(0.0, epsilon), time, waveScale).y;
  
  // Calculate tangent vectors
  let tangentX = vec3f(epsilon, hx - h0, 0.0);
  let tangentZ = vec3f(0.0, hz - h0, epsilon);
  
  // Normal is cross product of tangents
  return normalize(cross(tangentZ, tangentX));
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Scale unit quad to terrain size
  let worldXZ = input.position * uniforms.terrainSize;
  
  // Calculate wave displacement
  let waveDisp = calculateWaves(worldXZ, uniforms.time, material.waveScale);
  
  // Final world position with wave displacement
  let worldPos = vec3f(
    worldXZ.x + waveDisp.x,
    uniforms.waterLevel + waveDisp.y,
    worldXZ.y + waveDisp.z
  );
  
  // Transform to clip space
  let mvp = uniforms.viewProjectionMatrix * uniforms.modelMatrix;
  output.clipPosition = mvp * vec4f(worldPos, 1.0);
  
  // Pass world position
  output.worldPosition = (uniforms.modelMatrix * vec4f(worldPos, 1.0)).xyz;
  
  // Texture coordinates
  output.texCoord = input.uv;
  
  // View direction (camera to vertex)
  output.viewDir = normalize(uniforms.cameraPosition - output.worldPosition);
  
  // Calculate wave normal
  output.normal = calculateWaveNormal(worldXZ, uniforms.time, material.waveScale);
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

// Fresnel effect - more reflection at grazing angles
fn fresnelSchlick(cosTheta: f32, F0: f32, power: f32) -> f32 {
  return F0 + (1.0 - F0) * pow(1.0 - cosTheta, power);
}

// Simple pseudo-random for foam noise
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// Value noise for foam pattern
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

// Foam noise pattern
fn foamNoise(p: vec2f, time: f32) -> f32 {
  var n = 0.0;
  n += noise(p * 0.5 + time * 0.1) * 0.5;
  n += noise(p * 1.0 - time * 0.15) * 0.3;
  n += noise(p * 2.0 + time * 0.2) * 0.2;
  return n;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let viewDir = normalize(input.viewDir);
  let lightDir = normalize(material.lightDir);
  
  // ===== Fresnel Effect =====
  let NdotV = max(dot(normal, viewDir), 0.0);
  let fresnel = fresnelSchlick(NdotV, 0.02, material.fresnelPower);
  
  // ===== Water Depth (from screen-space depth) =====
  // Get screen UV from clip position
  let screenUV = input.clipPosition.xy / vec2f(textureDimensions(depthTexture));
  
  // Sample scene depth
  let sceneDepth = textureLoad(depthTexture, vec2i(input.clipPosition.xy), 0);
  let waterDepth = input.clipPosition.z / input.clipPosition.w;
  
  // Calculate linear depth difference (approximate)
  let depthDiff = max(sceneDepth - waterDepth, 0.0) * uniforms.heightScale * 10.0;
  
  // Depth-based opacity (shallow = transparent, deep = opaque)
  let depthFactor = 1.0 - exp(-depthDiff * material.depthFalloff);
  
  // ===== Base Water Color =====
  // Blend between shallow and deep color based on depth
  let baseColor = mix(material.waterColor.rgb, material.deepColor.rgb, depthFactor);
  
  // ===== Lighting =====
  // Diffuse (very subtle for water)
  let NdotL = max(dot(normal, lightDir), 0.0);
  let diffuse = NdotL * 0.3;
  
  // Specular (Blinn-Phong for sun reflection)
  let halfVec = normalize(lightDir + viewDir);
  let NdotH = max(dot(normal, halfVec), 0.0);
  let specular = pow(NdotH, material.specularPower) * fresnel;
  
  // ===== Foam =====
  // Foam appears at shoreline (shallow depth) and on wave crests
  let foamPattern = foamNoise(input.worldPosition.xz * 0.5, uniforms.time);
  let shorelineFoam = smoothstep(material.foamThreshold, 0.0, depthDiff);
  let crestFoam = smoothstep(0.3, 0.5, input.worldPosition.y - uniforms.waterLevel) * 0.3;
  let foamAmount = max(shorelineFoam, crestFoam) * foamPattern;
  
  // ===== Final Color Composition =====
  var finalColor = baseColor;
  
  // Add ambient and diffuse lighting
  finalColor = finalColor * (material.ambientIntensity + diffuse);
  
  // Add specular highlight
  finalColor = finalColor + specular * material.lightColor;
  
  // Mix in foam
  finalColor = mix(finalColor, material.foamColor, foamAmount * 0.7);
  
  // Add fresnel-based sky reflection (simplified - just brighten)
  let skyReflection = vec3f(0.6, 0.8, 1.0);
  finalColor = mix(finalColor, skyReflection, fresnel * 0.4);
  
  // ===== Final Alpha =====
  // Base opacity + depth-based opacity + fresnel reflection
  let alpha = mix(material.opacity * 0.3, material.opacity, depthFactor) + fresnel * 0.3;
  
  // Gamma correction
  finalColor = pow(finalColor, vec3f(1.0 / 2.2));
  
  return vec4f(finalColor, clamp(alpha, 0.0, 0.95));
}
