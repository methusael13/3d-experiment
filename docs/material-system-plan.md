# Material System Design Plan

## Overview

A central material system for the Pyro Engine that enables creating, editing, and registering reusable PBR materials through a visual node-based editor. Materials are stored in a central registry and can be referenced by any system (terrain biomes, objects, vegetation).

## Architecture

### Top-Level UI Changes

The MenuBar is restructured with a tab system:

```
[Pyro Engine] [File][Edit][View][Add]     [Editor] [Materials]     [42 FPS] [128 DC]
```

- **Editor tab** (default): Current view with sidebars + viewport + asset library
- **Materials tab**: Material browser (left) + node editor (center)

### Core Systems

#### 1. MaterialRegistry (`src/core/materials/MaterialRegistry.ts`)

Singleton registry storing all named materials. Systems reference materials by ID.

**MaterialDefinition** properties:
- `id: string` — UUID
- `name: string` — User-facing name
- `albedo`, `metallic`, `roughness`, `normalScale`, `occlusionStrength` — PBR scalar properties
- `emissiveFactor`, `ior`, `clearcoatFactor`, `clearcoatRoughness`, `alphaCutoff`
- `textures` — Map of texture slot → MaterialTextureRef (asset path, procedural params, or solid color)
- `nodeGraph` — Serialized node graph for the editor
- `tags: string[]` — For search/filtering
- `createdAt`, `updatedAt` — Timestamps

**MaterialTextureRef**:
- `type: 'asset' | 'procedural' | 'color'`
- `assetId?`, `assetPath?` — For asset-backed textures
- `proceduralParams?` — For procedural generation
- `color?` — For solid color fill

#### 2. Node Types

| Node | Inputs | Outputs | Purpose |
|------|--------|---------|---------|
| **PBR** | albedo, metallic, roughness, metallicRoughness, normal, occlusion, emissive, ior, clearcoat, clearcoatRoughness | material | Central material definition |
| **Texture Set** | — (picks from asset library) | albedo, normal, roughness, ao, displacement, specular, etc. | Multi-output from Quixel/PolyHaven texture packs |
| **Color** | — | color (RGB) | Solid color picker |
| **Number** | — | value (float) | Scalar value with slider |
| **Preview** | material | — | 2D material preview |

#### 3. Texture Set Node

When user clicks "Browse" on a Texture Set node:
1. Opens `AssetPickerModal` filtered to `type: texture`
2. Returns full `Asset` with `asset.files[]` containing texture maps
3. Node scans `asset.files` and creates dynamic output handles for each available `fileSubType`
4. Outputs appear as: `Albedo ●`, `Normal ●`, `Roughness ●`, `AO ●`, etc.
5. Each output can be individually connected to PBR Node inputs

#### 4. Pre-packed Texture Handling (metallicRoughness)

Quixel MegaScans and glTF assets often ship a single pre-packed `metallicRoughness` texture where G=roughness and B=metallic. The shader samples this as one texture (`textureFlags.z > 0.5` activates packed MR sampling in `object-template.wgsl`).

**PBR Node has three related inputs:**
- `metallic` (float) — Scalar metalness, controlled by inline slider or Number node
- `roughness` (float) — Scalar roughness, controlled by inline slider or Number node  
- `metallicRoughness` (texture) — Pre-packed MR texture, accepts Texture Set output only

**Behavior:**
- If `metallicRoughness` is connected, it takes priority over individual `metallic`/`roughness` values
- The shader reads G channel as roughness and B channel as metallic from the packed texture
- Individual `metallic`/`roughness` sliders are disabled when `metallicRoughness` is connected
- If only `metallic` or `roughness` is connected separately (from Number or Texture Set), the other remains as a scalar
- The Channel Pack node (Phase 4b) can create a packed MR texture from two separate maps if needed

