/**
 * fog-density-inject.wgsl — Froxel fog density injection (Pass 1)
 *
 * For each froxel voxel, compute fog density from:
 *   1. Global height fog (exponential falloff above fogHeight)
 *   2. Optional 3D noise modulation for heterogeneous/wispy fog
 *   3. Local fog volume emitters (sphere/box/cylinder shapes)
 *
 * Output: densityGrid.a = extinction coefficient σ_t at each froxel
 */

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;
const MAX_FOG_VOLUMES: u32 = 32u;

// ========== Uniforms ==========

struct DensityUniforms {
  inverseViewProj: mat4x4f,       // [0..63]
  cameraPosition: vec3f,           // [64..75]
  near: f32,                       // [76..79]
  far: f32,                        // [80..83]
  fogHeight: f32,                  // [84..87]
  fogHeightFalloff: f32,           // [88..91]
  fogBaseDensity: f32,             // [92..95]
  noiseEnabled: f32,               // [96..99]
  noiseScale: f32,                 // [100..103]
  noiseStrength: f32,              // [104..107]
  time: f32,                       // [108..111]  for noise animation
  windOffsetX: f32,                // [112..115]
  windOffsetY: f32,                // [116..119]
  windOffsetZ: f32,                // [120..123]
  fogVolumeCount: f32,             // [124..127]
}

// Local fog volume (must match CPU-side layout: 64 bytes per volume)
struct FogVolume {
  // Position (world space center)
  position: vec3f,
  // Shape: 0=sphere, 1=box, 2=cylinder
  shape: f32,
  // Extents: radius for sphere, half-extents for box, radius+height for cylinder
  extents: vec3f,
  density: f32,
  // Color tint (optional)
  color: vec3f,
  falloff: f32,
}

// ========== Bindings ==========

@group(0) @binding(0) var<uniform> u: DensityUniforms;
@group(0) @binding(1) var densityGrid: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> fogVolumes: array<FogVolume>;

// ========== Procedural 3D Noise (GPU-only, no texture dependency) ==========

fn hash3(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise3D(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  // Smooth Hermite interpolation
  let u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(
      mix(hash3(i + vec3f(0.0, 0.0, 0.0)), hash3(i + vec3f(1.0, 0.0, 0.0)), u.x),
      mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), u.x),
      u.y
    ),
    mix(
      mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), u.x),
      mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), u.x),
      u.y
    ),
    u.z
  );
}

fn fbmNoise3D(p: vec3f, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;
  var totalAmplitude = 0.0;
  var pos = p;

  for (var i = 0u; i < octaves; i++) {
    value += amplitude * valueNoise3D(pos * frequency);
    totalAmplitude += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }

  return value / totalAmplitude;
}

// ========== Depth Slicing (Exponential) ==========

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
}

// ========== World Position from Froxel Coord ==========

fn froxelToWorld(coord: vec3u) -> vec3f {
  let uv = (vec2f(coord.xy) + 0.5) / vec2f(f32(FROXEL_WIDTH), f32(FROXEL_HEIGHT));
  let ndcX = uv.x * 2.0 - 1.0;
  let ndcY = 1.0 - uv.y * 2.0;
  let linearDepth = sliceToDepth(f32(coord.z) + 0.5);

  let clipNear = vec4f(ndcX, ndcY, 1.0, 1.0);
  let clipFar  = vec4f(ndcX, ndcY, 0.0, 1.0);
  let worldNear4 = u.inverseViewProj * clipNear;
  let worldFar4  = u.inverseViewProj * clipFar;
  let worldNear = worldNear4.xyz / worldNear4.w;
  let worldFar  = worldFar4.xyz / worldFar4.w;

  let rayDir = normalize(worldFar - worldNear);
  return worldNear + rayDir * linearDepth;
}

// ========== Local Fog Volume Evaluation ==========

fn evaluateSphereVolume(worldPos: vec3f, vol: FogVolume) -> f32 {
  let d = length(worldPos - vol.position) / vol.extents.x; // extents.x = radius
  if (d >= 1.0) { return 0.0; }
  // Smooth falloff from center to edge
  let t = 1.0 - smoothstep(1.0 - vol.falloff, 1.0, d);
  return vol.density * t;
}

fn evaluateBoxVolume(worldPos: vec3f, vol: FogVolume) -> f32 {
  let local = abs(worldPos - vol.position);
  let halfExt = vol.extents;
  // Distance from center in normalized [0,1] per axis
  let d = local / halfExt;
  if (any(d > vec3f(1.0))) { return 0.0; }
  let maxD = max(d.x, max(d.y, d.z));
  let t = 1.0 - smoothstep(1.0 - vol.falloff, 1.0, maxD);
  return vol.density * t;
}

fn evaluateCylinderVolume(worldPos: vec3f, vol: FogVolume) -> f32 {
  let diff = worldPos - vol.position;
  let radialDist = length(diff.xz) / vol.extents.x; // extents.x = radius
  let heightDist = abs(diff.y) / vol.extents.y;      // extents.y = half-height
  if (radialDist >= 1.0 || heightDist >= 1.0) { return 0.0; }
  let maxD = max(radialDist, heightDist);
  let t = 1.0 - smoothstep(1.0 - vol.falloff, 1.0, maxD);
  return vol.density * t;
}

// ========== Main Compute ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT || gid.z >= FROXEL_DEPTH) { return; }

  let worldPos = froxelToWorld(gid);

  // ── Source 1: Global height fog ──
  let heightAboveFog = worldPos.y - u.fogHeight;
  var density = u.fogBaseDensity * exp(-u.fogHeightFalloff * heightAboveFog);

  // ── Source 2: 3D noise for heterogeneous/wispy fog (procedural, no texture needed) ──
  if (u.noiseEnabled > 0.5) {
    let noisePos = worldPos * u.noiseScale + vec3f(u.windOffsetX, u.windOffsetY, u.windOffsetZ);
    let rawNoise = fbmNoise3D(noisePos, 4u);
    // Remap noise to create clear contrast: wisps (dense) vs holes (near-zero)
    // Raw noise averages ~0.5; remap so values below 0.4 become 0 (holes)
    // and values above 0.4 become wispy density peaks
    let remapped = saturate((rawNoise - 0.35) * 3.0); // 0.35..0.68 → 0..1
    density *= mix(1.0, remapped, u.noiseStrength);
  }

  // ── Source 3: Local fog volumes ──
  let volumeCount = u32(u.fogVolumeCount);
  for (var i = 0u; i < volumeCount && i < MAX_FOG_VOLUMES; i++) {
    let vol = fogVolumes[i];
    var volDensity = 0.0;
    let shape = u32(vol.shape);
    if (shape == 0u) {
      volDensity = evaluateSphereVolume(worldPos, vol);
    } else if (shape == 1u) {
      volDensity = evaluateBoxVolume(worldPos, vol);
    } else {
      volDensity = evaluateCylinderVolume(worldPos, vol);
    }
    density += volDensity;
  }

  // Clamp to non-negative extinction
  let extinction = max(0.0, density);

  // Store: RGB unused in density pass, A = extinction coefficient
  textureStore(densityGrid, gid, vec4f(0.0, 0.0, 0.0, extinction));
}
