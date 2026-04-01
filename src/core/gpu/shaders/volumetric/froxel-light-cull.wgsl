/**
 * froxel-light-cull.wgsl — Light-to-froxel assignment (Phase 6b)
 *
 * For each froxel, determines which point and spot lights affect it.
 * Writes a FroxelLightList per froxel containing light indices.
 *
 * Each thread processes one froxel and tests all lights against it.
 * This is a simple brute-force approach suitable for <32 lights.
 * For many more lights, a separate tile-based culling pass would be needed.
 */

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;
const MAX_POINT_PER_FROXEL: u32 = 16u;
const MAX_SPOT_PER_FROXEL: u32 = 16u;

struct CullUniforms {
  inverseViewProj: mat4x4f,
  cameraPosition: vec3f,
  near: f32,
  far: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct PointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
}

struct SpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,
  cookieAtlasIndex: i32,
  cookieIntensity: f32,
  lightSpaceMatrix: mat4x4f,
}

struct LightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
}

struct FroxelLightList {
  pointCount: u32,
  spotCount: u32,
  pointIndices: array<u32, 16>,
  spotIndices: array<u32, 16>,
}

@group(0) @binding(0) var<uniform> u: CullUniforms;
@group(0) @binding(1) var<uniform> lightCounts: LightCounts;
@group(0) @binding(2) var<storage, read> pointLights: array<PointLightData>;
@group(0) @binding(3) var<storage, read> spotLights: array<SpotLightData>;
@group(0) @binding(4) var<storage, read_write> froxelLightLists: array<FroxelLightList>;

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
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

  let froxelIndex = gid.x + gid.y * FROXEL_WIDTH + gid.z * FROXEL_WIDTH * FROXEL_HEIGHT;
  let worldPos = froxelToWorld(gid);

  // Approximate froxel radius for intersection test
  // (half the diagonal of a froxel cell — conservative estimate)
  let sliceThick = sliceToDepth(f32(gid.z) + 1.0) - sliceToDepth(f32(gid.z));
  let froxelRadius = sliceThick * 0.7; // Conservative bound

  var pointCount = 0u;
  var spotCount = 0u;
  var pointIndices: array<u32, 16>;
  var spotIndices: array<u32, 16>;

  // Test point lights
  let numPoint = min(lightCounts.numPoint, 16u);
  for (var i = 0u; i < numPoint; i++) {
    let light = pointLights[i];
    let dist = length(light.position - worldPos);
    // Light affects froxel if within range + froxel radius
    if (dist < light.range + froxelRadius && pointCount < MAX_POINT_PER_FROXEL) {
      pointIndices[pointCount] = i;
      pointCount++;
    }
  }

  // Test spot lights (use range for broad-phase, cone for narrow)
  let numSpot = min(lightCounts.numSpot, 16u);
  for (var i = 0u; i < numSpot; i++) {
    let light = spotLights[i];
    let dist = length(light.position - worldPos);
    if (dist < light.range + froxelRadius && spotCount < MAX_SPOT_PER_FROXEL) {
      // Broad-phase: within range. Fine cone test done in scattering shader.
      spotIndices[spotCount] = i;
      spotCount++;
    }
  }

  // Write result
  var result: FroxelLightList;
  result.pointCount = pointCount;
  result.spotCount = spotCount;
  result.pointIndices = pointIndices;
  result.spotIndices = spotIndices;
  froxelLightLists[froxelIndex] = result;
}
