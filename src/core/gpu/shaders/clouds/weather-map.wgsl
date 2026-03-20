/**
 * weather-map.wgsl — 2D procedural weather map generation
 *
 * Generates a 512×512 rgba8unorm 2D texture:
 *   R: Cloud coverage (0 = clear, 1 = overcast)
 *   G: Cloud type (0 = stratus, 1 = cumulus)
 *   B: Precipitation (0 = none, 1 = heavy)
 *   A: Reserved
 *
 * Dispatched as @workgroup_size(8, 8, 1)
 */

struct WeatherParams {
  size: u32,          // Texture size (512)
  coverage: f32,      // Global coverage multiplier [0, 1]
  cloudType: f32,     // Global cloud type [0, 1]
  seed: f32,          // Random seed
}

@group(0) @binding(0) var<uniform> params: WeatherParams;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

// ========== Hash ==========

fn hash2(p: vec2f) -> vec2f {
  var q = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3))
  );
  return fract(sin(q + params.seed) * 43758.5453123);
}

fn hash1(p: vec2f) -> f32 {
  return fract(sin(dot(p + params.seed, vec2f(127.1, 311.7))) * 43758.5453123);
}

// ========== Tileable Value Noise ==========
// Wraps integer lattice coordinates to a given period so noise tiles seamlessly.
// This eliminates visible grid seams when the weather map UV repeats.

fn valueNoiseTileable(p: vec2f, period: f32) -> f32 {
  let pi = floor(p);
  let pf = fract(p);
  let w = pf * pf * (3.0 - 2.0 * pf); // Hermite

  // Wrap integer corners to period so edge values match opposite edge
  let p00 = vec2f(((pi.x) % period + period) % period, ((pi.y) % period + period) % period);
  let p10 = vec2f(((pi.x + 1.0) % period + period) % period, ((pi.y) % period + period) % period);
  let p01 = vec2f(((pi.x) % period + period) % period, ((pi.y + 1.0) % period + period) % period);
  let p11 = vec2f(((pi.x + 1.0) % period + period) % period, ((pi.y + 1.0) % period + period) % period);

  let a = hash1(p00);
  let b = hash1(p10);
  let c = hash1(p01);
  let d = hash1(p11);

  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// Non-tileable version for use in octaves where tiling doesn't matter
fn valueNoise(p: vec2f) -> f32 {
  let pi = floor(p);
  let pf = fract(p);
  let w = pf * pf * (3.0 - 2.0 * pf); // Hermite

  let a = hash1(pi + vec2f(0, 0));
  let b = hash1(pi + vec2f(1, 0));
  let c = hash1(pi + vec2f(0, 1));
  let d = hash1(pi + vec2f(1, 1));

  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// ========== Tileable FBM ==========
// Each octave uses a period that doubles with frequency, ensuring all octaves
// tile at the same spatial boundary.

fn fbmTileable(p: vec2f, baseFreq: f32, octaves: i32) -> f32 {
  var sum = 0.0;
  var freq = 1.0;
  var amp = 0.5;
  var total = 0.0;
  var period = baseFreq; // Base tiling period matches the initial frequency scale

  for (var i = 0; i < octaves; i++) {
    sum += valueNoiseTileable(p * freq, period) * amp;
    total += amp;
    freq *= 2.0;    // Integer multiplier so period stays aligned
    period *= 2.0;  // Period doubles with frequency
    amp *= 0.5;
  }

  return sum / total;
}

// Non-tileable FBM for fields where seams don't matter (cloud type, precipitation)
fn fbm(p: vec2f, octaves: i32) -> f32 {
  var sum = 0.0;
  var freq = 1.0;
  var amp = 0.5;
  var total = 0.0;
  var pos = p;

  for (var i = 0; i < octaves; i++) {
    sum += valueNoise(pos * freq) * amp;
    total += amp;
    freq *= 2.1;
    amp *= 0.5;
    let s = sin(0.65);
    let c = cos(0.65);
    pos = vec2f(pos.x * c - pos.y * s, pos.x * s + pos.y * c);
  }

  return sum / total;
}

// ========== Main ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let size = params.size;
  if (globalId.x >= size || globalId.y >= size) {
    return;
  }

  let uv = vec2f(globalId.xy) / f32(size);

  // Coverage: multi-octave tileable FBM for seamless weather map tiling
  let noise1 = fbmTileable(uv * 4.0, 4.0, 6);
  let noise2 = fbmTileable(uv * 2.0 + vec2f(5.2, 1.3), 2.0, 4);

  // Blend noise sources for natural cloud patterns
  let baseCoverage = noise1 * 0.7 + noise2 * 0.3;

  // Apply coverage control: remap so that coverage parameter controls how much sky is cloudy
  // At coverage=0, almost everything is below threshold → clear
  // At coverage=1, everything passes → overcast
  // Bias the noise upward and use the coverage param to control the cutoff
  let biased = baseCoverage * 1.2; // Boost noise range
  let coverageThreshold = (1.0 - params.coverage) * 0.8; // Scale threshold
  // Use a wider transition (0.75) for softer, more graduated cloud edges
  // instead of sharp cookie-cutter boundaries
  let coverage = saturate((biased - coverageThreshold) / 0.75);

  // Cloud type: separate noise field, blended with global type control
  let typeNoise = fbm(uv * 3.0 + vec2f(17.8, 42.1), 3);
  let cloudType = saturate(mix(typeNoise, params.cloudType, 0.6));

  // Precipitation: derived from high coverage areas
  let precip = saturate((coverage - 0.7) * 3.0) * fbm(uv * 6.0 + vec2f(33.2, 8.7), 3);

  textureStore(outputTexture, globalId.xy, vec4f(coverage, cloudType, precip, 0.0));
}
