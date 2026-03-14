// Terrain Layer Compositor — Compute Shader
//
// Blends up to MAX_LAYERS layer heightmaps onto a base heightmap, producing:
//   1. A composited heightmap (r32float)
//   2. An erosion mask (r32float) — 1.0 = fully erodable, 0.0 = protected
//
// Each layer has:
//   - Its own heightmap texture
//   - A blend mode (additive, multiply, replace, max, min)
//   - A blend factor (0..1)
//   - Optional oriented-rect bounds with feathered edges
//   - An erodable flag (affects erosion mask output)
//
// The compositor is dispatched once per compositing pass.
// If there are more layers than MAX_LAYERS, multiple passes are used,
// feeding the output of the previous pass as the base for the next.

// Maximum layers per dispatch (must match CPU-side MAX_COMPOSITOR_LAYERS_PER_PASS)
const MAX_LAYERS: u32 = 8u;

// Blend mode constants (must match TerrainBlendMode enum on CPU)
const BLEND_ADDITIVE: u32 = 0u;
const BLEND_MULTIPLY: u32 = 1u;
const BLEND_REPLACE:  u32 = 2u;
const BLEND_MAX:      u32 = 3u;
const BLEND_MIN:      u32 = 4u;

// Per-layer parameters packed into a uniform buffer
struct LayerParams {
  // Bounds: centerX, centerZ, halfExtentX, halfExtentZ
  bounds: vec4f,
  // rotation (radians), featherWidth, blendFactor, blendMode (as u32 bits in f32)
  config: vec4f,
  // flags: x = hasBounds (0 or 1), y = erodable (0 or 1), z = unused, w = unused
  flags: vec4f,
  // Height curve: x = heightMin, y = heightMax, z = heightEnabled (0/1), w = heightInvert (0/1)
  heightCurve: vec4f,
  // Slope curve: x = slopeMin, y = slopeMax, z = slopeEnabled (0/1), w = slopeInvert (0/1)
  slopeCurve: vec4f,
}

struct CompositorUniforms {
  // Number of active layers in this pass (1..MAX_LAYERS)
  layerCount: u32,
  // Terrain world size (for UV → world coordinate conversion)
  worldSize: f32,
  // Padding
  _pad0: f32,
  _pad1: f32,
  // Per-layer params array
  layers: array<LayerParams, MAX_LAYERS>,
}

@group(0) @binding(0) var<uniform> uniforms: CompositorUniforms;
@group(0) @binding(1) var baseHeightmap: texture_2d<f32>;
@group(0) @binding(2) var outputHeightmap: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var outputErosionMask: texture_storage_2d<r32float, write>;

// Layer heightmap textures (up to MAX_LAYERS)
// We bind all 8 slots; unused slots point to a 1x1 dummy texture.
@group(1) @binding(0) var layerTex0: texture_2d<f32>;
@group(1) @binding(1) var layerTex1: texture_2d<f32>;
@group(1) @binding(2) var layerTex2: texture_2d<f32>;
@group(1) @binding(3) var layerTex3: texture_2d<f32>;
@group(1) @binding(4) var layerTex4: texture_2d<f32>;
@group(1) @binding(5) var layerTex5: texture_2d<f32>;
@group(1) @binding(6) var layerTex6: texture_2d<f32>;
@group(1) @binding(7) var layerTex7: texture_2d<f32>;

// ============================================================================
// Oriented Rectangle SDF for Bounds Masking
// ============================================================================

fn computeOrientedRectMask(worldXZ: vec2f, layer: LayerParams) -> f32 {
  let hasBounds = layer.flags.x;
  if (hasBounds < 0.5) {
    return 1.0; // Global layer — no spatial masking
  }

  let center = layer.bounds.xy;
  let halfExtent = layer.bounds.zw;
  let rotation = layer.config.x;
  let featherWidth = layer.config.y;

  // Transform world position to layer-local space
  let cosR = cos(rotation);
  let sinR = sin(rotation);
  let offset = worldXZ - center;
  let local = vec2f(
    offset.x * cosR + offset.y * sinR,
    -offset.x * sinR + offset.y * cosR
  );

  // Box SDF: distance to nearest edge (positive = outside)
  let d = abs(local) - halfExtent;
  let outside = length(max(d, vec2f(0.0)));

  // Feathered falloff: 1.0 inside, smoothstep to 0.0 over featherWidth
  if (featherWidth <= 0.0) {
    return select(0.0, 1.0, outside <= 0.0);
  }
  return 1.0 - smoothstep(0.0, featherWidth, outside);
}

// ============================================================================
// Blend Functions
// ============================================================================

fn applyBlend(current: f32, layerHeight: f32, effective: f32, blendMode: u32) -> f32 {
  switch (blendMode) {
    case BLEND_ADDITIVE: {
      return current + layerHeight * effective;
    }
    case BLEND_MULTIPLY: {
      return mix(current, current * layerHeight, effective);
    }
    case BLEND_REPLACE: {
      return mix(current, layerHeight, effective);
    }
    case BLEND_MAX: {
      return mix(current, max(current, layerHeight), effective);
    }
    case BLEND_MIN: {
      return mix(current, min(current, layerHeight), effective);
    }
    default: {
      return current + layerHeight * effective;
    }
  }
}

// ============================================================================
// Sample Layer Heightmap by Index
// ============================================================================

