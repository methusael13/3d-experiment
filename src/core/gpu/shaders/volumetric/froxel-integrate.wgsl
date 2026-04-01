/**
 * froxel-integrate.wgsl — Front-to-back ray integration (Pass 3)
 *
 * Walks each column of the froxel grid (160×90 columns, 64 depth slices each)
 * front-to-back, accumulating in-scattered light and transmittance.
 *
 * Output: integratedGrid[x,y,z] = (accumulatedScatter.rgb, accumulatedTransmittance)
 * Any pixel can sample this at its depth to get the fog contribution.
 */

const FROXEL_WIDTH: u32 = 160u;
const FROXEL_HEIGHT: u32 = 90u;
const FROXEL_DEPTH: u32 = 64u;

struct IntegrateUniforms {
  near: f32,
  far: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: IntegrateUniforms;
@group(0) @binding(1) var scatterGrid: texture_3d<f32>;
@group(0) @binding(2) var integratedGrid: texture_storage_3d<rgba16float, write>;

fn sliceToDepth(slice: f32) -> f32 {
  return u.near * pow(u.far / u.near, slice / f32(FROXEL_DEPTH));
}

fn sliceThickness(slice: u32) -> f32 {
  let d0 = sliceToDepth(f32(slice));
  let d1 = sliceToDepth(f32(slice + 1u));
  return d1 - d0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= FROXEL_WIDTH || gid.y >= FROXEL_HEIGHT) { return; }

  var accumScatter = vec3f(0.0);
  var accumTransmittance = 1.0;

  for (var z = 0u; z < FROXEL_DEPTH; z++) {
    let data = textureLoad(scatterGrid, vec3u(gid.x, gid.y, z), 0);
    let scattering = data.rgb;
    let extinction = data.a;

    let thickness = sliceThickness(z);
    let sliceT = exp(-extinction * thickness);

    // Energy-conserving integration:
    // in-scattered = scattering × (1 - transmittance) / extinction
    let integScatter = scattering * (1.0 - sliceT) / max(extinction, 0.00001);

    accumScatter += accumTransmittance * integScatter;
    accumTransmittance *= sliceT;

    // Store per-slice so scene shaders can sample at any depth
    textureStore(integratedGrid, vec3u(gid.x, gid.y, z),
                 vec4f(accumScatter, accumTransmittance));
  }
}
