// Island Mask Generation Compute Shader
// Generates a mask texture for island terrain with organic coastlines
// 
// Output: R8 texture where 1.0 = land, 0.0 = ocean
// The CDLOD shader samples this to blend between terrain and sea floor

struct IslandParams {
  seed: f32,               // Random seed for coastline variation
  islandRadius: f32,       // Normalized radius (0.3-0.5 typical)
  coastNoiseScale: f32,    // Coastline wiggle frequency (3-8)
  coastNoiseStrength: f32, // Coastline wiggle amplitude (0.1-0.3)
  coastFalloff: f32,       // Width of coast-to-seafloor transition (0.05-0.5)
  _pad1: f32,              // Padding for 16-byte alignment
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> params: IslandParams;
@group(0) @binding(1) var outputMask: texture_storage_2d<r32float, write>;

// ============================================================================
// Noise Functions (simplified for mask generation)
// ============================================================================

// Simple hash function for pseudo-random values
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

// Simple 3-octave FBM for coastline noise
fn fbm3(p: vec2f) -> f32 {
  var value: f32 = 0.0;
  var amplitude: f32 = 1.0;
  var frequency: f32 = 1.0;
  var totalAmplitude: f32 = 0.0;
  
  // Add seed offset
  let seedOffset = vec2f(
    fract(params.seed * 0.1731) * 100.0,
    fract(params.seed * 0.4317) * 100.0
  );
  let pos = p + seedOffset;
  
  for (var i: u32 = 0u; i < 3u; i++) {
    value += amplitude * valueNoise(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  
  return value / totalAmplitude;
}

// ============================================================================
// Main Compute Entry Point
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(outputMask);
  
  // Bounds check
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  // Calculate UV coordinates [0, 1]
  let uv = vec2f(f32(globalId.x), f32(globalId.y)) / vec2f(f32(dims.x - 1u), f32(dims.y - 1u));
  
  // Calculate normalized distance from center [0-1]
  let center = vec2f(0.5, 0.5);
  let toCenter = uv - center;
  let dist = length(toCenter) * 2.0;  // 0 at center, 1 at corners
  
  // Sample noise along angular direction for organic coastline
  let angle = atan2(toCenter.y, toCenter.x);
  
  // Use angle to sample noise - creates consistent bulges/inlets around perimeter
  let coastNoise = fbm3(vec2f(
    cos(angle) * params.coastNoiseScale,
    sin(angle) * params.coastNoiseScale
  ));
  
  // Perturb distance with coastline noise
  // coastNoise is ~[0-1], so (coastNoise - 0.5) gives [-0.5, 0.5]
  let perturbedDist = dist + (coastNoise - 0.5) * params.coastNoiseStrength * 2.0;
  
  // Smooth falloff from land (1) to sea (0)
  // coastFalloff controls the width of the transition zone
  // Small values = sharp cliffs, large values = gradual continental shelf
  let halfFalloff = params.coastFalloff * 0.5;
  let falloffStart = params.islandRadius - halfFalloff;
  let falloffEnd = params.islandRadius + halfFalloff;
  
  let mask = 1.0 - smoothstep(falloffStart, falloffEnd, perturbedDist);
  
  // Write to output texture
  textureStore(outputMask, vec2i(globalId.xy), vec4f(mask, 0.0, 0.0, 1.0));
}
