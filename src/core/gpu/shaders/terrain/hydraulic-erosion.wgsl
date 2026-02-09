// Hydraulic Erosion Compute Shader
// Particle-based droplet simulation for realistic water erosion
//
// Algorithm:
// 1. Spawn water droplets at random positions
// 2. Each droplet flows downhill, picking up sediment
// 3. When droplet slows or capacity decreases, deposit sediment
// 4. Droplet evaporates over time

struct ErosionParams {
  inertia: f32,           // How much droplet keeps its direction (0-1)
  sedimentCapacity: f32,  // Max sediment a droplet can carry per unit water
  minCapacity: f32,       // Minimum sediment capacity (prevents zero capacity)
  erosionRate: f32,       // How quickly terrain erodes
  depositionRate: f32,    // How quickly sediment deposits
  evaporationRate: f32,   // Water evaporation per step
  gravity: f32,           // Acceleration due to gravity
  minSlope: f32,          // Minimum slope for erosion
  
  mapSize: u32,           // Heightmap resolution
  maxDropletLifetime: u32, // Maximum steps per droplet
  dropletCount: u32,      // Droplets per dispatch
  seed: f32,              // Random seed for droplet placement
  
  brushRadius: i32,       // Erosion brush radius
  heightScale: f32,       // World-space height scale for proper erosion strength
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> params: ErosionParams;
@group(0) @binding(1) var heightmapIn: texture_2d<f32>;
@group(0) @binding(2) var heightmapOut: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<storage, read_write> erosionMap: array<f32>;
@group(0) @binding(4) var<storage, read_write> flowAccumulation: array<atomic<u32>>;
@group(0) @binding(5) var flowMapOut: texture_storage_2d<r32float, write>;

// ============================================================================
// Random Number Generation
// ============================================================================

fn pcg(seed: u32) -> u32 {
  let state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randomFloat(seed: ptr<function, u32>) -> f32 {
  *seed = pcg(*seed);
  return f32(*seed) / f32(0xFFFFFFFFu);
}

// ============================================================================
// Height Sampling with Bilinear Interpolation from erosionMap buffer
// ============================================================================

// Read height from erosionMap buffer at integer coordinates
fn getHeightAt(x: u32, y: u32) -> f32 {
  let dims = textureDimensions(heightmapIn);
  let clampedX = min(x, dims.x - 1u);
  let clampedY = min(y, dims.y - 1u);
  let idx = clampedY * dims.x + clampedX;
  return erosionMap[idx];
}

// Bilinear interpolation sampling from erosionMap (world-scale values)
fn getHeightBilinear(pos: vec2f) -> f32 {
  let dims = textureDimensions(heightmapIn);
  let maxCoord = vec2f(f32(dims.x - 1u), f32(dims.y - 1u));
  let clampedPos = clamp(pos, vec2f(0.0), maxCoord);
  
  let x0 = u32(floor(clampedPos.x));
  let y0 = u32(floor(clampedPos.y));
  let x1 = min(x0 + 1u, dims.x - 1u);
  let y1 = min(y0 + 1u, dims.y - 1u);
  
  let fx = fract(clampedPos.x);
  let fy = fract(clampedPos.y);
  
  // Read from erosionMap buffer (world-scale heights)
  let h00 = getHeightAt(x0, y0);
  let h10 = getHeightAt(x1, y0);
  let h01 = getHeightAt(x0, y1);
  let h11 = getHeightAt(x1, y1);
  
  return mix(mix(h00, h10, fx), mix(h01, h11, fx), fy);
}

// Calculate resolution scale factor (relative to base resolution of 1024)
fn getResolutionScale() -> f32 {
  return f32(params.mapSize) / 1024.0;
}

// Calculate gradient at position using central differences
// eps = 1.0 (single texel) to detect fine local slopes accurately
fn getGradient(pos: vec2f) -> vec2f {
  let eps = 1.0;  // Keep at 1 texel - we need local slope detection for proper droplet flow
  let hL = getHeightBilinear(pos - vec2f(eps, 0.0));
  let hR = getHeightBilinear(pos + vec2f(eps, 0.0));
  let hD = getHeightBilinear(pos - vec2f(0.0, eps));
  let hU = getHeightBilinear(pos + vec2f(0.0, eps));
  
  return vec2f(hR - hL, hU - hD) / (2.0 * eps);
}

// ============================================================================
// Erosion/Deposition Application
// ============================================================================

// Apply erosion or deposition at position using soft brush
// Brush radius is scaled by resolution to maintain consistent world-space coverage
fn applyChange(pos: vec2f, amount: f32, isErosion: bool) {
  let dims = textureDimensions(heightmapIn);
  let mapSize = i32(dims.x);
  
  let centerX = i32(floor(pos.x));
  let centerY = i32(floor(pos.y));
  
  // Scale brush radius by resolution ratio to maintain consistent world-space coverage
  // At 4K (4096), radius is 4x larger in texels to cover same world area as at 1K
  let resScale = getResolutionScale();
  let radius = i32(f32(params.brushRadius) * resScale);
  
  // Calculate weight sum for normalization
  var weightSum: f32 = 0.0;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      let dist = sqrt(f32(dx * dx + dy * dy));
      if (dist <= f32(radius)) {
        let weight = max(0.0, 1.0 - dist / f32(radius));
        weightSum += weight;
      }
    }
  }
  
