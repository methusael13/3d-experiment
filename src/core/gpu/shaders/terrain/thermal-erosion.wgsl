// Thermal Erosion Compute Shader
// Simulates material movement due to gravity when slopes exceed the angle of repose
//
// Algorithm:
// 1. For each cell, compare height to 8 neighbors
// 2. If slope exceeds talus angle, move sediment downhill
// 3. Material flows to lower neighbors proportionally

struct ThermalParams {
  talusAngle: f32,        // Maximum stable slope angle (tangent, e.g., 0.7 for ~35°)
  erosionRate: f32,       // How much material moves per iteration
  iterations: u32,        // Number of iterations per dispatch
  mapSize: u32,           // Heightmap resolution
}

@group(0) @binding(0) var<uniform> params: ThermalParams;
@group(0) @binding(1) var heightmapIn: texture_2d<f32>;
@group(0) @binding(2) var heightmapOut: texture_storage_2d<r32float, write>;

// ============================================================================
// Neighbor Offsets
// ============================================================================

const NEIGHBOR_COUNT: u32 = 8u;
const NEIGHBOR_OFFSETS: array<vec2i, 8> = array<vec2i, 8>(
  vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1),
  vec2i(-1,  0),               vec2i(1,  0),
  vec2i(-1,  1), vec2i(0,  1), vec2i(1,  1)
);

// Distances for diagonal vs cardinal neighbors
const NEIGHBOR_DISTANCES: array<f32, 8> = array<f32, 8>(
  1.414, 1.0, 1.414,
  1.0,        1.0,
  1.414, 1.0, 1.414
);

// ============================================================================
// Thermal Erosion Logic
// ============================================================================

fn getHeight(pos: vec2i) -> f32 {
  let dims = textureDimensions(heightmapIn);
  let clampedPos = clamp(pos, vec2i(0), vec2i(dims) - 1);
  return textureLoad(heightmapIn, clampedPos, 0).r;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let pos = vec2i(globalId.xy);
  var currentHeight = getHeight(pos);
  
  // Iterate multiple times per dispatch for better convergence
  for (var iter = 0u; iter < params.iterations; iter++) {
    // Calculate slope differences to all neighbors
    var totalExcessSlope: f32 = 0.0;
    var excessSlopes: array<f32, 8>;
    
    for (var i = 0u; i < NEIGHBOR_COUNT; i++) {
      let neighborPos = pos + NEIGHBOR_OFFSETS[i];
      let neighborHeight = getHeight(neighborPos);
      let dist = NEIGHBOR_DISTANCES[i];
      
      // Calculate slope (height difference / distance)
      let heightDiff = currentHeight - neighborHeight;
      let slope = heightDiff / dist;
      
      // Check if slope exceeds talus angle
      if (slope > params.talusAngle) {
        excessSlopes[i] = slope - params.talusAngle;
        totalExcessSlope += excessSlopes[i];
      } else {
        excessSlopes[i] = 0.0;
      }
    }
    
    // If there's excess slope, move material
    if (totalExcessSlope > 0.0) {
      // Calculate total material to move
      var materialToMove: f32 = 0.0;
      
      for (var i = 0u; i < NEIGHBOR_COUNT; i++) {
        if (excessSlopes[i] > 0.0) {
          // Calculate material moved to this neighbor (proportional to excess slope)
          let proportion = excessSlopes[i] / totalExcessSlope;
          let dist = NEIGHBOR_DISTANCES[i];
          let amount = excessSlopes[i] * dist * 0.5 * params.erosionRate * proportion;
          materialToMove += amount;
        }
      }
      
      // Remove material from current cell
      currentHeight -= materialToMove;
    }
  }
  
  // Write result
  textureStore(heightmapOut, pos, vec4f(currentHeight, 0.0, 0.0, 1.0));
}

// ============================================================================
// Alternative: Parallel-safe thermal erosion with ping-pong buffers
// ============================================================================

