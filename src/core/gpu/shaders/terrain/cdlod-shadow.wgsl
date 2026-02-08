/**
 * CDLOD Terrain Shadow Pass Shader
 * 
 * Depth-only vertex shader for rendering terrain to shadow map.
 * Uses the same vertex layout as the main CDLOD shader for consistency.
 */

// Shadow pass uniform buffer
struct ShadowUniforms {
  lightSpaceMatrix: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  terrainSize: f32,
  heightScale: f32,
  gridSize: f32,
  skirtDepth: f32,
}

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;
@group(0) @binding(1) var heightmapTexture: texture_2d<f32>;

// Vertex input - same layout as main CDLOD shader
struct VertexInput {
  @location(0) position: vec2f,      // Grid vertex position (-0.5 to 0.5)
  @location(1) uv: vec2f,            // Grid UV (0 to 1)
  @location(6) isSkirt: f32,         // Skirt vertex flag
  @location(2) nodeOffset: vec2f,    // Instance: node center XZ
  @location(3) nodeScale: f32,       // Instance: node scale
  @location(4) nodeMorph: f32,       // Instance: morph factor (unused in shadow)
  @location(5) nodeLOD: f32,         // Instance: LOD level for mipmap sampling
}

@vertex
fn vs_shadow(input: VertexInput) -> @builtin(position) vec4f {
  // Calculate world position from grid + instance offset/scale
  let worldXZ = input.position * input.nodeScale * (uniforms.gridSize - 1.0) + input.nodeOffset;
  
  // Calculate UV for heightmap sampling (terrain centered at origin)
  let halfSize = uniforms.terrainSize * 0.5;
  let heightmapUV = (worldXZ + halfSize) / uniforms.terrainSize;
  
  // Sample heightmap at mip 0 (textureLoad requires i32 for coords)
  // Multiply by (dims - 1) so UV=1.0 maps to last valid texel, not out of bounds
  let texDims = textureDimensions(heightmapTexture, 0);
  let maxCoord = vec2f(f32(texDims.x) - 1.0, f32(texDims.y) - 1.0);
  let texCoord = vec2i(clamp(heightmapUV, vec2f(0.0), vec2f(1.0)) * maxCoord);
  let height = textureLoad(heightmapTexture, texCoord, 0).r;
  
  // Calculate Y position
  var worldY = height * uniforms.heightScale;
  
  // Apply skirt offset (push down for gap prevention)
  if (input.isSkirt > 0.5) {
    worldY -= uniforms.skirtDepth * input.nodeScale * uniforms.heightScale;
  }
  
  // Transform to light space
  let worldPos = vec4f(worldXZ.x, worldY, worldXZ.y, 1.0);
  return uniforms.lightSpaceMatrix * worldPos;
}
