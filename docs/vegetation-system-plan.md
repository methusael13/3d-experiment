# Vegetation System Implementation Plan

This document outlines the design and implementation plan for a GPU-based vegetation system that covers terrain with biome-appropriate plants, starting with grassland biomes.

## Overview

The vegetation system renders billboard-based plants (grass, shrubs, flowers) across terrain surfaces. Vegetation density is driven by:
- **Biome mask** - Which biome types are present at each location
- **Water flow map** - From hydraulic erosion, identifies fertile valleys
- **Terrain slope** - Steep slopes get less vegetation
- **Distance-based LOD** - Fewer instances at greater distances

## Architecture

```
src/core/vegetation/
├── index.ts                   # Public exports
├── VegetationManager.ts       # High-level orchestration
├── BiomeMaskGenerator.ts      # GPU compute for biome masks
├── VegetationSpawner.ts       # GPU compute for position generation
├── VegetationRenderer.ts      # Instanced billboard rendering
├── VegetationTileCache.ts     # Per-tile instance caching
├── PlantRegistry.ts           # Plant type definitions
└── types.ts                   # Shared interfaces

src/core/gpu/shaders/vegetation/
├── biome-mask.wgsl            # Biome probability computation
├── spawn.wgsl                 # Instance position generation
└── billboard.wgsl             # Vertex/fragment for rendering
```

---

## Phase 0: Water Flow Map Enhancement

**Goal:** Track water flow during hydraulic erosion to identify fertile areas.

### Changes to `hydraulic-erosion.wgsl`

```wgsl
// New binding for flow accumulation
@group(0) @binding(4) var<storage, read_write> flowAccumulation: array<atomic<u32>>;

// In simulateDroplet(), track visits:
fn simulateDroplet(startPos: vec2f) {
  // ... existing code ...
  
  for (var step = 0u; step < params.maxDropletLifetime; step++) {
    // Track droplet visit (atomic increment)
    let idx = u32(nodeY) * params.mapSize + u32(nodeX);
    atomicAdd(&flowAccumulation[idx], 1u);
    
    // ... rest of simulation ...
  }
}

// New finalize pass for flow map
@compute @workgroup_size(8, 8, 1)
fn finalizeFlowMap(@builtin(global_invocation_id) globalId: vec3u) {
  let dims = textureDimensions(heightmapIn);
  if (globalId.x >= dims.x || globalId.y >= dims.y) { return; }
  
  let idx = globalId.y * dims.x + globalId.x;
  let rawFlow = f32(atomicLoad(&flowAccumulation[idx]));
  
  // Normalize with log scale for better distribution
  let normalizedFlow = saturate(log(1.0 + rawFlow * 0.01) / log(100.0));
  
  textureStore(flowMapOut, vec2i(globalId.xy), vec4f(normalizedFlow, 0, 0, 1));
}
```

### Changes to `ErosionSimulator.ts`

```typescript
// Add flow resources
private flowAccumulationBuffer: UnifiedGPUBuffer | null = null;
private flowMapTexture: UnifiedGPUTexture | null = null;
private flowFinalizeLayout: GPUBindGroupLayout | null = null;
private flowFinalizePipeline: ComputePipelineWrapper | null = null;

// Initialize in initialize()
this.flowAccumulationBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
  label: 'flow-accumulation-buffer',
  size: this.resolution * this.resolution * 4, // u32 per texel
});

this.flowMapTexture = UnifiedGPUTexture.create2D(this.ctx, {
  label: 'flow-map',
  width: this.resolution,
  height: this.resolution,
  format: 'r32float',
  storage: true,
  sampled: true,
});

// Clear flow buffer at start of hydraulic erosion
// Finalize flow map after all erosion iterations complete

getFlowMap(): UnifiedGPUTexture | null {
  return this.flowMapTexture;
}
```

### Changes to `TerrainManager.ts`

```typescript
private flowMap: UnifiedGPUTexture | null = null;

// After erosion completes:
this.flowMap = this.erosionSimulator.getFlowMap();

getFlowMap(): UnifiedGPUTexture | null {
  return this.flowMap;
}
```

### Tasks
- [ ] Add `flowAccumulation` atomic buffer binding to hydraulic-erosion.wgsl
- [ ] Track droplet visits with `atomicAdd` during simulation
- [ ] Add `finalizeFlowMap` entry point
- [ ] Update ErosionSimulator with flow buffer + texture
- [ ] Add flow finalize pipeline and bind group
- [ ] Clear flow buffer at erosion start
- [ ] Add `getFlowMap()` accessor to ErosionSimulator
- [ ] Update TerrainManager to store and expose flow map
- [ ] Add debug mode in Terrain erosion settings to display the flow map

---

## Phase 1: Biome Mask Generation

**Goal:** Generate RGBA texture encoding biome probabilities from terrain data.

### Biome Channels
| Channel | Biome | Conditions |
|---------|-------|------------|
| R | Grassland | Moderate height, low slope, optimal flow |
| G | Rock/Cliff | High slope |
| B | Forest Edge | Moderate height, low slope, high flow |
| A | Reserved | Future (snow, desert, etc.) |

### `biome-mask.wgsl`

```wgsl
struct BiomeParams {
  heightInfluence: f32,     // How much height affects biome
  slopeInfluence: f32,      // How much slope affects biome
  flowInfluence: f32,       // How much water flow affects biome
  seed: f32,                // Noise variation seed
  grassHeightMin: f32,
  grassHeightMax: f32,
  grassSlopeMax: f32,
  rockSlopeMin: f32,
}

@group(0) @binding(0) var<uniform> params: BiomeParams;
@group(0) @binding(1) var heightmap: texture_2d<f32>;
@group(0) @binding(2) var flowMap: texture_2d<f32>;
@group(0) @binding(3) var biomeMaskOut: texture_storage_2d<rgba8unorm, write>;

fn calculateSlope(uv: vec2f) -> f32 {
  let eps = 1.0 / f32(textureDimensions(heightmap).x);
  let hL = textureLoad(heightmap, vec2i((uv - vec2f(eps, 0)) * vec2f(textureDimensions(heightmap))), 0).r;
  let hR = textureLoad(heightmap, vec2i((uv + vec2f(eps, 0)) * vec2f(textureDimensions(heightmap))), 0).r;
  let hD = textureLoad(heightmap, vec2i((uv - vec2f(0, eps)) * vec2f(textureDimensions(heightmap))), 0).r;
  let hU = textureLoad(heightmap, vec2i((uv + vec2f(0, eps)) * vec2f(textureDimensions(heightmap))), 0).r;
  
  let dx = (hR - hL) / (2.0 * eps);
  let dy = (hU - hD) / (2.0 * eps);
  
  return sqrt(dx * dx + dy * dy);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(heightmap);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  
  let uv = vec2f(gid.xy) / vec2f(dims);
  let height = textureLoad(heightmap, vec2i(gid.xy), 0).r;
  let flow = textureLoad(flowMap, vec2i(gid.xy), 0).r;
  let slope = calculateSlope(uv);
  
  // Grassland: moderate height, low slope, optimal flow (not too dry, not flooded)
  let heightFactor = smoothstep(params.grassHeightMin, params.grassHeightMax, height);
  let slopeFactor = 1.0 - smoothstep(0.3, params.grassSlopeMax, slope);
  let flowFactor = smoothstep(0.1, 0.4, flow) * (1.0 - smoothstep(0.7, 0.95, flow));
  let grass = heightFactor * slopeFactor * (0.3 + 0.7 * flowFactor);
  
  // Rock: steep slopes
  let rock = smoothstep(params.rockSlopeMin, 0.8, slope);
  
  // Forest edge: good flow, moderate slope
  let forest = smoothstep(0.3, 0.6, flow) * (1.0 - slope) * heightFactor;
  
  textureStore(biomeMaskOut, vec2i(gid.xy), vec4f(grass, rock, forest, 0.0));
}
```

