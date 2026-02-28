/**
 * Vegetation Billboard Shader
 * 
 * Renders camera-facing quads for vegetation instances.
 * Reads instance data from a storage buffer (shared with mesh renderer).
 * Only renders instances with renderFlag = 0 (billboard mode).
 * 
 * Features:
 * - Y-axis aligned billboarding (always upright)
 * - Wind animation (base oscillation + local gusts)
 * - Alpha cutout for vegetation edges
 * - Distance-based fade out
 * - Optional texture atlas support
 */

// ==================== Debug Mode ====================
// Set to true to visualize billboard instances as solid cyan
// (mesh instances will be magenta in vegetation-mesh.wgsl)
const DEBUG_RENDER_MODE_COLOR: bool = false;
const DEBUG_BILLBOARD_COLOR: vec3f = vec3f(0.0, 0.8, 1.0); // Cyan

// Set to true to visualize CDLOD LOD level per tile
// Each LOD level gets a distinct color: highest LOD (leaf) = green, lowest (root) = red
const DEBUG_LOD_LEVEL_COLOR: bool = true;

// ==================== Shared Instance Struct ====================

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (0=billboard), w = reserved
}

// ==================== Uniforms ====================

struct Uniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
  maxFadeDistance: f32,
  fadeStartRatio: f32,      // e.g. 0.75 = start fading at 75% of max distance
  lodLevel: f32,            // CDLOD LOD level (0=root/coarsest, N=leaf/finest) for debug vis
  maxLodLevels: f32,        // Total LOD levels in quadtree (e.g., 10)
  fallbackColor: vec3f,     // Plant type color when no texture assigned
  useTexture: f32,          // 1.0 = real texture provided, 0.0 = use fallback color
  atlasRegion: vec4f,       // xy = UV offset (0-1), zw = UV size (0-1). If zw = 0, no atlas remapping.
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

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;
@group(0) @binding(3) var plantTexture: texture_2d<f32>;
@group(0) @binding(4) var plantSampler: sampler;

// ==================== Vertex IO ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPos: vec3f,
  @location(2) color: vec3f,
  @location(3) alpha: f32,
}

// ==================== Wind Functions ====================

fn fbm2D(p: vec2f) -> f32 {
  // Simple 2-octave FBM using sin/cos
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  
  value += amp * (sin(pos.x * 1.0) * cos(pos.y * 1.3) * 0.5 + 0.5);
  pos *= 2.1;
  amp *= 0.5;
  value += amp * (sin(pos.x * 0.8) * cos(pos.y * 1.1) * 0.5 + 0.5);
  
  return value;
}

fn applyWind(worldPos: vec3f, vertexHeight: f32) -> vec3f {
  // Base global oscillation
  let phase = dot(worldPos.xz, wind.direction) * 0.1 + uniforms.time * wind.frequency;
  let baseWind = sin(phase) * wind.strength;
  
  // Local gust variation
  let gustUV = worldPos.xz * wind.gustFrequency + uniforms.time * 0.3;
  let gustNoise = fbm2D(gustUV) * 2.0 - 1.0;
  let localGust = gustNoise * wind.gustStrength;
  
  // Quadratic falloff from base (base of plant stays fixed)
  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight;
  
  return worldPos + vec3f(wind.direction.x, 0.0, wind.direction.y) * displacement;
}

