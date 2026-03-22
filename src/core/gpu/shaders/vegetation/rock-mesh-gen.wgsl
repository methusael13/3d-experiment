/**
 * rock-mesh-gen.wgsl — Procedural Rock Mesh Generation Compute Shader
 *
 * Deforms a base icosphere into a rock shape using layered 3D noise:
 *   Layer 1: Voronoi ridge noise (F2-F1) — angular craggy structure (weight 0.6)
 *   Layer 2: Domain-warped fBM — medium-scale geological variation (weight 0.25)
 *   Layer 3: Turbulence (abs-value fBM) — sharp V-shaped creases (weight 0.15)
 *
 * Input:  Base icosphere vertices (read-only storage buffer)
 * Output: Deformed vertices with normals + UVs (read-write storage buffer)
 *
 * Vertex layout (32 bytes per vertex, matching VegetationSubMesh interleaved format):
 *   [position.x, position.y, position.z, normal.x, normal.y, normal.z, u, v]
 *
 * Dispatched with workgroup_size(64), one thread per vertex.
 * The index buffer is passed through unchanged (copied on CPU side).
 */

// ==================== Uniforms ====================

struct RockGenParams {
  seed: f32,              // Shape seed (different seed = different rock)
  displacementScale: f32, // How much to displace vertices (0.0-1.0, default 0.35)
  baseRadius: f32,        // Base sphere radius before displacement (default 0.5)
  vertexCount: u32,       // Number of vertices to process
}

@group(0) @binding(0) var<uniform> params: RockGenParams;
@group(0) @binding(1) var<storage, read> baseVertices: array<f32>;     // xyz per vertex (3 floats each)
@group(0) @binding(2) var<storage, read_write> outputVertices: array<f32>; // 8 floats per vertex

// ==================== Hash Functions ====================

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

// ==================== Perlin Noise (3D) ====================

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

  let g000 = dot(gradientHash(pi + vec3f(0, 0, 0)), pf - vec3f(0, 0, 0));
  let g100 = dot(gradientHash(pi + vec3f(1, 0, 0)), pf - vec3f(1, 0, 0));
  let g010 = dot(gradientHash(pi + vec3f(0, 1, 0)), pf - vec3f(0, 1, 0));
  let g110 = dot(gradientHash(pi + vec3f(1, 1, 0)), pf - vec3f(1, 1, 0));
  let g001 = dot(gradientHash(pi + vec3f(0, 0, 1)), pf - vec3f(0, 0, 1));
  let g101 = dot(gradientHash(pi + vec3f(1, 0, 1)), pf - vec3f(1, 0, 1));
  let g011 = dot(gradientHash(pi + vec3f(0, 1, 1)), pf - vec3f(0, 1, 1));
  let g111 = dot(gradientHash(pi + vec3f(1, 1, 1)), pf - vec3f(1, 1, 1));

  let x00 = mix(g000, g100, w.x);
  let x10 = mix(g010, g110, w.x);
  let x01 = mix(g001, g101, w.x);
  let x11 = mix(g011, g111, w.x);
  let y0 = mix(x00, x10, w.y);
  let y1 = mix(x01, x11, w.y);
  return mix(y0, y1, w.z);
}

// ==================== Perlin fBM ====================

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

// ==================== Worley/Voronoi Noise (3D) ====================

/**
 * Compute F1 (nearest) and F2 (second nearest) distances to Voronoi cell points.
 * Returns vec2f(F1, F2).
 */
