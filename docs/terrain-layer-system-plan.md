# Terrain Layer System Plan

## Overview

Replace the current monolithic terrain generation pipeline (single global noise → erosion → render) with a **layer-based compositing system** where each layer has its own noise parameters, spatial bounds, blend factor, and erosion interaction flags.

## Current Architecture

The existing pipeline is:
1. **`HeightmapGenerator`** — GPU compute generates a single `r32float` heightmap using domain-warped fBm with one global `NoiseParams`
2. **`ErosionSimulator`** — GPU compute for hydraulic (particle-based) and thermal erosion on the whole heightmap
3. **`TerrainManager`** — Orchestrates: generate heightmap → apply erosion → normal map → CPU readback → CDLOD renderer

Supporting systems:
- Island mask (separate texture blended at CDLOD render time)
- Biome mask (slope/height-based for grass/rock/forest)
- Vegetation spawning tied to heightmap + biome mask
- CPU heightfield readback for player collision

**Key limitation**: No concept of compositing multiple noise sources or confining features to spatial regions.

---

## Proposed Design

### Core Types

```typescript
interface TerrainLayerBounds {
  centerX: number;       // World center X
  centerZ: number;       // World center Z
  halfExtentX: number;   // Half-width along local X axis
  halfExtentZ: number;   // Half-width along local Z axis
  rotation: number;      // Rotation angle in degrees (around Y axis)
  featherWidth: number;  // Soft-edge falloff in world units
}

type TerrainLayerType = 'noise' | 'rock' | 'island' | 'flatten' | 'imported';

type TerrainBlendMode = 'additive' | 'multiply' | 'replace' | 'max' | 'min';

interface TerrainLayer {
  id: string;
  name: string;
  type: TerrainLayerType;
  enabled: boolean;
  order: number;           // Stack order (lower = applied first)
  
  // Blend
  blendFactor: number;     // 0..1, how much this layer contributes
  blendMode: TerrainBlendMode;
  
  // Spatial bounds (null = global, applies to entire terrain)
  bounds: TerrainLayerBounds | null;
  
  // Erosion interaction
  erodable: boolean;       // Whether erosion simulation affects this layer (default: true)
  
  // Per-type params (discriminated by type)
  noiseParams?: NoiseParams;
  rockParams?: RockLayerParams;
  islandParams?: IslandLayerParams;
  flattenParams?: FlattenLayerParams;
}
```

### Layer Types

#### Noise Layer
Reuses existing `NoiseParams` (domain-warped fBm with ridged blending). Each noise layer generates its own heightmap texture via the existing `HeightmapGenerator`.

#### Rock Layer
Procedural rock formations using a stepping function on noise:

```typescript
interface RockLayerParams {
  noise: NoiseParams;        // Base noise field for rock formation
  stepCount: number;         // Number of discrete height steps (3-20)
  stepSharpness: number;     // Step transition sharpness (0=smooth, 1=hard)
  stepHeight: number;        // Vertical height per step (world units)
  edgeNoiseScale: number;    // Noise scale for step edge variation
  edgeNoiseAmount: number;   // Edge noise amplitude (0-1)
  heightScale: number;       // Overall height multiplier
}
```

GPU shader logic:
```wgsl
let rawHeight = sampleNoiseField(uv, params);
let stepValue = floor(rawHeight * stepCount) / stepCount;
let steppedHeight = mix(rawHeight, stepValue, stepSharpness);

// Edge noise at step boundaries
let edgeNoise = fbm(uv * edgeNoiseScale) * edgeNoiseAmount;
let distToStep = fract(rawHeight * stepCount);
let edgeMask = smoothstep(0.4, 0.5, distToStep) * smoothstep(0.6, 0.5, distToStep);
steppedHeight += edgeNoise * edgeMask;
```

Creates plateau/mesa formations with controllable step counts and natural edge detail.