// ==================== Vertex Shader ====================

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let instance = instances[instanceIndex];
  var output: VertexOutput;
  
  // Skip mesh-flagged instances (renderFlag > 0.5 means it's a 3D mesh instance)
  if (instance.rotationAndType.z > 0.5) {
    output.position = vec4f(0.0, 0.0, 0.0, 0.0);
    output.alpha = 0.0;
    return output;
  }
  
  let worldPosBase = instance.positionAndScale.xyz;
  let scale = instance.positionAndScale.w;
  let rotation = instance.rotationAndType.x;
  
  // Cross-billboard: two quads at 90° forming an X shape (12 vertices total)
  // Each quad: 2 triangles = 6 vertices
  // Quad 0 (vertices 0-5): aligned along the per-instance rotation angle
  // Quad 1 (vertices 6-11): rotated 90° from quad 0
  let quadPositions = array<vec2f, 6>(
    vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
    vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0)
  );
  let quadUVs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0)
  );
  
  let localVertIdx = vertexIndex % 12u;
  let quadIdx = localVertIdx / 6u;          // 0 or 1
  let vertInQuad = localVertIdx % 6u;       // 0-5
  
  let localPos = quadPositions[vertInQuad];
  let uv = quadUVs[vertInQuad];
  let vertexHeight = localPos.y; // 0 at base, 1 at top
  
  // Per-instance Y rotation + 90° offset for second quad
  let quadAngle = rotation + f32(quadIdx) * 1.5707963; // PI/2 = 90°
  let cosR = cos(quadAngle);
  let sinR = sin(quadAngle);
  let right = vec3f(cosR, 0.0, sinR); // Direction in XZ plane
  
  // Build world position
  var worldPos = worldPosBase;
  worldPos += right * localPos.x * scale;
  worldPos.y += localPos.y * scale;
  
  // Apply wind
  worldPos = applyWind(worldPos, vertexHeight);
  
  // Distance fade
  let dist = distance(worldPos, uniforms.cameraPosition);
  let fadeStart = uniforms.maxFadeDistance * uniforms.fadeStartRatio;
  let fade = 1.0 - smoothstep(fadeStart, uniforms.maxFadeDistance, dist);
  
  output.position = uniforms.viewProjection * vec4f(worldPos, 1.0);
  
  // Atlas region UV remapping: remap [0,1] quad UVs to atlas sub-region
  var finalUV = uv;
  if (uniforms.atlasRegion.z > 0.0) {
    finalUV = uniforms.atlasRegion.xy + uv * uniforms.atlasRegion.zw;
  }
  output.uv = finalUV;
  output.worldPos = worldPos;
  output.color = uniforms.fallbackColor;
  output.alpha = fade;
  
  return output;
}

// ==================== Fragment Output ====================

struct FragmentOutput {
  @location(0) color: vec4f,
  @location(1) normals: vec4f,  // World-space normal packed [0,1] + metallic in .w
}

// ==================== Fragment Shader ====================

@fragment
fn fragmentMain(input: VertexOutput) -> FragmentOutput {
  var fragOutput: FragmentOutput;
  // Sample texture
  let texColor = textureSample(plantTexture, plantSampler, input.uv);
  
  // Alpha cutout
  if (texColor.a < 0.5) {
    discard;
  }
  
  // Apply distance fade
  if (input.alpha < 0.01) {
    discard;
  }
  
  // When a real texture is provided, use its color directly.
  // When using fallback (no texture), use the plant's fallback color.
  var finalColor: vec3f;
  if (DEBUG_LOD_LEVEL_COLOR) {
    // Debug: color by CDLOD LOD level
    // 10 distinct colors for LOD levels 0-9
    let lod = u32(uniforms.lodLevel);
    switch lod {
      case 0u:  { finalColor = vec3f(1.0, 0.0, 0.0); }  // Red — root (coarsest/farthest)
      case 1u:  { finalColor = vec3f(1.0, 0.3, 0.0); }  // Dark orange
      case 2u:  { finalColor = vec3f(1.0, 0.6, 0.0); }  // Orange
      case 3u:  { finalColor = vec3f(1.0, 0.9, 0.0); }  // Yellow
      case 4u:  { finalColor = vec3f(0.7, 1.0, 0.0); }  // Yellow-green
      case 5u:  { finalColor = vec3f(0.3, 1.0, 0.0); }  // Light green
      case 6u:  { finalColor = vec3f(0.0, 1.0, 0.3); }  // Green
      case 7u:  { finalColor = vec3f(0.0, 1.0, 0.7); }  // Teal
      case 8u:  { finalColor = vec3f(0.0, 0.7, 1.0); }  // Light blue
      case 9u:  { finalColor = vec3f(0.0, 0.3, 1.0); }  // Blue — leaf (finest/closest)
      default:  { finalColor = vec3f(0.5, 0.0, 1.0); }  // Purple — beyond max
    }
  } else if (DEBUG_RENDER_MODE_COLOR) {
    // Debug: solid cyan for all billboard instances
    finalColor = DEBUG_BILLBOARD_COLOR;
  } else if (uniforms.useTexture > 0.5) {
    finalColor = texColor.rgb;
  } else {
    finalColor = input.color;
  }
  
  fragOutput.color = vec4f(finalColor, texColor.a * input.alpha);
  // Billboard normal: approximate as up-facing (Y+); metallic = 0
  fragOutput.normals = vec4f(0.5, 1.0, 0.5, 0.0);
  return fragOutput;
}
