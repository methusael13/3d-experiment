# Shadow Resource Consolidation Plan

## Problem Statement

Shadow rendering GPU resources are duplicated across three independent rendering systems, each maintaining its own:
- Dynamic uniform buffer for light-space matrices
- Bind group layout and bind group
- Shadow render pipeline
- `writeShadowMatrices()` / `prepareShadowPasses()` methods

### Current Resource Owners

| System | File | Uniform Buffer | Layout | Data Per Slot |
|--------|------|---------------|--------|---------------|
| **ObjectRendererGPU** | `src/core/gpu/renderers/ObjectRendererGPU.ts` | `shadowUniformBuffer` (21 slots × 256B) | `shadowBindGroupLayout` + `shadowModelBindGroupLayout` | mat4 (64 bytes) |
| **CDLODRendererGPU** | `src/core/terrain/CDLODRendererGPU.ts` | `shadowUniformBuffer` (own MAX_SHADOW_SLOTS × 256B) | `shadowBindGroupLayout` | mat4 + terrain params (96 bytes) |
| **VegetationMeshRenderer** | `src/core/vegetation/VegetationMeshRenderer.ts` | `shadowUniformsBuffer` | `shadowBindGroupLayout` | mat4 + instance data |

The **ShadowPass** orchestrator (`src/core/gpu/pipeline/passes/ShadowPass.ts`) must coordinate writes to each system's buffer separately. This led to the viewport/resolution mismatch bug (fixed in c93f828) and makes adding new shadow types (point light cubemaps) increasingly fragile.

**SceneEnvironment** (`src/core/gpu/renderers/shared/SceneEnvironment.ts`) is a separate concern — it manages the color-pass (shadow receiving) bind group (Group 3) by referencing shadow textures from `ShadowRendererGPU`. This role remains unchanged.

## Design Decision

**Expand `ShadowRendererGPU`** to be the single owner of all shadow GPU resources for both depth rendering and texture management. No new `ShadowResourceManager` class.

**Approach: Option (a) — Split bind groups per renderer.** Each renderer's shadow pipeline uses:
- **Group 0**: Shared light-space matrix from `ShadowRendererGPU` (dynamic offset)
- **Group 1+**: Renderer-specific data (model matrix, terrain params, instance buffer, etc.)

## Architecture After Consolidation

```
ShadowRendererGPU (expanded — single source of truth)
├── Texture Resources (existing, unchanged)
│   ├── Directional shadow map (single depth texture)
│   ├── CSM cascade array (depth texture array)
│   ├── Spot shadow atlas (depth 2d-array, per-light layers)
│   └── (Future: point shadow cubemap array)
│
├── Light Matrix Computation (existing, unchanged)
│   ├── Directional / CSM matrices
│   ├── Spot shadow matrices (per atlas layer)
│   └── (Future: point shadow face matrices)
│
├── Shared Depth-Pass Resources (NEW — moved from ObjectRendererGPU)
│   ├── shadowUniformBuffer: GPUBuffer (dynamic, 256-byte aligned slots)
│   ├── shadowBindGroupLayout: GPUBindGroupLayout (binding 0 = mat4, hasDynamicOffset)
│   ├── shadowBindGroup: GPUBindGroup
│   ├── writeShadowMatrices(matrices): void
│   ├── writeShadowMatricesAt(startSlot, matrices): void
│   └── Constants: SHADOW_SLOT_SIZE, DIRECTIONAL_SHADOW_SLOTS, MAX_SHADOW_SLOTS
│
├── Slot/Atlas Management (existing, unchanged)
│   ├── allocateShadowSlot() / freeShadowSlot()
│   ├── resizeSpotShadowAtlas()
│   └── getSpotShadowAtlasResolution()
│
└── Config (existing, unchanged)
    ├── resolution, shadowRadius, bias, PCF, CSM settings
    └── spotShadowAtlasResolution (per-light, driven by LightComponent)

SceneEnvironment (unchanged role)
├── References ShadowRendererGPU textures for color-pass sampling
├── Group 3 bind group: shadow map views + IBL + lights + spot atlas
└── Purely a consumer — does NOT own shadow resources
```