#### Island Layer
Refactored from existing island mask system. Replaces render-time CDLOD blending with generation-time compositing:

```typescript
interface IslandLayerParams {
  seed: number;
  islandRadius: number;
  coastNoiseScale: number;
  coastNoiseStrength: number;
  coastFalloff: number;
  seaFloorDepth: number;
}
```

- Always global bounds (null)
- Default blend mode: `'multiply'`
- Removes render-time island blending from CDLOD shader
- CPU heightfield readback now includes island shaping

#### Flatten Layer
Forces terrain to a target height within bounds:

```typescript
interface FlattenLayerParams {
  targetHeight: number;  // Normalized height to flatten to
}
```

Useful for creating building pads, roads, or clearings.

### Erosion Mask System

Each layer has an `erodable: boolean` flag. During compositing, a secondary **erosion mask texture** (`r32float`) is generated alongside the composited heightmap:

```
For each pixel:
  erosion_mask = 1.0;  // Start fully erodable
  
  For each layer:
    effective_blend = boundsMask * blendFactor;
    if (!layer.erodable):
      erosion_mask = mix(erosion_mask, 0.0, effective_blend);
  
  output_erosion_mask[pixel] = erosion_mask;
```

The erosion simulator then uses this mask:
- Hydraulic: multiply `erosionRate` by `erosionMask[P]` at each droplet position
- Thermal: multiply erosion rate by mask value

Rock formations stay crisp; erosion naturally works around them.

### Layer Compositing (GPU Compute)

A new `TerrainLayerCompositor` class with `terrain-layer-composite.wgsl`:

```
For each pixel:
  height = base_height;
  erosion_mask = 1.0;
  
  For each layer (sorted by order):
    // Compute spatial mask from oriented-rect SDF
    mask = (layer.bounds != null) 
      ? computeOrientedRectMask(worldPos, layer.bounds)
      : 1.0;
    
    effective = mask * layer.blendFactor;
    
    // Apply blend mode
    switch (layer.blendMode):
      'additive':  height = height + layerHeight * effective;
      'multiply':  height = mix(height, height * layerHeight, effective);
      'replace':   height = mix(height, layerHeight, effective);
      'max':       height = mix(height, max(height, layerHeight), effective);
      'min':       height = mix(height, min(height, layerHeight), effective);
    
    // Update erosion mask
    if (!layer.erodable):
      erosion_mask *= (1.0 - effective);
  
  output[pixel] = height;
  erosion_output[pixel] = erosion_mask;
```

### Oriented Rectangle SDF (Bounds)

For feathered spatial masking:

```wgsl
fn computeOrientedRectMask(worldXZ: vec2f, bounds: LayerBounds) -> f32 {
  // Transform to layer-local space
  let cosR = cos(bounds.rotation);
  let sinR = sin(bounds.rotation);
  let offset = worldXZ - vec2f(bounds.centerX, bounds.centerZ);
  let local = vec2f(
    offset.x * cosR + offset.y * sinR,
    -offset.x * sinR + offset.y * cosR
  );
  
  // Box SDF
  let d = abs(local) - vec2f(bounds.halfExtentX, bounds.halfExtentZ);
  let outside = length(max(d, vec2f(0.0)));
  
  // Feathered falloff
  return 1.0 - smoothstep(0.0, bounds.featherWidth, outside);
}
```

---

## Revised Generation Pipeline

```
1. Generate base heightmap (existing warped fBm via HeightmapGenerator)
2. For each enabled layer (sorted by order):
   → Generate layer heightmap (noise/rock/island/flatten)
   → Cache in layerHeightmaps Map<string, UnifiedGPUTexture>
3. Compositor pass (GPU compute — TerrainLayerCompositor):
   → Blend all layer heightmaps onto base heightmap
   → Output: composited heightmap + erosion mask
4. Erosion pass (existing hydraulic + thermal via ErosionSimulator):
   → Input: composited heightmap + erosion mask
   → Erosion mask modulates erosion/deposition per-texel
5. Normal map generation
6. Heightmap mipmap generation
7. CPU heightfield readback (for collision)
8. Vegetation system reconnection
```

