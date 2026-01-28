# Terrain Generation Implementation Plan

A procedural terrain generation system for the Scene Builder, featuring fractal noise heightmaps with hydraulic and thermal erosion simulation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Structures](#3-data-structures)
4. [Generation Pipeline](#4-generation-pipeline)
5. [Algorithms](#5-algorithms)
6. [GPU Integration](#6-gpu-integration)
7. [UI Panel Design](#7-ui-panel-design)
8. [Implementation Phases](#8-implementation-phases)
9. [Testing Strategy](#9-testing-strategy)

---

## 1. Overview

### Goals

- Add `TerrainObject` as a new scene object type alongside `ModelObject` and `PrimitiveObject`
- CPU-based terrain generation (one-time generation, not real-time)
- Configurable noise parameters (octaves, scale, ridged/smooth blend)
- Hydraulic erosion simulation for realistic drainage channels
- Thermal erosion for talus slopes and debris
- Height/slope/erosion-based material blending in shader
- Fixed seed for reproducible results
- "Update Terrain" button to regenerate (not live preview)

### Non-Goals (for v1)

- LOD/chunking for large terrains
- Real-time erosion preview
- Texture-based splatmaps (using procedural shader blending instead)
- Vegetation/foliage placement

---

## 2. Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Scene Builder                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  SceneObjects                                                           │
│  ├─ ModelObject                                                         │
│  ├─ PrimitiveObject                                                     │
│  └─ TerrainObject ◄───────────────────────────────────────────────────┐ │
│       │                                                                │ │
│       ├─ TerrainParams (configuration)                                 │ │
│       ├─ TerrainGenerator (CPU algorithms)                             │ │
│       │    ├─ generateHeightmap() → Float32Array                       │ │
│       │    ├─ applyHydraulicErosion() → Float32Array (erosionMap)      │ │
│       │    └─ applyThermalErosion() → void (modifies heightmap)        │ │
│       │                                                                │ │
│       └─ TerrainMesh (GPU resources)                                   │ │
│            ├─ VAO, VBO, IBO                                            │ │
│            └─ heightmapTexture (for shader detail)                     │ │
├────────────────────────────────────────────────────────────────────────┤ │
│  ComponentPanels                                                        │ │
│  └─ ObjectPanel                                                         │ │
│       └─ TerrainPanel (when Terrain selected) ─────────────────────────┘ │
│            ├─ Noise controls                                            │
│            ├─ Erosion controls                                          │
│            ├─ Material controls                                         │
│            └─ [Update Terrain] button                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Rendering                                                              │
│  └─ ObjectRenderer (renders TerrainMesh with terrain shader)            │
└─────────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
src/
├── core/
│   ├── sceneObjects/
│   │   ├── index.ts                    ← Export TerrainObject
│   │   ├── types.ts                    ← Add TerrainParams types
│   │   └── TerrainObject.ts            ← NEW: Main terrain class
│   │
│   └── terrain/                        ← NEW: Terrain generation module
│       ├── index.ts
│       ├── TerrainGenerator.ts         ← Heightmap + erosion algorithms
│       ├── TerrainMesh.ts              ← GPU mesh creation
│       ├── noise.ts                    ← Simplex/Perlin noise implementation
│       └── erosion.ts                  ← Erosion algorithms
│
├── demos/sceneBuilder/
│   ├── SceneBuilder.ts                 ← Add terrain creation UI
│   └── componentPanels/
│       ├── index.ts                    ← Export TerrainPanel
│       ├── ObjectPanel.ts              ← Integrate TerrainPanel
│       └── TerrainPanel.ts             ← NEW: Terrain-specific controls
│
└── loaders/
    └── SceneSerializer.ts              ← Add terrain serialization
```

---

## 3. Data Structures

### TerrainParams

```typescript
// src/core/sceneObjects/types.ts

export interface TerrainNoiseParams {
  seed: number;              // Random seed for reproducibility
  scale: number;             // Noise scale (larger = wider features)
  octaves: number;           // Number of noise layers (4-8 typical)
  lacunarity: number;        // Frequency multiplier per octave (2.0 typical)
  persistence: number;       // Amplitude multiplier per octave (0.5 typical)
  heightScale: number;       // Maximum terrain height in world units
  ridgeWeight: number;       // 0 = smooth fBm, 1 = sharp ridged noise
  offset: [number, number];  // Noise offset for panning
}

export interface TerrainErosionParams {
  // Hydraulic erosion
  enabled: boolean;
  iterations: number;        // Number of water droplets (50k-500k)
  maxDropletLifetime: number; // Max steps per droplet (64 typical)
  inertia: number;           // Direction persistence (0.05-0.1)
  sedimentCapacity: number;  // Carrying capacity factor (4-8)
  depositSpeed: number;      // Deposition rate (0.3)
  erodeSpeed: number;        // Erosion rate (0.3)
  evaporation: number;       // Water loss per step (0.01-0.02)
  gravity: number;           // Acceleration on slopes (4.0)
  erosionRadius: number;     // Brush radius for erosion (3)
  minSlope: number;          // Minimum slope for capacity calc (0.01)
  
  // Thermal erosion
  thermalEnabled: boolean;
  thermalIterations: number; // Iterations (50-200)
  talusAngle: number;        // Max stable slope angle (0.5 ≈ 30°)
}

export interface TerrainMaterialParams {
  // Height-based zones
  waterLevel: number;        // Below this = water (not rendered, just for reference)
  grassLine: number;         // Height where grass starts (0-1 normalized)
  rockLine: number;          // Height where rock dominates (0-1 normalized)
  snowLine: number;          // Height where snow starts (0-1 normalized)
  
  // Slope thresholds
  maxGrassSlope: number;     // Above this slope = no grass (0-1)
  maxSnowSlope: number;      // Above this slope = no snow (0-1)
  
  // Colors (RGB normalized)
  waterColor: [number, number, number];
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  snowColor: [number, number, number];
  dirtColor: [number, number, number];  // For erosion channels
}

export interface TerrainParams {
  resolution: number;        // Heightmap resolution (128, 256, 512, 1024)
  worldSize: number;         // Terrain size in world units
  noise: TerrainNoiseParams;
  erosion: TerrainErosionParams;
  material: TerrainMaterialParams;
}

export function createDefaultTerrainParams(): TerrainParams {
  return {
    resolution: 256,
    worldSize: 10,
    noise: {
      seed: 12345,
      scale: 3.0,
      octaves: 6,
      lacunarity: 2.0,
      persistence: 0.5,
      heightScale: 2.0,
      ridgeWeight: 0.5,
      offset: [0, 0],
    },
    erosion: {
      enabled: true,
      iterations: 100000,
      maxDropletLifetime: 64,
      inertia: 0.05,
      sedimentCapacity: 4.0,
      depositSpeed: 0.3,
      erodeSpeed: 0.3,
      evaporation: 0.01,
      gravity: 4.0,
      erosionRadius: 3,
      minSlope: 0.01,
      thermalEnabled: true,
      thermalIterations: 100,
      talusAngle: 0.5,
    },
    material: {
      waterLevel: 0.0,
      grassLine: 0.0,
      rockLine: 0.6,
      snowLine: 0.8,
      maxGrassSlope: 0.6,
      maxSnowSlope: 0.4,
      waterColor: [0.2, 0.4, 0.6],
      grassColor: [0.3, 0.5, 0.2],
      rockColor: [0.4, 0.35, 0.3],
      snowColor: [0.95, 0.95, 0.97],
      dirtColor: [0.35, 0.25, 0.2],
    },
  };
}
```

### TerrainObject

```typescript
// src/core/sceneObjects/TerrainObject.ts

export class TerrainObject extends RenderableObject {
  public readonly type = 'terrain';
  public params: TerrainParams;
  
  // Generated data
  private heightmap: Float32Array | null = null;
  private erosionMap: Float32Array | null = null;
  private mesh: TerrainMesh | null = null;
  
  // GPU resources (managed by TerrainMesh)
  private gpuMesh: GPUMesh | null = null;
  
  constructor(name: string, params?: Partial<TerrainParams>) {
    super(name);
    this.params = { ...createDefaultTerrainParams(), ...params };
  }
  
  async regenerate(): Promise<void> {
    // Implementation in Phase 2
  }
  
  getHeightmap(): Float32Array | null {
    return this.heightmap;
  }
  
  getErosionMap(): Float32Array | null {
    return this.erosionMap;
  }
  
  // Sample height at world position (for physics/placement)
  sampleHeightAtWorld(worldX: number, worldZ: number): number {
    // Implementation in Phase 3
  }
}
```

---

## 4. Generation Pipeline

### Pipeline Stages

```
User clicks "Update Terrain"
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 1: INITIALIZATION                                                │
│  ─────────────────────────                                              │
│  • Create Float32Array(resolution × resolution) for heightmap           │
│  • Initialize seeded RNG with params.noise.seed                         │
│  • Initialize noise generator with seed                                 │
│  Time: O(n²), ~1ms for 512x512                                          │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 2: BASE NOISE GENERATION                                         │
│  ───────────────────────────────                                        │
│  For each cell (x, y):                                                  │
│    • Sample fBm noise at (x * scale, y * scale)                         │
│    • Sample ridged noise at same position                               │
│    • Blend based on ridgeWeight                                         │
│    • Store height = blend * heightScale                                 │
│  Time: O(n² × octaves), ~50ms for 512x512, 6 octaves                    │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 3: HYDRAULIC EROSION (if enabled)                                │
│  ───────────────────────────────────────                                │
│  Create erosionMap Float32Array                                         │
│  For i = 0 to iterations:                                               │
│    • Spawn droplet at random position (seeded)                          │
│    • Simulate droplet movement (64 steps max)                           │
│      - Calculate gradient → update direction with inertia               │
│      - Move droplet → calculate height difference                       │
│      - Erode or deposit based on capacity vs sediment                   │
│      - Track erosion amount in erosionMap                               │
│  Time: O(iterations × lifetime), ~2-5s for 100k iterations              │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 4: THERMAL EROSION (if enabled)                                  │
│  ──────────────────────────────────────                                 │
│  For i = 0 to thermalIterations:                                        │
│    For each cell (x, y):                                                │
│      • Find steepest neighbor                                           │
│      • If slope > talusAngle: transfer material                         │
│  Time: O(iterations × n²), ~200ms for 100 iterations, 512x512           │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 5: MESH GENERATION                                               │
│  ─────────────────────────                                              │
│  • Create vertex array: position(3) + normal(3) + uv(2) + attrs(2)      │
│  • Calculate normals via central difference                             │
│  • Calculate per-vertex slope and erosion amount                        │
│  • Generate index buffer (2 triangles per quad)                         │
│  Time: O(n²), ~20ms for 512x512                                         │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage 6: GPU UPLOAD                                                    │
│  ─────────────────────                                                  │
│  • Create/update VAO with vertex attributes                             │
│  • Create/update VBO with vertex data                                   │
│  • Create/update IBO with indices                                       │
│  • Optional: Upload heightmap as R32F texture                           │
│  • Optional: Upload erosionMap as R32F texture                          │
│  Time: ~5ms                                                             │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
       DONE
   Total: 3-6 seconds for 512x512 with 100k erosion iterations
```

### Progress Reporting

For a responsive UI during generation:

```typescript
interface GenerationProgress {
  stage: 'init' | 'noise' | 'hydraulic' | 'thermal' | 'mesh' | 'upload';
  progress: number;  // 0-1
  message: string;
}

type ProgressCallback = (progress: GenerationProgress) => void;

async regenerate(onProgress?: ProgressCallback): Promise<void> {
  onProgress?.({ stage: 'init', progress: 0, message: 'Initializing...' });
  
  // Use requestAnimationFrame or setTimeout(0) between stages
  // to allow UI updates
  
  await this.generateHeightmap(onProgress);
  await this.applyErosion(onProgress);
  await this.generateMesh(onProgress);
  
  onProgress?.({ stage: 'upload', progress: 1, message: 'Complete' });
}
```

---

## 5. Algorithms

### 5.1 Simplex Noise

Using a standard simplex noise implementation (2D). Will include a pure TypeScript implementation to avoid dependencies.

```typescript
// src/core/terrain/noise.ts

export class SimplexNoise {
  private perm: Uint8Array;
  
  constructor(seed: number) {
    // Initialize permutation table from seed
    this.perm = this.generatePermutation(seed);
  }
  
  noise2D(x: number, y: number): number {
    // Standard simplex noise algorithm
    // Returns value in range [-1, 1]
  }
}
```

### 5.2 Fractal Brownian Motion (fBm)

```typescript
function fbm(
  noise: SimplexNoise,
  x: number, y: number,
  octaves: number,
  lacunarity: number,
  persistence: number
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise.noise2D(x * frequency, y * frequency);
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  
  return (value / maxValue + 1) / 2;  // Normalize to [0, 1]
}
```

### 5.3 Ridged Multifractal

```typescript
function ridged(
  noise: SimplexNoise,
  x: number, y: number,
  octaves: number,
  lacunarity: number,
  persistence: number
): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let weight = 1;
  
  for (let i = 0; i < octaves; i++) {
    let signal = noise.noise2D(x * frequency, y * frequency);
    signal = 1 - Math.abs(signal);  // Invert to create ridges
    signal = signal * signal;       // Sharpen ridges
    signal *= weight;
    
    weight = Math.min(1, Math.max(0, signal * 2));  // Weight decreases in valleys
    value += signal * amplitude;
    
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  
  return value;
}
```

### 5.4 Hydraulic Erosion (Particle-Based)

Based on Hans Theobald Beyer's implementation, simplified for clarity:

```typescript
// src/core/terrain/erosion.ts

interface Droplet {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  velocity: number;
  water: number;
  sediment: number;
}

export function simulateDroplet(
  heightmap: Float32Array,
  erosionMap: Float32Array,
  resolution: number,
  params: TerrainErosionParams,
  startX: number,
  startY: number
): void {
  const drop: Droplet = {
    x: startX,
    y: startY,
    dirX: 0,
    dirY: 0,
    velocity: 1,
    water: 1,
    sediment: 0,
  };
  
  for (let step = 0; step < params.maxDropletLifetime; step++) {
    const xi = Math.floor(drop.x);
    const yi = Math.floor(drop.y);
    
    // Check bounds
    if (xi < 1 || xi >= resolution - 2 || yi < 1 || yi >= resolution - 2) break;
    
    // Calculate gradient using bilinear interpolation
    const gradient = calculateGradient(heightmap, resolution, drop.x, drop.y);
    
    // Update direction (blend with inertia)
    drop.dirX = drop.dirX * params.inertia - gradient.x * (1 - params.inertia);
    drop.dirY = drop.dirY * params.inertia - gradient.y * (1 - params.inertia);
    
    // Normalize direction
    const dirLen = Math.sqrt(drop.dirX * drop.dirX + drop.dirY * drop.dirY);
    if (dirLen < 0.0001) break;  // Stuck in local minimum
    drop.dirX /= dirLen;
    drop.dirY /= dirLen;
    
    // Calculate new position
    const newX = drop.x + drop.dirX;
    const newY = drop.y + drop.dirY;
    
    // Calculate height change
    const oldHeight = sampleHeightBilinear(heightmap, resolution, drop.x, drop.y);
    const newHeight = sampleHeightBilinear(heightmap, resolution, newX, newY);
    const deltaHeight = newHeight - oldHeight;
    
    // Calculate sediment capacity
    const capacity = Math.max(-deltaHeight, params.minSlope) 
      * drop.velocity * drop.water * params.sedimentCapacity;
    
    // Erode or deposit
    if (drop.sediment > capacity || deltaHeight > 0) {
      // Deposit sediment
      const depositAmount = deltaHeight > 0
        ? Math.min(deltaHeight, drop.sediment)
        : (drop.sediment - capacity) * params.depositSpeed;
      
      drop.sediment -= depositAmount;
      depositSediment(heightmap, resolution, drop.x, drop.y, depositAmount);
    } else {
      // Erode terrain
      const erodeAmount = Math.min(
        (capacity - drop.sediment) * params.erodeSpeed,
        -deltaHeight
      );
      
      drop.sediment += erodeAmount;
      erodeTerrain(heightmap, erosionMap, resolution, drop.x, drop.y, 
                   erodeAmount, params.erosionRadius);
    }
    
    // Update droplet state
    drop.velocity = Math.sqrt(drop.velocity * drop.velocity + deltaHeight * params.gravity);
    drop.water *= (1 - params.evaporation);
    drop.x = newX;
    drop.y = newY;
    
    if (drop.water < 0.001) break;
  }
}
```

### 5.5 Thermal Erosion

```typescript
export function applyThermalErosion(
  heightmap: Float32Array,
  resolution: number,
  iterations: number,
  talusAngle: number
): void {
  const cellSize = 1 / resolution;
  
  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 1; y < resolution - 1; y++) {
      for (let x = 1; x < resolution - 1; x++) {
        const idx = y * resolution + x;
        const h = heightmap[idx];
        
        // Find steepest downhill neighbor
        let maxDelta = 0;
        let targetIdx = -1;
        
        const neighbors = [
          idx - 1,              // left
          idx + 1,              // right
          idx - resolution,     // up
          idx + resolution,     // down
        ];
        
        for (const ni of neighbors) {
          const delta = h - heightmap[ni];
          if (delta > maxDelta) {
            maxDelta = delta;
            targetIdx = ni;
          }
        }
        
        // Transfer material if slope exceeds talus angle
        if (maxDelta > talusAngle && targetIdx >= 0) {
          const transfer = (maxDelta - talusAngle) * 0.5;
          heightmap[idx] -= transfer;
          heightmap[targetIdx] += transfer;
        }
      }
    }
  }
}
```

---

## 6. GPU Integration

### Vertex Format

```typescript
// Per-vertex data layout
interface TerrainVertex {
  position: [number, number, number];  // 12 bytes
  normal: [number, number, number];    // 12 bytes
  uv: [number, number];                // 8 bytes
  slope: number;                       // 4 bytes (for material blending)
  erosion: number;                     // 4 bytes (for material blending)
}
// Total: 40 bytes per vertex
// 512x512 = 262,144 vertices = ~10MB
```

### Terrain Shader

```glsl
// Vertex shader
#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aUV;
in float aSlope;
in float aErosion;

uniform mat4 uModelMatrix;
uniform mat4 uViewProjection;
uniform mat3 uNormalMatrix;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out float vSlope;
out float vErosion;
out float vHeight;

void main() {
  vec4 worldPos = uModelMatrix * vec4(aPosition, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  vUV = aUV;
  vSlope = aSlope;
  vErosion = aErosion;
  vHeight = aPosition.y;  // Local height before transform
  
  gl_Position = uViewProjection * worldPos;
}

// Fragment shader
#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in float vSlope;
in float vErosion;
in float vHeight;

// Material params
uniform float uGrassLine;
uniform float uRockLine;
uniform float uSnowLine;
uniform float uMaxGrassSlope;
uniform float uMaxSnowSlope;
uniform vec3 uGrassColor;
uniform vec3 uRockColor;
uniform vec3 uSnowColor;
uniform vec3 uDirtColor;

// Lighting
uniform vec3 uSunDirection;
uniform vec3 uCameraPos;

out vec4 fragColor;

vec3 calculateTerrainColor() {
  // Normalize height to 0-1 range
  float normalizedHeight = clamp(vHeight / 2.0, 0.0, 1.0);  // Assuming heightScale = 2.0
  
  // Base material by height
  vec3 baseColor = uRockColor;
  
  // Grass on low slopes below rock line
  float grassFactor = (1.0 - smoothstep(uMaxGrassSlope - 0.1, uMaxGrassSlope, vSlope))
                    * (1.0 - smoothstep(uRockLine - 0.1, uRockLine, normalizedHeight));
  baseColor = mix(baseColor, uGrassColor, grassFactor);
  
  // Snow at high elevations on low slopes
  float snowFactor = smoothstep(uSnowLine - 0.05, uSnowLine + 0.05, normalizedHeight)
                   * (1.0 - smoothstep(uMaxSnowSlope - 0.1, uMaxSnowSlope, vSlope));
  baseColor = mix(baseColor, uSnowColor, snowFactor);
  
  // Dirt in erosion channels
  float erosionFactor = smoothstep(0.0, 0.5, vErosion);
  baseColor = mix(baseColor, uDirtColor, erosionFactor * 0.5);
  
  return baseColor;
}

void main() {
  vec3 baseColor = calculateTerrainColor();
  
  // Simple diffuse lighting
  vec3 normal = normalize(vNormal);
  float NdotL = max(0.0, dot(normal, normalize(uSunDirection)));
  float ambient = 0.3;
  float lighting = ambient + (1.0 - ambient) * NdotL;
  
  vec3 finalColor = baseColor * lighting;
  
  fragColor = vec4(finalColor, 1.0);
}
```

---

## 7. UI Panel Design

### TerrainPanel Layout

```
┌─────────────────────────────────────────────────┐
│ TERRAIN                                         │
├─────────────────────────────────────────────────┤
│ Resolution: [256 ▼]  World Size: [10.0]         │
├─────────────────────────────────────────────────┤
│ NOISE                                           │
│ ├─ Seed: [12345] [🎲]                           │
│ ├─ Scale: [────●────] 3.0                       │
│ ├─ Octaves: [────●────] 6                       │
│ ├─ Lacunarity: [────●────] 2.0                  │
│ ├─ Persistence: [────●────] 0.5                 │
│ ├─ Height: [────●────] 2.0                      │
│ └─ Ridge Amount: [────●────] 0.5                │
├─────────────────────────────────────────────────┤
│ HYDRAULIC EROSION [✓]                           │
│ ├─ Iterations: [────●────] 100000               │
│ ├─ Inertia: [────●────] 0.05                    │
│ ├─ Capacity: [────●────] 4.0                    │
│ ├─ Deposit Speed: [────●────] 0.3               │
│ ├─ Erode Speed: [────●────] 0.3                 │
│ └─ Evaporation: [────●────] 0.01                │
├─────────────────────────────────────────────────┤
│ THERMAL EROSION [✓]                             │
│ ├─ Iterations: [────●────] 100                  │
│ └─ Talus Angle: [────●────] 0.5                 │
├─────────────────────────────────────────────────┤
│ MATERIAL                                        │
│ ├─ Snow Line: [────●────] 0.8                   │
│ ├─ Rock Line: [────●────] 0.6                   │
│ ├─ Max Grass Slope: [────●────] 0.6             │
│ ├─ Grass Color: [■] #4D8033                     │
│ ├─ Rock Color: [■] #665A4D                      │
│ ├─ Snow Color: [■] #F2F2F7                      │
│ └─ Dirt Color: [■] #594033                      │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────┐ │
│ │           🔄 UPDATE TERRAIN                 │ │
│ └─────────────────────────────────────────────┘ │
│ Generating... ████████░░░░░░░░ 50%              │
└─────────────────────────────────────────────────┘
```

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (Day 1)
**Goal:** Basic terrain object that renders a flat grid

- [ ] Create `TerrainParams` types in `src/core/sceneObjects/types.ts`
- [ ] Create `TerrainObject` class extending `RenderableObject`
- [ ] Create `TerrainMesh` class for GPU buffer management
- [ ] Generate simple grid mesh (no noise yet)
- [ ] Add terrain object type to scene serialization
- [ ] Test: Create terrain in scene, verify it renders as flat plane

### Phase 2: Noise Generation (Day 2)
**Goal:** Terrain with procedural heightmap

- [ ] Implement `SimplexNoise` class in `src/core/terrain/noise.ts`
- [ ] Implement `fbm()` and `ridged()` noise functions
- [ ] Create `TerrainGenerator` class
- [ ] Implement `generateHeightmap()` method
- [ ] Update mesh generation to use heightmap
- [ ] Calculate normals from heightmap
- [ ] Test: Generate terrain with different seeds, verify visually different

### Phase 3: Hydraulic Erosion (Day 3)
**Goal:** Realistic erosion channels

- [ ] Implement droplet simulation in `src/core/terrain/erosion.ts`
- [ ] Implement gradient calculation with bilinear interpolation
- [ ] Implement erosion/deposition with brush radius
- [ ] Generate erosion map (for shader blending)
- [ ] Add erosion amount to vertex attributes
- [ ] Test: Compare terrain with/without erosion, verify channels form

### Phase 4: Thermal Erosion (Day 4)
**Goal:** Talus slopes and debris accumulation

- [ ] Implement thermal erosion algorithm
- [ ] Add thermal erosion to generation pipeline
- [ ] Test: Verify steep slopes become gentler after thermal erosion

### Phase 5: Terrain Shader (Day 5)
**Goal:** Material blending based on height/slope/erosion

- [ ] Create terrain-specific shader program
- [ ] Implement height-based material zones
- [ ] Implement slope-based grass/rock blending
- [ ] Implement snow on peaks (height + slope)
- [ ] Implement dirt in erosion channels
- [ ] Integrate with existing lighting system
- [ ] Test: Verify material transitions look natural

### Phase 6: UI Panel (Day 6)
**Goal:** Full terrain editing interface

- [ ] Create `TerrainPanel.ts` component
- [ ] Add noise parameter controls (sliders, seed input)
- [ ] Add erosion parameter controls
- [ ] Add material parameter controls (colors, thresholds)
- [ ] Implement "Update Terrain" button with async generation
- [ ] Add progress indicator during generation
- [ ] Integrate with `ObjectPanel.ts`
- [ ] Test: Full roundtrip - modify params, click update, see changes

### Phase 7: Integration & Polish (Day 7)
**Goal:** Production-ready feature

- [ ] Add "Add Terrain" button to scene builder toolbar
- [ ] Support terrain in scene save/load
- [ ] Add gizmo support for terrain (translate/scale)
- [ ] Performance optimization (Web Worker for erosion?)
- [ ] Add resolution dropdown (128/256/512/1024)
- [ ] Add preset configurations (mountains, hills, plains)
- [ ] Documentation and cleanup

---

## 9. Testing Strategy

### Unit Tests

```typescript
// src/core/terrain/noise.test.ts

describe('SimplexNoise', () => {
  it('should return same value for same seed and coordinates', () => {
    const noise1 = new SimplexNoise(12345);
    const noise2 = new SimplexNoise(12345);
    expect(noise1.noise2D(1.5, 2.5)).toEqual(noise2.noise2D(1.5, 2.5));
  });
  
  it('should return different values for different seeds', () => {
    const noise1 = new SimplexNoise(12345);
    const noise2 = new SimplexNoise(54321);
    expect(noise1.noise2D(1.5, 2.5)).not.toEqual(noise2.noise2D(1.5, 2.5));
  });
  
  it('should return values in range [-1, 1]', () => {
    const noise = new SimplexNoise(12345);
    for (let i = 0; i < 1000; i++) {
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const value = noise.noise2D(x, y);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('TerrainGenerator', () => {
  it('should generate heightmap of correct size', () => {
    const params = createDefaultTerrainParams();
    params.resolution = 64;
    const generator = new TerrainGenerator(params);
    const heightmap = generator.generateHeightmap();
    expect(heightmap.length).toBe(64 * 64);
  });
  
  it('should be deterministic with same seed', () => {
    const params = createDefaultTerrainParams();
    params.resolution = 32;
    
    const gen1 = new TerrainGenerator(params);
    const map1 = gen1.generateHeightmap();
    
    const gen2 = new TerrainGenerator(params);
    const map2 = gen2.generateHeightmap();
    
    expect(map1).toEqual(map2);
  });
});

describe('HydraulicErosion', () => {
  it('should reduce total height (erosion removes material)', () => {
    const params = createDefaultTerrainParams();
    params.resolution = 64;
    params.erosion.iterations = 1000;
    
    const generator = new TerrainGenerator(params);
    const heightmap = generator.generateHeightmap();
    
    const totalBefore = heightmap.reduce((a, b) => a + b, 0);
    generator.applyHydraulicErosion(heightmap);
    const totalAfter = heightmap.reduce((a, b) => a + b, 0);
    
    // Erosion should reduce total material (sediment carried off edge)
    expect(totalAfter).toBeLessThan(totalBefore);
  });
});
```

### Visual Tests

1. **Noise Visualization**
   - Render heightmap as grayscale image
   - Verify smooth gradients (no grid artifacts)
   - Verify fBm vs ridged produces different patterns

2. **Erosion Channels**
   - Enable erosion with 100k+ iterations
   - Verify channels form from peaks to edges
   - Verify channels merge (watershed behavior)

3. **Material Blending**
   - Place snow on high peaks only
   - Verify steep cliffs show rock, not grass
   - Verify erosion channels show dirt

### Performance Tests

| Resolution | No Erosion | 50k Erosion | 100k Erosion |
|------------|------------|-------------|--------------|
| 128×128    | < 10ms     | < 500ms     | < 1s         |
| 256×256    | < 50ms     | < 1s        | < 2s         |
| 512×512    | < 200ms    | < 3s        | < 6s         |
| 1024×1024  | < 800ms    | < 10s       | < 20s        |

---

## References

- [Hydraulic Erosion by Sebastian Lague](https://www.youtube.com/watch?v=eaXk97ujbPQ) - Visual explanation
- [Hans Beyer's Erosion Implementation](https://github.com/SebLague/Hydraulic-Erosion) - Reference code
- [Red Blob Games: Terrain Generation](https://www.redblobgames.com/maps/terrain-from-noise/) - Noise techniques
- [GPU Gems: Hydraulic Erosion](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu) - Advanced GPU approach

---

*Document created: January 2026*
