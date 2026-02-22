/**
 * Vegetation Instance Culling Compute Shader
 * 
 * Reads the full instance buffer from spawn, performs per-instance:
 *   1. Frustum culling (6-plane test on world position with size margin)
 *   2. Distance culling (camera distance vs maxDistance)
 *   3. Per-frame hybrid LOD: re-evaluates billboard vs mesh based on live camera distance
 *   4. Render type separation into compacted output buffers
 * 
 * Outputs compacted billboard + mesh instance buffers and indirect draw args.
 * 
 * DrawArgs layout (12 × u32 = 48 bytes, padded):
 *   Billboard (drawIndirect args):
 *     [0] vertexCount     = 12 (pre-filled by CPU)
 *     [1] instanceCount   = atomic counter (filled by this shader)
 *     [2] firstVertex     = 0
 *     [3] firstInstance   = 0
 *   Mesh (drawIndexedIndirect args):
 *     [4] indexCount       = meshIndexCount (pre-filled by CPU)
 *     [5] instanceCount   = atomic counter (filled by this shader)
 *     [6] firstIndex      = 0
 *     [7] baseVertex      = 0
 *     [8] firstInstance   = 0
 *   Padding:
 *     [9-11] = 0
 */

// Must match PlantInstance in spawn.wgsl and TypeScript (32 bytes)
struct PlantInstance {
  positionAndScale: vec4f,   // xyz = world position, w = uniform scale
  rotationAndType: vec4f,    // x = Y-axis rotation (rad), y = plantTypeIndex, z = renderFlag (0=bb, 1=mesh), w = unused
}

struct CullParams {
  // Frustum planes: 6 × vec4f (normal.xyz + distance.w)
  plane0: vec4f,
  plane1: vec4f,
  plane2: vec4f,
  plane3: vec4f,
  plane4: vec4f,
  plane5: vec4f,
  // Camera
  cameraPosition: vec3f,
  maxDistanceSq: f32,
  // Counts + hybrid LOD params
  totalInstances: u32,
  // Render mode: 0 = billboard-only, 1 = mesh-only, 2 = hybrid (re-evaluate per-frame)
  renderMode: u32,
  // Distance threshold for hybrid mode: < billboardDistance = mesh, >= billboardDistance = billboard
  billboardDistanceSq: f32,
  _pad0: f32,
}

// Bindings
@group(0) @binding(0) var<uniform> params: CullParams;
@group(0) @binding(1) var<storage, read> inputInstances: array<PlantInstance>;
@group(0) @binding(2) var<storage, read_write> billboardOutput: array<PlantInstance>;
@group(0) @binding(3) var<storage, read_write> meshOutput: array<PlantInstance>;
@group(0) @binding(4) var<storage, read_write> drawArgs: array<atomic<u32>>;
// Binding 5: spawn counter buffer — counterBuffer[0] = actual totalInstances from spawn shader
@group(0) @binding(5) var<storage, read> spawnCounters: array<u32>;

/**
 * Test if a point (with radius margin) is inside all 6 frustum planes.
 * Returns true if the sphere (pos, radius) is at least partially inside.
 */
fn isInFrustum(pos: vec3f, radius: f32) -> bool {
  if (dot(params.plane0.xyz, pos) + params.plane0.w + radius < 0.0) { return false; }
  if (dot(params.plane1.xyz, pos) + params.plane1.w + radius < 0.0) { return false; }
  if (dot(params.plane2.xyz, pos) + params.plane2.w + radius < 0.0) { return false; }
  if (dot(params.plane3.xyz, pos) + params.plane3.w + radius < 0.0) { return false; }
  if (dot(params.plane4.xyz, pos) + params.plane4.w + radius < 0.0) { return false; }
  if (dot(params.plane5.xyz, pos) + params.plane5.w + radius < 0.0) { return false; }
  return true;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.totalInstances) {
    return;
  }
  
  // Read actual instance count from GPU spawn counter (not maxInstances)
  let actualCount = spawnCounters[0];
  if (idx >= actualCount) {
    return;
  }
  
  var instance = inputInstances[idx];
  let worldPos = instance.positionAndScale.xyz;
  let scale = instance.positionAndScale.w;
  let spawnRenderFlag = instance.rotationAndType.z; // 0 = billboard, 1 = mesh (from spawn)
  
  // 1. Distance culling
  let diff = worldPos - params.cameraPosition;
  let distSq = dot(diff, diff);
  if (distSq > params.maxDistanceSq) {
    return; // Too far — cull
  }
  
  // 2. Frustum culling with bounding sphere
  let radius = scale * 2.0; // Conservative: 2× scale for billboard cross width
  if (!isInFrustum(worldPos, radius)) {
    return; // Outside frustum — cull
  }
  
  // 3. Determine render type — per-frame hybrid re-evaluation
  var isMesh: bool;
  
  if (params.renderMode == 2u) {
    // Hybrid mode: re-evaluate every frame using live camera distance
    isMesh = distSq < params.billboardDistanceSq;
    // Update the renderFlag in the output instance so shaders see the correct value
    instance.rotationAndType.z = select(0.0, 1.0, isMesh);
  } else {
    // Non-hybrid: use the spawn-baked renderFlag as-is
    isMesh = spawnRenderFlag >= 0.5;
  }
  
  // 4. Route to correct output based on render type
  if (isMesh) {
    let outIdx = atomicAdd(&drawArgs[5], 1u); // drawArgs[5] = mesh instanceCount
    meshOutput[outIdx] = instance;
  } else {
    let outIdx = atomicAdd(&drawArgs[1], 1u); // drawArgs[1] = billboard instanceCount
    billboardOutput[outIdx] = instance;
  }
}