// Terrain Heightmap Generation Compute Shader
// Generates heightmap using fBm (fractional Brownian motion) noise

// Noise generation outputs NORMALIZED heights in range [-0.5, 0.5]
// Actual terrain heightScale is applied at render time via TerrainManager.config.heightScale
// This separation allows:
// - Consistent heightmap generation regardless of final scale
// - Runtime adjustment of terrain height without regeneration
// - Single source of truth for heightScale in TerrainManager

struct GenerationParams {
  offset: vec2f,        // World offset for seamless tiling
  scale: vec2f,         // Scale factor for noise sampling
  octaves: u32,         // Number of noise octaves
  persistence: f32,     // Amplitude multiplier per octave (typically 0.5)
  lacunarity: f32,      // Frequency multiplier per octave (typically 2.0)
  seed: f32,            // Random seed for variation
  
  // Domain warping parameters
  warpStrength: f32,    // How much to warp the domain (0-2)
  warpScale: f32,       // Scale of warp noise
  warpOctaves: u32,     // Octaves for warp noise
  
  // Ridge/FBM blending
  ridgeWeight: f32,     // Blend between fbm (0) and ridged (1)
  
  // Octave rotation (reduces grid artifacts)
  rotateOctaves: u32,   // 0 = no rotation, 1 = rotate
  octaveRotation: f32,  // Rotation angle in degrees per octave
  
  _pad0: f32,           // Padding for vec4 alignment
  _pad1: f32,           // Padding for vec4 alignment
}

@group(0) @binding(0) var<uniform> params: GenerationParams;
@group(0) @binding(1) var outputHeightmap: texture_storage_2d<r32float, write>;

// ============================================================================
// Noise Functions
// ============================================================================

// Simple hash function for pseudo-random values
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D hash returning vec2
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Gradient noise (Perlin-like)
fn gradientNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  
  // Quintic interpolation curve
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  
  // Four corners
  let a = hash2(i + vec2f(0.0, 0.0));
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  
  // Bilinear interpolation
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Value noise with smooth interpolation
fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  
  // Cubic Hermite interpolation
  let u = f * f * (3.0 - 2.0 * f);
  
  let a = hash2(i + vec2f(0.0, 0.0));
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Simplex-like noise (faster than true simplex)
fn simplexNoise(p: vec2f) -> f32 {
  let K1: f32 = 0.366025404; // (sqrt(3)-1)/2
  let K2: f32 = 0.211324865; // (3-sqrt(3))/6
  
  let i = floor(p + (p.x + p.y) * K1);
  let a = p - i + (i.x + i.y) * K2;
  let o = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), a.x > a.y);
  let b = a - o + K2;
  let c = a - 1.0 + 2.0 * K2;
  
  var h = max(0.5 - vec3f(dot(a, a), dot(b, b), dot(c, c)), vec3f(0.0));
  h = h * h * h * h;
  
  let n = vec3f(
    dot(a, hash22(i) - 0.5),
    dot(b, hash22(i + o) - 0.5),
    dot(c, hash22(i + 1.0) - 0.5)
  );
  
  return dot(h, n) * 70.0;
}

// ============================================================================
// Utility Functions
// ============================================================================

