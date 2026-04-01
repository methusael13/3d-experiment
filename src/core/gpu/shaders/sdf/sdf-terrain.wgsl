// SDF Terrain Stamp - Compute signed distance to terrain surface for each voxel
// Each workgroup thread processes one XZ column of voxels

struct TerrainSDFUniforms {
  center: vec3f,
  resolution: f32,
  extent: vec3f,
  voxelSize: f32,
  heightScale: f32,
  terrainWorldSize: f32,
  terrainOriginX: f32,
  terrainOriginZ: f32,
}

@group(0) @binding(0) var sdfTexture: texture_storage_3d<r32float, write>;
@group(0) @binding(1) var<uniform> params: TerrainSDFUniforms;
@group(0) @binding(2) var heightmap: texture_2d<f32>;
@group(0) @binding(3) var heightmapSampler: sampler; // non-filtering (r32float is unfilterable)

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = u32(params.resolution);
  if (gid.x >= res || gid.y >= res) { return; }

  // Compute world-space XZ for this column
  let normalizedX = (f32(gid.x) + 0.5) / f32(res);
  let normalizedZ = (f32(gid.y) + 0.5) / f32(res);

  let worldX = params.center.x - params.extent.x + normalizedX * params.extent.x * 2.0;
  let worldZ = params.center.z - params.extent.z + normalizedZ * params.extent.z * 2.0;

  // Convert world XZ to terrain UV (0..1)
  let terrainUV = vec2f(
    (worldX - params.terrainOriginX) / params.terrainWorldSize,
    (worldZ - params.terrainOriginZ) / params.terrainWorldSize,
  );

  // Sample terrain height via textureLoad (r32float is unfilterable, can't use textureSampleLevel)
  let hmSize = textureDimensions(heightmap, 0);
  let clampedUV = clamp(terrainUV, vec2f(0.0), vec2f(1.0));
  let texelCoord = vec2i(clamp(vec2i(clampedUV * vec2f(hmSize)), vec2i(0), vec2i(hmSize) - vec2i(1)));
  let terrainHeight = textureLoad(heightmap, texelCoord, 0).r * params.heightScale;

  // Check if this XZ is inside the terrain bounds
  let inTerrainBounds = terrainUV.x >= 0.0 && terrainUV.x <= 1.0 && terrainUV.y >= 0.0 && terrainUV.y <= 1.0;

  // For each Y voxel in this column, compute signed distance
  for (var y = 0u; y < res; y++) {
    let normalizedY = (f32(y) + 0.5) / f32(res);
    let worldY = params.center.y - params.extent.y + normalizedY * params.extent.y * 2.0;

    var signedDist: f32;
    if (inTerrainBounds) {
      // Positive = above terrain, negative = inside terrain
      signedDist = worldY - terrainHeight;
    } else {
      // Outside terrain bounds: large positive distance
      signedDist = 999.0;
    }

    textureStore(sdfTexture, vec3u(gid.x, y, gid.y), vec4f(signedDist));
  }
}
