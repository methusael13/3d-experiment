// Water Rendering Shader v3
// High-quality water with Gerstner waves, analytical normals, atmospheric reflections
// Pure Gerstner implementation for consistent displacement and lighting

// ============================================================================
// Constants
// ============================================================================

const PI: f32 = 3.14159265359;

// Blend factor for shallow water color tint (artistic control)
// 0.0 = only deep color, 1.0 = full shallow→deep gradient
const WATER_COLOR_BLEND: f32 = 0.4;

// ============================================================================
// Uniform Structures
// ============================================================================

struct Uniforms {
  viewProjectionMatrix: mat4x4f,  // 0-15 (64 bytes)
  modelMatrix: mat4x4f,           // 16-31 (64 bytes)
  cameraPositionTime: vec4f,      // 32-35: xyz = camera position, w = time
  params: vec4f,                  // 36-39: x = terrainSize, y = waterLevel, z = heightScale, w = sunIntensity
  gridCenter: vec4f,              // 40-43: xy = center XZ in world coords, zw = unused
  gridScale: vec4f,               // 44-47: xy = scale XZ in world units, z = near, w = far
}

struct WaterMaterial {
  sunDirection: vec4f,            // 0-3: xyz = normalized sun dir, w = unused
  waterColor: vec4f,              // 4-7: shallow water tint (artistic)
  scatterColor: vec4f,            // 8-11: subsurface scattering color (deep water tint)
  foamColor: vec4f,               // 12-15: shoreline foam color
  params1: vec4f,                 // 16-19: x = waveScale, y = foamThreshold, z = fresnelPower, w = opacity
  params2: vec4f,                 // 20-23: x = ambientIntensity, y = depthFalloff, z = wavelength, w = detailStrength
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
  @location(0) position: vec2f,   // XZ position on unit quad [0, 1]
  @location(1) uv: vec2f,         // UV coordinates [0, 1]
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) texCoord: vec2f,
  @location(2) viewDir: vec3f,
  @location(3) distanceToCamera: f32,
  @location(4) gerstnerNormal: vec3f,  // Analytically computed normal from Gerstner waves
}

// ============================================================================
// Gerstner Wave Result Structure
// ============================================================================

struct GerstnerResult {
  displacement: vec3f,
  binormal: vec3f,
  tangent: vec3f,
}

// ============================================================================
// Gerstner Wave with Analytical Normal Derivatives
// ============================================================================

// Single Gerstner wave that returns displacement AND tangent/binormal for normal calculation
fn gerstnerWaveWithDerivatives(pos: vec2f, dir: vec2f, steepness: f32, wavelength: f32, time: f32) -> GerstnerResult {
  var result: GerstnerResult;
  
  let k = 2.0 * PI / wavelength;
  let c = sqrt(9.8 / k);  // Phase velocity from dispersion relation
  let d = normalize(dir);
  let f = k * (dot(d, pos) - c * time);
  let a = steepness / k;  // Amplitude
  
  let sinF = sin(f);
  let cosF = cos(f);
  
  // Displacement: x and z are horizontal, y is vertical
  result.displacement = vec3f(
    d.x * a * cosF,
    a * sinF,
    d.y * a * cosF
  );
  
  // Binormal (partial derivative with respect to x)
  // dP/dx = (1 - steepness * d.x * d.x * sin(f), steepness * d.x * cos(f), -steepness * d.x * d.y * sin(f))
  result.binormal = vec3f(
    1.0 - steepness * d.x * d.x * sinF,
    steepness * d.x * cosF,
    -steepness * d.x * d.y * sinF
  );
  
  // Tangent (partial derivative with respect to z)
  // dP/dz = (-steepness * d.x * d.y * sin(f), steepness * d.y * cos(f), 1 - steepness * d.y * d.y * sin(f))
  result.tangent = vec3f(
    -steepness * d.x * d.y * sinF,
    steepness * d.y * cosF,
    1.0 - steepness * d.y * d.y * sinF
  );
  
  return result;
}

