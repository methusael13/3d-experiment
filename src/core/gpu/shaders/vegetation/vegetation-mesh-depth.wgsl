/**
 * Vegetation Mesh Depth-Only Shader (Shadow Casting)
 * 
 * Renders vegetation mesh instances to shadow maps.
 * Uses light-space matrix instead of camera view-projection.
 * Alpha cutout for leaf transparency.
 * Distance-based discard to limit shadow cast range.
 */

// ==================== Shared Instance Struct ====================

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (1=mesh), w = reserved
}

// ==================== Uniforms ====================

struct DepthUniforms {
  lightSpaceMatrix: mat4x4f,
  cameraPosition: vec3f,         // Camera world position for distance culling
  shadowCastDistance: f32,        // Max distance from camera for shadow casting
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> uniforms: DepthUniforms;
@group(0) @binding(1) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(2) var baseColorTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

// ==================== Vertex IO ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// ==================== Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(instance_index) instanceIndex: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let instance = instances[instanceIndex];
  var output: VertexOutput;
  
  // Skip non-mesh instances
  if (instance.rotationAndType.z < 0.5) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
  
  let worldPosBase = instance.positionAndScale.xyz;
  let scale = instance.positionAndScale.w;
  let rotation = instance.rotationAndType.x;
  
  // Apply Y-axis rotation
  let cosR = cos(rotation);
  let sinR = sin(rotation);
  let rotatedPos = vec3f(
    position.x * cosR - position.z * sinR,
    position.y,
    position.x * sinR + position.z * cosR
  );
  
  // Apply scale and translate (same offset as main shader)
  let worldPos = worldPosBase + rotatedPos * scale + vec3f(0.0, scale * 0.5, 0.0);
  
  // Distance-based discard: skip instances beyond shadowCastDistance from camera
  let distToCamera = distance(worldPosBase, uniforms.cameraPosition);
  if (distToCamera > uniforms.shadowCastDistance) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
  
  // No wind animation in shadow pass — keeps shadows stable
  
  output.position = uniforms.lightSpaceMatrix * vec4f(worldPos, 1.0);
  output.uv = uv;
  
  return output;
}

// ==================== Fragment Shader ====================

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let baseColor = textureSample(baseColorTexture, texSampler, input.uv);
  
  // Alpha cutout — same threshold as main shader
  if (baseColor.a < 0.5) {
    discard;
  }
  
  // Depth-only output (color doesn't matter for shadow maps, but we need a color target
  // for compatibility — shadow pass uses depth-only attachment, so this is unused)
  return vec4f(0.0, 0.0, 0.0, 1.0);
}