### `BiomeMaskGenerator.ts`

```typescript
export interface BiomeParams {
  heightInfluence: number;
  slopeInfluence: number;
  flowInfluence: number;
  seed: number;
  grassHeightMin: number;
  grassHeightMax: number;
  grassSlopeMax: number;
  rockSlopeMin: number;
}

export function createDefaultBiomeParams(): BiomeParams {
  return {
    heightInfluence: 1.0,
    slopeInfluence: 1.0,
    flowInfluence: 1.0,
    seed: 12345,
    grassHeightMin: -0.2,
    grassHeightMax: 0.5,
    grassSlopeMax: 0.6,
    rockSlopeMin: 0.5,
  };
}

export class BiomeMaskGenerator {
  generateBiomeMask(
    heightmap: UnifiedGPUTexture,
    flowMap: UnifiedGPUTexture | null,
    params?: Partial<BiomeParams>
  ): UnifiedGPUTexture;
}
```

### Tasks
- [ ] Create `biome-mask.wgsl` compute shader
- [ ] Implement `BiomeMaskGenerator.ts` class
- [ ] Add biome params interface and defaults
- [ ] Sample heightmap for height values
- [ ] Calculate slope from heightmap gradients
- [ ] Sample flow map (with fallback if null)
- [ ] Output RGBA biome probabilities
- [ ] Integrate with TerrainManager

---

## Phase 2: Plant Foundation

**Goal:** Define plant types and create the registry.

### `types.ts`

```typescript
export interface PlantType {
  id: string;
  name: string;
  
  // Visual (colored quads initially)
  color: [number, number, number];
  
  // Atlas info (null initially, injected later)
  atlasRegion: {
    u: number;
    v: number;
    width: number;
    height: number;
  } | null;
  
  // Size in world units
  minSize: [number, number];
  maxSize: [number, number];
  
  // Spawn distribution
  spawnProbability: number;
  biomeChannel: 'r' | 'g' | 'b' | 'a';
  biomeThreshold: number;
  
  // Clustering
  clusterStrength: number;
  minSpacing: number;
  
  // LOD
  maxDistance: number;
  lodBias: number;
}

export interface VegetationConfig {
  enabled: boolean;
  globalDensity: number;
  windEnabled: boolean;
  debugMode: boolean;
}

export interface WindParams {
  direction: [number, number];  // XZ normalized
  strength: number;             // 0-1
  frequency: number;            // Oscillation speed
  gustStrength: number;         // Local variation amplitude
  gustFrequency: number;        // Spatial frequency of gusts
}
```

### `PlantRegistry.ts`

```typescript
export const GRASSLAND_PLANTS: PlantType[] = [
  {
    id: 'tall-grass',
    name: 'Tall Grass',
    color: [0.3, 0.6, 0.2],
    atlasRegion: null,
    minSize: [0.3, 0.5],
    maxSize: [0.5, 1.2],
    spawnProbability: 0.6,
    biomeChannel: 'r',
    biomeThreshold: 0.3,
    clusterStrength: 0.4,
    minSpacing: 0.2,
    maxDistance: 200,
    lodBias: 1.0,
  },
  {
    id: 'short-grass',
    name: 'Short Grass Clump',
    color: [0.4, 0.5, 0.2],
    atlasRegion: null,
    minSize: [0.2, 0.15],
    maxSize: [0.3, 0.3],
    spawnProbability: 0.8,
    biomeChannel: 'r',
    biomeThreshold: 0.2,
    clusterStrength: 0.2,
    minSpacing: 0.1,
    maxDistance: 100,
    lodBias: 0.8,
  },
  {
    id: 'wildflower-yellow',
    name: 'Yellow Wildflower',
    color: [0.9, 0.8, 0.2],
    atlasRegion: null,
    minSize: [0.15, 0.2],
    maxSize: [0.25, 0.4],
    spawnProbability: 0.15,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.7,
    minSpacing: 0.3,
    maxDistance: 150,
    lodBias: 1.2,
  },
  {
    id: 'wildflower-purple',
    name: 'Purple Wildflower',
    color: [0.6, 0.3, 0.7],
    atlasRegion: null,
    minSize: [0.12, 0.18],
    maxSize: [0.22, 0.35],
    spawnProbability: 0.1,
    biomeChannel: 'r',
    biomeThreshold: 0.5,
    clusterStrength: 0.6,
    minSpacing: 0.35,
    maxDistance: 150,
    lodBias: 1.2,
  },
  {
    id: 'small-shrub',
    name: 'Small Shrub',
    color: [0.25, 0.4, 0.2],
    atlasRegion: null,
    minSize: [0.4, 0.3],
    maxSize: [0.8, 0.6],
    spawnProbability: 0.05,
    biomeChannel: 'r',
    biomeThreshold: 0.6,
    clusterStrength: 0.3,
    minSpacing: 1.0,
    maxDistance: 300,
    lodBias: 1.5,
  },
];

export class PlantRegistry {
  private plants: Map<string, PlantType> = new Map();
  
  registerPlant(plant: PlantType): void;
  getPlant(id: string): PlantType | undefined;
  getPlantsByBiome(channel: 'r' | 'g' | 'b' | 'a'): PlantType[];
  getAllPlants(): PlantType[];
  setAtlasRegion(id: string, region: PlantType['atlasRegion']): void;
}
```

### Tasks
- [ ] Create `types.ts` with PlantType, VegetationConfig, WindParams
- [ ] Create `PlantRegistry.ts` with plant management
- [ ] Define initial grassland plant presets
- [ ] Add methods for atlas region injection

---

## Phase 3: Spawning System

**Goal:** GPU compute shader generates instance positions per terrain tile.

### `spawn.wgsl`