**Connection guardrails:**
- `metallicRoughness` input only accepts Texture Set outputs (it's a packed texture, not a scalar)
- When `metallicRoughness` is connected, `metallic` and `roughness` inputs show "overridden" status

### Asset Indexer Fix

The following patterns are missing from `TextureTypeValues` in `server/types/index.ts`:

| Pattern | Maps To | Source |
|---------|---------|--------|
| `_diff` | albedo | PolyHaven naming |
| `diffuse` | albedo | Standard naming |
| `_col_` | albedo | Common abbreviation |
| `_nor_` | normal | PolyHaven naming |
| `_nrm` | normal | Some tools |
| `_arm` | ao | ARM packed texture |

## Implementation Phases

### Phase 1: Foundation
- Material Registry (types, class, presets)
- Tab Bar UI + MenuBar layout changes
- SceneBuilderApp tab switching

### Phase 2: Node Editor
- Install `@xyflow/react` (works with preact/compat)
- MaterialEditorView layout
- Node Editor canvas (React Flow, dark theme)
- All node types (PBR, Texture Set, Color, Number, Preview)
- Graph ↔ Registry sync

### Phase 3: Material Browser
- Material list panel (search, CRUD)
- Built-in material presets (plastic, metal, gold, etc.)

### Phase 4: 3D Material Preview
The current Preview Node uses a CSS radial-gradient sphere, which approximates light interaction for scalar PBR properties (albedo color, metallic, roughness) but cannot render actual textures. This phase upgrades it to a GPU-rendered preview.

- Create a small offscreen WebGPU render target (256×256) per Preview node
- Reuse the existing `VariantRenderer` pipeline with a single sphere mesh
- Compose a material from the PBR node's resolved properties + texture references
- Load referenced texture files via `MaterialGPUCache` (shared, reference-counted)
- Render the sphere with full PBR lighting (single directional + IBL diffuse)
- Copy the render target to a canvas element inside the Preview node
- Update on every PBR node data change (debounced at ~100ms)
- Support shape selector: sphere (default), cube, plane

**Texture propagation**: When a Texture Set node's albedo output is connected to PBR's albedo input, the GPU preview loads and samples the actual albedo texture on the sphere. Same for normal, roughness, etc.

### Phase 4b: Channel Pack Node
Some texture formats (e.g., glTF metallicRoughness) pack multiple channels into a single RGBA texture. The shader's `MaterialUniforms` uses `textureFlags.z` to detect packed metallicRoughness (G=roughness, B=metallic). A Channel Pack node enables this workflow visually.

**Channel Pack Node**:
- **Inputs**: Up to 4 single-channel sources (R, G, B, A) — accepts Number or Texture Set outputs
- **Output**: Single packed RGBA texture
- **GPU implementation**: Uses a compute shader or render pass to compose channels from source textures
  - Extends `ProceduralTextureGenerator.packMetallicRoughness()` to a generic N-channel packer
- **Use cases**:
  - Pack metallic + roughness into metallicRoughness (matches shader expectation)
  - Pack AO + roughness + metallic into ARM format
  - Custom channel packing for specialized shaders

**Node UI**:
```
┌─────────────────────┐
│ 🔀 CHANNEL PACK     │
├─────────────────────┤
│ • R Channel          │ → Packed ●
│ • G Channel          │
│ • B Channel          │
│ • A Channel          │
│                      │
│ Preset: [MR Pack ▾]  │
│ Preview: [■■■■]      │
└─────────────────────┘
```

Presets dropdown: "Metallic-Roughness", "ARM (AO+Rough+Metal)", "Custom"

### Phase 5: Terrain Integration
- Update TerrainBiomeTextureResources to accept material IDs from registry
- Update MaterialSection UI to show material picker dropdown (from registry) instead of individual texture pickers per biome
- Subscribe terrain to registry change events for live material updates
- Add full PBR shading support for terrains supporting all texture types from the material registry
- Add roughness/displacement support to terrain shader (extend `TEXTURE_TYPE_CONFIGS`)

### Phase 6: Object Integration  
- Migrate existing MaterialPanel to use MaterialRegistry
- Objects can reference registry materials or have inline overrides
- Existing per-entity procedural texture workflow preserved as a node type
  - Create a separate Procedural texture node that can be used as texture input for PBR node (uses existing ProceduralTextureGenerator)

## File Structure

```
src/core/materials/
  types.ts                    — MaterialDefinition, MaterialTextureRef
  MaterialRegistry.ts         — Central registry singleton
  presets.ts                  — Built-in material presets
  index.ts                    — Barrel exports

src/demos/sceneBuilder/components/
  layout/
    TabBar/
      TabBar.tsx              — Tab buttons (Editor, Materials)
      TabBar.module.css
  panels/
    MaterialEditorPanel/
      MaterialEditorView.tsx   — Full materials tab layout
      MaterialEditorView.module.css
      MaterialBrowser.tsx      — Left panel: material list
      MaterialBrowser.module.css
      MaterialNodeEditor.tsx   — Center panel: React Flow canvas
      MaterialNodeEditor.module.css
      nodes/
        PBRNode.tsx
        TextureSetNode.tsx
        ColorNode.tsx
        NumberNode.tsx
        PreviewNode.tsx
        nodeStyles.module.css
      nodeTypes.ts             — Node type definitions
      graphSerializer.ts       — Node graph ↔ MaterialDefinition sync
  bridges/
    MaterialEditorBridge.tsx   — Connects editor to store + registry
```