  if (weightSum < 0.0001) {
    return;
  }
  
  // Apply change with normalized weights
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      let x = centerX + dx;
      let y = centerY + dy;
      
      if (x >= 0 && x < mapSize && y >= 0 && y < mapSize) {
        let dist = sqrt(f32(dx * dx + dy * dy));
        if (dist <= f32(radius)) {
          let weight = max(0.0, 1.0 - dist / f32(radius)) / weightSum;
          let idx = u32(y * mapSize + x);
          
          if (isErosion) {
            erosionMap[idx] -= amount * weight;
          } else {
            erosionMap[idx] += amount * weight;
          }
        }
      }
    }
  }
}

// ============================================================================
// Droplet Simulation
// ============================================================================

struct Droplet {
  pos: vec2f,
  dir: vec2f,
  vel: f32,
  water: f32,
  sediment: f32,
}

fn simulateDroplet(startPos: vec2f) {
  var droplet: Droplet;
  droplet.pos = startPos;
  droplet.dir = vec2f(0.0);
  droplet.vel = 0.0;
  droplet.water = 1.0;
  droplet.sediment = 0.0;
  
  let mapSize = f32(params.mapSize);
  
  for (var step = 0u; step < params.maxDropletLifetime; step++) {
    let nodeX = i32(floor(droplet.pos.x));
    let nodeY = i32(floor(droplet.pos.y));
    
    // Check bounds
    if (nodeX < 0 || nodeX >= i32(params.mapSize) - 1 ||
        nodeY < 0 || nodeY >= i32(params.mapSize) - 1) {
      break;
    }
    
    // Track droplet visit for flow accumulation map
    let flowIdx = u32(nodeY) * params.mapSize + u32(nodeX);
    atomicAdd(&flowAccumulation[flowIdx], 1u);
    
    // Calculate offset within cell
    let cellOffset = droplet.pos - vec2f(f32(nodeX), f32(nodeY));
    
    // Get current height and gradient
    let currentHeight = getHeightBilinear(droplet.pos);
    let gradient = getGradient(droplet.pos);
    
    // Update direction using gradient and inertia
    droplet.dir = normalize(
      droplet.dir * params.inertia - gradient * (1.0 - params.inertia) + vec2f(0.0001)
    );
    
    // Move droplet 1 texel at a time (avoid tunnelling at high resolutions)
    // Resolution compensation done via scaled lifetime and rates instead
    let newPos = droplet.pos + droplet.dir;
    
    // Check new position bounds
    if (newPos.x < 0.0 || newPos.x >= mapSize - 1.0 ||
        newPos.y < 0.0 || newPos.y >= mapSize - 1.0) {
      break;
    }
    
    // Calculate height difference
    let newHeight = getHeightBilinear(newPos);
    let deltaHeight = newHeight - currentHeight;
    
    // Calculate sediment capacity
    let capacity = max(
      -deltaHeight * droplet.vel * droplet.water * params.sedimentCapacity,
      params.minCapacity
    );
    
    // Erosion or deposition
    if (droplet.sediment > capacity || deltaHeight > 0.0) {
      // Deposit sediment
      var amountToDeposit: f32;
      if (deltaHeight > 0.0) {
        // Deposit enough to fill the hole (but not more than we have)
        amountToDeposit = min(deltaHeight, droplet.sediment);
      } else {
        // Deposit a portion of excess sediment
        amountToDeposit = (droplet.sediment - capacity) * params.depositionRate;
      }
      droplet.sediment -= amountToDeposit;
      applyChange(droplet.pos, amountToDeposit, false);
    } else {
      // Erode terrain
      let amountToErode = min(
        (capacity - droplet.sediment) * params.erosionRate,
        -deltaHeight + params.minSlope
      );
      droplet.sediment += amountToErode;
      applyChange(droplet.pos, amountToErode, true);
    }
    
    // Update velocity and water
    droplet.vel = sqrt(max(0.0, droplet.vel * droplet.vel - deltaHeight * params.gravity));
    droplet.water *= (1.0 - params.evaporationRate);
    
    // Move to new position
    droplet.pos = newPos;
    
    // Stop if water evaporated
    if (droplet.water < 0.01) {
      break;
    }
  }
}

