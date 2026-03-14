// Terrain Rock Layer — Compute Shader
//
// Generates a rock heightmap using ridged multi-fractal noise with
// sedimentary strata banding, slope-dependent detail, and exponential bias.
//
// Algorithm:
//   1. Sample domain-warped ridged fBm for the base shape (jagged ridgelines)
//   2. Apply power sharpening to force noise into thin, sharp ridges
//   3. Add sedimentary strata banding via sin(height * frequency)
//   4. Overlay high-frequency ridged detail masked by local slope
//   5. Apply exponential bias to deepen cracks and exaggerate peaks
//
// Output: r32float heightmap in normalized range, ready for compositing.

struct RockParams {
  // Noise params (matches GenerationParams layout from noise.wgsl)
  offset: vec2f,        // 0-1
  scale: vec2f,         // 2-3
  octaves: u32,         // 4
  persistence: f32,     // 5
  lacunarity: f32,      // 6
  seed: f32,            // 7
  warpStrength: f32,    // 8
  warpScale: f32,       // 9
  warpOctaves: u32,     // 10
  ridgeWeight: f32,     // 11
  rotateOctaves: u32,   // 12
  octaveRotation: f32,  // 13

  // Rock-specific params
  rockSharpness: f32,   // 14  Power exponent for ridge sharpening (1-5)
  strataFrequency: f32, // 15  Horizontal sedimentary banding frequency
  strataStrength: f32,  // 16  How much strata modulates the protrusions
  ridgeExponent: f32,   // 17  Exponential bias for deep cracks / jutting peaks
  detailFrequency: f32, // 18  High-freq ridged detail overlay scale
  detailStrength: f32,  // 19  Amplitude of slope-dependent detail
  heightScale: f32,     // 20  Overall output height multiplier
  _pad0: f32,           // 21
}

@group(0) @binding(0) var<uniform> params: RockParams;
@group(0) @binding(1) var outputHeightmap: texture_storage_2d<r32float, write>;

// ============================================================================
// Noise Functions (duplicated from noise.wgsl for standalone compilation)
// ============================================================================

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i + vec2f(0.0, 0.0));
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn rotate2D(p: vec2f, angle: f32) -> vec2f {
  let c = cos(angle);
  let s = sin(angle);
  return vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
}

fn getSeedOffset() -> vec2f {
  let normalizedSeed = fract(params.seed * 0.0001) * 1000.0;
  return vec2f(
    fract(normalizedSeed * 0.1731) * 100.0,
    fract(normalizedSeed * 0.4317) * 100.0
  );
}

fn fbmWithRotation(p: vec2f, octaves: u32) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var totalAmplitude: f32 = 0.0;
  var pos = p + getSeedOffset();
  let rotationRad = params.octaveRotation * 3.14159265359 / 180.0;

  for (var i: u32 = 0u; i < octaves; i++) {
    value += amplitude * valueNoise(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
    if (params.rotateOctaves > 0u) {
      pos = rotate2D(pos, rotationRad);
    }
  }
  return value / totalAmplitude;
}

fn fbm(p: vec2f) -> f32 {
  return fbmWithRotation(p, params.octaves);
}

fn fbmOctaves(p: vec2f, octaves: u32) -> f32 {
  return fbmWithRotation(p, octaves);
}

// ============================================================================
// Ridged Multi-Fractal Noise
// ============================================================================

fn ridgedFbm(p: vec2f) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var weight: f32 = 1.0;
  var pos = p + getSeedOffset();
  let rotationRad = params.octaveRotation * 3.14159265359 / 180.0;

  for (var i: u32 = 0u; i < params.octaves; i++) {
    var signal = valueNoise(pos * frequency);
    // Ridged: invert absolute value → sharp peaks at zero-crossings
    signal = 1.0 - abs(signal * 2.0 - 1.0);
    // Square for even sharper ridges
    signal = signal * signal;
    // Weight cascading: previous octave's sharp peaks influence next
    signal *= weight;
    weight = saturate(signal * 2.0);
    value += signal * amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
    if (params.rotateOctaves > 0u) {
      pos = rotate2D(pos, rotationRad);
    }
  }
  return value * 0.5;
}

/// Ridged fBm at custom frequency and octave count (for detail overlay)
fn ridgedFbmAt(p: vec2f, freqMul: f32, octaves: u32) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = freqMul;
  var weight: f32 = 1.0;
  var pos = p + getSeedOffset() + vec2f(73.1, 41.7); // offset to decorrelate from base

  for (var i: u32 = 0u; i < octaves; i++) {
    var signal = valueNoise(pos * frequency);
    signal = 1.0 - abs(signal * 2.0 - 1.0);
    signal = signal * signal;
    signal *= weight;
    weight = saturate(signal * 2.0);
    value += signal * amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  return value * 0.5;
}

