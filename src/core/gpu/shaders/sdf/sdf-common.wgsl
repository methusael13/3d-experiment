// SDF Common - Shared structures and utility functions for SDF shaders

struct SDFUniforms {
  center: vec3f,
  resolution: f32,
  extent: vec3f,
  voxelSize: f32,
}

// Convert voxel index to world-space position (center of voxel)
fn voxelToWorld(voxel: vec3u, uniforms: SDFUniforms) -> vec3f {
  let res = uniforms.resolution;
  let normalized = (vec3f(voxel) + 0.5) / res;  // 0..1
  return uniforms.center - uniforms.extent + normalized * uniforms.extent * 2.0;
}

// Convert world-space position to UVW coordinates (0..1) for texture sampling
fn worldToUVW(worldPos: vec3f, uniforms: SDFUniforms) -> vec3f {
  return (worldPos - uniforms.center + uniforms.extent) / (uniforms.extent * 2.0);
}

// Check if UVW is within bounds
fn isInsideBounds(uvw: vec3f) -> bool {
  return all(uvw >= vec3f(0.0)) && all(uvw <= vec3f(1.0));
}
