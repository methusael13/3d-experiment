/**
 * Procedural Texture Generator — Compute Shader
 *
 * Generates grayscale procedural textures using various noise functions.
 * Output is written to an rgba8unorm storage texture where R=G=B=value, A=1.
 *
 * Noise types (params.noiseType):
 *   0 = Perlin
 *   1 = fBm (fractal Brownian motion)
 *   2 = Voronoi F1
 *   3 = Voronoi F2
 *   4 = Voronoi F1-F2 (cell edges)
 *   5 = Musgrave (ridged multifractal)
 *   6 = Checker
 *   7 = White Noise
 *
 * Color ramp: 2-stop piecewise linear remap
 *   Thresholds: stopX, stopY (0 ≤ X ≤ Y ≤ 1)
 *   Output values: val0, valX, valY, val1
 *   Maps: [0..X] → [val0..valX], [X..Y] → [valX..valY], [Y..1] → [valY..val1]
 */

struct Params {
  resolution: u32,       // texture width/height
  noiseType: u32,        // noise function selector
  octaves: u32,          // fBm/Musgrave octave count
  _pad0: u32,

  scale: f32,            // coordinate scale
  lacunarity: f32,       // frequency multiplier per octave
  persistence: f32,      // amplitude multiplier per octave
  seed: f32,             // random seed offset

  cellDensity: f32,      // Voronoi cell density
  offsetX: f32,          // UV offset X
  offsetY: f32,          // UV offset Y
  _pad1: f32,

  // Color ramp
  stopX: f32,            // first threshold [0..1]
  stopY: f32,            // second threshold [0..1]
  val0: f32,             // output at t=0
  valX: f32,             // output at t=stopX

