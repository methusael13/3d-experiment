// SDF Clear - Initialize all voxels to maximum distance

const MAX_DISTANCE: f32 = 999.0;

struct ClearUniforms {
  resolution: vec4u,  // x = resolution, yzw = unused
}

@group(0) @binding(0) var sdfTexture: texture_storage_3d<r32float, write>;
@group(0) @binding(1) var<uniform> params: ClearUniforms;

@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = params.resolution.x;
  if (gid.x >= res || gid.y >= res || gid.z >= res) { return; }
  textureStore(sdfTexture, gid, vec4f(MAX_DISTANCE));
}