// Rotate a 2D vector by angle in radians
fn rotate2D(p: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Get seed offset for consistent random variation
fn getSeedOffset() -> vec2f {
  let normalizedSeed = fract(params.seed * 0.0001) * 1000.0;
  return vec2f(
    fract(normalizedSeed * 0.1731) * 100.0,
    fract(normalizedSeed * 0.4317) * 100.0
  );
}

// ============================================================================
// Fractal Brownian Motion (fBm) with octave rotation
// ============================================================================

fn fbmWithRotation(p: vec2f, octaves: u32) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var totalAmplitude: f32 = 0.0;
  
  var pos = p + getSeedOffset();
  
  // Octave rotation angle in radians
  let rotationRad = params.octaveRotation * 3.14159265359 / 180.0;
  
  for (var i: u32 = 0u; i < octaves; i++) {
    value += amplitude * valueNoise(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
    
    // Rotate position for next octave to reduce grid artifacts
    if (params.rotateOctaves > 0u) {
      pos = rotate2D(pos, rotationRad);
    }
  }
  
  return value / totalAmplitude;
}

// Simple FBM using params.octaves
fn fbm(p: vec2f) -> f32 {
  return fbmWithRotation(p, params.octaves);
}

// FBM with custom octave count (for warp noise)
fn fbmOctaves(p: vec2f, octaves: u32) -> f32 {
  return fbmWithRotation(p, octaves);
}

// Ridged multifractal noise with octave rotation - creates sharper peaks
fn ridgedFbm(p: vec2f) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var weight: f32 = 1.0;
  
  var pos = p + getSeedOffset();
  
  // Octave rotation angle in radians
  let rotationRad = params.octaveRotation * 3.14159265359 / 180.0;
  
  for (var i: u32 = 0u; i < params.octaves; i++) {
    var signal = valueNoise(pos * frequency);
    signal = 1.0 - abs(signal * 2.0 - 1.0); // Create ridges
    signal = signal * signal; // Square for sharper ridges
    signal *= weight;
    weight = saturate(signal * 2.0);
    
    value += signal * amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
    
    // Rotate position for next octave
    if (params.rotateOctaves > 0u) {
      pos = rotate2D(pos, rotationRad);
    }
  }
  
  return value * 0.5; // Normalize
}

// Billowy noise - softer undulating terrain
fn billowyFbm(p: vec2f) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var totalAmplitude: f32 = 0.0;
  
  // Apply seed offset - normalize seed to avoid float precision loss at large coordinates
  let normalizedSeed = fract(params.seed * 0.0001) * 1000.0;
  let seedOffset = vec2f(
    fract(normalizedSeed * 0.1731) * 100.0,
    fract(normalizedSeed * 0.4317) * 100.0
  );
  var pos = p + seedOffset;
  
  for (var i: u32 = 0u; i < params.octaves; i++) {
    var signal = valueNoise(pos * frequency);
    signal = abs(signal * 2.0 - 1.0); // Create billows
    
    value += signal * amplitude;
    totalAmplitude += amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  
  return value / totalAmplitude;
}

// Domain warping for more organic terrain (configurable)
fn warpedFbm(p: vec2f) -> f32 {
  var pos = p + getSeedOffset();
  
  // Early out if no warping
  if (params.warpStrength <= 0.0) {
    // Still blend with ridged if requested
    let fbmVal = fbm(pos);
    let ridgeVal = ridgedFbm(pos);
    return mix(fbmVal, ridgeVal, params.ridgeWeight);
  }
  
  // Use configurable warp scale for first warp
  let warpPos = pos * params.warpScale;
  
  // First warp layer using warpOctaves
  let q = vec2f(
    fbmOctaves(warpPos, params.warpOctaves),
    fbmOctaves(warpPos + vec2f(5.2, 1.3), params.warpOctaves)
  );
  
  // Apply first warp with configurable strength
  let warpedPos = pos + q * params.warpStrength;
  
  // Generate base noise at warped position
  let fbmVal = fbm(warpedPos);
  let ridgeVal = ridgedFbm(warpedPos);
  
  // Blend between fbm and ridged based on ridgeWeight
  return mix(fbmVal, ridgeVal, params.ridgeWeight);
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================

// Single unified entry point using warpedFbm which handles all noise types:
// - warpStrength = 0, ridgeWeight = 0 → Pure FBM
// - warpStrength = 0, ridgeWeight = 1 → Pure Ridged
// - warpStrength > 0 → Domain warped noise
// - ridgeWeight blends between FBM and Ridged styles
// - islandEnabled > 0 → Apply island mask for organic coastlines
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(outputHeightmap);
  
  // Bounds check
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  // Calculate UV coordinates [0, 1]
  let uv = vec2f(f32(globalId.x), f32(globalId.y)) / vec2f(f32(dims.x - 1u), f32(dims.y - 1u));
  
  // Calculate world position (scaled by noise scale params)
  let worldPos = params.offset + uv * params.scale;
  
  // Generate NORMALIZED height using configurable warped FBM
  // Output range: [-0.5, 0.5] (centered around 0)
  // Island masking is handled separately by CDLOD shader using island mask texture
  let height = warpedFbm(worldPos) - 0.5;
  
  // Write to output texture
  textureStore(outputHeightmap, vec2i(globalId.xy), vec4f(height, 0.0, 0.0, 1.0));
}