```wgsl
struct SpawnParams {
  tileOrigin: vec2f,        // World-space tile origin
  tileSize: f32,            // World-space tile size
  density: f32,             // Instances per square unit
  lodLevel: u32,            // Current LOD level
  plantTypeIndex: u32,      // Which plant type
  biomeChannel: u32,        // 0=R, 1=G, 2=B, 3=A
  biomeThreshold: f32,      // Minimum biome value
  seed: f32,                // Random seed
  cameraPos: vec3f,         // For distance culling
  maxDistance: f32,         // Max spawn distance
}

struct PlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = uniform scale
  rotationAndType: vec4f,   // x = Y rotation, yzw = color RGB
}

@group(0) @binding(0) var<uniform> params: SpawnParams;
@group(0) @binding(1) var biomeMask: texture_2d<f32>;
@group(0) @binding(2) var heightmap: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> instances: array<PlantInstance>;
@group(0) @binding(4) var<storage, read_write> instanceCount: atomic<u32>;

fn hash(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // Grid-based spawning within tile
  let gridSize = u32(ceil(params.tileSize * sqrt(params.density)));
  if (gid.x >= gridSize || gid.y >= gridSize) { return; }
  
  let cellSize = params.tileSize / f32(gridSize);
  let cellOrigin = params.tileOrigin + vec2f(gid.xy) * cellSize;
  
  // Deterministic jitter within cell
  let jitterSeed = cellOrigin + vec2f(params.seed);
  let jitter = vec2f(hash(jitterSeed), hash(jitterSeed + vec2f(1.0, 0.0)));
  let worldPos2D = cellOrigin + jitter * cellSize;
  
  // Sample biome mask
  let uv = worldPosToUV(worldPos2D);
  let biome = textureLoad(biomeMask, uvToTexel(uv), 0);
  let biomeValue = selectChannel(biome, params.biomeChannel);
  
  // Skip if below threshold
  if (biomeValue < params.biomeThreshold) { return; }
  
  // Distance-based probability
  let terrainHeight = textureLoad(heightmap, uvToTexel(uv), 0).r * heightScale;
  let worldPos = vec3f(worldPos2D.x, terrainHeight, worldPos2D.y);
  let dist = distance(worldPos, params.cameraPos);
  
  if (dist > params.maxDistance) { return; }
  
  // LOD-based density reduction
  let lodDensity = 1.0 / f32(1u << params.lodLevel);
  let spawnChance = biomeValue * lodDensity;
  
  if (hash(cellOrigin * 17.3 + params.seed) > spawnChance) { return; }
  
  // Emit instance
  let idx = atomicAdd(&instanceCount, 1u);
  let scale = mix(minSize, maxSize, hash(cellOrigin * 23.7));
  let rotation = hash(cellOrigin * 31.1) * 6.28318;
  
  instances[idx].positionAndScale = vec4f(worldPos, scale);
  instances[idx].rotationAndType = vec4f(rotation, plantColor);
}
```

### `VegetationSpawner.ts`

```typescript
export interface SpawnRequest {
  tileId: string;
  tileOrigin: vec2;
  tileSize: number;
  lodLevel: number;
  cameraPosition: vec3;
}

export class VegetationSpawner {
  constructor(ctx: GPUContext, plantRegistry: PlantRegistry);
  
  // Spawn vegetation for a tile, returns instance buffer
  spawnTile(
    request: SpawnRequest,
    biomeMask: UnifiedGPUTexture,
    heightmap: UnifiedGPUTexture
  ): Promise<{ buffer: GPUBuffer; count: number }>;
  
  // Batch spawn multiple tiles
  spawnTiles(requests: SpawnRequest[], ...): Promise<Map<string, TileData>>;
}
```

### Tasks
- [ ] Create `spawn.wgsl` compute shader
- [ ] Implement grid-based spawning with jitter
- [ ] Sample biome mask for spawn probability
- [ ] Calculate terrain height for Y positioning
- [ ] Apply LOD-based density reduction
- [ ] Use atomic counter for instance count
- [ ] Implement `VegetationSpawner.ts` class
- [ ] Add batch spawning for multiple tiles

---

## Phase 4: Billboard Rendering

**Goal:** Instanced billboard rendering with wind animation.

### `billboard.wgsl`

```wgsl
struct Uniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  time: f32,
}

struct WindParams {
  direction: vec2f,
  strength: f32,
  frequency: f32,
  gustStrength: f32,
  gustFrequency: f32,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> wind: WindParams;
@group(0) @binding(2) var<storage, read> instances: array<PlantInstance>;

// Optional: texture atlas
// @group(0) @binding(3) var plantAtlas: texture_2d<f32>;
// @group(0) @binding(4) var atlasSampler: sampler;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) worldPos: vec3f,
}

// Simple 2D FBM for wind gusts
fn fbm2D(p: vec2f, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var pos = p;
  
  for (var i = 0u; i < octaves; i++) {
    value += amplitude * (sin(pos.x) * cos(pos.y) * 0.5 + 0.5);
    pos *= 2.0;
    amplitude *= 0.5;
  }
  
  return value;
}

fn applyWind(worldPos: vec3f, vertexHeight: f32) -> vec3f {
  // Base oscillation (global)
  let phase = dot(worldPos.xz, wind.direction) * 0.1 + uniforms.time * wind.frequency;
  let baseWind = sin(phase) * wind.strength;
  
  // Local gust variation (GPU noise)
  let gustUV = worldPos.xz * wind.gustFrequency + uniforms.time * 0.3;
  let gustNoise = fbm2D(gustUV, 2u) * 2.0 - 1.0;
  let localGust = gustNoise * wind.gustStrength;
  
  // Apply to top vertices (vertexHeight = 0 at base, 1 at tip)
  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight;
  
  return worldPos + vec3f(wind.direction.x, 0.0, wind.direction.y) * displacement;
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let instance = instances[input.instanceIndex];
  let worldPosBase = instance.positionAndScale.xyz;
  let scale = instance.positionAndScale.w;
  let rotation = instance.rotationAndType.x;
  let color = instance.rotationAndType.yzw;
  
  // Quad vertices (2 triangles, 6 vertices)
  let quadVerts = array<vec2f, 6>(
    vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
    vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0)
  );
  let quadUVs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0)
  );
  
  let localPos = quadVerts[input.vertexIndex];
  let uv = quadUVs[input.vertexIndex];
  let vertexHeight = localPos.y;  // 0 at base, 1 at top
  
  // Billboard facing camera (Y-axis aligned)
  let toCamera = normalize(uniforms.cameraPosition - worldPosBase);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCamera));
  
  // Apply rotation around Y axis
  let cosR = cos(rotation);
  let sinR = sin(rotation);
  let rotatedRight = vec3f(
    right.x * cosR - right.z * sinR,
    0.0,
    right.x * sinR + right.z * cosR
  );
  
  // Build world position
  var worldPos = worldPosBase;
  worldPos += rotatedRight * localPos.x * scale;
  worldPos.y += localPos.y * scale;
  
  // Apply wind displacement
  worldPos = applyWind(worldPos, vertexHeight);
  
  var output: VertexOutput;
  output.position = uniforms.viewProjection * vec4f(worldPos, 1.0);
  output.uv = uv;
  output.color = color;
  output.worldPos = worldPos;
  
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Simple colored quad (atlas sampling can be added later)
  let color = input.color;
  
  // Soft alpha gradient at edges (optional)
  let alpha = smoothstep(0.0, 0.1, input.uv.x) * 
              smoothstep(1.0, 0.9, input.uv.x);
  
  // Distance fade
  let dist = distance(input.worldPos, uniforms.cameraPosition);
  let fade = 1.0 - smoothstep(150.0, 200.0, dist);
  
  return vec4f(color, alpha * fade);
}
```

