// Normal Map Generation Compute Shader
// Generates normal map from heightmap using Sobel-like filtering

struct NormalParams {
  texelSize: vec2<f32>,
  heightScale: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> params: NormalParams;
@group(0) @binding(1) var heightmap: texture_2d<f32>;
@group(0) @binding(2) var outputNormals: texture_storage_2d<rgba8snorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let dims = textureDimensions(outputNormals);
  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }
  
  let coord = vec2<i32>(global_id.xy);
  
  // Sample neighboring heights
  let left = textureLoad(heightmap, coord - vec2<i32>(1, 0), 0).r;
  let right = textureLoad(heightmap, coord + vec2<i32>(1, 0), 0).r;
  let down = textureLoad(heightmap, coord - vec2<i32>(0, 1), 0).r;
  let up = textureLoad(heightmap, coord + vec2<i32>(0, 1), 0).r;
  
  // Calculate gradients
  let dx = (right - left) * params.heightScale / (2.0 * params.texelSize.x);
  let dy = (up - down) * params.heightScale / (2.0 * params.texelSize.y);
  
  // Compute normal from gradients
  let normal = normalize(vec3<f32>(-dx, 1.0, -dy));
  
  // Store directly - rgba8snorm format stores [-1,1] range natively
  textureStore(outputNormals, coord, vec4<f32>(normal, 1.0));
}
