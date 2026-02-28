/**
 * Pack Metallic-Roughness Compute Shader
 *
 * Combines two grayscale input textures into a single metallicRoughness texture:
 *   R = 0 (unused per glTF spec)
 *   G = roughness (from roughness texture R channel)
 *   B = metallic (from metallic texture R channel)
 *   A = 1
 *
 * If only one texture is provided (the other is a 1x1 placeholder),
 * that channel gets the uniform value (1.0) which the shader multiplies with the material uniform.
 */

@group(0) @binding(0) var metallicTex: texture_2d<f32>;
@group(0) @binding(1) var roughnessTex: texture_2d<f32>;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(outputTex);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }

  let coord = vec2i(gid.xy);
  let metallicVal = textureLoad(metallicTex, coord, 0).r;
  let roughnessVal = textureLoad(roughnessTex, coord, 0).r;

  textureStore(outputTex, coord, vec4f(0.0, roughnessVal, metallicVal, 1.0));
}