### `VegetationRenderer.ts`

```typescript
export class VegetationRenderer {
  constructor(ctx: GPUContext);
  
  // Initialize render pipeline
  initialize(depthFormat: GPUTextureFormat): void;
  
  // Render all visible vegetation tiles
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: mat4,
    cameraPosition: vec3,
    tiles: Map<string, VegetationTileData>,
    wind: WindParams
  ): void;
  
  // Update wind parameters
  setWind(params: WindParams): void;
  
  destroy(): void;
}
```

### Tasks
- [ ] Create `billboard.wgsl` vertex/fragment shader
- [ ] Implement Y-axis aligned billboarding
- [ ] Add wind displacement with base oscillation
- [ ] Add GPU-computed local gusts (FBM noise)
- [ ] Implement distance-based alpha fade
- [ ] Create `VegetationRenderer.ts` class
- [ ] Set up instanced draw calls
- [ ] Handle wind uniform updates

---

## Phase 5: LOD & Tile Caching

**Goal:** Manage vegetation instances per terrain tile with LOD-aware caching.

### LOD Density Mapping

| Terrain LOD | Vegetation Density | Max Distance |
|-------------|-------------------|--------------|
| 0 (closest) | 100% | 0-50m |
| 1 | 60% | 50-100m |
| 2 | 30% | 100-200m |
| 3 | 10% | 200-400m |
| 4+ | 0% | >400m |

### `VegetationTileCache.ts`

```typescript
interface VegetationTileData {
  tileId: string;
  lodLevel: number;
  instanceBuffer: GPUBuffer;
  instanceCount: number;
  lastUsedFrame: number;
  bounds: BoundingBox;
}

export class VegetationTileCache {
  private tiles: Map<string, VegetationTileData> = new Map();
  private maxCacheSize: number = 100;
  private currentFrame: number = 0;
  
  // Called when terrain tile becomes visible
  onTileVisible(tileId: string, lodLevel: number, bounds: BoundingBox): void;
  
  // Called when terrain tile LOD changes
  onTileLODChange(tileId: string, oldLod: number, newLod: number): void;
  
  // Called when terrain tile becomes invisible
  onTileHidden(tileId: string): void;
  
  // Get tiles to render
  getVisibleTiles(): VegetationTileData[];
  
  // Evict old tiles (LRU)
  evictOldTiles(): void;
  
  // Connect to terrain CDLOD events
  connectToTerrain(terrainManager: TerrainManager): void;
}
```

### Integration with CDLOD

```typescript
// In CDLODRendererGPU.ts or TerrainQuadtree.ts
interface TileVisibilityCallback {
  onTileVisible(tileId: string, lodLevel: number, bounds: BoundingBox): void;
  onTileLODChange(tileId: string, oldLod: number, newLod: number): void;
  onTileHidden(tileId: string): void;
}

// Emit events during quadtree traversal
```

### Tasks
- [ ] Create `VegetationTileCache.ts` class
- [ ] Implement tile lifecycle management
- [ ] Add LRU eviction policy
- [ ] Define LOD-to-density mapping
- [ ] Add tile visibility callbacks to CDLOD
- [ ] Connect vegetation cache to terrain tile events

---

## Phase 6: VegetationManager Integration

**Goal:** High-level orchestration connecting all vegetation components.

### `VegetationManager.ts`

```typescript
export class VegetationManager {
  private ctx: GPUContext;
  private plantRegistry: PlantRegistry;
  private biomeMaskGenerator: BiomeMaskGenerator;
  private spawner: VegetationSpawner;
  private renderer: VegetationRenderer;
  private tileCache: VegetationTileCache;
  
  private biomeMask: UnifiedGPUTexture | null = null;
  private config: VegetationConfig;
  private wind: WindParams;
  
  constructor(ctx: GPUContext);
  
  initialize(): void;
  
  // Generate biome mask from terrain data
  generateBiomeMask(
    heightmap: UnifiedGPUTexture,
    flowMap: UnifiedGPUTexture | null,
    params?: Partial<BiomeParams>
  ): void;
  
  // Connect to TerrainManager for tile events
  connectToTerrain(terrainManager: TerrainManager): void;
  
  // Called each frame
  update(cameraPosition: vec3, deltaTime: number): void;
  
  // Render vegetation
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: mat4,
    cameraPosition: vec3
  ): void;
  
  // Configuration
  setConfig(config: Partial<VegetationConfig>): void;
  setWind(params: Partial<WindParams>): void;
  
  // Debug
  getBiomeMask(): UnifiedGPUTexture | null;
  getStats(): { tileCount: number; instanceCount: number };
  
  destroy(): void;
}
```

### Integration with Render Pipeline

```typescript
// In GPUForwardPipeline.ts
renderVegetation(
  passEncoder: GPURenderPassEncoder,
  context: RenderContext
): void {
  if (!this.vegetationManager?.isEnabled()) return;
  
  this.vegetationManager.render(
    passEncoder,
    context.viewProjectionMatrix,
    context.cameraPosition
  );
}
```

### Tasks
- [ ] Create `VegetationManager.ts` class
- [ ] Implement initialization and lifecycle
- [ ] Add biome mask generation trigger
- [ ] Connect to TerrainManager
- [ ] Implement per-frame update
- [ ] Add render method
- [ ] Expose configuration setters
- [ ] Add to GPUForwardPipeline

---

## Phase 7: UI & Polish

**Goal:** Add user controls and optimize performance.

### TerrainPanel Vegetation Section

```tsx
// VegetationSection.tsx
const VegetationSection = () => {
  return (
    <Section title="Vegetation" defaultOpen={false}>
      <Checkbox label="Enable Vegetation" ... />
      <Slider label="Global Density" min={0} max={2} ... />
      
      <SubSection title="Wind">
        <Checkbox label="Enable Wind" ... />
        <Slider label="Wind Strength" min={0} max={1} ... />
        <Slider label="Wind Frequency" min={0.1} max={5} ... />
        <Slider label="Gust Strength" min={0} max={1} ... />
      </SubSection>
      
      <SubSection title="Debug">
        <Checkbox label="Show Biome Mask" ... />
        <Checkbox label="Show Flow Map" ... />
      </SubSection>
    </Section>
  );
};
```

