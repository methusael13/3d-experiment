/**
 * cloud-temporal.wgsl — Temporal reprojection for volumetric clouds
 *
 * Phase 3: Merges the current half-resolution checkerboard cloud result with
 * the previous frame's history buffer using motion-vector-based reprojection.
 *
 * Key design decisions:
 * - Generates per-pixel screen-space motion vectors from depth reconstruction +
 *   prevViewProj / inverseViewProj matrices (no separate motion vector texture)
 * - Uses neighborhood clamping (AABB) to reject stale history, preventing ghosting
 * - For non-marched checkerboard pixels, reconstructs from reprojected history
 *   with spatial neighbor fallback when history is invalid
 * - Blend weight is kept moderate (0.6-0.7) to allow fast convergence during motion
 *
 * Output: rgba16float texture matching the cloud ray march resolution (half-res)
 *   RGB = temporally filtered scattered light
 *   A   = temporally filtered transmittance
 */

struct TemporalUniforms {
  resolution: vec2u,            // [0..7]   Half-res dimensions
  frameIndex: u32,              // [8..11]  Frame counter (for checkerboard pattern)
  blendWeight: f32,             // [12..15] History blend weight (0.7 = 70% history)
  fullResolution: vec2u,        // [16..23] Full viewport resolution
  checkerboard: u32,            // [24..27] 1 = checkerboard enabled
  _pad0: f32,                   // [28..31]
  prevViewProj: mat4x4f,        // [32..95]  Previous frame's view-projection matrix
  inverseViewProj: mat4x4f,     // [96..159] Current frame's inverse view-projection matrix
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

// ========== Motion Vector Generation ==========

/// Compute screen-space motion vector for a pixel by reconstructing its world
/// position from the current inverse VP, then projecting through the previous VP.
/// Returns the UV offset (currentUV - previousUV) in half-res texture space.
fn computeMotionVector(pixelCoord: vec2u) -> vec2f {
  // Current pixel UV in [0, 1]
  let uv = (vec2f(pixelCoord) + 0.5) / vec2f(u.resolution);
  let ndc = uv * 2.0 - 1.0;

  // Reconstruct world position from current frame's inverse VP
  // Use clip z=1 (far plane) since clouds are at sky distance.
  // Flip Y for NDC (clip space Y goes up, screen Y goes down)
  let clipPos = vec4f(ndc.x, -ndc.y, 1.0, 1.0);
  let worldPos4 = u.inverseViewProj * clipPos;
  let worldPos = worldPos4.xyz / worldPos4.w;

  // Project world position through previous frame's VP matrix
  let prevClip = u.prevViewProj * vec4f(worldPos, 1.0);
  let prevNDC = prevClip.xy / prevClip.w;
  // Convert back to UV space (flip Y back)
  let prevUV = vec2f(prevNDC.x, -prevNDC.y) * 0.5 + 0.5;

  // Motion vector = where this pixel was in the previous frame
  return prevUV - uv;
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

// ========== Reprojected History Sampling ==========

/// Sample the history texture at the reprojected UV location using bilinear interpolation.
/// Returns (sample, isValid) where isValid = false if the reprojected UV is out of bounds.
fn sampleReprojectedHistory(pixelCoord: vec2u, motionVector: vec2f) -> vec4f {
  let uv = (vec2f(pixelCoord) + 0.5) / vec2f(u.resolution);
  let prevUV = uv + motionVector;

  // Check bounds — reject if the reprojected UV is outside [0, 1]
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    // Return a sentinel value — caller checks via separate bounds test
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // Convert UV to pixel coordinates for bilinear sampling
  let prevPixelF = prevUV * vec2f(u.resolution) - 0.5;
  let prevPixel = vec2i(floor(prevPixelF));
  let frac = prevPixelF - vec2f(prevPixel);

  let dims = vec2i(u.resolution);

  // Gather 4 nearest pixels (clamp to bounds)
  let p00 = vec2u(vec2i(clamp(prevPixel.x, 0, dims.x - 1), clamp(prevPixel.y, 0, dims.y - 1)));
  let p10 = vec2u(vec2i(clamp(prevPixel.x + 1, 0, dims.x - 1), clamp(prevPixel.y, 0, dims.y - 1)));
  let p01 = vec2u(vec2i(clamp(prevPixel.x, 0, dims.x - 1), clamp(prevPixel.y + 1, 0, dims.y - 1)));
  let p11 = vec2u(vec2i(clamp(prevPixel.x + 1, 0, dims.x - 1), clamp(prevPixel.y + 1, 0, dims.y - 1)));

  let s00 = textureLoad(historyTexture, p00, 0);
  let s10 = textureLoad(historyTexture, p10, 0);
  let s01 = textureLoad(historyTexture, p01, 0);
  let s11 = textureLoad(historyTexture, p11, 0);

  // Bilinear interpolation
  let top = mix(s00, s10, frac.x);
  let bottom = mix(s01, s11, frac.x);
  return mix(top, bottom, frac.y);
}

/// Returns true if the reprojected UV is within valid screen bounds.
fn isReprojectionValid(pixelCoord: vec2u, motionVector: vec2f) -> bool {
  let uv = (vec2f(pixelCoord) + 0.5) / vec2f(u.resolution);
  let prevUV = uv + motionVector;
  return prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0;
}

// ========== Main ==========

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let pixelCoord = globalId.xy;
  if (pixelCoord.x >= u.resolution.x || pixelCoord.y >= u.resolution.y) {
    return;
  }

  let current = textureLoad(currentTexture, pixelCoord, 0);

  // Compute per-pixel motion vector from VP delta
  let motionVector = computeMotionVector(pixelCoord);
  let reprojValid = isReprojectionValid(pixelCoord, motionVector);

  // Sample reprojected history (bilinear at motion-corrected location)
  var history: vec4f;
  if (reprojValid) {
    history = sampleReprojectedHistory(pixelCoord, motionVector);
  } else {
    // No valid history — will use current frame data only
    history = current;
  }

  // If checkerboard is disabled, just do simple temporal blend with clamping
  if (u.checkerboard == 0u) {
    let aabb = neighborhoodAABB(pixelCoord);
    let clamped = clamp(history, aabb[0], aabb[1]);
    let blendFactor = select(0.0, u.blendWeight * 0.5, reprojValid);
    let blended = mix(current, clamped, blendFactor);
    textureStore(outputTexture, pixelCoord, blended);
    return;
  }

  let marched = wasMarchedThisFrame(pixelCoord, u.frameIndex);

  if (marched) {
    // This pixel was freshly ray-marched.
    // Blend with AABB-clamped, motion-reprojected history for temporal stability.
    let aabb = neighborhoodAABB(pixelCoord);
    let clamped = clamp(history, aabb[0], aabb[1]);

    // Use moderate blend weight — enough to smooth noise but not so much that
    // it causes ghosting during camera motion. Reduce blend if reprojection is invalid.
    let blendFactor = select(0.0, u.blendWeight, reprojValid);
    let blended = mix(current, clamped, blendFactor);
    textureStore(outputTexture, pixelCoord, blended);
  } else {
    // This pixel was NOT ray-marched this frame.
    // Use motion-reprojected history as the primary source, with spatial
    // reconstruction as fallback when history is invalid.
    if (reprojValid) {
      // Clamp reprojected history against the neighborhood of marched pixels
      let aabb = neighborhoodAABB(pixelCoord);
      let clamped = clamp(history, aabb[0], aabb[1]);

      // Blend reprojected history with spatial reconstruction for robustness
      let spatial = spatialReconstruct(pixelCoord);
      let blended = mix(spatial, clamped, 0.7);
      textureStore(outputTexture, pixelCoord, blended);
    } else {
      // No valid history — fall back to pure spatial reconstruction
      let reconstructed = spatialReconstruct(pixelCoord);
      textureStore(outputTexture, pixelCoord, reconstructed);
    }
  }
}
