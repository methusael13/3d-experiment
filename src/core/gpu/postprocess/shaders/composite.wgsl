// Final Composite Shader
// Combines scene color with SSAO
// Note: Tonemapping/gamma is currently handled by individual renderers
// A future refactor could centralize this for proper HDR workflow

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var aoTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn fs_composite(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Sample scene color (already tonemapped/gamma corrected by individual renderers)
  let color = textureSample(colorTexture, texSampler, uv);
  
  // Sample AO (0 = full occlusion, 1 = no occlusion)
  let ao = textureSample(aoTexture, texSampler, uv).r;
  
  // Apply AO to darken occluded areas
  // We apply AO after gamma since the color is already in gamma space
  // This is not physically correct but works for the current pipeline
  return vec4f(color.rgb * ao, color.a);
}

// Passthrough version (for when AO is disabled)
@fragment
fn fs_passthrough_copy(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(colorTexture, texSampler, uv);
}
