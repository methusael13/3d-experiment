// Shadow Depth Shader for Terrain - UNIFIED GRID VERSION
// Uses a single dense grid mesh (not CDLOD) to eliminate LOD boundary artifacts
// The grid is positioned around the shadow volume center (camera + forward offset)

// ============================================================================
// Uniform Structures
// ============================================================================

struct ShadowUniforms {
  lightSpaceMatrix: mat4x4f,  // Combined view-projection from light's POV
  modelMatrix: mat4x4f,       // Terrain model matrix (usually identity)
  shadowCenter: vec2f,        // Center of shadow grid in world XZ
  shadowRadius: f32,          // Radius of shadow grid
  heightScale: f32,           // Terrain height scale
  terrainSize: f32,           // World size of terrain
  gridResolution: f32,        // Number of grid vertices per side
  depthBias: f32,             // Bias to prevent shadow acne
  _pad0: f32,
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: ShadowUniforms;
@group(0) @binding(1) var heightmap: texture_2d<f32>;

// ============================================================================
// Vertex Structures - Simple Grid (no instancing)
// ============================================================================

struct VertexInput {
  @location(0) localPosition: vec2f,  // Grid position in range [0, 1]
}

struct VertexOutput {
  @builtin(position) position: vec4f,
}

// ============================================================================
// Helper Functions
// ============================================================================

// Convert world XZ position to heightmap UV coordinates
fn worldToUV(worldXZ: vec2f) -> vec2f {
  let terrainOrigin = vec2f(-uniforms.terrainSize * 0.5);
  return (worldXZ - terrainOrigin) / uniforms.terrainSize;
}

// Sample height from heightmap at mip level 0 (highest detail)
fn sampleHeightAt(texCoord: vec2i) -> f32 {
  let dims = textureDimensions(heightmap, 0);
  let clampedCoord = clamp(texCoord, vec2i(0), vec2i(i32(dims.x) - 1, i32(dims.y) - 1));
  return textureLoad(heightmap, clampedCoord, 0).r;
}

// Sample height with manual bilinear interpolation at LOD 0
fn sampleHeightSmooth(worldXZ: vec2f) -> f32 {
  let uv = worldToUV(worldXZ);
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(1.0));
  
  let dims = textureDimensions(heightmap, 0);
  let texelF = clampedUV * vec2f(f32(dims.x) - 1.0, f32(dims.y) - 1.0);
  
  let texel00 = vec2i(i32(floor(texelF.x)), i32(floor(texelF.y)));
  let texel10 = texel00 + vec2i(1, 0);
  let texel01 = texel00 + vec2i(0, 1);
  let texel11 = texel00 + vec2i(1, 1);
  
  let h00 = sampleHeightAt(texel00);
  let h10 = sampleHeightAt(texel10);
  let h01 = sampleHeightAt(texel01);
  let h11 = sampleHeightAt(texel11);
  
  let frac = fract(texelF);
  let h0 = mix(h00, h10, frac.x);
  let h1 = mix(h01, h11, frac.x);
  return mix(h0, h1, frac.y);
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  
  // Convert local grid position [0,1] to world position
  // Grid covers a square of (2 * shadowRadius) centered at shadowCenter
  let worldXZ = uniforms.shadowCenter + (input.localPosition - 0.5) * 2.0 * uniforms.shadowRadius;
  
  // Sample height at LOD 0 (highest detail, no LOD artifacts)
  let normalizedHeight = sampleHeightSmooth(worldXZ);
  let height = normalizedHeight * uniforms.heightScale;
  
  // Note: Depth bias is applied via hardware depthBias in pipeline config
  // Manual bias here would push geometry in wrong direction relative to light
  
  let worldPos = vec3f(worldXZ.x, height, worldXZ.y);
  
  // Transform to light space
  let mvp = uniforms.lightSpaceMatrix * uniforms.modelMatrix;
  output.position = mvp * vec4f(worldPos, 1.0);
  
  return output;
}

// ============================================================================
// Fragment Shader
// ============================================================================

// Depth-only pass: no color output needed
// Hardware writes depth from @builtin(position).z to depth attachment automatically
@fragment
fn fs_main() {
  // Depth-only pass: depth is written automatically by hardware
  // from the @builtin(position) value in the vertex shader output
}
