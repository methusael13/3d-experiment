/**
 * cloud-temporal.wgsl — Temporal reprojection for volumetric clouds
 *
 * Phase 3: Merges the current half-resolution checkerboard cloud result with
 * the previous frame's history buffer.
 *
 * Key design decisions:
 * - Uses neighborhood clamping (AABB) to reject stale history, preventing ghosting
 * - For non-marched checkerboard pixels, reconstructs from spatial neighbors ONLY
 *   (no history dependency for non-marched pixels — avoids stretching artifacts)
 * - Blend weight is kept moderate (0.6-0.7) to allow fast convergence during motion
 *
 * Output: rgba16float texture matching the cloud ray march resolution (half-res)
 *   RGB = temporally filtered scattered light
 *   A   = temporally filtered transmittance
 */

struct TemporalUniforms {
  resolution: vec2u,        // [0..7]   Half-res dimensions
  frameIndex: u32,          // [8..11]  Frame counter (for checkerboard pattern)
  blendWeight: f32,         // [12..15] History blend weight (0.7 = 70% history)
  fullResolution: vec2u,    // [16..23] Full viewport resolution
  checkerboard: u32,        // [24..27] 1 = checkerboard enabled
  _pad0: f32,               // [28..31]
}

@group(0) @binding(0) var<uniform> u: TemporalUniforms;
@group(0) @binding(1) var currentTexture: texture_2d<f32>;  // Current frame ray march output
@group(0) @binding(2) var historyTexture: texture_2d<f32>;  // Previous frame result (ping-pong)
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba16float, write>;

// ========== Checkerboard Pattern ==========

/// Returns true if this pixel was ray-marched this frame.
fn wasMarchedThisFrame(coord: vec2u, frameIndex: u32) -> bool {
  return ((coord.x + coord.y + frameIndex) % 2u) == 0u;
}

// ========== Neighborhood Statistics ==========

/// Compute the min/max AABB of the 3×3 neighborhood from marched pixels only.
/// Returns (minVal, maxVal). If no valid neighbors found, returns wide range.
fn neighborhoodAABB(center: vec2u) -> array<vec4f, 2> {
  let dims = textureDimensions(currentTexture);
  var minVal = vec4f(1e10);
  var maxVal = vec4f(-1e10);
  var validCount = 0u;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let sx = clamp(i32(center.x) + dx, 0, i32(dims.x) - 1);
      let sy = clamp(i32(center.y) + dy, 0, i32(dims.y) - 1);
      let coord = vec2u(u32(sx), u32(sy));
      // Only consider pixels that were actually marched this frame
      if (wasMarchedThisFrame(coord, u.frameIndex) || u.checkerboard == 0u) {
        let sample = textureLoad(currentTexture, coord, 0);
        minVal = min(minVal, sample);
        maxVal = max(maxVal, sample);
        validCount += 1u;
      }
    }
  }

  // If we found no valid marched neighbors (unlikely), use current pixel
  if (validCount == 0u) {
    let fallback = textureLoad(currentTexture, center, 0);
    return array<vec4f, 2>(fallback, fallback);
  }

  // Expand AABB slightly to allow minor temporal variations
  let margin = (maxVal - minVal) * 0.15;
  return array<vec4f, 2>(minVal - margin, maxVal + margin);
}

// ========== Spatial Reconstruction ==========

/// For non-marched pixels: reconstruct purely from spatial neighbors (marched this frame).
/// Uses distance-weighted average of the 4 cardinal marched neighbors.
fn spatialReconstruct(center: vec2u) -> vec4f {
  let dims = textureDimensions(currentTexture);
  var sum = vec4f(0.0);
  var weight = 0.0;

  let offsets = array<vec2i, 4>(
    vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1)
  );

  for (var i = 0; i < 4; i++) {
    let nx = i32(center.x) + offsets[i].x;
    let ny = i32(center.y) + offsets[i].y;
    if (nx >= 0 && nx < i32(dims.x) && ny >= 0 && ny < i32(dims.y)) {
      let neighborCoord = vec2u(u32(nx), u32(ny));
      if (wasMarchedThisFrame(neighborCoord, u.frameIndex)) {
        let sample = textureLoad(currentTexture, neighborCoord, 0);
        sum += sample;
        weight += 1.0;
      }
    }
  }

  if (weight > 0.0) {
    return sum / weight;
  }

  // Fallback: use history as last resort
  return textureLoad(historyTexture, center, 0);
}

// ========== Main ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelCoord = globalId.xy;
  if (pixelCoord.x >= u.resolution.x || pixelCoord.y >= u.resolution.y) {
    return;
  }

  let current = textureLoad(currentTexture, pixelCoord, 0);
  let history = textureLoad(historyTexture, pixelCoord, 0);

  // If checkerboard is disabled, just do simple temporal blend with clamping
  if (u.checkerboard == 0u) {
    let aabb = neighborhoodAABB(pixelCoord);
    let clamped = clamp(history, aabb[0], aabb[1]);
    let blended = mix(current, clamped, u.blendWeight * 0.5);
    textureStore(outputTexture, pixelCoord, blended);
    return;
  }

  let marched = wasMarchedThisFrame(pixelCoord, u.frameIndex);

  if (marched) {
    // This pixel was freshly ray-marched.
    // Blend with AABB-clamped history for temporal stability.
    let aabb = neighborhoodAABB(pixelCoord);
    let clamped = clamp(history, aabb[0], aabb[1]);

    // Use moderate blend weight — enough to smooth noise but not so much that
    // it causes ghosting during camera motion
    let blended = mix(current, clamped, u.blendWeight);
    textureStore(outputTexture, pixelCoord, blended);
  } else {
    // This pixel was NOT ray-marched this frame.
    // Reconstruct from spatial neighbors (marched pixels in cardinal directions).
    // This avoids relying on history which can be stale after camera motion.
    let reconstructed = spatialReconstruct(pixelCoord);

    // Light history blend for temporal smoothness, but spatial reconstruction dominates
    let aabb = neighborhoodAABB(pixelCoord);
    let clamped = clamp(history, aabb[0], aabb[1]);
    let blended = mix(reconstructed, clamped, u.blendWeight * 0.4);
    textureStore(outputTexture, pixelCoord, blended);
  }
}
