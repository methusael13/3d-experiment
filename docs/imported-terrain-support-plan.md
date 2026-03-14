# Imported Terrain Support Plan

> Support for loading externally-generated terrain data alongside the existing procedural CDLOD pipeline.

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [External Terrain Data Formats](#2-external-terrain-data-formats)
3. [Architecture: TerrainDataSource Strategy](#3-architecture-terraindatasource-strategy)
4. [Heightmap Import Pipeline](#4-heightmap-import-pipeline)
5. [Normal Map & Detail Noise](#5-normal-map--detail-noise)
6. [Splat Map / Biome Mask](#6-splat-map--biome-mask)
7. [Flow Map](#7-flow-map)
8. [Vegetation System Integration](#8-vegetation-system-integration)
9. [CDLOD Renderer Changes](#9-cdlod-renderer-changes)
10. [TerrainManager Refactor](#10-terrainmanager-refactor)
11. [UI Changes](#11-ui-changes)
12. [Scene Serialization](#12-scene-serialization)
13. [File Impact Matrix](#13-file-impact-matrix)
14. [Implementation Phases](#14-implementation-phases)

---

## 1. Current Architecture

The terrain system is a procedural CDLOD pipeline with these components:

| Component | File | Role |
|---|---|---|
| **TerrainManager** | `src/core/terrain/TerrainManager.ts` | Orchestrator — owns heightmap generation, erosion, rendering, vegetation |
| **HeightmapGenerator** | `src/core/terrain/HeightmapGenerator.ts` | GPU compute noise → `r32float` heightmap + normal map + island mask |
| **ErosionSimulator** | `src/core/terrain/ErosionSimulator.ts` | Hydraulic + thermal erosion via GPU compute (ping-pong textures) |
| **HeightmapMipmapGenerator** | `src/core/terrain/HeightmapMipmapGenerator.ts` | Mip chain for CDLOD LOD sampling — format-agnostic ✅ |
| **CDLODRendererGPU** | `src/core/terrain/CDLODRendererGPU.ts` | Quadtree LOD + instanced grid rendering — decoupled from data source ✅ |
| **TerrainQuadtree** | `src/core/terrain/TerrainQuadtree.ts` | Frustum culling + LOD node selection — pure geometry ✅ |
| **TerrainBiomeTextureResources** | `src/core/terrain/TerrainBiomeTextureResources.ts` | Biome splatting textures (albedo/normal per biome) — decoupled ✅ |
| **BiomeMaskGenerator** | `src/core/vegetation/BiomeMaskGenerator.ts` | GPU compute biome mask from heightmap + flow map |
| **VegetationSpawner** | `src/core/vegetation/VegetationSpawner.ts` | GPU compute spawn — samples biome mask by channel index |
| **VegetationManager** | `src/core/vegetation/VegetationManager.ts` | Tile-based vegetation orchestration |
| **PlantRegistry** | `src/core/vegetation/PlantRegistry.ts` | Plant type definitions organized by biome channel (r/g/b/a) |
| **TerrainComponent** | `src/core/ecs/components/TerrainComponent.ts` | ECS thin wrapper → TerrainManager |
| **GPUTerrainSceneObject** | `src/core/sceneObjects/GPUTerrainSceneObject.ts` | Scene proxy for selection/shadow casting |
| **TerrainPanelBridge** | `src/demos/.../TerrainPanelBridge.tsx` | UI → TerrainManager connection |

### Current Data Flow

```
HeightmapGenerator → [r32float heightmap]
        ↓
ErosionSimulator → [eroded r32float heightmap] + [flow map]
        ↓
HeightmapGenerator.generateNormalMap() → [rgba8snorm normal map]
        ↓
BiomeMaskGenerator → [rgba8unorm biome mask] (from heightmap + flow)
        ↓
CDLODRendererGPU.render() ← heightmap, normalMap, biomeMask
VegetationSpawner.spawnForPlant() ← heightmap, biomeMask
CPU readback ← heightmap (for collision/FPS camera)
```

### Key Decoupling Point

**CDLODRendererGPU is already decoupled from the data source.** It takes `heightmapTexture`, `normalMapTexture`, `biomeMaskTexture` as render params. The CDLOD quadtree, grid mesh, shadow pass — all work on any `r32float` heightmap. The coupling problem is in **TerrainManager** which hard-wires procedural generation.

---

## 2. External Terrain Data Formats

Terrain generation software (World Machine, World Engine, Gaea, etc.) typically exports:

| Data | Format | Our Internal Format |
|---|---|---|
| **Heightmap** | 16-bit PNG, 32-bit float RAW, EXR | `r32float` GPU texture, normalized [-0.5, 0.5] |
| **Normal map** | RGB8/RGB16 PNG | `rgba8snorm` GPU texture |
| **Splat/Weight map** | RGBA8 PNG (per-channel biome weights) | `rgba8unorm` GPU texture (R=grass, G=rock, B=forest, A=reserved) |
| **Flow map** | Single-channel 8/16-bit PNG | `r32float` GPU texture, normalized 0-1 |
| **Detail normal map** | RGB8 PNG (tiled micro-detail) | New: tiling normal texture for close-up detail |
| **Metadata** | JSON/custom | World size, height range, resolution, channel meanings |

### Height Range Convention

- Our engine stores heightmap as normalized `[-0.5, 0.5]` in the GPU texture
- `heightScale` uniform converts to world units at render time
- External tools output either normalized `[0, 1]` or absolute meters
- Import must remap: `externalValue → (externalValue - min) / (max - min) - 0.5`

---

## 3. Architecture: TerrainDataSource Strategy

### Core Abstraction

Introduce a **`TerrainDataSource`** interface that abstracts how terrain data is produced. TerrainManager becomes data-source-agnostic.

```
TerrainDataSource (interface)
  ├── ProceduralTerrainSource  ← existing behavior extracted
  │     Uses HeightmapGenerator + ErosionSimulator
  └── ImportedTerrainSource    ← new
        Loads heightmap/normal/splatmap/flow from files
```

### Interface Definition (`src/core/terrain/TerrainDataSource.ts`)

```typescript
export type TerrainSourceMode = 'procedural' | 'imported';

export interface ImportedTerrainMetadata {
  heightmapPath: string;
  normalMapPath?: string;
  splatMapPath?: string;
  flowMapPath?: string;
  detailNormalMapPath?: string;
  worldSize: number;
  heightRange: { min: number; max: number };
  heightFormat: 'normalized' | 'absolute';
  splatChannelNames?: {
    r?: string; g?: string; b?: string; a?: string;
  };
}

export interface TerrainDataResult {
  heightmap: UnifiedGPUTexture;
  normalMap: UnifiedGPUTexture;
  flowMap: UnifiedGPUTexture | null;
  biomeMask: UnifiedGPUTexture | null;
  detailNormalMap: UnifiedGPUTexture | null;
  cpuHeightfield: Float32Array | null;
  heightfieldResolution: number;
}

export interface TerrainDataSource {
  readonly mode: TerrainSourceMode;
  initialize(ctx: GPUContext): void;
  generate(progressCallback?: GenerationProgressCallback): Promise<TerrainDataResult>;
  readonly supportsRegeneration: boolean;
  readonly supportsErosion: boolean;
  getFlowMap(): UnifiedGPUTexture | null;
  destroy(): void;
}
```

---

## 4. Heightmap Import Pipeline

### New File: `src/core/terrain/HeightmapImporter.ts`

Utility for converting external heightmap formats to our engine's `r32float` convention.

**Supported input formats:**
- **16-bit PNG**: Decode via `createImageBitmap()` + canvas readback, divide by 65535 to normalize
- **32-bit float RAW**: Direct `ArrayBuffer` → `Float32Array` upload
- **EXR**: Float EXR loader (single channel extraction)
- **8-bit PNG**: Decode via standard image path, divide by 255 (lower precision fallback)

**Processing steps:**
1. Load file → get raw pixel data as `Float32Array`
2. Validate: must be square, power-of-2 resolution
3. Remap height range: `(value - srcMin) / (srcMax - srcMin) - 0.5` → normalized `[-0.5, 0.5]`
4. Upload to `r32float` GPU texture with `storage: true, sampled: true, copySrc: true`
5. Generate mip chain via existing `HeightmapMipmapGenerator`
6. CPU readback for collision (reuse `TerrainManager.readbackHeightmap()` logic)

**Key method:**
```typescript
class HeightmapImporter {
  async loadHeightmap(
    ctx: GPUContext,
    filePath: string,
    heightRange: { min: number; max: number },
    format: 'png16' | 'png8' | 'raw32' | 'exr'
  ): Promise<{ texture: UnifiedGPUTexture; cpuData: Float32Array; resolution: number }>
}
```

### New File: `src/core/terrain/ImportedTerrainSource.ts`

Implements `TerrainDataSource` for externally-generated terrain:

1. Uses `HeightmapImporter` to load the heightmap
2. If normal map path provided → load as `rgba8snorm` texture; otherwise → derive using existing `HeightmapGenerator.generateNormalMap()`
3. If splat map path provided → load as `rgba8unorm` biome mask directly
4. If flow map path provided → load as `r32float` texture
5. If detail normal map path provided → load as `rgba8unorm` tiling texture
6. Optionally supports applying erosion on top of imported heightmap (uses existing `ErosionSimulator`)

```typescript
class ImportedTerrainSource implements TerrainDataSource {
  readonly mode = 'imported';
  readonly supportsRegeneration = false; // Can reload from files
  readonly supportsErosion = true;       // Can apply erosion on top

  constructor(metadata: ImportedTerrainMetadata) { ... }
  async generate(progressCallback?): Promise<TerrainDataResult> { ... }
}
```

### New File: `src/core/terrain/ProceduralTerrainSource.ts`

Extracts existing procedural logic from `TerrainManager.generate()`:

- Wraps `HeightmapGenerator` + `ErosionSimulator`
- Implements `TerrainDataSource`
- Exposes noise params, erosion params
- `regenerateHeightmapOnly()` for live preview
- This is mostly **code extraction**, not new logic

---

## 5. Normal Map & Detail Noise

### Current CDLOD Shader Normal Pipeline

The fragment shader in `cdlod.wgsl` has a three-layer normal blending stack:

1. **Base normal** — sampled from `normalMapTexture` (binding 3)
2. **Procedural detail normal** — computed analytically via `getProceduralDetailNormal()` using FBM with analytical derivatives. Slope-dependent: flat areas get rolling noise, steep areas get rocky noise. Also applies vertex displacement via `getProceduralDetail()`.
3. **Biome texture normals** — from per-biome normal maps (binding group 1, `TerrainBiomeTextureResources`)

Blending order: `base → UDN blend with detail → weighted blend with biome normals`

### What Changes for Imported Terrains

**The existing normal map slot works as-is** — imported normal maps are loaded and passed as `normalMapTexture` to `CDLODRenderParams`. No shader change for the base normal.

**Procedural detail noise still works and is desirable** — it adds micro-displacement close to camera that no heightmap resolution can match. For imported terrain the user tunes detail params (frequency, amplitude, fade distances) or sets `detailAmplitude = 0` to disable.

**New capability: Imported detail normal map** — replaces the procedural detail noise with an artist-authored micro-normal texture from the terrain tool.

### Shader Change (`cdlod.wgsl`)

Add a new texture binding and uniform flag:

```wgsl
// New binding (Group 0, binding 9 or Group 1 spare slot):
@group(0) @binding(9) var importedDetailNormal: texture_2d<f32>;

// New uniform field:
useImportedDetailNormal: f32,  // 1.0 = use imported, 0.0 = use procedural
detailNormalTiling: f32,       // world-space tiling scale for imported detail

// In fragment shader:
var detailNormal: vec3f;
if (uniforms.useImportedDetailNormal > 0.5) {
    let detailUV = worldXZ * uniforms.detailNormalTiling;
    let sampled = textureSampleLevel(importedDetailNormal, linearSampler, detailUV, 0.0);
    detailNormal = normalize(sampled.xyz * 2.0 - 1.0);
} else {
    detailNormal = getProceduralDetailNormal(worldXZ, distanceToCamera, slope);
}
```

### CDLODRendererGPU Changes

- Add binding 9 to bind group layout for optional detail normal texture
- Add `useImportedDetailNormal` + `detailNormalTiling` to uniform buffer
- Add `setDetailNormalMap(texture: UnifiedGPUTexture | null, tiling?: number)` method
- Default: 1x1 flat normal placeholder (same as existing default normal)

---

## 6. Splat Map / Biome Mask

### Current Internal Format

`BiomeMaskGenerator` produces an `rgba8unorm` texture:
- R = Grassland weight (0-1)
- G = Rock/Cliff weight (0-1)
- B = Forest Edge weight (0-1)
- A = Reserved

This is consumed by:
- **CDLODRendererGPU** (binding 8) — drives terrain texture splatting
- **VegetationSpawner** (binding 2) — each `PlantType` has `biomeChannel: 'r'|'g'|'b'|'a'` + `biomeThreshold`

### Imported Splat Map Compatibility

External tools export RGBA splat maps where each channel = a terrain type weight. This maps directly to our biome mask format.

**Scenario A — Direct channel mapping (simplest):**
Import RGBA image → load as `rgba8unorm` → assign directly as `biomeMask`. User maps their channels to our R/G/B/A convention. Both terrain splatting and vegetation spawning work unchanged.

**Scenario B — Channel remapping:**
If external tool uses different channel assignments (e.g., R=snow, G=grass), provide a remapping utility. Can be done as a simple compute shader or CPU-side channel swizzle during import.

**Scenario C — More than 4 biomes (future):**
External tools may export 8+ channels across multiple textures. Our system supports 4 channels (RGBA). Initial implementation limits to 4; future extension could add a second splat texture.

### Changes Needed

1. **`TerrainManager`**: Add `setExternalBiomeMask(texture: UnifiedGPUTexture)` — bypasses `BiomeMaskGenerator` and sets `this.biomeMask` directly
2. **`ImportedTerrainSource`**: Load splat map → `rgba8unorm` GPU texture → return as `biomeMask` in `TerrainDataResult`
3. **Channel remapping utility** (optional): Compute shader or CPU utility to rearrange RGBA channels
4. **UI**: Channel mapping dropdown when importing (R=which biome, etc.)

### No Changes Needed

- `BiomeMaskGenerator` — already accepts any `r32float` heightmap/flow; can still be used on imported heightmaps if user wants procedural biome derivation
- `CDLODRendererGPU` binding 8 — already takes any `rgba8unorm` texture
- `VegetationSpawner` binding 2 — already takes any `rgba8unorm` texture, samples by channel index

---

## 7. Flow Map

### Current Implementation

- **Source**: `ErosionSimulator` generates flow during hydraulic erosion (atomic u32 accumulation → normalized float via `finalizeFlowMap`)
- **Format**: `r32float` texture, same resolution as heightmap
- **Consumers**: `BiomeMaskGenerator.generate(heightmap, flowMap)` for forest placement; debug visualization

### For Imported Flow Maps

External tools export flow accumulation as single-channel images (8/16-bit). The mapping is straightforward:

1. Load image → convert to `r32float` GPU texture (same as heightmap import pipeline)
2. Normalize to 0-1 range if not already
3. Pass to `TerrainManager` as `flowMap`

**If no flow map provided**: `BiomeMaskGenerator` already handles null flow by using a 1x1 `dummyFlowTexture` and has a `defaultFlowValue` parameter in the GPU struct. Vegetation spawning does not depend on flow maps at all.

### No Changes Needed

`BiomeMaskGenerator` is already decoupled from flow map source — it accepts any `r32float` texture via its `generate(heightmap, flowMap)` method.

---

## 8. Vegetation System Integration

### Current Biome Coupling

The vegetation system's biome dependency is through **two textures passed at initialization**:

1. `VegetationManager.connectToTerrain(plantRegistry, heightmap, biomeMask, ...)` — receives RGBA8 biome mask + r32float heightmap
2. `VegetationSpawner.spawnForPlant(request, plant, biomeMask, heightmap, ...)` — samples biome mask at binding 2, heightmap at binding 1
3. Each `PlantType` has `biomeChannel: 'r'|'g'|'b'|'a'` and `biomeThreshold: number`
4. The spawn shader (`spawn.wgsl`) samples the channel specified by `biomeChannel` (integer 0-3) and compares against threshold

**The GPU pipeline is entirely channel-index-based and does not know biome names.** The coupling is texture-in, texture-out.

### Biome Name Display in UI

Biome names are defined in `DEFAULT_BIOME_CONFIGS` (`vegetation/types.ts`):

```typescript
DEFAULT_BIOME_CONFIGS = {
  r: { biomeName: 'Grassland',    displayColor: [0.3, 0.7, 0.2] },
  g: { biomeName: 'Rock/Cliff',   displayColor: [0.5, 0.5, 0.5] },
  b: { biomeName: 'Forest Edge',  displayColor: [0.1, 0.4, 0.15] },
  a: { biomeName: 'Reserved',     displayColor: [0.0, 0.0, 0.0] },
};
```

These are **mutable display strings** stored in `BiomePlantConfig`. The `VegetationContent.tsx` panel reads them from `PlantRegistry.getAllBiomeConfigs()` and renders tabs/sections using the `biomeName` field. This is already data-driven.

### Changes Needed

**`PlantRegistry`** — add one new method:
```typescript
setBiomeNames(names: Partial<Record<BiomeChannel, { name: string; color?: [number, number, number] }>>): void
```
When importing terrain with a splat map, call this to relabel biomes (e.g., "Dirt", "Snow", "Sand" instead of "Grassland", "Rock/Cliff", "Forest Edge"). The UI automatically refreshes because it reads from the mutable biome configs.

**`BiomeMaskContent.tsx`** — conditionally hide when imported splat map is in use (the procedural biome mask editor doesn't apply when the mask is pre-baked from external tool). Show it when the user opts to regenerate biome mask from the imported heightmap.

### No Changes Needed

| Component | Why |
|---|---|
| `VegetationSpawner` + `spawn.wgsl` | Samples by channel index (0-3), not by name |
| `VegetationManager` | `connectToTerrain()` already accepts arbitrary texture refs |
| `VegetationContent.tsx` | Already reads mutable `biomeName` from `PlantRegistry` |
| `VegetationCullingPipeline` | Operates on instance buffers, no biome dependency |
| All vegetation renderers | Render instances, no biome dependency |

---

## 9. CDLOD Renderer Changes

### Summary of CDLODRendererGPU Modifications

The renderer is mostly decoupled already. Changes are small and additive:

1. **New binding 9**: Optional imported detail normal map texture
2. **New uniform fields** (2 floats): `useImportedDetailNormal`, `detailNormalTiling`
3. **New method**: `setDetailNormalMap(texture: UnifiedGPUTexture | null, tiling?: number)`
4. **Bind group layout update**: Add entry 9 to existing layout
5. **Default placeholder**: 1x1 flat normal texture for binding 9 when no detail normal is loaded

### What Stays the Same ✅

- Quadtree LOD selection — pure geometry, no data dependency
- Grid mesh generation — static vertices/indices
- Instance buffer management — driven by quadtree nodes
- Shadow pass — uses heightmap texture, works with any r32float
- Biome texture splatting (Group 1) — independent resource manager
- Material system — color/texture per biome
- Wireframe mode — topology change only
- All existing uniform fields and bindings 0-8

---

## 10. TerrainManager Refactor

### Current State

`TerrainManager` is monolithic: it directly owns `HeightmapGenerator`, `ErosionSimulator`, and orchestrates the procedural pipeline in `generate()`.

### Refactored State

Add a `TerrainDataSource` field and delegate data generation:

```typescript
class TerrainManager {
  private source: TerrainDataSource;        // NEW: replaces direct generator/simulator refs
  private heightmapGenerator: HeightmapGenerator | null = null;  // Kept for normal map derivation
  
  // ... existing renderer, vegetation, biome mask fields stay ...
  
  /** Switch terrain source mode */
  setSource(source: TerrainDataSource): void {
    this.source?.destroy();
    this.source = source;
    this.source.initialize(this.ctx);
  }
  
  /** Load terrain from external files */
  async loadFromFiles(metadata: ImportedTerrainMetadata, progressCallback?): Promise<void> {
    const source = new ImportedTerrainSource(metadata);
    this.setSource(source);
    await this.generate(progressCallback);
  }
  
  /** Generate terrain (delegates to source) */
  async generate(progressCallback?): Promise<void> {
    const result = await this.source.generate(progressCallback);
    this.heightmap = result.heightmap;
    this.normalMap = result.normalMap;
    this.flowMap = result.flowMap;
    this.biomeMask = result.biomeMask;
    this.cpuHeightfield = result.cpuHeightfield;
    // ... connect to vegetation, etc. (existing logic) ...
  }
  
  getSourceMode(): TerrainSourceMode { return this.source.mode; }
}
```

### TerrainManagerConfig Changes

```typescript
export interface TerrainManagerConfig {
  // ... existing fields ...
  sourceMode: TerrainSourceMode;              // NEW
  importedMetadata?: ImportedTerrainMetadata;  // NEW
}
```

### Backward Compatibility

Default `sourceMode = 'procedural'`. Existing code that creates `TerrainManager` without specifying a source gets the `ProceduralTerrainSource` automatically. All existing APIs (`regenerate()`, `setWorldSize()`, etc.) continue to work.

---

## 11. UI Changes

### TerrainPanel Modifications

Add a **source mode selector** at the top of the terrain panel:

```
┌─────────────────────────────────────────┐
│ Terrain Source: [Procedural ▼] [Import] │
├─────────────────────────────────────────┤
│                                         │
│  (Conditional content based on mode)    │
│                                         │
└─────────────────────────────────────────┘
```

**Procedural mode** (existing, unchanged):
- Noise section (seed, octaves, warp, ridge, etc.)
- Erosion section (hydraulic/thermal)
- Material section (biome colors + textures)
- Detail section (frequency, amplitude, fade)
- Island mode section

**Imported mode** (new):
- File picker for heightmap (drag-drop or browse from asset library)
- Optional file pickers: normal map, splat map, flow map, detail normal map
- World size input
- Height range inputs (min, max)
- Height format selector (normalized / absolute)
- Splat channel naming (R=?, G=?, B=?, A=?)
- "Import" / "Reimport" button
- Material section (same as procedural — biome textures still apply)
- Detail section (procedural micro-detail on top of imported, or imported detail normal)
- Optional erosion section (apply erosion on imported heightmap)

**Shared sections** (both modes):
- Material / biome textures
- Procedural detail noise (or imported detail normal toggle)
- Vegetation editor button
- Biome mask editor button (hidden if imported splat map is active)

### TerrainPanelBridge Changes

- Track `sourceMode` state
- When switching to imported mode: show file pickers, hide noise/erosion sections
- Wire up `manager.loadFromFiles()` for import action
- Pass `sourceMode` to child editors (BiomeMaskPanelBridge, VegetationPanelBridge)

---

## 12. Scene Serialization

`SceneSerializer` needs to save and restore terrain source state.

### Procedural Mode (existing + extend)

```json
{
  "terrain": {
    "sourceMode": "procedural",
    "worldSize": 400,
    "heightScale": 125,
    "noise": { ... },
    "erosion": { ... },
    "material": { ... }
  }
}
```

### Imported Mode (new)

```json
{
  "terrain": {
    "sourceMode": "imported",
    "worldSize": 400,
    "heightScale": 200,
    "imported": {
      "heightmapPath": "terrain/heightmap.png",
      "normalMapPath": "terrain/normal.png",
      "splatMapPath": "terrain/splat.png",
      "flowMapPath": null,
      "detailNormalMapPath": "terrain/detail_normal.png",
      "heightRange": { "min": 0, "max": 1 },
      "heightFormat": "normalized",
      "splatChannelNames": {
        "r": "Grass", "g": "Rock", "b": "Snow", "a": "Dirt"
      }
    },
    "material": { ... }
  }
}
```

On load: detect `sourceMode`, create appropriate `TerrainDataSource`, call `generate()`.

---

## 13. File Impact Matrix

### New Files

| File | Purpose |
|---|---|
| `src/core/terrain/TerrainDataSource.ts` | Interface + shared types |
| `src/core/terrain/ProceduralTerrainSource.ts` | Extracted procedural logic |
| `src/core/terrain/ImportedTerrainSource.ts` | External terrain loader |
| `src/core/terrain/HeightmapImporter.ts` | Format conversion utility |

### Modified Files

| File | Change | Size |
|---|---|---|
| `src/core/terrain/TerrainManager.ts` | Delegate to `TerrainDataSource`, add `setSource()`, `loadFromFiles()` | Medium |
| `src/core/terrain/CDLODRendererGPU.ts` | Add binding 9 (detail normal), 2 uniform floats, `setDetailNormalMap()` | Small |
| `src/core/gpu/shaders/terrain/cdlod.wgsl` | Branch for imported vs procedural detail normal | Small |
| `src/core/terrain/types.ts` | Add `TerrainSourceMode`, `ImportedTerrainMetadata` types | Small |
| `src/core/terrain/index.ts` | Export new modules | Tiny |
| `src/core/vegetation/PlantRegistry.ts` | Add `setBiomeNames()` method | Small |
| `src/demos/.../TerrainPanelBridge.tsx` | Source mode switching, file picker wiring | Medium |
| `src/demos/.../TerrainPanel.tsx` | Conditional UI sections for procedural vs imported | Medium |
| `src/demos/.../BiomeMaskContent.tsx` | Hide when imported splat map is active | Small |
| `src/loaders/SceneSerializer.ts` | Serialize/deserialize source mode + imported metadata | Small |

### Unchanged Files ✅

| File | Why |
|---|---|
| `TerrainQuadtree.ts` | Pure geometry, no data dependency |
| `HeightmapMipmapGenerator.ts` | Works on any r32float texture |
| `TerrainBiomeTextureResources.ts` | Independent biome texture manager |
| `BiomeMaskGenerator.ts` | Already accepts arbitrary heightmap/flow textures |
| `VegetationSpawner.ts` + `spawn.wgsl` | Channel-index sampling, no name dependency |
| `VegetationManager.ts` | Receives textures via `connectToTerrain()` |
| `VegetationContent.tsx` | Reads mutable biome names from PlantRegistry |
| `TerrainComponent.ts` | Thin wrapper delegates to TerrainManager |
| `GPUTerrainSceneObject.ts` | Delegates to TerrainManager |
| `GPUCullingPipeline.ts` | Quadtree-based, no data source knowledge |
| `ErosionSimulator.ts` | Can be used on any heightmap input |
| `HeightmapGenerator.ts` | `generateNormalMap()` reusable for imported heightmaps |
| All other WGSL shaders | Data-source agnostic |

---

## 14. Implementation Phases

### Phase 1: Interface + Extract Procedural Source (No behavior change)

1. Create `TerrainDataSource.ts` with interface + types
2. Create `ProceduralTerrainSource.ts` — extract `generate()` logic from `TerrainManager`
3. Refactor `TerrainManager` to use `ProceduralTerrainSource` internally
4. **Validate**: everything works identically as before

### Phase 2: Heightmap Importer

1. Create `HeightmapImporter.ts` — format loading + r32float conversion
2. Support 16-bit PNG and raw float32 initially
3. Add height range normalization
4. Add resolution validation
5. **Test**: load a sample 16-bit heightmap and verify GPU texture contents

### Phase 3: ImportedTerrainSource

1. Create `ImportedTerrainSource.ts` implementing `TerrainDataSource`
2. Wire up heightmap loading, mipmap generation, CPU readback
3. Normal map: derive from heightmap using existing `HeightmapGenerator.generateNormalMap()`
4. Splat map: load as `rgba8unorm` biome mask
5. Flow map: load as `r32float`
6. **Test**: import an external terrain and render via CDLOD

### Phase 4: Detail Normal Map Support

1. Add binding 9 + uniforms to `CDLODRendererGPU`
2. Add shader branch in `cdlod.wgsl` for imported vs procedural detail normal
3. Add `setDetailNormalMap()` API
4. **Test**: load a tiling detail normal and verify blending

### Phase 5: Vegetation + Biome Integration

1. Add `PlantRegistry.setBiomeNames()` method
2. Wire up splat channel names from `ImportedTerrainMetadata`
3. Conditionally hide BiomeMask editor for imported splat maps
4. **Test**: import terrain with splat map, verify vegetation spawns on correct biomes with correct labels

### Phase 6: UI + Serialization

1. Add source mode selector to `TerrainPanel`
2. Add file pickers + import controls for imported mode
3. Wire up `TerrainPanelBridge` to switch between modes
4. Add serialization for imported terrain metadata in `SceneSerializer`
5. **Test**: full round-trip — import terrain → render → save scene → reload
