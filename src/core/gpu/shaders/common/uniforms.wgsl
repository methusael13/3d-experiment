// Common Uniform Structures for WebGPU Shaders
// These structures define the layout of uniform buffers used across shaders

// Camera uniforms - typically bound at group 0
struct CameraUniforms {
  viewMatrix: mat4x4f,
  projectionMatrix: mat4x4f,
  viewProjectionMatrix: mat4x4f,
  inverseViewMatrix: mat4x4f,
  inverseProjectionMatrix: mat4x4f,
  cameraPosition: vec3f,
  nearPlane: f32,
  farPlane: f32,
  aspectRatio: f32,
  fov: f32,
  time: f32,
}

// Model uniforms - typically bound at group 1
struct ModelUniforms {
  modelMatrix: mat4x4f,
  normalMatrix: mat4x4f,  // Transpose of inverse model matrix (3x3 expanded to 4x4)
  mvpMatrix: mat4x4f,
}

// Light uniforms
struct DirectionalLight {
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  shadowEnabled: u32,
  shadowViewProjection: mat4x4f,
}

struct PointLight {
  position: vec3f,
  radius: f32,
  color: vec3f,
  intensity: f32,
}

// Lighting uniforms - typically bound at group 2
struct LightingUniforms {
  ambientColor: vec3f,
  ambientIntensity: f32,
  directionalLight: DirectionalLight,
  pointLightCount: u32,
  _padding: vec3f,
}

// Material uniforms for PBR
struct MaterialUniforms {
  baseColor: vec4f,
  emissive: vec3f,
  metallic: f32,
  roughness: f32,
  ao: f32,
  normalScale: f32,
  _padding: f32,
}

// Terrain-specific uniforms
struct TerrainUniforms {
  worldOffset: vec2f,
  terrainSize: vec2f,
  heightScale: f32,
  texelSize: f32,
  morphFactor: f32,
  lodLevel: f32,
  minHeight: f32,
  maxHeight: f32,
  _padding: vec2f,
}

// CDLOD instance data (per-patch)
struct CDLODInstance {
  worldOffset: vec2f,
  scale: f32,
  lodLevel: f32,
  morphFactor: f32,
  _padding: vec3f,
}

// Shadow map uniforms
struct ShadowUniforms {
  lightViewProjection: mat4x4f,
  shadowMapSize: vec2f,
  shadowBias: f32,
  shadowStrength: f32,
}
