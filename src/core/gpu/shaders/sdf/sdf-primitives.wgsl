/**
 * SDF Primitive Stamping Shader (Phase G3)
 * 
 * For each voxel, computes the minimum signed distance to all scene primitives
 * (boxes, spheres, capsules) and min's it with the existing SDF value (terrain).
 * This allows mesh objects to "stamp" their approximate shapes into the distance field.
 */

struct PrimitiveUniforms {
  // vec4: center.xyz, resolution
  centerRes: vec4f,
  // vec4: extent.xyz, voxelSize
  extentVoxel: vec4f,
  // vec4: primitiveCount, pad, pad, pad
  counts: vec4u,
}

// Packed primitive data: 3 vec4s per primitive
// vec4[0]: center.xyz, type (0=sphere, 1=box, 2=capsule)
// vec4[1]: extents.xyz, pad
struct PackedPrimitive {
  centerType: vec4f,
  extents: vec4f,
}

@group(0) @binding(0) var sdfTexture: texture_storage_3d<r32float, read_write>;
@group(0) @binding(1) var<uniform> uniforms: PrimitiveUniforms;
@group(0) @binding(2) var<storage, read> primitives: array<PackedPrimitive>;

fn voxelToWorld(gid: vec3u) -> vec3f {
  let center = uniforms.centerRes.xyz;
  let extent = uniforms.extentVoxel.xyz;
  let res = u32(uniforms.centerRes.w);
  let voxelSize = uniforms.extentVoxel.w;
  
  // Map voxel [0, res) to world space: center - extent + (gid + 0.5) * voxelSize
  return center - extent + (vec3f(gid) + 0.5) * voxelSize;
}

// SDF distance functions

fn sdfSphere(p: vec3f, center: vec3f, radius: f32) -> f32 {
  return length(p - center) - radius;
}

fn sdfBox(p: vec3f, center: vec3f, halfExtents: vec3f) -> f32 {
  let d = abs(p - center) - halfExtents;
  return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0);
}

fn sdfCapsule(p: vec3f, center: vec3f, radius: f32, halfHeight: f32) -> f32 {
  // Vertical capsule: line segment from center - (0, halfHeight, 0) to center + (0, halfHeight, 0)
  let pa = p - (center - vec3f(0.0, halfHeight, 0.0));
  let ba = vec3f(0.0, halfHeight * 2.0, 0.0);
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - radius;
}

@compute @workgroup_size(8, 8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = u32(uniforms.centerRes.w);
  if (any(gid >= vec3u(res))) { return; }
  
  let worldPos = voxelToWorld(gid);
  let primCount = uniforms.counts.x;
  
  // Read existing SDF value (terrain distance)
  var minDist = textureLoad(sdfTexture, gid).r;
  
  // Compute min distance to all primitives
  for (var i = 0u; i < primCount; i++) {
    let prim = primitives[i];
    let center = prim.centerType.xyz;
    let primType = u32(prim.centerType.w);
    let extents = prim.extents.xyz;
    
    var dist: f32;
    switch (primType) {
      case 0u: {
        // Sphere: extents.x = radius
        dist = sdfSphere(worldPos, center, extents.x);
      }
      case 1u: {
        // Box: extents = half-extents
        dist = sdfBox(worldPos, center, extents);
      }
      case 2u: {
        // Capsule: extents.x = radius, extents.y = halfHeight
        dist = sdfCapsule(worldPos, center, extents.x, extents.y);
      }
      default: {
        dist = 999.0;
      }
    }
    
    minDist = min(minDist, dist);
  }
  
  textureStore(sdfTexture, gid, vec4f(minDist));
}