  valY: f32,             // output at t=stopY
  val1: f32,             // output at t=1
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> params: Params;

// ==================== Hash Functions ====================

fn hash2(p: vec2f) -> vec2f {
  var q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn hash1(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// ==================== Perlin Noise ====================

fn fade(t: vec2f) -> vec2f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn gradientDot(cellCorner: vec2f, offset: vec2f) -> f32 {
  let h = hash1(cellCorner);
  // 4 gradient directions based on hash
  let angle = h * 6.28318;
  let grad = vec2f(cos(angle), sin(angle));
  return dot(grad, offset);
}

fn perlinNoise(p: vec2f) -> f32 {
  let pi = floor(p);
  let pf = p - pi;
  let w = fade(pf);

  let n00 = gradientDot(pi + vec2f(0.0, 0.0), pf - vec2f(0.0, 0.0));
  let n10 = gradientDot(pi + vec2f(1.0, 0.0), pf - vec2f(1.0, 0.0));
  let n01 = gradientDot(pi + vec2f(0.0, 1.0), pf - vec2f(0.0, 1.0));
  let n11 = gradientDot(pi + vec2f(1.0, 1.0), pf - vec2f(1.0, 1.0));

  let nx0 = mix(n00, n10, w.x);
  let nx1 = mix(n01, n11, w.x);
  return mix(nx0, nx1, w.y) * 0.5 + 0.5; // remap to [0,1]
}

// ==================== fBm ====================

fn fbm(p: vec2f, octaves: u32, lacunarity: f32, persistence: f32) -> f32 {
  var value = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;
  var maxAmp = 0.0;
  var pos = p;

  for (var i = 0u; i < octaves; i++) {
    value += amplitude * perlinNoise(pos * frequency);
    maxAmp += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / maxAmp;
}

// ==================== Voronoi ====================

fn voronoi(p: vec2f, density: f32) -> vec2f {
  // Returns vec2(F1, F2) — distances to nearest and second nearest cell
  let scaledP = p * density;
  let pi = floor(scaledP);
  let pf = scaledP - pi;

  var d1 = 999.0;
  var d2 = 999.0;

  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbor = vec2f(f32(x), f32(y));
      let cellPos = hash2(pi + neighbor);
      let diff = neighbor + cellPos - pf;
      let dist = length(diff);

      if (dist < d1) {
        d2 = d1;
        d1 = dist;
      } else if (dist < d2) {
        d2 = dist;
      }
    }
  }

  return vec2f(d1, d2);
}

// ==================== Musgrave (Ridged Multifractal) ====================

fn musgrave(p: vec2f, octaves: u32, lacunarity: f32, persistence: f32) -> f32 {
  var value = 0.0;
  var weight = 1.0;
  var frequency = 1.0;
  var pos = p;

  for (var i = 0u; i < octaves; i++) {
    var signal = perlinNoise(pos * frequency);
    // Ridge: fold the signal
    signal = 1.0 - abs(signal * 2.0 - 1.0);
    signal = signal * signal;
    signal *= weight;
    weight = clamp(signal, 0.0, 1.0);
    value += signal;
    frequency *= lacunarity;
  }

  return value / f32(octaves);
}

// ==================== Checker ====================

fn checker(p: vec2f, density: f32) -> f32 {
  let scaledP = p * density;
  let ix = i32(floor(scaledP.x));
  let iy = i32(floor(scaledP.y));
  return select(0.0, 1.0, ((ix + iy) & 1) == 0);
}

// ==================== White Noise ====================

fn whiteNoise(p: vec2f) -> f32 {
  return hash1(p);
}

// ==================== Color Ramp ====================

fn applyColorRamp(t: f32) -> f32 {
  let clamped = clamp(t, 0.0, 1.0);

  if (clamped <= params.stopX) {
    // [0, stopX] → [val0, valX]
    let frac = select(0.0, clamped / params.stopX, params.stopX > 0.0);
    return mix(params.val0, params.valX, frac);
  } else if (clamped <= params.stopY) {
    // [stopX, stopY] → [valX, valY]
    let range = params.stopY - params.stopX;
    let frac = select(0.0, (clamped - params.stopX) / range, range > 0.0);
    return mix(params.valX, params.valY, frac);
  } else {
    // [stopY, 1] → [valY, val1]
    let range = 1.0 - params.stopY;
    let frac = select(0.0, (clamped - params.stopY) / range, range > 0.0);
    return mix(params.valY, params.val1, frac);
  }
}

// ==================== Main ====================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = params.resolution;
  if (gid.x >= res || gid.y >= res) {
    return;
  }

  // UV coordinates [0, 1]
  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / f32(res);

  // Apply offset and scale
  let p = (uv + vec2f(params.offsetX, params.offsetY)) * params.scale + vec2f(params.seed, params.seed * 0.7);

  var value = 0.0;

  switch (params.noiseType) {
    case 0u: {
      // Perlin
      value = perlinNoise(p);
    }
    case 1u: {
      // fBm
      value = fbm(p, params.octaves, params.lacunarity, params.persistence);
    }
    case 2u: {
      // Voronoi F1
      let v = voronoi(uv + vec2f(params.offsetX, params.offsetY), params.cellDensity + params.seed * 0.01);
      value = clamp(v.x, 0.0, 1.0);
    }
    case 3u: {
      // Voronoi F2
      let v = voronoi(uv + vec2f(params.offsetX, params.offsetY), params.cellDensity + params.seed * 0.01);
      value = clamp(v.y, 0.0, 1.0);
    }
    case 4u: {
      // Voronoi F1-F2 (edges)
      let v = voronoi(uv + vec2f(params.offsetX, params.offsetY), params.cellDensity + params.seed * 0.01);
      value = clamp(v.y - v.x, 0.0, 1.0);
    }
    case 5u: {
      // Musgrave (ridged multifractal)
      value = musgrave(p, params.octaves, params.lacunarity, params.persistence);
    }
    case 6u: {
      // Checker
      value = checker(uv + vec2f(params.offsetX, params.offsetY), params.cellDensity);
    }
    case 7u: {
      // White noise
      value = whiteNoise(p * f32(res));
    }
    default: {
      value = 0.5;
    }
  }

  // Apply color ramp
  let remapped = applyColorRamp(value);
  let clamped = clamp(remapped, 0.0, 1.0);

  textureStore(outputTex, vec2i(gid.xy), vec4f(clamped, clamped, clamped, 1.0));
}