fn sampleLayer(index: u32, coord: vec2i) -> f32 {
  switch (index) {
    case 0u: { return textureLoad(layerTex0, coord, 0).r; }
    case 1u: { return textureLoad(layerTex1, coord, 0).r; }
    case 2u: { return textureLoad(layerTex2, coord, 0).r; }
    case 3u: { return textureLoad(layerTex3, coord, 0).r; }
    case 4u: { return textureLoad(layerTex4, coord, 0).r; }
    case 5u: { return textureLoad(layerTex5, coord, 0).r; }
    case 6u: { return textureLoad(layerTex6, coord, 0).r; }
    case 7u: { return textureLoad(layerTex7, coord, 0).r; }
    default: { return 0.0; }
  }
}

// ============================================================================
// Slope Computation (for blend curve modulation)
// ============================================================================

// Compute slope magnitude at a texel coordinate using central differences on the base heightmap.
// Returns 0.0 for flat terrain, approaching 1.0 for near-vertical slopes.
fn computeSlope(coord: vec2i) -> f32 {
  let dims = textureDimensions(baseHeightmap);
  let maxCoord = vec2i(i32(dims.x) - 1, i32(dims.y) - 1);

  // Clamp neighbor coordinates to texture bounds
  let left  = textureLoad(baseHeightmap, clamp(coord + vec2i(-1, 0), vec2i(0), maxCoord), 0).r;
  let right = textureLoad(baseHeightmap, clamp(coord + vec2i( 1, 0), vec2i(0), maxCoord), 0).r;
  let down  = textureLoad(baseHeightmap, clamp(coord + vec2i(0, -1), vec2i(0), maxCoord), 0).r;
  let up    = textureLoad(baseHeightmap, clamp(coord + vec2i(0,  1), vec2i(0), maxCoord), 0).r;

  let dx = (right - left) * 0.5;
  let dy = (up - down) * 0.5;

  // Scale by resolution to get world-space gradient, then convert to slope 0..1
  // The heightmap is normalized [-0.5, 0.5], so gradient magnitude directly gives slope
  let gradientMag = length(vec2f(dx, dy)) * f32(dims.x);
  return saturate(gradientMag);
}

// ============================================================================
// Blend Curve Modulation
// ============================================================================

// Apply height/slope-based blend curve to modulate the effective blend factor.
// baseHeight: normalized height from the base heightmap at this texel
// slope: computed slope (0=flat, 1=vertical) at this texel
fn applyBlendCurve(layer: LayerParams, baseHeight: f32, slope: f32) -> f32 {
  var modifier: f32 = 1.0;

  // Height curve
  let hEnabled = layer.heightCurve.z;
  if (hEnabled > 0.5) {
    let hMin = layer.heightCurve.x;
    let hMax = layer.heightCurve.y;
    let hInvert = layer.heightCurve.w;
    // Remap base height from [-0.5, 0.5] to [0, 1] for curve comparison
    let h01 = baseHeight + 0.5;
    var hMod = smoothstep(hMin, hMax, h01);
    if (hInvert > 0.5) { hMod = 1.0 - hMod; }
    modifier *= hMod;
  }

  // Slope curve
  let sEnabled = layer.slopeCurve.z;
  if (sEnabled > 0.5) {
    let sMin = layer.slopeCurve.x;
    let sMax = layer.slopeCurve.y;
    let sInvert = layer.slopeCurve.w;
    var sMod = smoothstep(sMin, sMax, slope);
    if (sInvert > 0.5) { sMod = 1.0 - sMod; }
    modifier *= sMod;
  }

  return modifier;
}

// ============================================================================
// Main Composite Pass
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(baseHeightmap);

  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }

  let coord = vec2i(globalId.xy);

  // UV [0, 1] for this texel
  let uv = vec2f(f32(globalId.x), f32(globalId.y)) / vec2f(f32(dims.x - 1u), f32(dims.y - 1u));

  // World position (terrain centered at origin)
  let halfWorld = uniforms.worldSize * 0.5;
  let worldXZ = uv * uniforms.worldSize - vec2f(halfWorld, halfWorld);

  // Start with base heightmap value
  let baseHeight = textureLoad(baseHeightmap, coord, 0).r;
  var height = baseHeight;
  var erosionMask: f32 = 1.0;

  // Compute slope once per texel (used by blend curves across all layers)
  let slope = computeSlope(coord);

  // Apply each layer in order
  let count = min(uniforms.layerCount, MAX_LAYERS);
  for (var i: u32 = 0u; i < count; i++) {
    let layer = uniforms.layers[i];

    // Compute spatial mask from oriented-rect bounds
    let boundsMask = computeOrientedRectMask(worldXZ, layer);
    let blendFactor = layer.config.z;

    // Apply height/slope blend curve modifier (1.0 if no curve enabled)
    let curveModifier = applyBlendCurve(layer, baseHeight, slope);

    let effective = boundsMask * blendFactor * curveModifier;

    if (effective <= 0.001) {
      continue; // Skip layers with negligible contribution
    }

    // Sample this layer's heightmap
    let layerHeight = sampleLayer(i, coord);

    // Extract blend mode from config.w (stored as bitcast f32 → u32)
    let blendMode = bitcast<u32>(layer.config.w);

    // Apply blend
    height = applyBlend(height, layerHeight, effective, blendMode);

    // Update erosion mask: non-erodable layers reduce erosion strength
    let isErodable = layer.flags.y;
    if (isErodable < 0.5) {
      erosionMask *= (1.0 - effective);
    }
  }

  // Clamp erosion mask to [0, 1]
  erosionMask = clamp(erosionMask, 0.0, 1.0);

  // Write outputs
  textureStore(outputHeightmap, coord, vec4f(height, 0.0, 0.0, 1.0));
  textureStore(outputErosionMask, coord, vec4f(erosionMask, 0.0, 0.0, 1.0));
}