// This version reads from one buffer and writes to another, avoiding race conditions
@compute @workgroup_size(8, 8, 1)
fn mainPingPong(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let pos = vec2i(globalId.xy);
  let currentHeight = getHeight(pos);
  
  // Calculate how much material flows INTO this cell from neighbors
  // and how much flows OUT to neighbors
  var inflowAmount: f32 = 0.0;
  var outflowAmount: f32 = 0.0;
  
  for (var i = 0u; i < NEIGHBOR_COUNT; i++) {
    let neighborPos = pos + NEIGHBOR_OFFSETS[i];
    
    // Bounds check
    if (neighborPos.x < 0 || neighborPos.x >= i32(dims.x) ||
        neighborPos.y < 0 || neighborPos.y >= i32(dims.y)) {
      continue;
    }
    
    let neighborHeight = getHeight(neighborPos);
    let dist = NEIGHBOR_DISTANCES[i];
    
    // Calculate slope from neighbor to this cell
    let heightDiffFromNeighbor = neighborHeight - currentHeight;
    let slopeFromNeighbor = heightDiffFromNeighbor / dist;
    
    // Material flows INTO this cell if neighbor is higher and slope exceeds talus
    if (slopeFromNeighbor > params.talusAngle) {
      let excessSlope = slopeFromNeighbor - params.talusAngle;
      inflowAmount += excessSlope * dist * 0.5 * params.erosionRate / 8.0;
    }
    
    // Calculate slope from this cell to neighbor
    let heightDiffToNeighbor = currentHeight - neighborHeight;
    let slopeToNeighbor = heightDiffToNeighbor / dist;
    
    // Material flows OUT of this cell if slope exceeds talus
    if (slopeToNeighbor > params.talusAngle) {
      let excessSlope = slopeToNeighbor - params.talusAngle;
      outflowAmount += excessSlope * dist * 0.5 * params.erosionRate / 8.0;
    }
  }
  
  // Calculate new height
  let newHeight = currentHeight + inflowAmount - outflowAmount;
  
  // Write result
  textureStore(heightmapOut, pos, vec4f(newHeight, 0.0, 0.0, 1.0));
}

// ============================================================================
// Combined erosion pass (thermal + smoothing)
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn mainWithSmoothing(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let pos = vec2i(globalId.xy);
  let currentHeight = getHeight(pos);
  
  // Thermal erosion
  var thermalDelta: f32 = 0.0;
  
  for (var i = 0u; i < NEIGHBOR_COUNT; i++) {
    let neighborPos = pos + NEIGHBOR_OFFSETS[i];
    
    if (neighborPos.x < 0 || neighborPos.x >= i32(dims.x) ||
        neighborPos.y < 0 || neighborPos.y >= i32(dims.y)) {
      continue;
    }
    
    let neighborHeight = getHeight(neighborPos);
    let dist = NEIGHBOR_DISTANCES[i];
    
    // Inflow from higher neighbors
    let heightDiff = neighborHeight - currentHeight;
    let slope = heightDiff / dist;
    
    if (slope > params.talusAngle) {
      let excess = slope - params.talusAngle;
      thermalDelta += excess * dist * 0.5 * params.erosionRate / 8.0;
    }
    
    // Outflow to lower neighbors
    if (slope < -params.talusAngle) {
      let excess = -slope - params.talusAngle;
      thermalDelta -= excess * dist * 0.5 * params.erosionRate / 8.0;
    }
  }
  
  // Apply light smoothing to reduce harsh edges
  var avgNeighborHeight: f32 = 0.0;
  var validNeighbors: u32 = 0u;
  
  for (var i = 0u; i < NEIGHBOR_COUNT; i++) {
    let neighborPos = pos + NEIGHBOR_OFFSETS[i];
    
    if (neighborPos.x >= 0 && neighborPos.x < i32(dims.x) &&
        neighborPos.y >= 0 && neighborPos.y < i32(dims.y)) {
      avgNeighborHeight += getHeight(neighborPos);
      validNeighbors++;
    }
  }
  
  if (validNeighbors > 0u) {
    avgNeighborHeight /= f32(validNeighbors);
  }
  
  // Blend thermal erosion with slight smoothing
  let smoothingFactor: f32 = 0.05;
  let smoothingDelta = (avgNeighborHeight - currentHeight) * smoothingFactor;
  
  let newHeight = currentHeight + thermalDelta + smoothingDelta;
  
  textureStore(heightmapOut, pos, vec4f(newHeight, 0.0, 0.0, 1.0));
}