## Slot Layout (Dynamic Uniform Buffer)

```
Slot 0-3:  CSM cascade matrices (directional light)
Slot 4:    Single directional shadow map matrix
Slot 5-20: Spot light matrices (up to 16 spot lights)
Slot 21+:  (Future) Point light cubemap face matrices (6 per point light)
```

Each slot = 256 bytes (WebGPU `minUniformBufferOffsetAlignment`).
Only the first 64 bytes (1 mat4) of each slot are used; the remaining 192 bytes are padding.

## Migration Plan

### Phase 1: Add shared resources to ShadowRendererGPU

**File:** `src/core/gpu/renderers/ShadowRendererGPU.ts`

Add:
- `shadowUniformBuffer` — the shared dynamic buffer (moved from ObjectRendererGPU)
- `shadowBindGroupLayout` — bind group layout with `hasDynamicOffset: true`
- `shadowBindGroup` — bind group referencing the buffer
- `writeShadowMatrices()` / `writeShadowMatricesAt()` — matrix write methods
- `getShadowBindGroupLayout()` — for pipeline creation by other renderers
- `getShadowBindGroup()` — for `setBindGroup()` calls during depth passes
- Slot constants as static readonly members

### Phase 2: Migrate ObjectRendererGPU

**File:** `src/core/gpu/renderers/ObjectRendererGPU.ts`

Remove:
- `shadowUniformBuffer`, `shadowBindGroup`, `shadowBindGroupLayout`
- `writeShadowMatrices()`, `writeShadowMatricesAt()`
- `SHADOW_SLOT_SIZE`, `DIRECTIONAL_SHADOW_SLOTS`, `MAX_SHADOW_SLOTS`

Keep:
- `shadowPipeline` (object-shadow.wgsl — vertex shader uses model matrix)
- `shadowModelBindGroupLayout` (Group 1 for per-mesh model matrix)

Update:
- `createShadowPipeline()`: use `shadowRenderer.getShadowBindGroupLayout()` for Group 0
- `renderShadowPass(passEncoder, slotIndex, ...)`: accept `shadowBindGroup` from ShadowRendererGPU
  - `setBindGroup(0, shadowRenderer.getShadowBindGroup(), [slotIndex * 256])`
  - `setBindGroup(1, meshModelBindGroup)` (existing per-mesh Group 1)

**Shader:** `object-shadow.wgsl` — no change needed (already reads mat4 from Group 0 binding 0)

### Phase 3: Migrate VegetationMeshRenderer

**File:** `src/core/vegetation/VegetationMeshRenderer.ts`

Remove:
- `shadowUniformsBuffer`, `shadowBindGroupLayout`

Keep:
- `shadowPipeline` (vegetation-mesh-depth.wgsl — vertex shader uses instance transforms)

Update:
- Shadow pipeline: Group 0 = shared mat4, Group 1 = vegetation instance data
- `renderShadowPass()`: use shared bind group for Group 0

**Shader:** `vegetation-mesh-depth.wgsl`
- Split current single bind group into:
  - `@group(0) @binding(0) var<uniform> shadow: ShadowUniforms;` (mat4 from shared buffer)
  - `@group(1) @binding(0) ...` (vegetation instance buffer, mesh transform, etc.)

### Phase 4: Migrate CDLODRendererGPU

**File:** `src/core/terrain/CDLODRendererGPU.ts`

This is the most complex migration because the terrain shadow uniform packs more than a mat4 — it includes heightmap scale, offset, and other terrain-specific parameters alongside the light-space matrix.

Remove:
- `shadowUniformBuffer`, `shadowBindGroup`, `shadowBindGroupLayout`