**Caching strategy**: Individual layer heightmaps are cached. When a single layer changes, only that layer's heightmap is regenerated, then the compositor re-runs. This avoids regenerating all layers.

---

## Bounds Visualization & Editing

### LayerBoundsGizmo
A new gizmo class for viewport manipulation:
- Rectangular outline projected onto terrain surface (Y from heightmap sampling)
- Corner handles for resize (4 corners)
- Edge midpoint handles for single-axis resize
- Rotation handle (arc at one edge)
- Semi-transparent fill showing feathered falloff region
- Color-coded per selected layer

### Viewport Integration
- When a layer is selected in TerrainPanel, bounds gizmo appears on terrain
- Bounds data stored as 2D XZ coordinates (rect is projected onto terrain for display only)
- Reuses existing gizmo patterns (BaseGizmo, GizmoRendererGPU, TransformGizmoManager)

---

## Implementation Phases

### Phase 1 — Core Layer Types & Compositing (Engine) ✅ COMPLETE
- [x] Define `TerrainLayer` and related types in `src/core/terrain/types.ts`
- [x] Create `TerrainLayerCompositor` class (`src/core/terrain/TerrainLayerCompositor.ts`)
- [x] Create `terrain-layer-composite.wgsl` compute shader
- [x] Create `terrain-rock-layer.wgsl` compute shader for rock stepping
- [x] Add layer management methods to `TerrainManager`
- [x] Update `TerrainManager.generateWithLayers()` pipeline
- [x] Modular `ITerrainLayerGenerator` interface with pluggable generators
- [x] Four built-in generators: Noise, Rock, Island, Flatten (in `src/core/terrain/layers/`)
- [x] Heightmap normalization (min/max reduction + three-tier remap to [-0.5, 0.5])
- [x] Register new shaders in ShaderLoader
- [ ] Erosion mask integration in ErosionSimulator (deferred — mask texture is generated, shader sampling TBD)
- [ ] Island mask refactor from render-time to generation-time (deferred to Phase 4)

### Phase 2 — Bounds System (Engine + Gizmo)
- [x] Implement oriented-rect SDF with feathering in compositor shader (done in Phase 1 — `terrain-layer-composite.wgsl`)
- [x] Create `LayerBoundsGizmo` class (`src/demos/sceneBuilder/gizmos/LayerBoundsGizmo.ts`)
- [x] Wire up bounds visualization to renderer (dynamic lines/triangles in `GizmoRendererGPU`)
- [x] Integrate with `TransformGizmoManager` (rendering, input, Layer Bounds API)

### Phase 3 — UI Integration (React/SceneBuilder) ✅ COMPLETE
- [x] Layer list panel with ordering, visibility, blend controls (`LayersSection.tsx`)
- [x] Per-layer param editors (rock, flatten — noise uses existing NoiseSection)
- [x] Bounds editing UI connecting to `LayerBoundsGizmo` (numeric fields + bounds toggle)
- [x] Integrated into `TerrainPanel` via `layersProps` optional prop
- [x] Update `TerrainPanelBridge` to expose layer API (state, handlers, layersProps wiring)

### Phase 4 — Polish & Migration (In Progress)
- [x] Erosion mask integration in hydraulic erosion shader (`@binding(6)` erosionMaskTex)
- [x] ErosionSimulator: bind group layout, 1x1 white placeholder, `setErosionMask()`, all bind groups updated
- [ ] Deprecate old `IslandConfig` / island mask methods (JSDoc annotations added, full removal deferred)
- [ ] Remove render-time island blending from CDLOD shader (deferred — requires uniform struct + bind group changes)
- [ ] Scene serialization support for layers
- [ ] Performance profiling and optimization

---