// ============================================================================
// Domain-Warped Base Noise (ridged + smooth blend via ridgeWeight)
// ============================================================================

fn warpedFbm(p: vec2f) -> f32 {
  var pos = p + getSeedOffset();

  if (params.warpStrength <= 0.0) {
    let fbmVal = fbm(pos);
    let ridgeVal = ridgedFbm(pos);
    return mix(fbmVal, ridgeVal, params.ridgeWeight);
  }

  let warpPos = pos * params.warpScale;
  let q = vec2f(
    fbmOctaves(warpPos, params.warpOctaves),
    fbmOctaves(warpPos + vec2f(5.2, 1.3), params.warpOctaves)
  );
  let warpedPos = pos + q * params.warpStrength;

  let fbmVal = fbm(warpedPos);
  let ridgeVal = ridgedFbm(warpedPos);
  return mix(fbmVal, ridgeVal, params.ridgeWeight);
}

// ============================================================================
// Rock Protrusion — Ridged Strata with Power Sharpening
// ============================================================================

fn applyRockProtrusion(rawHeight: f32, worldPos: vec2f) -> f32 {
  // 1. Power sharpening: forces the noise into thin, sharp ridges
  //    Higher rockSharpness → thinner, more dramatic protrusions
  let sharpened = pow(max(rawHeight, 0.0), params.rockSharpness);

  // 2. Sedimentary strata banding: sin(height * frequency) creates
  //    horizontal layering like real sedimentary rock
  let strata = sin(rawHeight * params.strataFrequency);
  let strataModulation = strata * params.strataStrength * sharpened;

  // 3. Combine: base protrusion + strata variation
  let protrusion = sharpened + strataModulation;

  return protrusion;
}

// ============================================================================
// Slope-Dependent Detail — micro-cracks only on steep faces
// ============================================================================

fn slopeBasedDetail(worldPos: vec2f, baseHeight: f32) -> f32 {
  if (params.detailStrength < 0.001) {
    return 0.0;
  }

  // Cheap slope approximation: sample base noise at small offsets
  let eps = 0.01; // Small offset in UV space
  let hx = warpedFbm(worldPos + vec2f(eps, 0.0));
  let hz = warpedFbm(worldPos + vec2f(0.0, eps));

  // Gradient magnitude (approximates slope)
  let dhdx = (hx - baseHeight) / eps;
  let dhdz = (hz - baseHeight) / eps;
  let slope = sqrt(dhdx * dhdx + dhdz * dhdz);

  // Slope mask: detail is stronger on steep areas, fades on flat
  let slopeMask = smoothstep(0.5, 3.0, slope);

  // High-frequency ridged detail noise
  let detail = ridgedFbmAt(worldPos, params.detailFrequency, 3u);

  return detail * params.detailStrength * slopeMask;
}

// ============================================================================
// Exponential Bias — deepens cracks, exaggerates peaks
// ============================================================================

fn exponentialBias(h: f32) -> f32 {
  // sign(H) * |H|^exponent
  // Exponent > 1.0: pushes mid-values down, pulls extremes up/down
  // Creates that aggressive jutting look with deep crevices
  let s = sign(h);
  let a = abs(h);
  return s * pow(a, params.ridgeExponent);
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(outputHeightmap);

  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }

  // Calculate UV coordinates [0, 1]
  let uv = vec2f(f32(globalId.x), f32(globalId.y)) / vec2f(f32(dims.x - 1u), f32(dims.y - 1u));

  // World position scaled by noise scale params
  let worldPos = params.offset + uv * params.scale;

  // Step 1: Generate base noise field (domain-warped ridged fBm)
  let rawHeight = warpedFbm(worldPos);

  // Step 2: Apply rock protrusion shaping (power sharpening + strata)
  let protrusion = applyRockProtrusion(rawHeight, worldPos);

  // Step 3: Add slope-dependent high-frequency detail (micro-cracks)
  let detail = slopeBasedDetail(worldPos, rawHeight);

  // Step 4: Combine and apply exponential bias
  let combined = protrusion + detail;
  let biased = exponentialBias(combined - 0.5); // Center around 0

  // Step 5: Apply overall height scale
  // Output in [-0.5, 0.5] range for compositor normalization
  let finalHeight = biased * params.heightScale;

  textureStore(outputHeightmap, vec2i(globalId.xy), vec4f(finalHeight, 0.0, 0.0, 1.0));
}
