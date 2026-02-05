/**
 * Object Shader - Basic lit mesh rendering
 * 
 * Supports:
 * - Per-instance model matrices
 * - Basic directional lighting with ambient
 * - PBR-style albedo/metallic/roughness (simplified)
 */

// ============ Uniforms ============

struct GlobalUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  lightDirection: vec3f,
  _pad1: f32,
  lightColor: vec3f,
  ambientIntensity: f32,
}

struct MaterialUniforms {
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> globals: GlobalUniforms;
@group(0) @binding(1) var<uniform> material: MaterialUniforms;

// Per-instance model matrix (stored in storage buffer for flexibility)
@group(1) @binding(0) var<storage, read> instanceModels: array<mat4x4f>;

// ============ Vertex Shader ============

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @builtin(instance_index) instanceIndex: u32,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) uv: vec2f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Get model matrix for this instance
  let model = instanceModels[input.instanceIndex];
  
  // Transform position to world space
  let worldPos = model * vec4f(input.position, 1.0);
  output.worldPosition = worldPos.xyz;
  
  // Transform to clip space
  output.clipPosition = globals.viewProjection * worldPos;
  
  // Transform normal to world space (assuming uniform scale)
  // For non-uniform scale, we'd need inverse transpose
  let normalMatrix = mat3x3f(
    model[0].xyz,
    model[1].xyz,
    model[2].xyz
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  
  output.uv = input.uv;
  
  return output;
}

// ============ Fragment Shader ============

// Simplified PBR-ish lighting
fn calcLighting(
  N: vec3f,
  V: vec3f,
  L: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  lightColor: vec3f,
  ambient: f32
) -> vec3f {
  let NdotL = max(dot(N, L), 0.0);
  
  // Diffuse (Lambert)
  let diffuse = albedo * NdotL * lightColor;
  
  // Ambient (hemisphere approximation)
  let skyColor = vec3f(0.4, 0.6, 1.0);
  let groundColor = vec3f(0.3, 0.25, 0.2);
  let hemisphere = mix(groundColor, skyColor, N.y * 0.5 + 0.5);
  let ambientLight = albedo * hemisphere * ambient;
  
  // Simple specular (Blinn-Phong for now)
  let H = normalize(L + V);
  let NdotH = max(dot(N, H), 0.0);
  let shininess = mix(16.0, 256.0, 1.0 - roughness);
  let specular = lightColor * pow(NdotH, shininess) * (1.0 - roughness) * 0.5;
  
  // Metallic reduces diffuse, increases specular tint
  let finalDiffuse = diffuse * (1.0 - metallic);
  let finalSpecular = specular * mix(vec3f(1.0), albedo, metallic);
  
  return finalDiffuse + finalSpecular + ambientLight;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let N = normalize(input.worldNormal);
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);
  
  let color = calcLighting(
    N, V, L,
    material.albedo,
    material.metallic,
    material.roughness,
    globals.lightColor,
    globals.ambientIntensity
  );
  
  // Output linear HDR - tonemapping and gamma applied in composite pass
  return vec4f(color, 1.0);
}

// ============ Single Instance Variant ============
// For objects without instancing (uses push constant or single model)

struct SingleModelUniforms {
  model: mat4x4f,
}

@group(1) @binding(0) var<uniform> singleModel: SingleModelUniforms;

@vertex
fn vs_single(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Transform position to world space
  let worldPos = singleModel.model * vec4f(input.position, 1.0);
  output.worldPosition = worldPos.xyz;
  
  // Transform to clip space
  output.clipPosition = globals.viewProjection * worldPos;
  
  // Transform normal
  let normalMatrix = mat3x3f(
    singleModel.model[0].xyz,
    singleModel.model[1].xyz,
    singleModel.model[2].xyz
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  
  output.uv = input.uv;
  
  return output;
}
