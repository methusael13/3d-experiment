// Heightmap Generation Compute Shader
// Generates procedural heightmap using fractional Brownian motion (fBm) noise

struct GenerationParams {
  offset: vec2<f32>,
  scale: vec2<f32>,
  heightScale: f32,
  octaves: u32,
  persistence: f32,
  lacunarity: f32,
}

@group(0) @binding(0) var<uniform> params: GenerationParams;
@group(0) @binding(1) var outputTexture: texture_storage_2d<r32float, write>;

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  
  return mix(
    mix(hash(i + vec2<f32>(0.0, 0.0)), hash(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y
  );
}

fn fbm(p: vec2<f32>) -> f32 {
  var value = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;
  var pos = p;
  
  for (var i = 0u; i < params.octaves; i++) {
    value += amplitude * noise(pos * frequency);
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  
  return value;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let dims = textureDimensions(outputTexture);
  if (global_id.x >= dims.x || global_id.y >= dims.y) {
    return;
  }
  
  let uv = vec2<f32>(f32(global_id.x), f32(global_id.y)) / vec2<f32>(f32(dims.x), f32(dims.y));
  let worldPos = params.offset + uv * params.scale;
  
  let height = fbm(worldPos) * params.heightScale;
  
  textureStore(outputTexture, vec2<i32>(global_id.xy), vec4<f32>(height, 0.0, 0.0, 1.0));
}
