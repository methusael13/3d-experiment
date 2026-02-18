/**
 * CDLOD Terrain Shadow Pass Shader
 * 
 * Depth-only vertex shader for rendering terrain to shadow map.
 * Uses the same vertex layout AND vertex transformation logic as the main
 * CDLOD shader (cdlod.wgsl) to ensure shadow geometry matches exactly.
 * 
 * Key requirements for artifact-free shadows:
 * - Same CDLOD morphing logic as main pass
 * - Same mip-level height sampling as main pass
 * - Same skirt depth formula as main pass
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
// Height Sampling (matches cdlod.wgsl sampleHeightSmooth exactly)
// ============================================================================

// Convert world XZ position to heightmap UV coordinates
fn worldToUV(worldXZ: vec2f) -> vec2f {
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  return (worldXZ - terrainOrigin) / uniforms.terrainSize;
}

// Sample height at texel coordinates with clamping (matches cdlod.wgsl)
fn sampleHeightAt(texCoord: vec2i, mipLevel: i32) -> f32 {
  let dims = textureDimensions(heightmapTexture, mipLevel);
  let clampedCoord = clamp(texCoord, vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  return textureLoad(heightmapTexture, clampedCoord, mipLevel).r;
}

// Sample height with manual bilinear interpolation at specified LOD mip level
// This matches cdlod.wgsl's sampleHeightSmooth() exactly
fn sampleHeightSmooth(worldXZ: vec2f, lodLevel: f32) -> f32 {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  // Get mip level as integer (floor for the current mip)
  let mipLevel = i32(lodLevel);
  let dims = textureDimensions(heightmapTexture, mipLevel);
  
  // Convert UV to texel coordinates (floating point)
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  
  // Get integer texel coordinates for the 4 corners
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = texel00 + vec2i(1, 0);
  let texel01 = texel00 + vec2i(0, 1);
  let texel11 = texel00 + vec2i(1, 1);
  
  // Sample the 4 corners
  let h00 = sampleHeightAt(texel00, mipLevel);
  let h10 = sampleHeightAt(texel10, mipLevel);
  let h01 = sampleHeightAt(texel01, mipLevel);
  let h11 = sampleHeightAt(texel11, mipLevel);
  
  // Bilinear interpolation weights
  let frac = fract(texelF);
  
  // Interpolate along X, then along Y
  let h0 = mix(h00, h10, frac.x);
  let h1 = mix(h01, h11, frac.x);
  return mix(h0, h1, frac.y);
}

// ============================================================================
// Vertex Input - same layout as main CDLOD shader
// ============================================================================

struct VertexInput {
  @location(0) position: vec2f,      // Grid vertex position (-0.5 to 0.5)
  @location(1) uv: vec2f,            // Grid UV (0 to 1)
  @location(6) isSkirt: f32,         // Skirt vertex flag
  @location(2) nodeOffset: vec2f,    // Instance: node center XZ
  @location(3) nodeScale: f32,       // Instance: node scale
  @location(4) nodeMorph: f32,       // Instance: morph factor
  @location(5) nodeLOD: f32,         // Instance: LOD level for mipmap sampling
}

// ============================================================================
// Vertex Shader (matches cdlod.wgsl vs_main vertex transformation)
// ============================================================================

@vertex
fn vs_shadow(input: VertexInput) -> @builtin(position) vec4f {
  // Calculate world XZ position from grid + instance offset/scale
  // (matches cdlod.wgsl exactly)
  var worldXZ = input.position * input.nodeScale * (uniforms.gridSize - 1.0) + input.nodeOffset;
  
  // ===== CDLOD Morphing (matches cdlod.wgsl exactly) =====
  // Vertices at "odd" positions in the parent grid need to morph
  // to the midpoint between their "even" neighbors when transitioning.
  let parentScale = input.nodeScale * 2.0;
  
  // Determine if this vertex is at an odd position in parent grid
  let parentGridPos = worldXZ / parentScale;
  let fracPart = fract(parentGridPos + 0.5);
  
  // Odd positions are those at 0.5 in fractional space
  let oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0);
  let oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0);
  
  // Apply morph factor to odd vertices
  let morphX = oddX * input.nodeMorph;
  let morphZ = oddZ * input.nodeMorph;
  
  // Snap to parent grid positions for morphing
  let snappedXZ = floor(worldXZ / parentScale + 0.5) * parentScale;
  
  // Morph world position
  let morphedXZ = vec2f(
    mix(worldXZ.x, snappedXZ.x, morphX),
    mix(worldXZ.y, snappedXZ.y, morphZ)
  );
  
  // Sample heightmap with LOD-based mip level (matches cdlod.wgsl exactly)
  let normalizedHeight = sampleHeightSmooth(morphedXZ, input.nodeLOD);
  
  // Apply heightScale to convert normalized height to world units
  var worldY = normalizedHeight * uniforms.heightScale;
  
  // Apply skirt offset (matches cdlod.wgsl skirt formula)
  if (input.isSkirt > 0.5) {
    let skirtOffset = input.nodeScale * (uniforms.gridSize - 1.0) * 0.15;
    worldY -= skirtOffset;
  }
  
  // Transform to light space
  let worldPos = vec4f(morphedXZ.x, worldY, morphedXZ.y, 1.0);
  return uniforms.lightSpaceMatrix * worldPos;
}