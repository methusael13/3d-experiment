/**
 * Biome Mask Generation Compute Shader
 * 
 * ================================================================================
 * OUTPUT FORMAT (rgba8unorm)
 * ================================================================================
 * 
 * Each channel stores a biome PROBABILITY (0.0 to 1.0):
 * 
 *   R channel: Grassland probability
 *              - Thrives at moderate heights with low slopes
 *              - Reduced near water accumulation areas
 *              
 *   G channel: Rock/Cliff probability  
 *              - Appears on steep slopes (>30°)
 *              - Also at very high elevations
 *              
 *   B channel: Forest probability
 *              - Requires moderate water flow
 *              - Moderate terrain (not too steep/high)
 *              
 *   A channel: Reserved (always 1.0)
 *              - Future: Snow, Desert, Wetland, etc.
 *
 * ================================================================================
 * USAGE IN VEGETATION SPAWNER
 * ================================================================================
 * 
 * To sample biome probabilities in another shader:
 * 
 *   let biome = textureLoad(biomeMask, coord, 0);
 *   let grassProb = biome.r;   // 0.0 = no grass,     1.0 = ideal for grass
 *   let rockProb  = biome.g;   // 0.0 = not rocky,    1.0 = bare rock
 *   let forestProb = biome.b;  // 0.0 = no forest,    1.0 = ideal for forest
 *   
 * Probabilities are NOT mutually exclusive - a pixel can have:
 *   - High grass + high forest = transition zone, pick randomly
 *   - High rock = suppress vegetation regardless of other channels
 *   - Low all channels = barren/extreme terrain
 *
 * Example weighted random selection:
 *   
 *   let total = grassProb + forestProb;
 *   let rand = randomFloat(seed);  // 0-1
 *   if (rockProb > 0.7) { 
 *     // No vegetation on rock
 *   } else if (rand < grassProb / total) {
 *     // Spawn grass vegetation
 *   } else {
 *     // Spawn forest vegetation  
 *   }
 *
 * ================================================================================
 * VISUALIZATION
 * ================================================================================
 * 
 * Preview colors when displayed directly:
 *   - Red/Yellow = Grassland dominant
 *   - Green      = Rock/Cliff dominant  
 *   - Blue/Cyan  = Forest dominant
 *   - Magenta    = Grass + Forest overlap
 *   - White      = All biomes suitable
 *   - Black      = No biomes suitable (extreme terrain)
 *
 * ================================================================================
 */

// ==================== Uniforms ====================

struct BiomeParams {
  heightInfluence: f32,
  slopeInfluence: f32,
  flowInfluence: f32,
  seed: f32,
  
  grassHeightMin: f32,
  grassHeightMax: f32,
  grassSlopeMax: f32,
  rockSlopeMin: f32,
  
  forestFlowMin: f32,
  forestFlowMax: f32,
  forestHeightMin: f32,
  forestHeightMax: f32,
  
