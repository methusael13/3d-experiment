/**
 * Vegetation Mesh Instance Shader
 * 
 * Renders 3D vegetation meshes using instanced rendering.
 * Reads instance data from a shared storage buffer (same as billboard renderer).
 * Only renders instances with renderFlag = 1 (mesh mode).
 * 
 * Features:
 * - Per-instance Y-axis rotation and scale
 * - Per-submesh wind multiplier
 * - Alpha cutout for leaves/petals
 * - Basic PBR-compatible output
 */

// ==================== Debug Mode ====================
// Set to true to visualize mesh instances as solid magenta
// (billboard instances will be cyan in billboard.wgsl)
const DEBUG_RENDER_MODE_COLOR: bool = true;
const DEBUG_MESH_COLOR: vec3f = vec3f(1.0, 0.0, 0.8); // Magenta

// ==================== Shared Instance Struct ====================

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (1=mesh), w = reserved
}

// ==================== Uniforms ====================

struct MeshUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  windMultiplier: f32,      // Per-submesh: 0 = rigid (trunk), 1 = full (leaves)
  maxDistance: f32,          // Max render distance — discard instances beyond this
  _pad: vec2f,
}

struct WindParams {
  direction: vec2f,
  strength: f32,
  frequency: f32,
  gustStrength: f32,
  gustFrequency: f32,
  _pad: vec2f,
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> uniforms: MeshUniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(3) var baseColorTexture: texture_2d<f32>;
@group(0) @binding(4) var texSampler: sampler;

// ==================== Vertex IO ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) worldNormal: vec3f,
}

// ==================== Wind ====================

fn fbm2D(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  value += amp * (sin(pos.x) * cos(pos.y * 1.3) * 0.5 + 0.5);
  pos *= 2.1;
  amp *= 0.5;
  value += amp * (sin(pos.x * 0.8) * cos(pos.y * 1.1) * 0.5 + 0.5);
  return value;
}

fn applyMeshWind(worldPos: vec3f, vertexHeight: f32, windMult: f32) -> vec3f {
  if (windMult < 0.001) { return worldPos; }
  
  let phase = dot(worldPos.xz, wind.direction) * 0.1 + uniforms.time * wind.frequency;
  let baseWind = sin(phase) * wind.strength;
  
  let gustUV = worldPos.xz * wind.gustFrequency + uniforms.time * 0.3;
  let gustNoise = fbm2D(gustUV) * 2.0 - 1.0;
  let localGust = gustNoise * wind.gustStrength;
  
  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight * windMult;
  
  return worldPos + vec3f(wind.direction.x, 0.0, wind.direction.y) * displacement;
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
  
  // Skip billboard-flagged instances (renderFlag < 0.5 means billboard)
  if (instance.rotationAndType.z < 0.5) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
  
  let worldPosBase = instance.positionAndScale.xyz;
  
  // Distance-based discard: skip instances beyond max render distance
  let distToCamera = distance(worldPosBase, uniforms.cameraPosition);
  if (distToCamera > uniforms.maxDistance) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }
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
  let rotatedNormal = vec3f(
    normal.x * cosR - normal.z * sinR,
    normal.y,
    normal.x * sinR + normal.z * cosR
  );
  
  // Apply scale and translate
  // Offset Y by scale*0.5 so the base of the normalized model (Y=-0.5 to 0.5) sits on the terrain surface
  var worldPos = worldPosBase + rotatedPos * scale + vec3f(0.0, scale * 0.5, 0.0);
  
  // Estimate vertex height for wind (normalize Y position relative to model)
  // Assumes model origin is at base, positive Y is up
  let vertexHeight = saturate(position.y * 2.0); // Scale factor for typical vegetation models
  
  // Apply wind
  worldPos = applyMeshWind(worldPos, vertexHeight, uniforms.windMultiplier);
  
  output.position = uniforms.viewProjection * vec4f(worldPos, 1.0);
  output.uv = uv;
  output.worldPos = worldPos;
  output.worldNormal = normalize(rotatedNormal);
  
  return output;
}

// ==================== Fragment Shader ====================

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let baseColor = textureSample(baseColorTexture, texSampler, input.uv);
  
  // Alpha cutout
  if (baseColor.a < 0.5) {
    discard;
  }
  
  // Simple directional lighting (sun approximation)
  let lightDir = normalize(vec3f(0.5, 0.8, 0.3));
  let ndotl = max(dot(input.worldNormal, lightDir), 0.0);
  let ambient = 0.3;
  let lighting = ambient + (1.0 - ambient) * ndotl;
  
  var finalColor: vec3f;
  if (DEBUG_RENDER_MODE_COLOR) {
    // Debug: solid magenta for all mesh instances
    finalColor = DEBUG_MESH_COLOR * lighting;
  } else {
    finalColor = baseColor.rgb * lighting;
  }
  
  return vec4f(finalColor, baseColor.a);
}