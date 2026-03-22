# Procedural Rock System — Implementation Plan

## Overview

Add a `procedural-rock` render mode to the vegetation system that generates deformed icosphere rock meshes entirely on the GPU via compute shaders. Each rock plant type gets one unique procedurally generated shape at 4 LOD tiers, with baked albedo + normal map textures. The generated meshes feed into the existing variant renderer pipeline, inheriting full PBR lighting, CSM shadows, multi-light, IBL, spot shadows, and cloud shadows with zero shader changes.

**Design Principle**: One rock mesh = one plant type. To get visual variety, users create multiple plant types each with a different shape seed. This keeps the architecture identical to how GLTF mesh vegetation works today — no special-casing in spawn, cull, or render paths.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  User clicks "Generate Rock Mesh" in Vegetation Panel         │
└──────────┬────────────────────────────────────────────────────┘
           │
           ▼
┌───────────────────────────────────────────────────────────────┐
│  ProceduralRockMeshGenerator (new)                            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ rock-mesh-gen.wgsl (compute)                            │  │
│  │  • Base icosphere at 4 subdivision levels               │  │
│  │  • Noise displacement: Voronoi ridges + fBM + turbulence│  │
│  │  • Normal computation via finite-difference gradient     │  │
│  │  • UV generation via spherical projection                │  │
│  │  Output: 4 × (vertex buffer + index buffer)             │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ rock-texture-gen.wgsl (compute)                         │  │
│  │  • Albedo: fallbackColor + noise tint + moss on top     │  │
│  │  • AO: baked from displacement concavity                │  │
│  │  • Normal map: micro-detail noise gradient              │  │
│  │  Output: 1 × albedo texture + 1 × normal texture       │  │
│  └─────────────────────────────────────────────────────────┘  │
│  Result: ProceduralRockRef (4 VegetationMesh + 2 textures)   │
└──────────┬────────────────────────────────────────────────────┘
           │ cached on PlantType; looks like a GLTF mesh to the system
           ▼
