// Heightmap Normalization — Two-Pass Compute Shader
//
// Pass 1 (reduceMinMax): Parallel reduction to find min/max values across the heightmap.
//   Each workgroup reduces a tile to a single min/max pair, written to a storage buffer.
//
// Pass 2 (normalize): Reads the global min/max from the buffer and remaps all
//   heightmap values from [actual_min, actual_max] → [-0.5, 0.5].
//
// This ensures the composited heightmap stays in the expected normalized range
// regardless of how many layers are stacked with additive blending.

// ============================================================================
// Pass 1: Parallel Min/Max Reduction
// ============================================================================

// Workgroup size for reduction pass
// Each workgroup processes TILE_SIZE × TILE_SIZE texels
const TILE_SIZE: u32 = 16u;
const WORKGROUP_ELEMENTS: u32 = 256u; // TILE_SIZE * TILE_SIZE

// Shared memory for workgroup reduction
var<workgroup> sharedMin: array<f32, WORKGROUP_ELEMENTS>;
var<workgroup> sharedMax: array<f32, WORKGROUP_ELEMENTS>;

struct MinMaxResult {
  minVal: f32,
  maxVal: f32,
}

// Storage buffer for per-workgroup min/max results
// Size = ceil(width / TILE_SIZE) * ceil(height / TILE_SIZE) elements
@group(0) @binding(0) var inputHeightmap: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> minMaxBuffer: array<MinMaxResult>;

@compute @workgroup_size(TILE_SIZE, TILE_SIZE, 1)
fn reduceMinMax(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIdx: u32,
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(num_workgroups) numWorkgroups: vec3u,
) {
  let dims = textureDimensions(inputHeightmap);

  // Load texel value (out-of-bounds texels get neutral values)
  var val: f32 = 0.0;
  if (globalId.x < dims.x && globalId.y < dims.y) {
    val = textureLoad(inputHeightmap, vec2i(globalId.xy), 0).r;
  }

  // Initialize shared memory
  sharedMin[localIdx] = select(val, 1e10, globalId.x >= dims.x || globalId.y >= dims.y);
  sharedMax[localIdx] = select(val, -1e10, globalId.x >= dims.x || globalId.y >= dims.y);
  workgroupBarrier();

  // Parallel reduction within workgroup
  var stride: u32 = WORKGROUP_ELEMENTS / 2u;
  while (stride > 0u) {
    if (localIdx < stride) {
      sharedMin[localIdx] = min(sharedMin[localIdx], sharedMin[localIdx + stride]);
      sharedMax[localIdx] = max(sharedMax[localIdx], sharedMax[localIdx + stride]);
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  // Thread 0 writes workgroup result
  if (localIdx == 0u) {
    let wgIndex = workgroupId.y * numWorkgroups.x + workgroupId.x;
    minMaxBuffer[wgIndex] = MinMaxResult(sharedMin[0], sharedMax[0]);
  }
}

// ============================================================================
// Pass 2: Final Reduction + Normalize
// ============================================================================

// For the final reduction, we read the per-workgroup results and find global min/max,
// then normalize the heightmap in a single pass.
//
// We use a two-binding approach:
// - binding 0: the per-workgroup MinMaxResult buffer (from pass 1)
// - binding 1: input heightmap (to read)
// - binding 2: output heightmap (to write, normalized)
// - binding 3: uniform with totalWorkgroups count

struct NormalizeParams {
  totalWorkgroups: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> minMaxResults: array<MinMaxResult>;
@group(0) @binding(1) var normalizeInput: texture_2d<f32>;
@group(0) @binding(2) var normalizeOutput: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> normalizeParams: NormalizeParams;

// Shared memory for final min/max reduction across all workgroup results
// We process up to 1024 workgroup results in a single workgroup
const MAX_WG_RESULTS: u32 = 1024u;
var<workgroup> finalMin: array<f32, MAX_WG_RESULTS>;
var<workgroup> finalMax: array<f32, MAX_WG_RESULTS>;
var<workgroup> globalMin: f32;
var<workgroup> globalMax: f32;

@compute @workgroup_size(8, 8, 1)
fn normalize(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIdx: u32,
) {
  let dims = textureDimensions(normalizeInput);
  let totalWG = normalizeParams.totalWorkgroups;

  // Step 1: Thread 0 of each workgroup does a serial scan of the
  // min/max buffer to find global min/max. This is fast because
  // totalWorkgroups is typically small (e.g., 64×64 = 4096 for 1024² at tile=16).
  // For even a 4K heightmap with tile=16, that's 256×256 = 65536 entries — still fast serially
  // in a single thread (memory-bound, ~65K reads).
  //
  // A better approach for very large buffers would be another parallel reduction,
  // but for typical terrain sizes this is negligible.
  if (localIdx == 0u) {
    var gMin: f32 = 1e10;
    var gMax: f32 = -1e10;
    for (var i: u32 = 0u; i < totalWG; i++) {
      let r = minMaxResults[i];
      gMin = min(gMin, r.minVal);
      gMax = max(gMax, r.maxVal);
    }
    globalMin = gMin;
    globalMax = gMax;
  }
  workgroupBarrier();

  // Step 2: Normalize this texel
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }

  let gMin = globalMin;
  let gMax = globalMax;
  let range = gMax - gMin;

  let rawHeight = textureLoad(normalizeInput, vec2i(globalId.xy), 0).r;

  // Three-tier normalization strategy to preserve detail:
  //
  // Case 1: Already in [-0.5, 0.5] → pass through unchanged (zero detail loss)
  // Case 2: Range ≤ 1.0 but shifted → translate only (zero detail loss)
  // Case 3: Range > 1.0 → must rescale (some detail compression, unavoidable)

  var normalizedHeight: f32;
  if (range < 1e-8) {
    // Flat heightmap — just center at 0
    normalizedHeight = 0.0;
  } else if (gMin >= -0.5 && gMax <= 0.5) {
    // Case 1: Already in range — no transformation needed
    normalizedHeight = rawHeight;
  } else if (range <= 1.0) {
    // Case 2: Range fits in [-0.5, 0.5] but is shifted — translate only
    // Shift the midpoint to 0.0, preserving all relative height differences exactly
    let midpoint = (gMin + gMax) * 0.5;
    normalizedHeight = rawHeight - midpoint;
  } else {
    // Case 3: Range exceeds 1.0 — must rescale to fit
    normalizedHeight = ((rawHeight - gMin) / range) - 0.5;
  }

  textureStore(normalizeOutput, vec2i(globalId.xy), vec4f(normalizedHeight, 0.0, 0.0, 1.0));
}