### Performance Optimizations

1. **Frustum culling** - Skip tiles outside view frustum
2. **GPU buffer pooling** - Reuse instance buffers
3. **Async spawning** - Don't block main thread
4. **Distance sorting** - Render front-to-back for early Z rejection
5. **Instance count limits** - Cap per-tile instances

### Tasks
- [ ] Create VegetationSection.tsx component
- [ ] Add to TerrainPanel
- [ ] Implement vegetation config store
- [ ] Add wind parameter controls
- [ ] Add debug visualization toggles
- [ ] Implement frustum culling
- [ ] Add GPU buffer pooling
- [ ] Performance profiling and optimization

---

## Summary

### File Structure (Final)

```
src/core/vegetation/
├── index.ts
├── types.ts
├── VegetationManager.ts
├── BiomeMaskGenerator.ts
├── VegetationSpawner.ts
├── VegetationRenderer.ts
├── VegetationTileCache.ts
└── PlantRegistry.ts

src/core/gpu/shaders/vegetation/
├── biome-mask.wgsl
├── spawn.wgsl
└── billboard.wgsl
```

### Data Flow

```
[Heightmap] + [Flow Map] → [BiomeMaskGenerator] → [Biome Mask]
                                                        ↓
[Camera Position] + [Tile Bounds] → [VegetationSpawner] → [Instance Buffers]
                                                                ↓
                                    [VegetationRenderer] → [Billboard Quads]
```

### Progress Tracking

#### Phase 0: Water Flow Map
- [ ] Add flowAccumulation atomic buffer to hydraulic-erosion.wgsl
- [ ] Track droplet visits with atomicAdd
- [ ] Add finalizeFlowMap entry point
- [ ] Update ErosionSimulator with flow buffer + texture
- [ ] Add flow finalize pipeline and bind group
- [ ] Clear flow buffer at erosion start
- [ ] Add getFlowMap() to ErosionSimulator
- [ ] Update TerrainManager to expose flow map

#### Phase 1: Biome Mask
- [ ] Create biome-mask.wgsl
- [ ] Implement BiomeMaskGenerator.ts
- [ ] Add biome params interface
- [ ] Sample heightmap, slope, flow
- [ ] Output RGBA biome probabilities
- [ ] Integrate with TerrainManager

#### Phase 2: Plant Foundation
- [ ] Create types.ts
- [ ] Create PlantRegistry.ts
- [ ] Define grassland plant presets
- [ ] Add atlas region injection

#### Phase 3: Spawning
- [ ] Create spawn.wgsl
- [ ] Grid-based spawning with jitter
- [ ] Biome mask sampling
- [ ] Terrain height positioning
- [ ] LOD density reduction
- [ ] Implement VegetationSpawner.ts
- [ ] Batch spawning

#### Phase 4: Rendering
- [ ] Create billboard.wgsl
- [ ] Y-axis billboarding
- [ ] Wind displacement
- [ ] Local gusts (FBM)
- [ ] Distance fade
- [ ] Implement VegetationRenderer.ts
- [ ] Instanced draw calls

#### Phase 5: LOD & Caching
- [ ] Create VegetationTileCache.ts
- [ ] Tile lifecycle management
- [ ] LRU eviction
- [ ] LOD density mapping
- [ ] CDLOD tile callbacks

#### Phase 6: Integration
- [ ] Create VegetationManager.ts
- [ ] Connect to TerrainManager
- [ ] Add to render pipeline

#### Phase 7: UI & Polish
- [ ] Create VegetationSection.tsx
- [ ] Wind controls
- [ ] Debug visualizations
- [ ] Performance optimization

---

---

## Phase 4b Details: 3D Mesh Rendering (Future)

**Note:** This section documents the design for 3D mesh support, to be implemented after billboard rendering is working.

### Multi-Mesh Model Support

A single GLTF/GLB file can contain multiple sub-meshes. For example, a tree model might have:
- Mesh 0: **Trunk** → bark material
- Mesh 1: **Branches** → bark material  
- Mesh 2: **Leaves** → leaf material (alpha cutout)

The `VegetationMesh` structure should represent the **whole model**:

```typescript
interface VegetationMesh {
  id: string;
  name: string;
  
  // All sub-meshes from the GLB (trunk, leaves, branches, etc.)
  subMeshes: VegetationSubMesh[];
  
  // Model-level properties
  boundingBox: BoundingBox;
  castsShadow: boolean;
  receivesWind: boolean;
}

interface VegetationSubMesh {
  // Geometry
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  
  // Material reference (from GLBModel.materials)
  materialIndex: number;
  material: VegetationMaterial;
  
  // Per-submesh wind behavior (leaves sway more than trunk)
  windMultiplier: number;  // 0 = rigid, 1 = full wind effect
}
```

### Wind Per Sub-Mesh

Different parts of a plant should respond differently to wind:

| Sub-Mesh | Wind Multiplier | Behavior |
|----------|-----------------|----------|
| Trunk | 0.0 | Rigid, no movement |
| Branches | 0.3 | Slight sway |
| Leaves | 1.0 | Full flutter |
| Flowers | 0.8 | Strong sway |

### Rendering Multi-Mesh Models

```typescript
// In VegetationRenderer
renderMeshInstances(pass: GPURenderPassEncoder, mesh: VegetationMesh, instances: GPUBuffer) {
  // Set instance buffer once for the whole model
  pass.setBindGroup(1, instancesBindGroup);
  
  // Draw each sub-mesh with the same instances
  for (const subMesh of mesh.subMeshes) {
    // Set per-submesh material/geometry
    pass.setBindGroup(2, subMesh.materialBindGroup);
    pass.setVertexBuffer(0, subMesh.vertexBuffer);
    pass.setIndexBuffer(subMesh.indexBuffer, 'uint32');
    
    // Wind multiplier passed via uniform
    pass.setBindGroup(3, windBindGroup); // includes windMultiplier
    
    pass.drawIndexed(subMesh.indexCount, instanceCount);
  }
}
```

### Plant Type Variants

A single plant type (e.g., "oak tree") should have multiple mesh variants for natural variation:

```typescript
interface PlantType {
  id: string;
  name: string;
  
  renderMode: 'billboard' | 'mesh' | 'hybrid';
  
  // Billboard variants (colors or atlas regions)
  billboardVariants: {
    color: [number, number, number];
    atlasRegion: AtlasRegion | null;
  }[];
  
  // Multiple mesh variants per plant type
  meshVariants: string[];  // Array of meshIds from VegetationMeshRegistry
  
  // ... other properties ...
}

// Example plant definition with variants
const oakTree: PlantType = {
  id: 'oak-tree',
  name: 'Oak Tree',
  renderMode: 'mesh',
  billboardVariants: [],
  meshVariants: [
    'oak-tree-01',  // Different oak tree models
    'oak-tree-02',
    'oak-tree-03',
    'oak-tree-04',
    'oak-tree-05',
  ],
  // ...
};
```

