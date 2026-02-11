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

// ============================================================================
// Bilinear Height Sampling (matches cdlod.wgsl for consistent shadow/main heights)
// ============================================================================

// Sample height with manual bilinear interpolation (r32float is unfilterable)
// UV should be in [0, 1] range (terrain-space coordinates)
fn sampleHeightBilinear(uv: vec2f) -> f32 {
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  let texDims = textureDimensions(heightmapTexture, 0);
  
  // Convert UV to texel coordinates (floating point)
  // Note: multiply by (dims - 1) so UV=1.0 maps to last valid texel center
  let texelF = clampedUV * vec2f(f32(texDims.x) - 1.0, f32(texDims.y) - 1.0);
  
  // Get integer texel coordinates for the 4 corners
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = min(texel00 + vec2i(1, 0), vec2i(i32(texDims.x) - 1, i32(texDims.y) - 1));
  let texel01 = min(texel00 + vec2i(0, 1), vec2i(i32(texDims.x) - 1, i32(texDims.y) - 1));
  let texel11 = min(texel00 + vec2i(1, 1), vec2i(i32(texDims.x) - 1, i32(texDims.y) - 1));
  
  // Sample the 4 corners
  let h00 = textureLoad(heightmapTexture, texel00, 0).r;
  let h10 = textureLoad(heightmapTexture, texel10, 0).r;
  let h01 = textureLoad(heightmapTexture, texel01, 0).r;
  let h11 = textureLoad(heightmapTexture, texel11, 0).r;
  
  // Bilinear interpolation weights
  let frac = fract(texelF);
  
  // Interpolate along X, then along Y
  let h0 = mix(h00, h10, frac.x);
  let h1 = mix(h01, h11, frac.x);
  return mix(h0, h1, frac.y);
}

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
  
  // Sample heightmap with bilinear interpolation (matches main cdlod.wgsl pass)
  // This prevents shadow artifacts caused by height mismatch between passes
  let height = sampleHeightBilinear(heightmapUV);
  
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
