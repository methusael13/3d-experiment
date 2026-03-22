/**
 * Channel Pack Compute Shader
 * 
 * Generic N-channel packer: composes up to 4 input textures into a single
 * RGBA output texture. Each input channel can come from a separate texture's
 * R channel, or use a scalar fallback value.
 * 
 * Supports presets:
 * - Metallic-Roughness: R=0, G=roughness, B=metallic, A=1
 * - ARM: R=AO, G=roughness, B=metallic, A=1
 * - Custom: user-defined per-channel mapping
 *
 * Uniform layout (Params):
 *   vec4(hasR, hasG, hasB, hasA)      — 1.0 if texture is bound, 0.0 = use scalar
 *   vec4(scalarR, scalarG, scalarB, scalarA) — fallback scalar values
 *   vec4(swizzleR, swizzleG, swizzleB, swizzleA) — source channel index (0=R,1=G,2=B,3=A)
 */

struct Params {
  // vec4(hasR, hasG, hasB, hasA)
  hasChannel: vec4f,
  // vec4(scalarR, scalarG, scalarB, scalarA)
  scalarValues: vec4f,
  // vec4(swizzleR, swizzleG, swizzleB, swizzleA) — which channel to read from input
  swizzle: vec4f,
}

@group(0) @binding(0) var inputR: texture_2d<f32>;
@group(0) @binding(1) var inputG: texture_2d<f32>;
@group(0) @binding(2) var inputB: texture_2d<f32>;
@group(0) @binding(3) var inputA: texture_2d<f32>;
@group(0) @binding(4) var outputTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> params: Params;

fn sampleChannel(tex: texture_2d<f32>, coord: vec2i, swizzleIdx: f32) -> f32 {
  let sample = textureLoad(tex, coord, 0);
  let idx = u32(swizzleIdx);
  switch (idx) {
    case 0u: { return sample.r; }
    case 1u: { return sample.g; }
    case 2u: { return sample.b; }
    case 3u: { return sample.a; }
    default: { return sample.r; }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(outputTex);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let coord = vec2i(gid.xy);
  
  // Read each channel from its source texture or use scalar fallback
  var r: f32;
  var g: f32;
  var b: f32;
  var a: f32;
  
  if (params.hasChannel.x > 0.5) {
    r = sampleChannel(inputR, coord, params.swizzle.x);
  } else {
    r = params.scalarValues.x;
  }
  
  if (params.hasChannel.y > 0.5) {
    g = sampleChannel(inputG, coord, params.swizzle.y);
  } else {
    g = params.scalarValues.y;
  }
  
  if (params.hasChannel.z > 0.5) {
    b = sampleChannel(inputB, coord, params.swizzle.z);
  } else {
    b = params.scalarValues.z;
  }
  
  if (params.hasChannel.w > 0.5) {
    a = sampleChannel(inputA, coord, params.swizzle.w);
  } else {
    a = params.scalarValues.w;
  }

  textureStore(outputTex, coord, vec4f(r, g, b, a));
}
