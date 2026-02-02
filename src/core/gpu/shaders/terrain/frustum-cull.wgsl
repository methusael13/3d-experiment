// GPU Frustum Culling Compute Shader for CDLOD Terrain
//
// Tests quadtree nodes against frustum planes and outputs visible nodes
// to an indirect draw buffer. This moves culling from CPU to GPU.
//
// Workflow:
// 1. CPU uploads all potential nodes to nodeInputBuffer
// 2. This shader tests each node's AABB against frustum
// 3. Visible nodes are atomically appended to visibleNodesBuffer
// 4. Draw count is atomically incremented for indirect draw

// ============================================================================
// Uniform Structures
// ============================================================================

struct CullUniforms {
  // Frustum planes (6 planes: left, right, bottom, top, near, far)
  // Each plane stored as vec4: (normal.xyz, distance)
  frustumPlanes: array<vec4f, 6>,
  
  // Camera position for distance-based LOD
  cameraPosition: vec3f,
  _pad0: f32,
  
  // Number of input nodes to process
  nodeCount: u32,
  
  // Terrain parameters
  terrainSize: f32,
  heightScale: f32,
  _pad1: f32,
}

// Input node structure (from CPU)
struct InputNode {
  // AABB min (xyz) + LOD level (w)
  minBounds: vec4f,
  // AABB max (xyz) + morph factor (w)
  maxBounds: vec4f,
  // Center XZ + size + padding
  centerXZ: vec2f,
  size: f32,
  _pad: f32,
}

// Output node structure (for vertex shader)
struct OutputNode {
  // Offset XZ + scale + morph
  offsetX: f32,
  offsetZ: f32,
  scale: f32,
  morph: f32,
  lod: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

// Indirect draw arguments structure
struct DrawIndirectArgs {
  indexCount: u32,
  instanceCount: atomic<u32>,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: CullUniforms;
@group(0) @binding(1) var<storage, read> inputNodes: array<InputNode>;
@group(0) @binding(2) var<storage, read_write> visibleNodes: array<OutputNode>;
@group(0) @binding(3) var<storage, read_write> drawArgs: DrawIndirectArgs;

// ============================================================================
// Helper Functions
// ============================================================================

// Test if a point is on the positive side of a plane
fn pointOnPositiveSide(plane: vec4f, point: vec3f) -> bool {
  return dot(plane.xyz, point) + plane.w >= 0.0;
}

// Test AABB against frustum (conservative test)
// Returns true if AABB is at least partially inside frustum
fn aabbInFrustum(minBounds: vec3f, maxBounds: vec3f) -> bool {
  // For each frustum plane, find the corner of the AABB
  // that is most in the direction of the plane normal.
  // If that corner is behind the plane, the AABB is culled.
  
  for (var i = 0u; i < 6u; i++) {
    let plane = uniforms.frustumPlanes[i];
    
    // Find positive vertex (the corner most aligned with plane normal)
    var positiveVertex = minBounds;
    if (plane.x >= 0.0) { positiveVertex.x = maxBounds.x; }
    if (plane.y >= 0.0) { positiveVertex.y = maxBounds.y; }
    if (plane.z >= 0.0) { positiveVertex.z = maxBounds.z; }
    
    // If positive vertex is behind plane, AABB is fully outside
    if (!pointOnPositiveSide(plane, positiveVertex)) {
      return false;
    }
  }
  
  return true;
}

// Calculate morph factor based on distance
fn calculateMorphFactor(center: vec3f, size: f32, lodLevel: f32) -> f32 {
  let dx = center.x - uniforms.cameraPosition.x;
  let dz = center.z - uniforms.cameraPosition.z;
  let distance = sqrt(dx * dx + dz * dz);
  
  // LOD transition distances
  let lodThreshold = size * 2.0;
  let transitionStart = lodThreshold * 0.7;
  let transitionEnd = lodThreshold * 1.0;
  
  // Morph factor ramps from 0 to 1 as we approach the threshold
  let morph = saturate((distance - transitionStart) / (transitionEnd - transitionStart));
  
  return morph;
}

// ============================================================================
// Compute Shader
// ============================================================================

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let nodeIndex = globalId.x;
  
  // Bounds check
  if (nodeIndex >= uniforms.nodeCount) {
    return;
  }
  
  let node = inputNodes[nodeIndex];
  
  // Extract data
  let minBounds = node.minBounds.xyz;
  let maxBounds = node.maxBounds.xyz;
  let lodLevel = node.minBounds.w;
  let morphFactor = node.maxBounds.w;
  let centerXZ = node.centerXZ;
  let size = node.size;
  
  // Frustum culling test
  if (!aabbInFrustum(minBounds, maxBounds)) {
    return; // Culled
  }
  
  // Node is visible - add to output buffer
  // Use atomic to get unique index
  let outputIndex = atomicAdd(&drawArgs.instanceCount, 1u);
  
  // Calculate grid scale (world units per vertex)
  let gridSize = 65.0; // Match CDLODRendererGPU gridSize
  let scale = size / (gridSize - 1.0);
  
  // Recalculate morph based on current camera position (optional)
  // This ensures morph is always up-to-date even if CPU data is stale
  let center3D = vec3f(centerXZ.x, (minBounds.y + maxBounds.y) * 0.5, centerXZ.y);
  let dynamicMorph = calculateMorphFactor(center3D, size, lodLevel);
  
  // Write output node
  visibleNodes[outputIndex].offsetX = centerXZ.x;
  visibleNodes[outputIndex].offsetZ = centerXZ.y;
  visibleNodes[outputIndex].scale = scale;
  visibleNodes[outputIndex].morph = dynamicMorph;
  visibleNodes[outputIndex].lod = lodLevel;
}

// ============================================================================
// Reset Shader
// ============================================================================

// Separate shader to reset the instance count before culling
@compute @workgroup_size(1)
fn reset_draw_args() {
  atomicStore(&drawArgs.instanceCount, 0u);
}
