/**
 * cloud-noise-gen.wgsl — 3D Worley-Perlin base shape noise generation
 *
 * Generates a 128³ rgba8unorm 3D texture:
 *   R: Perlin-Worley (low freq base shape)
 *   G: Worley octave 1
 *   B: Worley octave 2
 *   A: Worley octave 3
 *
 * Dispatched as @workgroup_size(4, 4, 4), 32³ workgroups
 */

struct NoiseParams {
  size: u32,         // Texture size (128)
  seed: f32,         // Random seed
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> params: NoiseParams;
@group(0) @binding(1) var outputTexture: texture_storage_3d<rgba8unorm, write>;

// ========== Hash Functions ==========

fn hash3(p: vec3f) -> vec3f {
  var q = vec3f(
    dot(p, vec3f(127.1, 311.7, 74.7)),
    dot(p, vec3f(269.5, 183.3, 246.1)),
    dot(p, vec3f(113.5, 271.9, 124.6))
  );
  return fract(sin(q + params.seed) * 43758.5453123);
}

fn hash1(p: vec3f) -> f32 {
  return fract(sin(dot(p + params.seed, vec3f(127.1, 311.7, 74.7))) * 43758.5453123);
}

// ========== Perlin Noise ==========

fn fade(t: vec3f) -> vec3f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn gradientHash(p: vec3f) -> vec3f {
  let h = hash3(p);
  return normalize(h * 2.0 - 1.0);
}

fn perlinNoise(p: vec3f) -> f32 {
  let pi = floor(p);
  let pf = p - pi;
  let w = fade(pf);

  // 8 corner gradients
  let g000 = dot(gradientHash(pi + vec3f(0, 0, 0)), pf - vec3f(0, 0, 0));
  let g100 = dot(gradientHash(pi + vec3f(1, 0, 0)), pf - vec3f(1, 0, 0));
  let g010 = dot(gradientHash(pi + vec3f(0, 1, 0)), pf - vec3f(0, 1, 0));
  let g110 = dot(gradientHash(pi + vec3f(1, 1, 0)), pf - vec3f(1, 1, 0));
  let g001 = dot(gradientHash(pi + vec3f(0, 0, 1)), pf - vec3f(0, 0, 1));
  let g101 = dot(gradientHash(pi + vec3f(1, 0, 1)), pf - vec3f(1, 0, 1));
  let g011 = dot(gradientHash(pi + vec3f(0, 1, 1)), pf - vec3f(0, 1, 1));
  let g111 = dot(gradientHash(pi + vec3f(1, 1, 1)), pf - vec3f(1, 1, 1));

  // Trilinear interpolation
  let x00 = mix(g000, g100, w.x);
  let x10 = mix(g010, g110, w.x);
  let x01 = mix(g001, g101, w.x);
  let x11 = mix(g011, g111, w.x);
  let y0 = mix(x00, x10, w.y);
  let y1 = mix(x01, x11, w.y);
  return mix(y0, y1, w.z);
}

// ========== Worley (Cellular) Noise ==========

fn worleyNoise(p: vec3f) -> f32 {
  let pi = floor(p);
  let pf = fract(p);

  var minDist = 1.0;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      for (var z = -1; z <= 1; z++) {
        let offset = vec3f(f32(x), f32(y), f32(z));
        let cellPoint = hash3(pi + offset);
        let diff = offset + cellPoint - pf;
        let dist = dot(diff, diff);
        minDist = min(minDist, dist);
      }
    }
  }
  return sqrt(minDist);
}

// ========== FBM ==========

fn perlinFBM(p: vec3f, octaves: i32) -> f32 {
  var sum = 0.0;
  var freq = 1.0;
  var amp = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += perlinNoise(p * freq) * amp;
    total += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / total;
}

fn worleyFBM(p: vec3f, freq: f32) -> f32 {
  return worleyNoise(p * freq);
}

// ========== Main ==========

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let size = params.size;
  if (any(globalId >= vec3u(size, size, size))) {
    return;
  }

  let uvw = vec3f(globalId) / f32(size);

  // Perlin-Worley (R channel): blend of Perlin and Worley for organic shapes
  let perlin = perlinFBM(uvw * 8.0, 4) * 0.5 + 0.5; // [0, 1]
  let worley1 = 1.0 - worleyNoise(uvw * 8.0);        // Invert: 1 = cell center, 0 = edge
  let perlinWorley = saturate(perlin * 0.6 + worley1 * 0.4);

  // Worley at 3 octaves (G, B, A channels)
  let w1 = 1.0 - worleyFBM(uvw, 8.0);
  let w2 = 1.0 - worleyFBM(uvw, 16.0);
  let w3 = 1.0 - worleyFBM(uvw, 32.0);

  textureStore(outputTexture, globalId, vec4f(perlinWorley, w1, w2, w3));
}
