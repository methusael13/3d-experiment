/**
 * cloud-detail-noise.wgsl — 3D detail erosion noise generation
 *
 * Generates a 32³ rgba8unorm 3D texture:
 *   R: Worley octave 1 (high freq)
 *   G: Worley octave 2
 *   B: Worley octave 3
 *   A: Combined FBM of R/G/B
 *
 * Used to erode cloud edges for wispy/turbulent appearance.
 * Dispatched as @workgroup_size(4, 4, 4), 8³ workgroups
 */

struct NoiseParams {
  size: u32,
  seed: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> params: NoiseParams;
@group(0) @binding(1) var outputTexture: texture_storage_3d<rgba8unorm, write>;

// ========== Hash ==========

fn hash3(p: vec3f) -> vec3f {
  var q = vec3f(
    dot(p, vec3f(127.1, 311.7, 74.7)),
    dot(p, vec3f(269.5, 183.3, 246.1)),
    dot(p, vec3f(113.5, 271.9, 124.6))
  );
  return fract(sin(q + params.seed) * 43758.5453123);
}

// ========== Worley ==========

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

// ========== Main ==========

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let size = params.size;
  if (any(globalId >= vec3u(size, size, size))) {
    return;
  }

  let uvw = vec3f(globalId) / f32(size);

  // Three Worley frequencies for detail erosion — reduced for broader detail features
  let w1 = 1.0 - worleyNoise(uvw * 2.0);
  let w2 = 1.0 - worleyNoise(uvw * 4.0);
  let w3 = 1.0 - worleyNoise(uvw * 8.0);

  // FBM combination
  let combined = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;

  textureStore(outputTexture, globalId, vec4f(w1, w2, w3, combined));
}