// ============================================================================
// Main Compute Kernels
// ============================================================================

// Initialize erosion map from input heightmap
@compute @workgroup_size(8, 8, 1)
fn initErosionMap(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let idx = globalId.y * dims.x + globalId.x;
  let height = textureLoad(heightmapIn, vec2i(globalId.xy), 0).r;
  // Re-mapped to world scale for erosion
  erosionMap[idx] = height * params.heightScale;
}

// Simulate droplets (run multiple times for full erosion)
@compute @workgroup_size(64, 1, 1)
fn simulateDroplets(@builtin(global_invocation_id) globalId: vec3u) {
  if (globalId.x >= params.dropletCount) {
    return;
  }
  
  // Generate random starting position
  var seed = u32(globalId.x) + u32(params.seed * 1000000.0);
  let startX = randomFloat(&seed) * f32(params.mapSize - 2u) + 1.0;
  let startY = randomFloat(&seed) * f32(params.mapSize - 2u) + 1.0;
  
  simulateDroplet(vec2f(startX, startY));
}

// Write erosion map back to texture
@compute @workgroup_size(8, 8, 1)
fn finalizeErosion(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let idx = globalId.y * dims.x + globalId.x;
  // Write back world scale to normalized values in texture
  let height = erosionMap[idx] / params.heightScale;
  
  textureStore(heightmapOut, vec2i(globalId.xy), vec4f(height, 0.0, 0.0, 1.0));
}

// Finalize flow map - normalize accumulated flow values and write to texture
// Uses log scale for better distribution since flow values vary widely
@compute @workgroup_size(8, 8, 1)
fn finalizeFlowMap(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  
  if (globalId.x >= dims.x || globalId.y >= dims.y) {
    return;
  }
  
  let idx = globalId.y * dims.x + globalId.x;
  let rawFlow = f32(atomicLoad(&flowAccumulation[idx]));
  
  // Normalize with log scale for better distribution
  // More sensitive: even small values (1-10 visits) will show some color
  // log(1 + x) / log(1000) gives good range for 0-1000+ visits
  let normalizedFlow = saturate(log(1.0 + rawFlow) / log(1000.0));
  
  textureStore(flowMapOut, vec2i(globalId.xy), vec4f(normalizedFlow, 0.0, 0.0, 1.0));
}
