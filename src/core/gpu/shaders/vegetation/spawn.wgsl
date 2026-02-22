/**
 * Vegetation Spawn Compute Shader
 * 
 * Generates instance positions for vegetation on terrain tiles.
 * Uses grid-based spawning with deterministic jitter for reproducible placement.
 * 
 * Each instance stores:
 *   positionAndScale: vec4f  (xyz = world position, w = scale)
 *   rotationAndType:  vec4f  (x = Y rotation, y = variant index, z = render flag, w = reserved)
 * 
 * Render flag: 0.0 = billboard, 1.0 = 3D mesh
 */

// ==================== Uniforms ====================

struct SpawnParams {
  // Tile info (vec4 aligned)
  tileOrigin: vec2f,         // World-space XZ origin of this tile
  tileSize: f32,             // World-space tile size
  density: f32,              // Base instances per square unit
  
  // Plant info
  biomeChannel: u32,         // 0=R, 1=G, 2=B, 3=A
  biomeThreshold: f32,       // Minimum biome value to spawn
  renderMode: u32,           // 0=billboard, 1=mesh, 2=hybrid
  variantCount: u32,         // Number of mesh/atlas variants (min 1)
  
  // Camera + LOD
  cameraPos: vec3f,          // Camera world position
  maxDistance: f32,           // Max spawn distance from camera
  
  // Hybrid parameters
  billboardDistance: f32,     // 3D→billboard transition distance
  seed: f32,                 // Per-dispatch random seed
  
  // Terrain parameters
  terrainSize: f32,          // Total terrain world size
  heightScale: f32,          // Terrain height multiplier
  
  // Size range
  minScale: f32,             // Minimum instance scale
  maxScale: f32,             // Maximum instance scale
  
  // Spawn limits
  maxInstances: u32,         // Buffer capacity (prevent overflow)
  
  // Clustering parameters
  clusterStrength: f32,      // 0 = uniform, 1 = highly clustered
  minSpacing: f32,           // Minimum distance between instances (world units)
  _padding: u32,
}

struct PlantInstance {
  positionAndScale: vec4f,
  rotationAndType: vec4f,
}

// ==================== Bindings ====================

@group(0) @binding(0) var<uniform> params: SpawnParams;
@group(0) @binding(1) var biomeMask: texture_2d<f32>;
@group(0) @binding(2) var heightmap: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> instances: array<PlantInstance>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
// counters[0] = total instance count
// counters[1] = mesh instance count
// counters[2] = billboard instance count

// ==================== Hash Functions ====================

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  let k = vec2f(
    hash21(p),
    hash21(p + vec2f(127.1, 311.7))
  );
  return k;
}

// ==================== Noise Functions (for clustering) ====================

/**
 * Value noise for smooth spatial variation.
 * Returns value in [0, 1].
 */
fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  
  // Smooth interpolation curve
  let u = f * f * (3.0 - 2.0 * f);
  
  // Four corners
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Fractal Brownian Motion — multi-octave noise for natural cluster patterns.
 * Uses 3 octaves with increasing frequency and decreasing amplitude.
 * Returns value in approximately [0, 1].
 */
fn clusterFBM(p: vec2f) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var maxValue = 0.0;
  
  // 3 octaves for a good balance of detail and performance
  for (var i = 0; i < 3; i++) {
    value += amplitude * valueNoise(p * frequency);
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  
  return value / maxValue;
}

// ==================== Coordinate Helpers ====================

/**
 * Convert world XZ position to heightmap UV (0-1).
 * Terrain is centered at origin: world range is [-terrainSize/2, terrainSize/2]
 */
fn worldToUV(worldXZ: vec2f) -> vec2f {
  return (worldXZ / params.terrainSize) + 0.5;
}

/**
 * Convert UV (0-1) to texel coordinates for textureLoad.
 */
fn uvToTexel(uv: vec2f, dims: vec2u) -> vec2i {
  return vec2i(
    clamp(i32(uv.x * f32(dims.x)), 0, i32(dims.x) - 1),
    clamp(i32(uv.y * f32(dims.y)), 0, i32(dims.y) - 1)
  );
}

/**
 * Select a channel from an RGBA vector by index.
 */
fn selectChannel(v: vec4f, channel: u32) -> f32 {
  switch channel {
    case 0u: { return v.r; }
    case 1u: { return v.g; }
    case 2u: { return v.b; }
    case 3u: { return v.a; }
    default: { return v.r; }
  }
}