### Instance Variant Selection

The spawn shader selects a variant per instance using deterministic hashing:

```wgsl
// In spawn.wgsl
let variantSeed = cellOrigin * 41.7 + params.seed;
let variantIndex = u32(hash(variantSeed) * f32(params.variantCount));

instances[idx].variantIndex = variantIndex;
```

### Phase 4b Tasks
- [ ] Create VegetationMesh interface with subMeshes array
- [ ] Create VegetationSubMesh interface with windMultiplier
- [ ] Add mesh loading from GLBLoader output
- [ ] Create vegetation-mesh.wgsl shader
- [ ] Implement per-submesh wind uniforms
- [ ] Add variant selection to spawner
- [ ] Implement multi-mesh instanced draw calls

---

## Texture Atlas Specification

**Note:** This section documents the texture atlas format for billboard vegetation. Initially we'll use colored quads, then add atlas support as a polish step.

### Image Format Pipeline

| Stage | Format | Purpose |
|-------|--------|---------|
| Source/Authoring | PNG (RGBA 8-bit) | Easy to edit, transparent background |
| Runtime (Dev) | PNG (uncompressed) | Quick iteration during development |
| Runtime (Prod) | KTX2 with BC7 | GPU-compressed, ~4x smaller, mipmap support |

**Why BC7 for Production?**
- Best quality for alpha cutout (vegetation edges)
- 4:1 compression vs uncompressed
- WebGPU supports `bc7-rgba-unorm` natively
- Mipmaps prevent aliasing at distance

### Atlas Layout

```
┌─────────────────────────────────────────┐
│  Tall Grass  │  Short Grass │ Wildflower │
│   (0,0)      │   (256,0)    │  (512,0)   │
│   256x512    │   256x256    │  128x256   │
├──────────────┼──────────────┼────────────┤
│  Wildflower  │  Small Shrub │   Fern     │
│   Purple     │              │            │
│   (0,512)    │   (256,512)  │  (512,512) │
│   128x256    │   256x256    │  128x256   │
├──────────────┴──────────────┴────────────┤
│            ... more sprites ...           │
└──────────────────────────────────────────┘
```

**Recommended Atlas Size:** 2048×2048 (or 4096×4096 for more variety)

### JSON Metadata Descriptor

```json
{
  "atlasSize": [2048, 2048],
  "format": "bc7-rgba-unorm",
  "sprites": [
    {
      "id": "tall-grass",
      "variants": [
        { "u": 0, "v": 0, "width": 256, "height": 512 },
        { "u": 256, "v": 0, "width": 256, "height": 512 },
        { "u": 512, "v": 0, "width": 256, "height": 512 }
      ],
      "pivot": [0.5, 0.0],
      "aspectRatio": 0.5
    },
    {
      "id": "wildflower-yellow",
      "variants": [
        { "u": 0, "v": 512, "width": 128, "height": 256 }
      ],
      "pivot": [0.5, 0.0],
      "aspectRatio": 0.5
    }
  ]
}
```

### TypeScript Interface

```typescript
interface AtlasRegion {
  u: number;      // X offset in pixels
  v: number;      // Y offset in pixels
  width: number;  // Width in pixels
  height: number; // Height in pixels
}

interface SpriteDefinition {
  id: string;
  variants: AtlasRegion[];
  pivot: [number, number];  // Normalized anchor point (0.5, 0.0 = bottom-center)
  aspectRatio: number;      // width / height
}

interface VegetationAtlas {
  atlasSize: [number, number];
  format: string;
  sprites: SpriteDefinition[];
}
```

### Build Pipeline

#### Option 1: Offline Build Script (Recommended for Production)

```bash
# scripts/build-vegetation-atlas.js
node scripts/build-vegetation-atlas.js \
  --input public/textures/vegetation/ \
  --output public/textures/vegetation-atlas.ktx2 \
  --descriptor public/textures/vegetation-atlas.json \
  --size 2048
```

**Process:**
1. Read all PNG source images from input folder
2. Pack into atlas using bin-packing algorithm
3. Generate mipmaps
4. Compress to BC7 using `ktx-software` tools
5. Output `.ktx2` + `.json` descriptor

#### Option 2: Runtime Packing (Development Only)

For quick iteration during development:
1. Load individual PNGs at runtime
2. Pack into 2D array texture or atlas (no compression)
3. Generate descriptor dynamically

### Useful Tools