┌───────────────────────────────────────────────────────────────┐
│  Existing Pipeline (NO changes to these)                      │
│                                                               │
│  VegetationSpawner (spawn.wgsl)                               │
│    → spawns instances with renderMode=mesh (renderFlag=1)     │
│                                                               │
│  VegetationCullingPipeline (cull.wgsl)                        │
│    → frustum + distance cull, outputs to meshOutput buffer    │
│                                                               │
│  VegetationMeshVariantRenderer                                │
│    → registers rock vertex/index buffers via addMeshFromRaw   │
│    → creates ECS entities with VegetationInstanceComponent    │
│    → LOD tier selection based on tile lodLevel (MODIFIED)     │
│                                                               │
│  VariantRenderer.renderColor()                                │
│    → full PBR + CSM + IBL + multi-light + cloud shadow        │
│  VariantRenderer.renderDepthOnly()                            │
│    → shadow map depth passes                                  │
└───────────────────────────────────────────────────────────────┘
```

---

## 3D Noise Strategy for Convincing Rocks

Three noise layers combine to produce angular, craggy rock shapes:

### Layer 1: Voronoi Ridge Noise (F2 - F1) — Primary Shape (weight: 0.6)

Standard Worley/Voronoi computes distance to nearest cell point (F1). For rocks, we compute `F2 - F1` (second-nearest minus nearest), which produces **sharp ridges at cell boundaries** resembling fracture lines and craggy protrusions. This is the key differentiator from smooth Perlin blobs.

```wgsl
fn voronoiRidge(p: vec3f) -> f32 {
    // Find F1 (nearest) and F2 (second nearest) distances
    // Return F2 - F1 → sharp ridges at cell boundaries
}
```

### Layer 2: Domain-Warped fBM — Medium Variation (weight: 0.25)

Fractal Brownian Motion (3 octaves of Perlin noise) with **domain warping** — the input coordinates are themselves offset by noise. This creates organic, self-similar folding patterns that resemble geological stratification.

```wgsl
fn domainWarpedFBM(p: vec3f, seed: f32) -> f32 {
    let warp = vec3f(perlinFBM(p + 100), perlinFBM(p + 200), perlinFBM(p + 300)) * 0.3;
    return perlinFBM((p + warp) * 4.0);
}
```

### Layer 3: Turbulence (abs-value fBM) — Sharp Creases (weight: 0.15)

Taking `abs(perlinNoise)` before summing octaves folds the noise at zero crossings, creating **sharp V-shaped valleys** instead of smooth undulations. Classic technique from Perlin 1985 for marble/rock textures.

```wgsl
fn turbulenceNoise(p: vec3f) -> f32 {
    var sum = 0.0; var amp = 0.5; var freq = 1.0;
    for (var i = 0; i < 3; i++) {
        sum += abs(perlinNoise(p * freq)) * amp;
        freq *= 2.0; amp *= 0.5;
    }
    return sum;
}
```

### Combined Displacement

```wgsl
fn rockDisplacement(dir: vec3f, seed: f32) -> f32 {
    let p = dir * 3.0 + seed * 17.0;
    let ridge = voronoiRidge(p * 2.0);
    let fbm = domainWarpedFBM(p, seed);
    let turb = turbulenceNoise(p * 6.0);
    return ridge * 0.6 + fbm * 0.25 + turb * 0.15;
}
```

---

## LOD Tier System

Each rock plant type generates **4 LOD tiers** with different icosphere subdivision levels:

| LOD Tier | Subdivision | Vertices | Triangles | Tile LOD Range |
|----------|------------|----------|-----------|----------------|
| 3 (high) | 3 | 642 | 1,280 | leaf to leaf-1 |
| 2 (mid) | 2 | 162 | 320 | leaf-2 to leaf-3 |
| 1 (low) | 1 | 42 | 80 | leaf-4 to leaf-5 |
| 0 (minimal) | 0 | 12 | 20 | ≤ leaf-6 |

The same noise displacement is applied at all tiers (same seed = same shape). Coarser tiers naturally smooth out fine detail since there are fewer vertices to displace. Textures are shared across all LOD tiers — only geometry simplifies.

### LOD Tier Mapping Function

```typescript
function lodLevelToRockTier(lodLevel: number, maxLodLevels: number): number {
    const leafLevel = maxLodLevels - 1;
    const levelsFromLeaf = leafLevel - lodLevel;
    if (levelsFromLeaf <= 1) return 3;  // closest
    if (levelsFromLeaf <= 3) return 2;  // mid
    if (levelsFromLeaf <= 5) return 1;  // far
    return 0;                            // distant
}
```

---

## Procedural Texture Generation

Two 128×128 textures generated per rock plant type via compute shader:

### Albedo + AO Texture (rgba8unorm)

- **RGB**: Base color from `PlantType.fallbackColor`, modulated by:
  - Low-frequency noise tint (warm/cool color shifts per rock region)
  - Moss/lichen on upward-facing surfaces (green tint where spherical-UV normal.y > threshold)
  - Darker in concavities (AO from displacement noise evaluation)
- **A**: Ambient occlusion factor (1.0 = fully lit, 0.0 = deep crevice)

### Normal Map Texture (rgba8unorm)

- Micro-detail normals computed from noise gradient at higher frequency than the geometry
- Provides surface roughness detail that the mesh LOD can't capture
- Uses tangent-space normals in standard [0,1] encoding (compatible with `texturedFeature`)

### Texture Binding

Textures are set as `VegetationSubMesh.baseColorTexture` and bound via the existing `texturedFeature` — the PBR pipeline samples them automatically via `textureSample(baseColorTexture, ...)`. No shader changes needed.

---

## GPU Memory Budget (Per Rock Plant Type)

| Resource | Size |
|----------|------|
| Vertex buffer LOD 3 (642 × 32 bytes) | 20.5 KB |
| Vertex buffer LOD 2 (162 × 32 bytes) | 5.2 KB |
| Vertex buffer LOD 1 (42 × 32 bytes) | 1.3 KB |
| Vertex buffer LOD 0 (12 × 32 bytes) | 0.4 KB |
| Index buffers (all 4 LODs) | ~8 KB |
| Albedo texture (128² × 4) | 64 KB |
| Normal map texture (128² × 4) | 64 KB |
| **Total** | **~163 KB** |

For a scene with 6 different rock types: **~980 KB** total GPU memory.

---

## Caching Strategy

- Rock meshes + textures are generated **once per plant type** via user-triggered "Generate" button
- Cached in a `ProceduralRockRef` on the `PlantType` — persists for the session
- **Invalidation**: Only regenerated if user clicks "Regenerate" (e.g., after changing seed)
- The `ProceduralRockRef` stores 4 `VegetationMesh` objects (one per LOD tier) + 2 `UnifiedGPUTexture`
- Generation runs as a single GPU compute submission (~< 50ms)

---

## UI Flow

### In the Vegetation Panel (per plant type)

When a plant type's renderMode is `procedural-rock`:

**Before generation:**
```
Render Mode: [procedural-rock ▾]
Rock Shape Seed: [42        ]
⚠ Rock mesh not generated
[🪨 Generate Rock Mesh]
```

**After generation:**
```
Render Mode: [procedural-rock ▾]
Rock Shape Seed: [42        ]
✅ Rock mesh generated (4 LODs, ~163 KB)
[🔄 Regenerate]
```

The `procedural-rock` option appears in the render mode dropdown alongside `billboard`, `mesh`, `hybrid`, and `grass-blade`. If selected but no mesh is generated yet, the plant type won't spawn until the user clicks Generate.

---

## Implementation Phases

### Phase 1: Types & Data Model

**Files modified:**
- `src/core/vegetation/types.ts`

**Changes:**
- Add `'procedural-rock'` to `RenderMode` type union
- Add `ProceduralRockRef` interface:
  ```typescript
  interface ProceduralRockRef {
      seed: number;
      lodMeshes: VegetationMesh[];  // [lod0, lod1, lod2, lod3]
      albedoTexture: UnifiedGPUTexture;
      normalTexture: UnifiedGPUTexture;
  }
  ```
- Add `rockRef: ProceduralRockRef | null` to `PlantType`
- Add `rockSeed: number` to `PlantType` (user-configurable shape seed)
- Update `createDefaultPlantType()` with rock defaults

### Phase 2: Compute Shader — Rock Mesh Generation

**Files created:**
- `src/core/gpu/shaders/vegetation/rock-mesh-gen.wgsl`

**Shader design:**
- Input: uniform params (seed, subdivision level, displacement amplitude)
- Input: read-only storage buffer with base icosphere vertices for given subdivision
- Output: read-write storage buffer with deformed vertices (position + normal + UV)
- Workgroup size: 64 (one thread per vertex)
- Operations per vertex:
  1. Read base icosphere position
  2. Normalize to unit sphere
  3. Compute spherical UV
  4. Evaluate combined noise displacement along the radial direction
  5. Displace vertex: `pos = normalize(basePos) * (radius + displacement * amplitude)`
  6. Compute normal via central-difference gradient (6 noise samples)
  7. Write to output buffer

### Phase 3: Compute Shader — Rock Texture Generation

**Files created:**
- `src/core/gpu/shaders/vegetation/rock-texture-gen.wgsl`

**Shader design:**
- Two dispatch passes: one for albedo+AO, one for normal map
- Input: uniform params (seed, fallbackColor, moss threshold)
- Output: 128×128 `rgba8unorm` storage textures
- Workgroup size: 8×8
- Albedo pass: evaluate noise at spherical UV → color modulation + moss + AO
- Normal pass: evaluate noise gradient at higher frequency → tangent-space normal

### Phase 4: TypeScript Generator Class

**Files created:**
- `src/core/vegetation/ProceduralRockMeshGenerator.ts`

**Class responsibilities:**
- `generate(ctx: GPUContext, seed: number, fallbackColor: [number,number,number]): ProceduralRockRef`
- Creates base icosphere vertex data for subdivisions 0-3 (CPU-side constant data)
- Uploads base vertices to GPU storage buffer
- Runs `rock-mesh-gen.wgsl` compute shader for each of 4 LOD tiers
- Reads back deformed vertices (or uses them directly as vertex buffers)
- Runs `rock-texture-gen.wgsl` compute shader for albedo + normal textures
- Returns `ProceduralRockRef` with 4 `VegetationMesh` + 2 textures
- Icosphere generation algorithm (CPU): recursive midpoint subdivision of base icosahedron

### Phase 5: Integration with Vegetation Pipeline

**Files modified:**
- `src/core/vegetation/VegetationManager.ts`
  - In `_ensurePlantMesh()`: for `renderMode === 'procedural-rock'`, use `rockRef.lodMeshes[tier]` instead of loading GLTF
  - LOD tier selection via `lodLevelToRockTier(tile.lodLevel, maxLodLevels)`
  - Skip mesh loading if `rockRef` is null (not yet generated)

- `src/core/vegetation/VegetationMeshVariantRenderer.ts`
  - In `_createDrawGroupEntity()`: when creating draw groups for procedural rocks, use the rock's PBR material (high roughness, opaque, single-sided)
  - Support multiple `VegetationMesh` per plant (LOD tiers) — select based on tile `lodLevel`

- `src/core/vegetation/VegetationRenderer.ts`
  - Route `renderMode === 4` (procedural-rock) through the mesh pipeline path (same as renderMode 1)
  - Set `windInfluence: 0` for rocks (they don't sway)

- `src/core/vegetation/PlantRegistry.ts`
  - Store `rockRef` per plant type
  - Emit events on rock generation/regeneration
  - Serialize/deserialize rock seed (not the GPU buffers — regenerate on load)

### Phase 6: UI — Generate Button

**Files modified:**
- `src/demos/sceneBuilder/components/panels/VegetationPanel/VegetationContent.tsx`
  - When a plant's renderMode is `procedural-rock`:
    - Show rock seed input field
    - Show "Generate Rock Mesh" / "Regenerate" button
    - Show generation status (not generated / generated with stats)
  - `procedural-rock` option available in render mode dropdown

- `src/demos/sceneBuilder/components/bridges/VegetationPanelBridge.tsx`
  - Wire `generateRockMesh(plantId)` action to `VegetationManager`
  - Expose generation status per plant type

### Phase 7: Serialization

**Files modified:**
- `src/loaders/SceneSerializer.ts`
  - Serialize `rockSeed` per plant type (the seed, not GPU data)
  - On scene load: if a plant has `renderMode: 'procedural-rock'` and a `rockSeed`, auto-regenerate the mesh

### Phase 8 (Future): Cross-Plant-Type Spawn/Cull Batching Optimization

**Scope**: General optimization applicable to ALL vegetation plant types (grass, trees, rocks).

**Current behavior**: Each plant type within each tile gets its own:
- Spawn compute dispatch
- Cull compute dispatch
- Draw call(s)

With N plant types across M visible tiles, this is N × M dispatches per frame.

**Optimization opportunity**: Batch multiple plant types into a single spawn/cull dispatch per tile:
- **Batched spawn**: One compute dispatch generates instances for all plant types in a tile, using a plant-type index per cell
- **Batched cull**: One compute dispatch culls all instances in a tile, partitioning output by plant type
- **Reduced overhead**: Fewer command encoder dispatches, better GPU occupancy

**Implementation sketch:**
1. Modify `spawn.wgsl` to accept an array of plant parameters and iterate over them per cell
2. Modify `cull.wgsl` to partition mesh output by plant type using atomic counters per type
3. Update `VegetationSpawner` and `VegetationCullingPipeline` to batch requests per tile
4. Keep per-plant-type draw calls (different meshes require separate drawIndexedIndirect)

**Estimated impact**: Reduces compute dispatch count by ~Nx for N plant types per tile. Most beneficial when many plant types coexist in the same biome (e.g., 3 grass types + 2 flower types + 3 rock types = 8x fewer dispatches).

This is a standalone optimization task that does not block the procedural rock feature.

---

## Files Summary

### New Files (3)

| File | Description |
|------|-------------|
| `src/core/vegetation/ProceduralRockMeshGenerator.ts` | GPU compute-driven rock mesh + texture generator |
| `src/core/gpu/shaders/vegetation/rock-mesh-gen.wgsl` | Compute: icosphere deformation with layered noise |
| `src/core/gpu/shaders/vegetation/rock-texture-gen.wgsl` | Compute: albedo+AO and normal map generation |

### Modified Files (7)

| File | Description |
|------|-------------|
| `src/core/vegetation/types.ts` | Add `'procedural-rock'` to RenderMode, `ProceduralRockRef` type |
| `src/core/vegetation/PlantRegistry.ts` | Store per-plant rock generation state |
| `src/core/vegetation/VegetationManager.ts` | Handle `procedural-rock` in mesh loading, LOD tier selection |
| `src/core/vegetation/VegetationMeshVariantRenderer.ts` | LOD-tier mesh selection for rock plant types |
| `src/core/vegetation/VegetationRenderer.ts` | Route renderMode 4 to mesh pipeline |
| `src/demos/sceneBuilder/components/panels/VegetationPanel/VegetationContent.tsx` | Generate button, seed input, status display |
| `src/demos/sceneBuilder/components/bridges/VegetationPanelBridge.tsx` | Wire generation trigger |

### Unchanged Files (Critical Path)

| File | Why Unchanged |
|------|---------------|
| `spawn.wgsl` | Rocks spawn as renderMode=mesh, no changes needed |
| `cull.wgsl` | Standard mesh culling path, no changes needed |
| `VariantRenderer.ts` | Reads ECS entities generically, no changes needed |
| `VariantMeshPool.ts` | addMeshFromRawBuffers works for any vertex buffer |
| `VariantPipelineManager.ts` | Composes shaders from features, no changes needed |
| `vegetationInstancingFeature.ts` | Instance transform + wind, rocks just use windInfluence=0 |
| `VegetationInstanceComponent.ts` | Buffer refs, no changes needed |
| `object-template.wgsl` | PBR template, no changes needed |
| `texturedFeature.ts` | Texture sampling, no changes needed |
| All PBR/shadow/lighting shaders | Inherited automatically via variant pipeline |