  defaultFlowValue: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> params: BiomeParams;
@group(0) @binding(1) var heightmap: texture_2d<f32>;
@group(0) @binding(2) var flowMap: texture_2d<f32>;
@group(0) @binding(3) var biomeMaskOut: texture_storage_2d<rgba8unorm, write>;

// ==================== Helper Functions ====================

/**
 * Calculate terrain slope from heightmap gradients.
 * Returns normalized slope value (0 = flat, 1 = vertical).
 */
fn calculateSlope(coord: vec2i, dims: vec2u) -> f32 {
  let x = coord.x;
  let y = coord.y;
  let w = i32(dims.x);
  let h = i32(dims.y);
  
  // Sample neighboring heights with boundary clamping
  let hL = textureLoad(heightmap, vec2i(max(x - 1, 0), y), 0).r;
  let hR = textureLoad(heightmap, vec2i(min(x + 1, w - 1), y), 0).r;
  let hD = textureLoad(heightmap, vec2i(x, max(y - 1, 0)), 0).r;
  let hU = textureLoad(heightmap, vec2i(x, min(y + 1, h - 1)), 0).r;
  
  // Calculate gradients (assuming unit texel spacing)
  let dx = (hR - hL) * 0.5;
  let dy = (hU - hD) * 0.5;
  
  // Slope magnitude (gradient length)
  let slope = sqrt(dx * dx + dy * dy);
  
  // Normalize to 0-1 range (tanh-like clamping for steep slopes)
  return saturate(slope * 4.0);
}

/**
 * Sample flow map with fallback to default value if texture is invalid.
 */
fn sampleFlow(coord: vec2i, dims: vec2u) -> f32 {
  let flowDims = textureDimensions(flowMap);
  
  // Check if flow map has valid dimensions
  if (flowDims.x <= 1u || flowDims.y <= 1u) {
    return params.defaultFlowValue;
  }
  
  // Scale coordinates if flow map has different resolution
  let scaledCoord = vec2i(
    i32(f32(coord.x) * f32(flowDims.x) / f32(dims.x)),
    i32(f32(coord.y) * f32(flowDims.y) / f32(dims.y))
  );
  
  return textureLoad(flowMap, scaledCoord, 0).r;
}

/**
 * Simple hash function for deterministic noise.
 */
fn hash(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

// ==================== Biome Calculation Functions ====================

/**
 * Calculate grassland probability (R channel).
 * Grassland thrives at moderate heights, low slopes, with optimal water flow.
 */
fn calculateGrassland(height: f32, slope: f32, flow: f32, noise: f32) -> f32 {
  // Height factor: peaks in middle range
  let heightFactor = smoothstep(params.grassHeightMin, params.grassHeightMin + 0.15, height) 
                   * (1.0 - smoothstep(params.grassHeightMax - 0.15, params.grassHeightMax, height));
  
  // Slope factor: grass doesn't grow on steep slopes
  let slopeFactor = 1.0 - smoothstep(params.grassSlopeMax * 0.7, params.grassSlopeMax, slope);
  
  // Combine with weighted average instead of multiplication
  let heightScore = heightFactor * params.heightInfluence;
  let slopeScore = slopeFactor * params.slopeInfluence;
  
  // Base probability from height and slope (main factors for grass)
  let baseProbability = min(heightScore, slopeScore);
  
  // Add slight noise variation
  return saturate(baseProbability * (0.85 + 0.3 * noise));
}

/**
 * Calculate rock/cliff probability (G channel).
 * Rock appears on steep slopes regardless of other factors.
 */
fn calculateRock(height: f32, slope: f32, flow: f32, noise: f32) -> f32 {
  // Primary factor: steep slopes
  let slopeFactor = smoothstep(params.rockSlopeMin, params.rockSlopeMin + 0.2, slope);
  
  // Very high areas are also rocky
  let highAltitudeFactor = smoothstep(0.7, 0.85, height);
  
  // Combine (either steep OR very high)
  let baseProbability = max(slopeFactor, highAltitudeFactor * 0.6);
  
  // Apply slope influence  
  return saturate(baseProbability * (0.9 + 0.2 * noise));
}

/**
 * Calculate forest edge probability (B channel).
 * Forest grows where there's good water flow and moderate terrain.
 */
fn calculateForest(height: f32, slope: f32, flow: f32, noise: f32) -> f32 {
  // Height factor: moderate elevations
  let heightFactor = smoothstep(params.forestHeightMin, params.forestHeightMin + 0.15, height)
                   * (1.0 - smoothstep(params.forestHeightMax - 0.15, params.forestHeightMax, height));
  
  // Slope factor: forests don't grow on cliffs
  let slopeFactor = 1.0 - smoothstep(0.35, 0.65, slope);
  
  // Flow factor: needs good water but not flooded
  let flowFactor = smoothstep(params.forestFlowMin, params.forestFlowMin + 0.15, flow)
                 * (1.0 - smoothstep(params.forestFlowMax - 0.15, params.forestFlowMax, flow));
  
  // Weighted combination - use min to ensure all conditions are met
  let terrainScore = min(heightFactor, slopeFactor);
  
  // Flow heavily influences forest presence
  let baseProbability = terrainScore * (0.3 + 0.7 * flowFactor * params.flowInfluence);
  
  // Add noise variation for natural clustering
  return saturate(baseProbability * (0.75 + 0.5 * noise));
}

// ==================== Main Entry Point ====================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(heightmap);
  
  // Bounds check
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  
  let coord = vec2i(gid.xy);
  
  // Sample terrain data
  let rawHeight = textureLoad(heightmap, coord, 0).r;
  // Normalize: terrain heights are typically in -0.5 to 0.5 range
  let height = saturate(rawHeight + 0.5);
  
  let slope = calculateSlope(coord, dims);
  let flow = sampleFlow(coord, dims);
  
  // Generate per-pixel noise for variation
  let noiseCoord = vec2f(gid.xy) * 0.1 + params.seed;
  let noise = hash(noiseCoord);
  
  // Calculate biome probabilities
  let grassland = calculateGrassland(height, slope, flow, noise);
  let rock = calculateRock(height, slope, flow, noise);
  let forest = calculateForest(height, slope, flow, noise);
  
  // Rock overrides other biomes on steep slopes
  let grassFinal = grassland * (1.0 - rock * 0.7);
  let forestFinal = forest * (1.0 - rock * 0.8);
  
  // Output: pure biome probabilities
  // R = grassland probability
  // G = rock probability
  // B = forest probability
  // A = reserved (always 1.0)
  textureStore(biomeMaskOut, coord, vec4f(grassFinal, rock, forestFinal, 1.0));
}