## Implementation Notes

### Modular Generator Architecture (Implemented)

Layer generators follow the `ITerrainLayerGenerator` interface pattern. Each layer type is a self-contained module in `src/core/terrain/layers/` that owns its GPU pipelines and knows how to produce a heightmap. The compositor is completely layer-type-agnostic — it delegates to registered generators via a registry.

**To add a new layer type:**
1. Create `src/core/terrain/layers/MyLayerGenerator.ts` implementing `ITerrainLayerGenerator`
2. Add the new type to `TerrainLayerType` in `types.ts`
3. Register it: `compositor.registerGenerator(new MyLayerGenerator(...))`

No changes needed to the compositor or blend shader.

### Heightmap Normalization (Implemented)

After layer compositing, the heightmap may exceed the expected [-0.5, 0.5] range (e.g., multiple additive layers). A two-pass GPU normalization ensures the output stays in range:

1. **Pass 1 (reduceMinMax)**: Parallel workgroup reduction finds per-tile min/max
2. **Pass 2 (normalize)**: Three-tier strategy based on global min/max:
   - **Already in range** (min ≥ -0.5, max ≤ 0.5): Pass through unchanged — zero detail loss
   - **Range fits but shifted** (range ≤ 1.0): Translate only (subtract midpoint) — zero detail loss, preserves all relative heights
   - **Range exceeds 1.0**: Full rescale to [-0.5, 0.5] — only when unavoidable

This preserves rock layer detail (subtle stepped variations) in the common case, only compressing when the total range genuinely can't fit.

### Per-Layer Height Scale Convention

All layer height params are **normalized** (fraction of the global `heightScale`), not world units. The global `heightScale` is applied at render time in the CDLOD shader: `worldHeight = normalizedHeight * heightScale`.

**Implications:**
- A rock layer `heightScale` of 0.08 means 8% of terrain height (10m on a 125m terrain)
- Changing global `heightScale` proportionally affects all layers
- The UI layer (Phase 3) should convert world units ↔ normalized for display: `displayHeight = normalizedValue * terrainManager.config.heightScale`

This matches the existing convention used by the base noise generator, erosion, biome mask, and vegetation systems.

### Erosion Mask Status

The erosion mask texture is **generated** by the compositor (1.0 = erodable, 0.0 = protected by non-erodable layers like rock). However, the `ErosionSimulator` shader doesn't yet **sample** this mask — erosion runs uniformly. Integrating the mask into the hydraulic/thermal erosion shaders is deferred. The mask is stored and accessible via `compositor.getErosionMask()` and `terrainManager.getErosionMask()`.

---

## Files to Create/Modify

### New Files
- `src/core/terrain/TerrainLayerCompositor.ts` — Layer compositing pipeline
- `src/core/gpu/shaders/terrain/terrain-layer-composite.wgsl` — Compositor compute shader
- `src/core/gpu/shaders/terrain/terrain-rock-layer.wgsl` — Rock layer compute shader
- `src/demos/sceneBuilder/gizmos/LayerBoundsGizmo.ts` — Bounds editing gizmo
- `src/demos/sceneBuilder/components/panels/TerrainPanel/LayersSection.tsx` — Layers UI panel

### Modified Files
- `src/core/terrain/types.ts` — Add layer types
- `src/core/terrain/TerrainManager.ts` — Layer management + pipeline integration
- `src/core/terrain/ErosionSimulator.ts` — Erosion mask support
- `src/core/gpu/shaders/terrain/hydraulic-erosion.wgsl` — Erosion mask sampling
- `src/core/gpu/shaders/terrain/thermal-erosion.wgsl` — Erosion mask sampling
- `src/core/terrain/HeightmapGenerator.ts` — Island layer refactor
- `src/core/gpu/ShaderLoader.ts` — Register new shaders
- `src/demos/sceneBuilder/components/bridges/TerrainPanelBridge.tsx` — Expose layer API