fn worleyF1F2(p: vec3f) -> vec2f {
  let pi = floor(p);
  let pf = fract(p);

  var f1 = 999.0;
  var f2 = 999.0;

  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      for (var z = -1; z <= 1; z++) {
        let offset = vec3f(f32(x), f32(y), f32(z));
        let cellPoint = hash3(pi + offset);
        let diff = offset + cellPoint - pf;
        let dist = length(diff);

        if (dist < f1) {
          f2 = f1;
          f1 = dist;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
  }
  return vec2f(f1, f2);
}

/**
 * Voronoi ridge noise: F2 - F1.
 * Produces sharp ridges at cell boundaries — the signature rock fracture pattern.
 * Returns value in approximately [0, 1].
 */
fn voronoiRidge(p: vec3f) -> f32 {
  let f = worleyF1F2(p);
  return saturate(f.y - f.x);
}

// ==================== Layer 2: Domain-Warped fBM ====================

fn domainWarpedFBM(p: vec3f) -> f32 {
  let warp = vec3f(
    perlinFBM(p + vec3f(100.0, 0.0, 0.0), 3),
    perlinFBM(p + vec3f(0.0, 200.0, 0.0), 3),
    perlinFBM(p + vec3f(0.0, 0.0, 300.0), 3)
  ) * 0.3;
  return perlinFBM((p + warp) * 4.0, 3);
}

// ==================== Layer 3: Turbulence (abs-value fBM) ====================

fn turbulenceNoise(p: vec3f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var total = 0.0;
  for (var i = 0; i < 3; i++) {
    sum += abs(perlinNoise(p * freq)) * amp;
    total += amp;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum / total;
}

// ==================== Combined Rock Displacement ====================

/**
 * Evaluate rock displacement at a point on the unit sphere.
 * @param dir - Normalized direction (unit sphere position)
 * @return Signed displacement amount (can be negative for concavities)
 */
fn rockDisplacement(dir: vec3f) -> f32 {
  let p = dir * 4.0 + params.seed * 17.0;

  // Layer 1: Voronoi ridges — angular craggy structure (0.5 weight)
  // Higher frequency (×3) produces more fracture lines per rock
  let ridge = voronoiRidge(p * 3.0);

  // Layer 2: Large-scale shape variation — breaks the sphere into an asymmetric blob
  // Low frequency, high amplitude — this is what makes each seed look truly different
  let bigShape = perlinFBM(p * 0.8, 2) * 0.5 + 0.5;

  // Layer 3: Domain-warped fBM — medium geological variation (0.2 weight)
  let fbm = domainWarpedFBM(p) * 0.5 + 0.5;

  // Layer 4: Turbulence — sharp creases (0.1 weight)
  let turb = turbulenceNoise(p * 8.0);

  // Combine: big shape dominates for non-spherical silhouette,
  // ridges add angular detail, fBM + turbulence for texture
  let combined = bigShape * 0.35 + ridge * 0.35 + fbm * 0.2 + turb * 0.1;

  // Remap: allow significant concavities for irregular shapes
  return combined * 2.0 - 0.6;
}

// ==================== Normal Computation via Central Differences ====================

/**
 * Compute the surface normal at a point by evaluating displacement at 6 neighboring
 * points and computing the gradient via finite differences.
 */
fn computeRockNormal(dir: vec3f) -> vec3f {
  let eps = 0.01;

  // Evaluate displacement at 6 offset points
  let dx = rockDisplacement(normalize(dir + vec3f(eps, 0.0, 0.0)))
         - rockDisplacement(normalize(dir - vec3f(eps, 0.0, 0.0)));
  let dy = rockDisplacement(normalize(dir + vec3f(0.0, eps, 0.0)))
         - rockDisplacement(normalize(dir - vec3f(0.0, eps, 0.0)));
  let dz = rockDisplacement(normalize(dir + vec3f(0.0, 0.0, eps)))
         - rockDisplacement(normalize(dir - vec3f(0.0, 0.0, eps)));

  // The gradient of the displacement field
  let gradient = vec3f(dx, dy, dz) / (2.0 * eps);

  // Normal is the sphere normal (dir) minus the tangential gradient component
  // For a sphere, the surface normal after displacement is:
  //   N = normalize(dir - gradient * displacementScale)
  return normalize(dir - gradient * params.displacementScale);
}

// ==================== Spherical UV Mapping ====================

fn sphericalUV(dir: vec3f) -> vec2f {
  let theta = atan2(dir.z, dir.x); // -π to π
  let phi = asin(clamp(dir.y, -1.0, 1.0)); // -π/2 to π/2

  let u = (theta / (2.0 * 3.14159265)) + 0.5; // [0, 1]
  let v = (phi / 3.14159265) + 0.5;            // [0, 1]
  return vec2f(u, v);
}

// ==================== Main Entry Point ====================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let vertexIndex = gid.x;
  if (vertexIndex >= params.vertexCount) {
    return;
  }

  // Read base icosphere vertex position (3 floats per vertex)
  let baseIdx = vertexIndex * 3u;
  let basePos = vec3f(
    baseVertices[baseIdx + 0u],
    baseVertices[baseIdx + 1u],
    baseVertices[baseIdx + 2u]
  );

  // Normalize to unit sphere (icosphere vertices should already be normalized,
  // but normalize just in case of floating point drift from subdivision)
  let dir = normalize(basePos);

  // Compute displacement along the radial direction
  let displacement = rockDisplacement(dir);

  // Displace vertex
  let radius = params.baseRadius + displacement * params.displacementScale * params.baseRadius;
  let deformedPos = dir * radius;

  // Compute normal via central differences on the displacement field
  let normal = computeRockNormal(dir);

  // Spherical UV mapping
  let uv = sphericalUV(dir);

  // Write output vertex: [pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, u, v]
  let outIdx = vertexIndex * 8u;
  outputVertices[outIdx + 0u] = deformedPos.x;
  outputVertices[outIdx + 1u] = deformedPos.y;
  outputVertices[outIdx + 2u] = deformedPos.z;
  outputVertices[outIdx + 3u] = normal.x;
  outputVertices[outIdx + 4u] = normal.y;
  outputVertices[outIdx + 5u] = normal.z;
  outputVertices[outIdx + 6u] = uv.x;
  outputVertices[outIdx + 7u] = uv.y;
}
