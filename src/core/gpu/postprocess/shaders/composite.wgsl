// Final Composite Shader
// Combines HDR scene color with SSAO and applies tonemapping + gamma correction

// ============ Fullscreen Quad Vertex Shader ============

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (3 vertices cover entire screen)
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

// ============ Uniforms and Textures ============

struct CompositeUniforms {
  tonemapping: u32,  // 0=none, 1=Reinhard, 2=Uncharted2, 3=ACES
  gamma: f32,
  exposure: f32,
  _padding: f32,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var aoTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: CompositeUniforms;

// Reinhard tonemapping
fn tonemap_reinhard(color: vec3f) -> vec3f {
  return color / (color + vec3f(1.0));
}

// ACES filmic tonemapping (more cinematic)
fn tonemap_aces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return saturate((color * (a * color + b)) / (color * (c * color + d) + e));
}

// Uncharted 2 tonemapping
fn tonemap_uncharted2_partial(x: vec3f) -> vec3f {
  let A = 0.15;
  let B = 0.50;
  let C = 0.10;
  let D = 0.20;
  let E = 0.02;
  let F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

fn tonemap_uncharted2(color: vec3f) -> vec3f {
  let W = 11.2; // White point
  let curr = tonemap_uncharted2_partial(color * 2.0);
  let white_scale = vec3f(1.0) / tonemap_uncharted2_partial(vec3f(W));
  return curr * white_scale;
}

// Apply tonemapping based on selected operator
fn apply_tonemapping(color: vec3f) -> vec3f {
  switch (uniforms.tonemapping) {
    case 0u: { return color; }                     // None (linear)
    case 1u: { return tonemap_reinhard(color); }   // Reinhard
    case 2u: { return tonemap_uncharted2(color); } // Uncharted 2
    case 3u: { return tonemap_aces(color); }       // ACES
    default: { return tonemap_aces(color); }
  }
}

// Gamma correction with configurable gamma
fn gamma_correct_configurable(color: vec3f) -> vec3f {
  return pow(color, vec3f(1.0 / uniforms.gamma));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Sample HDR scene color
  let hdr_color = textureSample(colorTexture, texSampler, uv);
  
  // Sample AO (0 = full occlusion, 1 = no occlusion)
  let ao = textureSample(aoTexture, texSampler, uv).r;
  
  // Apply exposure adjustment
  var color = hdr_color.rgb * uniforms.exposure;
  
  // Apply AO in HDR (linear) space before tonemapping
  // Use alpha to control AO strength: 
  // - Where alpha = 1 (fully opaque terrain), apply full AO
  // - Where alpha < 1 (transparent water blend), reduce AO since it was
  //   computed for geometry hidden beneath the water surface
  let ao_strength = mix(1.0, ao, hdr_color.a);
  color = color * ao_strength;
  
  // Apply tonemapping
  color = apply_tonemapping(color);
  
  // Apply gamma correction
  color = gamma_correct_configurable(color);
  
  return vec4f(color, hdr_color.a);
}

// Passthrough version (for when AO is disabled, still applies tonemapping)
@fragment
fn fs_passthrough_copy(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hdr_color = textureSample(colorTexture, texSampler, uv);
  
  // Apply exposure adjustment
  var color = hdr_color.rgb * uniforms.exposure;
  
  // Apply tonemapping
  color = apply_tonemapping(color);
  
  // Apply gamma correction
  color = gamma_correct_configurable(color);
  
  return vec4f(color, hdr_color.a);
}
