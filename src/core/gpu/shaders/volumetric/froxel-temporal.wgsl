/**
 * froxel-temporal.wgsl — Temporal reprojection for froxel grid (Pass 2.5)
 *
 * Runs between scattering and integration. Reprojects previous frame's
 * scattering result into current frame to smooth temporal artifacts.
 * Uses 95% history / 5% current by default (configurable).
 *
 * Inserted optionally — when disabled, scatterGrid passes directly to integrate.
 */

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;

struct TemporalUniforms {
  prevViewProj: mat4x4f,          // Previous frame's view-projection
  inverseViewProj: mat4x4f,       // Current frame's inverse VP
  cameraPosition: vec3f,
  near: f32,
  far: f32,
  temporalBlend: f32,             // 0.95 typical
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: TemporalUniforms;
@group(0) @binding(1) var currentScatter: texture_3d<f32>;
@group(0) @binding(2) var historyScatter: texture_3d<f32>;
@group(0) @binding(3) var outputScatter: texture_storage_3d<rgba16float, write>;
@group(0) @binding(4) var historySampler: sampler;

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
}

fn depthToSlice(linearDepth: f32) -> f32 {
  return log(linearDepth / u.near) / log(u.far / u.near) * f32(FROXEL_DEPTH);
}

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

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT || gid.z >= FROXEL_DEPTH) { return; }

  let current = textureLoad(currentScatter, gid, 0);

  // Reproject: find where this froxel was in the previous frame
  let worldPos = froxelToWorld(gid);
  let prevClip = u.prevViewProj * vec4f(worldPos, 1.0);
  let prevNDC = prevClip.xyz / prevClip.w;
  let prevUV = prevNDC.xy * vec2f(0.5, -0.5) + 0.5;

  // Compute linear depth in prev frame for slice lookup
  let prevLinearDepth = length(worldPos - u.cameraPosition);
  let prevSlice = depthToSlice(prevLinearDepth);
  let prevW = prevSlice / f32(FROXEL_DEPTH);

  // Validate: is the reprojected coordinate in bounds?
  let inBounds = prevUV.x >= 0.0 && prevUV.x <= 1.0 &&
                 prevUV.y >= 0.0 && prevUV.y <= 1.0 &&
                 prevW >= 0.0 && prevW <= 1.0;

  if (inBounds) {
    let historyUVW = vec3f(prevUV.x, prevUV.y, prevW);
    let history = textureSampleLevel(historyScatter, historySampler, historyUVW, 0.0);

    // Blend: temporalBlend% history + (1-temporalBlend)% current
    let blended = mix(current, history, u.temporalBlend);
    textureStore(outputScatter, gid, blended);
  } else {
    // Out of bounds: keep current (no history available)
    textureStore(outputScatter, gid, current);
  }
}
