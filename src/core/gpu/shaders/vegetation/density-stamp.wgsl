/**
 * Vegetation Density Stamp Compute Shader
 * 
 * Reads spawned vegetation instance buffers and stamps each instance's
 * world XZ position into a density texture. This texture is then sampled
 * by the CDLOD terrain shader to darken the ground beneath vegetation.
 * 
 * Uses atomic operations on a u32 storage buffer (accumulation buffer),
 * which is then normalized into an r8unorm texture in a second pass.
 * 
 * Two entry points:
 *   - stampInstances: Reads instance buffer, atomically increments density texels
 *   - normalizeToTexture: Converts accumulated u32 counts to normalized [0,1] density
 */

// ==================== Stamp Pass ====================

struct StampParams {
  terrainSize: f32,        // Total terrain world size
  texelResolution: f32,    // Density map resolution (e.g., 512)
  instanceCount: u32,      // Number of instances to process
  splatRadius: u32,        // Radius in texels for each instance stamp (0 = single texel)
}

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world position, w = scale
  rotationAndType: vec4f,   // x = rotation, y = variant, z = renderFlag, w = unused
}

@group(0) @binding(0) var<uniform> params: StampParams;
@group(0) @binding(1) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(2) var<storage, read> spawnCounters: array<u32>;
@group(0) @binding(3) var<storage, read_write> accumBuffer: array<atomic<u32>>;

/**
 * Convert world XZ to density map texel coordinates.
 * Terrain is centered at origin: world range is [-terrainSize/2, terrainSize/2]
 */
fn worldToTexel(worldXZ: vec2f) -> vec2i {
  let uv = (worldXZ / params.terrainSize) + 0.5;
  let res = i32(params.texelResolution);
  return vec2i(
    clamp(i32(uv.x * f32(res)), 0, res - 1),
    clamp(i32(uv.y * f32(res)), 0, res - 1)
  );
}

fn texelIndex(coord: vec2i) -> u32 {
  return u32(coord.y) * u32(params.texelResolution) + u32(coord.x);
}

@compute @workgroup_size(256)
fn stampInstances(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  
  // Bounds check — use actual spawn count from GPU counter
  let actualCount = min(spawnCounters[0], params.instanceCount);
  if (idx >= actualCount) {
    return;
  }
  
  let inst = instances[idx];
  let worldPos = inst.positionAndScale.xyz;
  let scale = inst.positionAndScale.w;
  
  let center = worldToTexel(worldPos.xz);
  let radius = i32(params.splatRadius);
  let res = i32(params.texelResolution);
  
  // Splat a small kernel around the instance position
  // Weight falls off with distance for a smooth density field
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      let tx = center.x + dx;
      let ty = center.y + dy;
      
      // Bounds check
      if (tx < 0 || tx >= res || ty < 0 || ty >= res) {
        continue;
      }
      
      // Distance-based weight (1 at center, 0 at edge)
      let dist = length(vec2f(f32(dx), f32(dy)));
      if (dist > f32(radius) + 0.5) {
        continue;
      }
      
      // Weight: higher for larger plants, falloff with distance
      let distWeight = select(
        1.0 - dist / (f32(radius) + 1.0),
        1.0,
        radius == 0
      );
      let weight = u32(max(distWeight * scale * 4.0, 1.0));
      
      let tIdx = texelIndex(vec2i(tx, ty));
      atomicAdd(&accumBuffer[tIdx], weight);
    }
  }
}

// ==================== Normalize Pass ====================

struct NormalizeParams {
  texelResolution: f32,
  maxCount: f32,      // Maximum expected count per texel (for normalization)
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> normParams: NormalizeParams;
@group(0) @binding(1) var<storage, read> accumBufferRead: array<u32>;
@group(0) @binding(2) var densityOut: texture_storage_2d<r8unorm, write>;

@compute @workgroup_size(8, 8)
fn normalizeToTexture(@builtin(global_invocation_id) gid: vec3u) {
  let res = u32(normParams.texelResolution);
  if (gid.x >= res || gid.y >= res) {
    return;
  }
  
  let idx = gid.y * res + gid.x;
  let rawCount = f32(accumBufferRead[idx]);
  
  // Normalize: saturate to [0, 1] using maxCount as the full-density reference
  let density = saturate(rawCount / max(normParams.maxCount, 1.0));
  
  // Apply a smooth curve for more natural-looking darkening
  // (square root makes low density more visible)
  let smoothDensity = sqrt(density);
  
  textureStore(densityOut, vec2i(gid.xy), vec4f(smoothDensity, 0.0, 0.0, 1.0));
}