Keep:
- `shadowPipeline` (CDLOD shadow shader)

Update:
- Shadow pipeline: Group 0 = shared mat4 (dynamic offset), Group 1 = terrain params + heightmap
- Create a new `terrainShadowParamsBuffer` for the terrain-specific data
- `renderShadowPass()`: 
  - `setBindGroup(0, shadowRenderer.getShadowBindGroup(), [dynamicOffset])`
  - `setBindGroup(1, terrainShadowBindGroup)` (heightmap + terrain params, per-pass data)

**Shader:** `cdlod-shadow.wgsl` (or equivalent)
- Split current uniforms:
  - `@group(0) @binding(0) var<uniform> shadow: ShadowUniforms;` → just mat4 from shared buffer
  - `@group(1) @binding(0) var<uniform> terrain: TerrainShadowParams;` → heightmap scale/offset/params
  - `@group(1) @binding(1) var heightmap: texture_2d<f32>;` → heightmap texture

### Phase 5: Update ShadowPass Orchestrator

**File:** `src/core/gpu/pipeline/passes/ShadowPass.ts`

Update:
- Instead of `this.objectRenderer.writeShadowMatrices(...)`, call `this.shadowRenderer.writeShadowMatrices(...)`
- Instead of `this.objectRenderer.writeShadowMatricesAt(...)`, call `this.shadowRenderer.writeShadowMatricesAt(...)`
- Pass the shared resources to each renderer's shadow pass call

## Files Affected

### Core changes:
1. `src/core/gpu/renderers/ShadowRendererGPU.ts` — add shared buffer/layout/bind group
2. `src/core/gpu/renderers/ObjectRendererGPU.ts` — remove shadow buffer, use shared
3. `src/core/terrain/CDLODRendererGPU.ts` — remove shadow buffer, split bind groups
4. `src/core/vegetation/VegetationMeshRenderer.ts` — remove shadow buffer, split bind groups
5. `src/core/gpu/pipeline/passes/ShadowPass.ts` — use ShadowRendererGPU for matrix writes

### Shader changes:
6. `src/core/gpu/shaders/object-shadow.wgsl` — likely no change
7. `src/core/gpu/shaders/terrain/cdlod-shadow.wgsl` — split into Group 0 + Group 1
8. `src/core/gpu/shaders/vegetation/vegetation-mesh-depth.wgsl` — split into Group 0 + Group 1

### Unchanged:
- `SceneEnvironment` — continues to reference shadow textures for color-pass sampling
- `LightBufferManager` — continues to pack spot shadow matrices for fragment shader
- `LightingSystem` — continues to manage slot allocation and matrix computation
- Fragment shaders (`shadow-csm.wgsl`, `lights.wgsl`, `pbr.wgsl`) — no change

## Benefits

1. **Single source of truth** for shadow uniform buffer — eliminates sync bugs
2. **Easier to add new shadow types** (point light cubemaps) — just allocate more slots
3. **Consistent slot numbering** across all renderers — no per-renderer slot definitions
4. **Simplified ShadowPass** — one `writeShadowMatrices()` call instead of per-renderer writes
5. **Memory savings** — one buffer instead of three

## Risks

- Each renderer's shadow pipeline now has 2 bind groups instead of 1 — minor perf overhead from extra `setBindGroup()` call per render pass
- CDLODRendererGPU shader split requires careful testing of terrain shadow rendering
- Vegetation shadow shader split needs to maintain instance buffer access patterns

## Future: Point Light Cubemap Shadows

After this consolidation, adding point light shadows becomes straightforward:
1. Allocate slots 21-44 (4 point lights × 6 faces) in the shared buffer
2. Create a new point shadow cubemap array texture in `ShadowRendererGPU`
3. `ShadowPass` renders 6 face passes per point light using the shared buffer
4. Each renderer's existing shadow pipeline works unchanged — just different mat4 per face
5. Fragment shader samples the cubemap using light-to-fragment direction vector