// Combined displacement and normal from multiple Gerstner waves
fn getGerstnerWaves(worldXZ: vec2f, time: f32, waveScale: f32, baseWavelength: f32) -> GerstnerResult {
  var result: GerstnerResult;
  result.displacement = vec3f(0.0);
  result.binormal = vec3f(1.0, 0.0, 0.0);  // Start with identity
  result.tangent = vec3f(0.0, 0.0, 1.0);
  
  // Derived wavelengths from base
  let wavelength1 = baseWavelength;
  let wavelength2 = baseWavelength * 0.6;
  let wavelength3 = baseWavelength * 0.35;
  let wavelength4 = baseWavelength * 0.2;
  
  // Wave 1: Primary swell (strongest)
  let w1 = gerstnerWaveWithDerivatives(worldXZ, vec2f(1.0, 0.3), 0.25 * waveScale, wavelength1, time);
  result.displacement += w1.displacement;
  result.binormal += w1.binormal - vec3f(1.0, 0.0, 0.0);  // Accumulate delta
  result.tangent += w1.tangent - vec3f(0.0, 0.0, 1.0);
  
  // Wave 2: Secondary cross swell
  let w2 = gerstnerWaveWithDerivatives(worldXZ, vec2f(-0.6, 0.8), 0.18 * waveScale, wavelength2, time * 1.1);
  result.displacement += w2.displacement;
  result.binormal += w2.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w2.tangent - vec3f(0.0, 0.0, 1.0);
  
  // Wave 3: Medium waves
  let w3 = gerstnerWaveWithDerivatives(worldXZ, vec2f(0.4, -0.9), 0.12 * waveScale, wavelength3, time * 0.9);
  result.displacement += w3.displacement;
  result.binormal += w3.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w3.tangent - vec3f(0.0, 0.0, 1.0);
  
  // Wave 4: Small detail waves
  let w4 = gerstnerWaveWithDerivatives(worldXZ, vec2f(-0.8, -0.4), 0.08 * waveScale, wavelength4, time * 1.3);
  result.displacement += w4.displacement;
  result.binormal += w4.binormal - vec3f(1.0, 0.0, 0.0);
  result.tangent += w4.tangent - vec3f(0.0, 0.0, 1.0);
  
  return result;
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
// High-Frequency Normal Detail (Fragment Shader Only)
// ============================================================================

// Gradient noise - returns derivatives for normal mapping
fn gradientNoise(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  
  // Smoothstep for interpolation
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  
  // Hash corners
  let a = hash(i);
  let b = hash(i + vec2f(1.0, 0.0));
  let c = hash(i + vec2f(0.0, 1.0));
  let d = hash(i + vec2f(1.0, 1.0));
  
  // Bilinear interpolation with derivatives
  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = a - b - c + d;
  
  let value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  let dx = du.x * (k1 + k3 * u.y);
  let dy = du.y * (k2 + k3 * u.x);
  
  return vec3f(value, dx, dy);  // value, dvalue/dx, dvalue/dy
}

// Multi-octave detail normal perturbation
// Returns a normal delta to add to the base normal
fn detailNormalPerturbation(worldPos: vec2f, time: f32, baseWavelength: f32, strength: f32) -> vec3f {
  if (strength <= 0.001) {
    return vec3f(0.0);
  }
  
  var normalDelta = vec3f(0.0);
  
  // Detail octaves at higher frequencies than the geometry waves
  // Base wavelength determines starting scale for details
  let detailScale = 1.0 / (baseWavelength * 0.1);  // Detail starts at 10% of base wavelength
  
  // Octave 1: Medium detail (1/10 of base wavelength)
  let scale1 = detailScale * 1.0;
  let g1 = gradientNoise(worldPos * scale1 + time * 0.5);
  normalDelta.x += g1.y * 0.5;
  normalDelta.z += g1.z * 0.5;
  
  // Octave 2: Fine detail (1/25 of base wavelength)
  let scale2 = detailScale * 2.5;
  let g2 = gradientNoise(worldPos * scale2 - time * 0.3);
  normalDelta.x += g2.y * 0.3;
  normalDelta.z += g2.z * 0.3;
  
  // Octave 3: Very fine detail (1/50 of base wavelength)
  let scale3 = detailScale * 5.0;
  let g3 = gradientNoise(worldPos * scale3 + vec2f(time * 0.2, -time * 0.15));
  normalDelta.x += g3.y * 0.2;
  normalDelta.z += g3.z * 0.2;
  
  return normalDelta * strength;
}

// ============================================================================
// Depth Linearization (Reversed Depth Buffer)
// ============================================================================

// For reversed depth buffer (WebGPU default): z=1 at near, z=0 at far
// Returns linear view-space distance from camera
fn linearizeDepthReversed(d: f32, near: f32, far: f32) -> f32 {
  return near * far / (near + d * (far - near));
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  let waterLevel = uniforms.params.y;
  let time = uniforms.cameraPositionTime.w;
  let cameraPosition = uniforms.cameraPositionTime.xyz;
  let waveScale = material.params1.x;
  let wavelength = material.params2.z;  // Base wavelength from material
  
  // Grid placement: position is [0,1], transform to world space using gridCenter and gridScale
  let gridCenterXZ = uniforms.gridCenter.xy;
  let gridScaleXZ = uniforms.gridScale.xy;
  
  // Convert [0,1] to [-0.5, 0.5] then scale and offset
  let normalizedPos = input.position - vec2f(0.5);
  let worldXZ = gridCenterXZ + normalizedPos * gridScaleXZ;
  
  // Get Gerstner waves with displacement and derivatives for normal
  let gerstner = getGerstnerWaves(worldXZ, time, waveScale, wavelength);
  
  // Final world position
  let worldPos = uniforms.modelMatrix * vec4f(
    worldXZ.x + gerstner.displacement.x,
    waterLevel + gerstner.displacement.y,
    worldXZ.y + gerstner.displacement.z,
    1.0
  );
  
  // Compute normal from tangent and binormal (cross product)
  // Order matters: cross(tangent, binormal) gives upward normal for flat surface
  // cross((0,0,1), (1,0,0)) = (0, 1, 0) = upward
  let normal = normalize(cross(gerstner.tangent, gerstner.binormal));
  
  output.clipPosition = uniforms.viewProjectionMatrix * worldPos;
  output.worldPosition = worldPos.xyz;
  output.texCoord = input.uv;
  output.viewDir = normalize(cameraPosition - worldPos.xyz);
  output.distanceToCamera = length(cameraPosition - worldPos.xyz);
  output.gerstnerNormal = normal;
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let waterLevel = uniforms.params.y;
  let sunIntensity = uniforms.params.w;
  let time = uniforms.cameraPositionTime.w;
  let near = uniforms.gridScale.z;
  let far = uniforms.gridScale.w;
  let foamThreshold = material.params1.y;
  let fresnelPower = material.params1.z;
  let opacity = material.params1.w;
  let ambientIntensity = material.params2.x;
  let depthFalloff = material.params2.y;
  
  let sunDir = normalize(material.sunDirection.xyz);
  let viewDir = normalize(input.viewDir);
  
  // ===== Wave Normal from Gerstner (computed in vertex shader) =====
  // Smooth normals with distance (avoid aliasing at distance)
  let distFactor = min(1.0, sqrt(input.distanceToCamera * 0.002) * 0.7);
  var N = normalize(mix(input.gerstnerNormal, vec3f(0.0, 1.0, 0.0), distFactor));
  
  // ===== High-Frequency Detail Normal (Fragment Shader) =====
  // Add procedural detail that's independent of mesh resolution
  let detailStrength = material.params2.w;
  let wavelength = material.params2.z;
  
  // Detail fades with distance to prevent aliasing
  let detailFade = 1.0 - min(1.0, input.distanceToCamera * 0.003);
  let detailDelta = detailNormalPerturbation(
    input.worldPosition.xz, 
    time, 
    wavelength, 
    detailStrength * detailFade
  );
  
  // Perturb the normal with detail
  N = normalize(N + vec3f(detailDelta.x, 0.0, detailDelta.z));
  
  // ===== Fresnel =====
  // Schlick's approximation with smoothstep for softer edge transition
  let NdotV = max(0.0, dot(N, viewDir));
  let rawFresnel = pow(1.0 - NdotV, fresnelPower);
  // Smoothstep creates a softer transition avoiding the sharp pow() edge
  let fresnel = 0.02 + 0.98 * smoothstep(0.0, 1.0, rawFresnel);
  
  // ===== Reflection =====
  var R = normalize(reflect(-viewDir, N));
  R.y = abs(R.y);  // Ensure reflection points upward
  
  // Sky reflection
  let skyColor = cheapAtmosphere(R, sunDir);
  let sunReflection = getSun(R, sunDir, sunIntensity);
  let reflection = skyColor + vec3f(1.0, 0.95, 0.9) * sunReflection;
  
  // ===== Water Depth Calculation (Linearized) =====
  // Get NDC depths (both in [0,1], reversed depth: 1=near, 0=far)
  let sceneDepthNDC = textureLoad(depthTexture, vec2i(input.clipPosition.xy), 0);
  let waterDepthNDC = input.clipPosition.z;  // Already in [0,1], no /w needed
  
  // Linearize to view-space distances (world units from camera)
  let sceneLinear = linearizeDepthReversed(sceneDepthNDC, near, far);
  let waterLinear = linearizeDepthReversed(waterDepthNDC, near, far);
  
  // Water depth in world units (distance through water to terrain)
  let rawWaterDepth = max(sceneLinear - waterLinear, 0.0);
  
  // Detect "open ocean" (no terrain underneath - depth buffer shows far plane)
  // In reversed depth: 0 = far plane, so very small values indicate sky/no geometry
  let isOpenOcean = sceneDepthNDC < 0.0001;  // Near far plane = open ocean
  
  // Cap water depth for color calculations to prevent over-absorption
  // Beyond ~30m, treat as "deep enough" - this prevents black water in open ocean
  let maxColorDepth = 30.0;
  let waterDepthMeters = select(min(rawWaterDepth, maxColorDepth), maxColorDepth, isOpenOcean);
  
  // ===== Subsurface Scattering (Beer-Lambert Absorption) =====
  // Light absorption increases exponentially with depth
  // absorptionCoeff ~0.1 gives reasonable falloff (50% at ~7m, 90% at ~23m)
  let absorptionCoeff = depthFalloff * 0.05;  // Use depthFalloff to control absorption rate
  let transmittance = exp(-waterDepthMeters * absorptionCoeff);
  
  // Blend shallow (waterColor) to deep (scatterColor) based on depth
  // transmittance: 1 at surface (shallow color), 0 at depth (deep color)
  // Note: deep color is the TARGET, not something we absorb through to black
  let waterTint = mix(material.scatterColor.rgb, material.waterColor.rgb, transmittance);
  
  // Shore blend based on actual depth
  let shoreBlend = 1.0 - transmittance;  // Reuse transmittance for consistency
  
  // ===== Shore Foam =====
  // Foam appears within foamThreshold meters of shore (world units)
  // foamThreshold: 0 = no foam, 2-5 = typical shore foam range
  let foamPattern = foamNoise(input.worldPosition.xz * 0.3, time);
  let foamFade = 1.0 - saturate(waterDepthMeters / max(foamThreshold, 0.001));
  let shoreFoam = select(0.0, foamFade * foamPattern, foamThreshold > 0.0);
  
  // ===== Final Color Composition =====
  // Balanced blend: water tint is base color, reflection is added on top via fresnel
  // - At steep angles (looking down): fresnel ~0.02, mostly water tint visible
  // - At glancing angles (horizon): fresnel ~1.0, mostly reflection visible
  // The 0.4 reflection multiplier ensures water tint shows through even at glancing angles
  var finalColor = mix(waterTint, reflection, fresnel * 0.4) + fresnel * reflection * 0.3;
  
  // Add ambient (slightly stronger for deep ocean richness)
  finalColor += vec3f(0.02, 0.04, 0.08) * ambientIntensity;
  
  // Mix in shore foam
  finalColor = mix(finalColor, material.foamColor.rgb, shoreFoam * 0.8);
  
  // ===== Alpha =====
  // Deep ocean mode: use high base opacity everywhere, only reduce slightly at very shallow shores
  // transmittance is 1.0 at surface, 0.0 at depth - we want OPPOSITE behavior for opacity
  // shoreBlend (1 - transmittance) is high for deep water, low for shore
  // Minimum alpha of 0.7 ensures water is never too transparent
  let minAlpha = 0.7;
  let baseAlpha = max(opacity, minAlpha);
  // Only reduce alpha at very shallow shores (within 2m depth) for soft edge
  let shoreEdgeFade = saturate(waterDepthMeters / 2.0);
  let alpha = mix(minAlpha, baseAlpha, shoreEdgeFade) + fresnel * 0.15;
  
  // Output pre-multiplied alpha for waterMask blend state:
  // - RGB is pre-multiplied by alpha for correct color blending
  // - Alpha value is used by blend state to clear destination alpha
  //   (marking water pixels for SSAO exclusion in composite pass)
  return vec4f(finalColor * alpha, alpha);
}