// ==================== Main Entry Point ====================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // Determine grid resolution from tile size and density
  let gridSize = u32(ceil(params.tileSize * sqrt(params.density)));
  
  // Bounds check
  if (gid.x >= gridSize || gid.y >= gridSize) {
    return;
  }
  
  let cellSize = params.tileSize / f32(gridSize);
  let cellOrigin = params.tileOrigin + vec2f(f32(gid.x), f32(gid.y)) * cellSize;
  
  // ---- Deterministic jitter within cell ----
  let jitterSeed = cellOrigin * 7.13 + params.seed;
  let jitter = hash22(jitterSeed);
  let worldXZ = cellOrigin + jitter * cellSize;
  
  // ---- Convert to UV and sample textures ----
  let uv = worldToUV(worldXZ);
  
  // Skip if outside terrain bounds
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return;
  }
  
  let biomeDims = textureDimensions(biomeMask);
  let heightDims = textureDimensions(heightmap);
  
  let biomeTexel = uvToTexel(uv, biomeDims);
  let heightTexel = uvToTexel(uv, heightDims);
  
  // ---- Sample biome probability ----
  let biome = textureLoad(biomeMask, biomeTexel, 0);
  let biomeValue = selectChannel(biome, params.biomeChannel);
  
  // Skip if below threshold
  if (biomeValue < params.biomeThreshold) {
    return;
  }
  
  // ---- Clustering rejection ----
  // Use low-frequency FBM noise to create natural cluster patterns.
  // clusterStrength controls how much the noise gates spawning:
  //   0.0 = no clustering (all pass), 1.0 = tight clusters
  if (params.clusterStrength > 0.001) {
    // Large wavelength noise (~8-16 world units per feature) for natural-looking clumps
    let clusterNoise = clusterFBM(worldXZ * 0.12 + params.seed * 0.7);
    
    // Remap noise through a threshold curve controlled by clusterStrength.
    // Higher clusterStrength raises the threshold, rejecting more points,
    // leaving only the noise peaks (= cluster centers).
    let threshold = params.clusterStrength * 0.85; // max threshold ~0.85 to keep some vegetation
    if (clusterNoise < threshold) {
      return;
    }
  }
  
  // ---- MinSpacing enforcement ----
  // If cell size is smaller than minSpacing, probabilistically reject
  // to approximate minimum distance between instances.
  if (params.minSpacing > 0.0 && cellSize < params.minSpacing) {
    let spacingRatio = cellSize / params.minSpacing;
    // Probability of keeping = (cellSize / minSpacing)^2 (area-based)
    let keepProb = spacingRatio * spacingRatio;
    let spacingRoll = hash21(cellOrigin * 23.7 + params.seed * 3.1);
    if (spacingRoll > keepProb) {
      return;
    }
  }
  
  // ---- Density-based probability culling ----
  // Use biome value as spawn probability (higher biome = more likely)
  let spawnRoll = hash21(cellOrigin * 17.3 + params.seed);
  if (spawnRoll > biomeValue) {
    return;
  }
  
  // ---- Calculate world Y from heightmap ----
  let rawHeight = textureLoad(heightmap, heightTexel, 0).r;
  let worldY = rawHeight * params.heightScale;
  let worldPos = vec3f(worldXZ.x, worldY, worldXZ.y);
  
  // ---- Distance culling (safety net — main culling done by GPU cull shader per-frame) ----
  // With CDLOD-driven tiles, spawn camera is tile center, so this mainly prevents
  // instances at tile edges from exceeding the buffer. The per-frame cull.wgsl
  // handles actual camera-distance culling dynamically.
  let dist = distance(worldPos, params.cameraPos);
  if (dist > params.maxDistance) {
    return;
  }
  
  // NOTE: Distance-based density falloff removed — LOD-based density from CDLOD
  // quadtree now handles this. Closer tiles get higher density via densityMultiplier,
  // farther tiles get lower density. No need for per-instance distance thinning.
  
  // ---- Check instance buffer capacity ----
  let totalCount = atomicLoad(&counters[0]);
  if (totalCount >= params.maxInstances) {
    return;
  }
  
  // ---- Determine render flag ----
  var renderFlag = 0.0; // 0 = billboard
  if (params.renderMode == 1u) {
    // mesh-only
    renderFlag = 1.0;
  } else if (params.renderMode == 2u) {
    // hybrid: mesh if close, billboard if far
    if (dist < params.billboardDistance) {
      renderFlag = 1.0;
    }
  }
  
  // ---- Calculate instance properties ----
  let scale = mix(params.minScale, params.maxScale, hash21(cellOrigin * 31.7 + params.seed * 2.1));
  let rotation = hash21(cellOrigin * 41.3 + params.seed * 5.3) * 6.28318; // 0 to 2π
  let variantIndex = f32(u32(hash21(cellOrigin * 53.9 + params.seed * 7.7) * f32(max(params.variantCount, 1u))));
  
  // ---- Emit instance ----
  let idx = atomicAdd(&counters[0], 1u);
  if (idx >= params.maxInstances) {
    return;  // Double-check after atomic increment
  }
  
  instances[idx].positionAndScale = vec4f(worldPos, scale);
  instances[idx].rotationAndType = vec4f(rotation, variantIndex, renderFlag, 0.0);
  
  // Track render type counts
  if (renderFlag > 0.5) {
    atomicAdd(&counters[1], 1u);
  } else {
    atomicAdd(&counters[2], 1u);
  }
}