| Tool | Purpose |
|------|---------|
| [TexturePacker](https://www.codeandweb.com/texturepacker) | GUI atlas packing |
| [free-tex-packer](https://github.com/nickolasgk/free-tex-packer) | Open-source alternative |
| [ktx-software](https://github.com/KhronosGroup/KTX-Software) | KTX2/BC7 compression |
| [toktx](https://github.com/KhronosGroup/KTX-Software) | CLI for KTX2 creation |

### Shader Integration

```wgsl
// In billboard.wgsl - atlas sampling
@group(0) @binding(3) var vegetationAtlas: texture_2d<f32>;
@group(0) @binding(4) var atlasSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) atlasRegion: vec4f,  // xy = offset, zw = size (normalized)
  @location(2) worldPos: vec3f,
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  // Transform local UV (0-1) to atlas UV
  let atlasUV = input.atlasRegion.xy + input.uv * input.atlasRegion.zw;
  let color = textureSample(vegetationAtlas, atlasSampler, atlasUV);
  
  // Alpha cutout for vegetation edges
  if (color.a < 0.5) { discard; }
  
  // Distance fade
  let dist = distance(input.worldPos, uniforms.cameraPosition);
  let fade = 1.0 - smoothstep(150.0, 200.0, dist);
  
  return vec4f(color.rgb, color.a * fade);
}
```

### Implementation Strategy

1. **Phase 4a (Initial):** Use colored quads - fast iteration, no external assets needed
2. **Phase 4a+ (Polish):** Add atlas support with PNG loading for development
3. **Production:** Add KTX2/BC7 build pipeline for optimized runtime

### Atlas Tasks
- [ ] Define AtlasRegion and SpriteDefinition interfaces
- [ ] Create VegetationAtlasLoader class
- [ ] Update PlantType to reference atlas regions
- [ ] Modify billboard.wgsl for atlas UV sampling
- [ ] Add alpha cutout support
- [ ] Create build-vegetation-atlas.js script (optional)
- [ ] Add KTX2 loading support (optional)

---

## Asset Sources

This section documents where to source vegetation billboard textures.

### Free Resources (CC0 / Public Domain)

| Source | URL | License | Best For |
|--------|-----|---------|----------|
| **Poly Haven** | https://polyhaven.com | CC0 | Terrain materials, some vegetation |
| **OpenGameArt** | https://opengameart.org | Mixed (check each) | Stylized vegetation, grass sprites |
| **Kenney Assets** | https://kenney.nl/assets | CC0 | Clean stylized PNGs, game-ready |
| **itch.io** | https://itch.io/game-assets/free/tag-vegetation | Varies | Indie packs, variety |
| **Textures.com** | https://www.textures.com | Limited free | Photorealistic cutouts |

### Paid Resources (High Quality)

| Source | URL | Price | Notes |
|--------|-----|-------|-------|
| **Quixel Megascans** | https://quixel.com/megascans | Free w/ Unreal or $19/mo | Photoscanned, best quality |
| **GameTextures** | https://gametextures.com | Subscription | Stylized and realistic |
| **cgtrader** | https://cgtrader.com | Per-pack | Individual packs |
| **TurboSquid** | https://turbosquid.com | Per-pack | Professional quality |

### Recommended Sources by Category

| Category | Best Source | Search Terms |
|----------|-------------|--------------|
| **Tall Grass** | Quixel Megascans, OpenGameArt | "grass blade", "tall grass billboard" |
| **Short Grass** | Kenney, Quixel | "grass clump", "lawn texture cutout" |
| **Wildflowers** | OpenGameArt, itch.io | "flower sprite", "wildflower cutout", "daisy png" |
| **Ferns** | Quixel Megascans, Textures.com | "fern frond", "fern alpha" |
| **Small Shrubs** | Quixel, itch.io | "bush billboard", "shrub cutout" |

### DIY: Creating Custom Vegetation Textures

1. **Photography Method:**
   - Take photos of plants against a plain background (blue/green screen or overcast sky)
   - Use GIMP / Photoshop to remove background
   - Export as PNG with alpha channel
   - Create multiple variations (3-5) per plant type for natural variety

2. **Requirements:**
   - Minimum resolution: 256x256 (512x512 recommended for tall grass)
   - Format: PNG with transparency
   - Background: Fully transparent (alpha = 0)
   - Edges: Clean anti-aliased edges for better blending

3. **Tips:**
   - Shoot in diffuse lighting (overcast day) to avoid harsh shadows
   - Include slight color variations between variants
   - Photograph at slight angles for more natural billboard appearance

### Development vs Production Strategy

- **Development/Testing:** Use [Kenney](https://kenney.nl/assets) or [OpenGameArt](https://opengameart.org) - quick to download, CC0 license, works immediately
- **Production Quality:** [Quixel Megascans](https://quixel.com/megascans) if accessible (free with Unreal Engine license, or subscription)

---

## Current Asset Inventory

This section documents the vegetation assets currently available in the `/public/` folder.

### 1. Ribbon Grass (3D Model + Billboard)

| Property | Value |
|----------|-------|
| **Asset ID** | `tbdpec3r` |
| **Name** | Ribbon Grass |
| **Latin Name** | Phalaris Arundinacea |
| **Path** | `models/terrain/vegetation/ribbon_grass_tbdpec3r_ue_high/` |
| **Biome** | Grassland (Europe) |
| **Type** | 3D Plant with Billboard LOD |

#### Model Variants
6 variations (A-F), each with 3 LOD levels:

| Variant | LOD0 Tris | LOD1 Tris | LOD2 Tris (Billboard) |
|---------|-----------|-----------|------------------------|
| VarA | 2,205 | 927 | 5 |
| VarB | 2,575 | 1,183 | 5 |
| VarC | 3,719 | 1,379 | 6 |
| VarD | 2,211 | 951 | 5 |
| VarE | 2,211 | 951 | 4 |
| VarF | 1,263 | 531 | 4 |

#### Available Files
```
ribbon_grass_tbdpec3r_ue_high/
├── tbdpec3r_tier_1.gltf          # UE format
├── tbdpec3r.json                 # Full asset metadata
├── standard/
│   └── tbdpec3r_tier_1_nonUE.gltf  # ✅ Standard GLTF (use this)
└── Textures/
    ├── T_tbdpec3r_4K_B-O.png     # BaseColor + Opacity (combined)
    ├── T_tbdpec3r_4K_B.png       # BaseColor only
    ├── T_tbdpec3r_4K_N.png       # Normal map
    ├── T_tbdpec3r_4K_ORT.png     # Occlusion-Roughness-Translucency
    ├── T_tbdpec3r_4K_Billboard_B-O.png  # Billboard BaseColor+Opacity
    └── T_tbdpec3r_4K_Billboard_N-T.png  # Billboard Normal+Translucency
```

#### Billboard Textures (Multiple Resolutions)

| Resolution | Basecolor | Opacity | Normal | Translucency |
|------------|-----------|---------|--------|--------------|
| 8K | ✓ | ✓ | ✓ | ✓ |
| 4K | ✓ | ✓ | ✓ | ✓ |
| 2K | ✓ | ✓ | ✓ | ✓ |
| 1K | ✓ | ✓ | ✓ | ✓ |

#### Material Parameters
```json
{
  "isCameraFacingBillboard": true,
  "baseColorControls": [0.9, 0.9, 0.9, 0],
  "translucencyTint": [0.72, 0.90, 0.68, 1],
  "translucencyControls": [1, 2, 0.9, 0]
}
```

#### Usage Notes
- Use `standard/tbdpec3r_tier_1_nonUE.gltf` for WebGPU loading
- Billboard textures available for automatic LOD transition
- Camera-facing billboard mode supported
- Translucency support for subsurface scattering effect

---

### 2. Bracken Fern (Atlas Texture)

| Property | Value |
|----------|-------|
| **Asset ID** | `okdr22` |
| **Name** | Bracken Fern |
| **Latin Name** | Pteridium |
| **Path** | `textures/atlas/vegetation/bracken_fern_okdr22_4k/` |
| **Biome** | Temperate Forest (Oceania) |
| **Type** | Atlas Texture |
| **Physical Size** | 0.41m × 0.41m |
| **Resolution** | 4096×4096 |
| **Texel Density** | 9,917 px/m |

#### Available Maps

| Map Type | File | Color Space | Purpose |
|----------|------|-------------|---------|
| **BaseColor** | `Bracken_Fern_okdr22_4K_BaseColor.jpg` | sRGB | Main color texture |
| **Opacity** | `Bracken_Fern_okdr22_4K_Opacity.jpg` | Linear | Alpha mask (separate) |
| **Normal** | `Bracken_Fern_okdr22_4K_Normal.jpg` | Linear | Surface detail |
| **Bump** | `Bracken_Fern_okdr22_4K_Bump.jpg` | Linear | Height variation |
| **Roughness** | `Bracken_Fern_okdr22_4K_Roughness.jpg` | Linear | Surface roughness |
| **Gloss** | `Bracken_Fern_okdr22_4K_Gloss.jpg` | Linear | Inverse roughness |
| **Specular** | `Bracken_Fern_okdr22_4K_Specular.jpg` | sRGB | Specular intensity |
| **Translucency** | `Bracken_Fern_okdr22_4K_Translucency.jpg` | sRGB | Subsurface scattering |
| **Displacement** | `Bracken_Fern_okdr22_4K_Displacement.jpg` | Linear | Height displacement |

#### Displacement Parameters
```json
{
  "displacementScale": 0.795388,
  "displacementBias": 0.391462,
  "displacementCalibrationAccuracy": 0.980405
}
```

#### Usage Notes
- **Opacity is separate** - must combine BaseColor + Opacity into RGBA for WebGPU
- This is a **photoscanned atlas** (multiple fern fronds in one image)
- Not tileable - designed for cutout/decal usage
- 4K resolution may need downsampling for billboard instances
- EXR versions available for higher quality (16/32-bit) if needed

#### Preprocessing Required
```bash
# Combine BaseColor + Opacity into RGBA PNG
# Option 1: ImageMagick
convert BaseColor.jpg Opacity.jpg -compose CopyOpacity -composite fern_rgba.png

# Option 2: Node.js script with sharp
```

---

### Asset Usage Matrix

| Asset | Billboard | 3D Mesh | LOD Support | Ready to Use |
|-------|-----------|---------|-------------|--------------|
| Ribbon Grass | ✓ | ✓ | ✓ (3 levels) | ✓ GLTF available |
| Bracken Fern | ✓ | ✗ | ✗ | ⚠️ Needs RGBA combine |

### Recommended Integration Order

1. **Phase 4a (Colored Quads):** Start without textures
2. **Phase 4a+ (Basic Textures):** Use Ribbon Grass billboard textures (`T_tbdpec3r_4K_Billboard_B-O.png`)
3. **Phase 4b (3D Mesh):** Load Ribbon Grass GLTF variants
4. **Future:** Process Bracken Fern atlas for additional variety

### Asset Preprocessing Tasks
- [ ] Test load `standard/tbdpec3r_tier_1_nonUE.gltf` in GLBLoader
- [ ] Combine Bracken Fern BaseColor + Opacity → RGBA PNG
- [ ] Create atlas descriptor for Bracken Fern sprite regions (if multiple fronds)
- [ ] Downsample 4K textures to 1K/2K for billboard LODs

---

## Asset Library Integration

The **Asset Library Server** (`server/`) provides a centralized system for indexing, previewing, and serving vegetation assets. This enables the vegetation system to discover available plant models and textures at runtime.

### Architecture

```
server/
├── index.ts                    # Express server with REST API
├── db/
│   └── database.ts             # SQLite database (assets, files, metadata)
└── services/
    ├── AssetIndexer.ts         # Scans public/ for assets
    ├── FileWatcher.ts          # Live reload on asset changes
    └── PreviewGenerator.ts     # Thumbnail generation
```

### Asset Discovery Flow

```
[Asset Library Server]
        ↓
1. Scans public/models/terrain/vegetation/
2. Parses GLTF, manifest.json, texture packs
3. Indexes to SQLite (asset_files table)
        ↓
[VegetationManager]
        ↓
4. Queries /api/assets?type=vegetation
5. Receives asset metadata + file paths
6. Loads models/textures on demand
```

### API Endpoints for Vegetation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/assets?type=vegetation` | GET | List all vegetation assets |
| `/api/assets?category=model&subtype=vegetation` | GET | 3D vegetation models |
| `/api/assets?category=texture&subtype=atlas` | GET | Texture atlases |
| `/api/assets/:id` | GET | Full asset details with files |
| `/api/previews/:id.webp` | GET | Thumbnail preview |

### Database Schema (Asset Files)

```sql
-- Individual files within a vegetation asset
CREATE TABLE asset_files (
  id INTEGER PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id),
  file_type TEXT,      -- 'model', 'texture', 'billboard', 'metadata'
  lod_level INTEGER,   -- 0=highest detail, 1, 2, etc.
  resolution TEXT,     -- '4K', '2K', '1K'
  format TEXT,         -- 'gltf', 'png', 'jpg', 'ktx2'
  path TEXT NOT NULL,
  file_size INTEGER
);
```

### Example: Loading Ribbon Grass from Asset Library

```typescript
// In VegetationManager
async loadVegetationAssets(): Promise<void> {
  // Query asset library for vegetation models
  const response = await fetch('/api/assets?type=vegetation');
  const assets = await response.json();
  
  for (const asset of assets) {
    // Get full asset with files
    const details = await fetch(`/api/assets/${asset.id}`).then(r => r.json());
    
    // Filter for GLTF models
    const gltfFile = details.files.find(f => 
      f.format === 'gltf' && f.path.includes('nonUE')
    );
    
    if (gltfFile) {
      // Load 3D mesh variant
      const mesh = await this.loadVegetationMesh(gltfFile.path);
      this.plantRegistry.registerMesh(asset.id, mesh);
    }
    
    // Check for billboard textures
    const billboardFile = details.files.find(f => 
      f.path.toLowerCase().includes('billboard') && 
      f.format === 'png'
    );
    
    if (billboardFile) {
      // Load billboard atlas region
      const atlasRegion = await this.loadBillboardTexture(billboardFile.path);
      this.plantRegistry.setAtlasRegion(asset.id, atlasRegion);
    }
  }
}
```

### Integration Tasks
- [ ] Add `/api/assets?type=vegetation` filter to AssetIndexer
- [ ] Detect vegetation assets by folder structure (`/vegetation/`) or manifest
- [ ] Extract LOD levels from GLTF filename patterns
- [ ] Add VegetationAssetLoader class that queries asset library
- [ ] Cache loaded vegetation meshes and textures
- [ ] Add hot-reload support for vegetation asset changes

### Asset Type Detection

The AssetIndexer uses these patterns to identify vegetation assets:

| Pattern | Type | Example |
|---------|------|---------|
| `*/vegetation/*` | vegetation | `models/terrain/vegetation/ribbon_grass/` |
| `manifest.json` with `"biome"` | vegetation | Quixel vegetation packs |
| `*_atlas/*` with plants | atlas | `textures/atlas/vegetation/` |

---

## Future Enhancements

1. **Texture Atlas** - Replace colored quads with sprite textures
2. **Additional Biomes** - Forest, desert, snow, wetland
3. **Procedural Generation** - Runtime plant variation
4. **Shadow Casting** - Simple billboard shadows
5. **Cross-fading LOD** - Smooth transitions between density levels
6. **Seasonal Variation** - Color shifts based on time/weather
7. **Interactive Vegetation** - Player collision response
8. **Automatic Impostor Generation** - Render 3D mesh from multiple angles to create billboard atlas
