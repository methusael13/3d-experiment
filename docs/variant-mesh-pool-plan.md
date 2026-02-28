# VariantMeshPool — Composition-Native GPU Resource Manager

## Motivation

The current architecture has a fundamental tension: `ShaderComposer` owns binding index assignment for Group 2 (textures), but `ObjectRendererGPU` owns the actual GPU resources and creates bind groups with a hardcoded 10-slot layout (bindings 0-9 for PBR textures). When features like `reflection-probe` add extra texture resources to Group 2, the VariantRenderer must reconstruct bind groups by reaching into ObjectRendererGPU's internal mesh data via `getMeshTextureEntries()` — a fragile bridge that breaks when binding indices shift due to feature resolution order.

The solution: a new `VariantMeshPool` that is native to the shader composition system, stores textures by canonical resource name (not positional index), and builds Group 2 bind groups dynamically from the composed shader's `bindingLayout` metadata.

## Architecture Overview

```
┌─────────────────────┐     ┌──────────────────────────┐
│   ObjectRendererGPU  │     │     VariantMeshPool       │
│   (Legacy Path)      │     │  (Composition-Native)     │
├─────────────────────┤     ├──────────────────────────┤
│ • object.wgsl shader │     │ • Named texture storage   │
│ • Hardcoded 10-slot  │     │ • Dynamic bind group from │
│   Group 2 layout     │     │   ComposedShader metadata │
│ • Own pipelines      │     │ • No shader/pipeline deps │
│ • Shadow pass        │     │ • Used by VariantRenderer │
│ • Selection mask     │     │   and VariantPipelineMgr  │
├─────────────────────┤     ├──────────────────────────┤
│ CONSUMERS:           │     │ CONSUMERS:                │
│ • BillboardBaker     │     │ • VariantRenderer (color) │
│ • ReflectionProbe    │     │ • VariantRenderer (depth) │
│   CaptureRenderer    │     │ • ShadowPass (composed)   │
│ • Monolithic opaque  │     │ • OpaquePass (composed)   │
│   path (fallback)    │     │                           │
│ • Vegetation system  │     │                           │
│ • Selection mask/    │     │                           │
│   outline pass       │     │                           │
└─────────────────────┘     └──────────────────────────┘
         ▲                            ▲
         │                            │
    ┌────┴────────────────────────────┴───┐
    │        MeshComponent /              │
    │    PrimitiveGeometryComponent       │
    │  (registers with BOTH during        │
    │   GPU init, using same mesh IDs)    │
    └─────────────────────────────────────┘
```

## VariantMeshPool API

```typescript
// src/core/gpu/pipeline/VariantMeshPool.ts

interface VariantMeshEntry {
  id: number;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  
  // Group 1 resources (shared with ObjectRendererGPU)
  modelBuffer: GPUBuffer;       // mat4x4f model matrix
  materialBuffer: GPUBuffer;    // MaterialUniforms (96 bytes base + feature uniforms)
  modelBindGroup: GPUBindGroup; // Group 1: model + material
  
  // Named texture resources — keyed by canonical RES names
  // e.g., { 'baseColorTexture': view, 'baseColorSampler': sampler, ... }
  textureResources: Map<string, GPUBindingResource>;
  
  // Draw parameters
  doubleSided: boolean;
}

class VariantMeshPool {
  constructor(ctx: GPUContext);
  
  // ---- Mesh lifecycle ----
  addMesh(data: GPUMeshData): number;
  removeMesh(id: number): void;
  hasMesh(id: number): boolean;
  
  // ---- Transform / Material ----
  setTransform(id: number, matrix: mat4 | Float32Array): void;
  setMaterial(id: number, material: Partial<GPUMaterial>): void;
  writeExtraUniforms(id: number, data: Float32Array, byteOffset: number): void;
  getMaterial(id: number): GPUMaterial | null;
  
  // ---- Named texture resources ----
  // Sets individual texture resources by canonical name
  setTextureResource(meshId: number, name: string, resource: GPUBindingResource): void;
  // Bulk-set PBR textures (convenience wrapper)
  setPBRTextures(meshId: number, textures: GPUMaterialTextures): void;
  // Clear a named resource
  clearTextureResource(meshId: number, name: string): void;
  
  // ---- Bind group construction (composition-native) ----
  // Builds Group 2 bind group dynamically from composed shader's bindingLayout
  buildTextureBindGroup(
    meshId: number,
    composedShader: ComposedShader,
    layout: GPUBindGroupLayout,
  ): GPUBindGroup;
  
  // ---- Shared accessors for VariantRenderer ----
  getModelBindGroup(meshId: number): GPUBindGroup | null;
  getVertexBuffer(meshId: number): GPUBuffer | null;
  getDrawParams(meshId: number): DrawParams | null;
  isDoubleSided(meshId: number): boolean;
  
  // ---- Global uniforms (Group 0) ----
  getGlobalBindGroupLayout(): GPUBindGroupLayout;
  getGlobalBindGroup(): GPUBindGroup;
  getModelBindGroupLayout(): GPUBindGroupLayout;
  writeGlobalUniforms(params: ObjectRenderParams): void;
  
  // ---- Empty bind group for unused slots ----
  getEmptyBindGroup(): { layout: GPUBindGroupLayout; bindGroup: GPUBindGroup };
  
  destroy(): void;
}
```

## Key Design: Dynamic Bind Group Construction

The critical method is `buildTextureBindGroup()`. It iterates the composed shader's `bindingLayout` map, looks up each resource by canonical name in the mesh's `textureResources` map, and falls back to placeholders:

```typescript
buildTextureBindGroup(
  meshId: number,
  composedShader: ComposedShader,
  layout: GPUBindGroupLayout,
): GPUBindGroup {
  const mesh = this.meshes.get(meshId);
  const entries: GPUBindGroupEntry[] = [];
  
  for (const [name, res] of composedShader.bindingLayout) {
    if (res.group !== 'textures') continue;
    
    // Look up by canonical resource name — order-independent!
    const resource = mesh?.textureResources.get(name) 
      ?? this.getPlaceholder(name, res);
    
    entries.push({ binding: res.bindingIndex, resource });
  }
  
  return device.createBindGroup({ layout, entries });
}
```

This completely eliminates binding order fragility — the ShaderComposer can assign any binding indices in any order, and the bind group will always match because resources are looked up by name.

## ObjectRendererGPU Consumers (Legacy Path — Kept As-Is)

These paths continue using ObjectRendererGPU unchanged:

| Consumer | Why it stays on ObjectRendererGPU |
|----------|----------------------------------|
| `BillboardBaker` | Creates its own temporary ObjectRendererGPU instance for baking |
| `ReflectionProbeCaptureRenderer` | Uses VariantRenderer which needs mesh data; will migrate alongside VariantRenderer |
| `OpaquePass` (monolithic path, `useComposedShaders=false`) | Fallback path using `object.wgsl` directly |
| `ShadowPass` (legacy path) | `renderShadowPass()` with dynamic uniform buffer |
| `SelectionMaskPass` | Uses ObjectRendererGPU's dedicated selection pipeline |
| `SelectionOutlinePass` | Reads mask from ObjectRendererGPU |
| Vegetation `VegetationMeshRenderer` | Does not use composed shaders |
| `PrimitiveObject` (legacy SceneObject) | Direct ObjectRendererGPU calls |
| `ModelObject` (legacy SceneObject) | Direct ObjectRendererGPU calls |

## Migration: ECS Components

### MeshComponent
Currently calls `ctx.objectRenderer.addMesh()`. After migration:
1. **Still calls** `ctx.objectRenderer.addMesh()` — for legacy path compatibility
2. **Also calls** `ctx.variantMeshPool.addMesh()` — with same mesh data
3. When textures are loaded, calls `variantMeshPool.setPBRTextures(meshId, textures)` to store named resources
4. The mesh ID should be the same for both pools (VariantMeshPool accepts the ObjectRendererGPU mesh ID)

### PrimitiveGeometryComponent  
Same dual-registration pattern. Primitives rarely have textures, so the textureResources map is mostly empty.

### ReflectionProbeComponent
Instead of being a special case in VariantRenderer, probes just register their cubemap/sampler by name:
```typescript
// After bake completes:
variantMeshPool.setTextureResource(meshId, RES.REFLECTION_PROBE_CUBEMAP, probe.cubemapView);
variantMeshPool.setTextureResource(meshId, RES.REFLECTION_PROBE_SAMPLER, probe.cubemapSampler);
```

## Migration: VariantRenderer Changes

### Before (current)
```typescript
class VariantRenderer {
  constructor(objectRenderer: ObjectRendererGPU) { ... }
  
  // Gets mesh data from ObjectRendererGPU
  const meshData = this.objectRenderer.getMeshRenderData(meshId);
  
  // Builds bind groups by reaching into ObjectRendererGPU internals
  const pbrEntries = this.objectRenderer.getMeshTextureEntries(meshData.id);
}
```

### After
```typescript
class VariantRenderer {
  constructor(meshPool: VariantMeshPool) { ... }
  
  // Gets mesh data from VariantMeshPool
  const drawParams = this.meshPool.getDrawParams(meshId);
  const modelBG = this.meshPool.getModelBindGroup(meshId);
  
  // Builds bind groups natively from composed shader
  const texBG = this.meshPool.buildTextureBindGroup(meshId, entry.composed, entry.textureBindGroupLayout);
  // ^ No special cases for probe, SSR, etc. — they're all just named resources
}
```

## Migration: VariantPipelineManager Changes

### Before
```typescript
constructor(
  ctx: GPUContext,
  globalBindGroupLayout: GPUBindGroupLayout,    // from ObjectRendererGPU
  modelBindGroupLayout: GPUBindGroupLayout,     // from ObjectRendererGPU
  existingTextureBindGroupLayout: GPUBindGroupLayout,  // from ObjectRendererGPU
)
```

### After
```typescript
constructor(
  ctx: GPUContext,
  meshPool: VariantMeshPool,  // owns all layouts
)
// Gets layouts from meshPool.getGlobalBindGroupLayout(), etc.
// For Group 2, ALWAYS builds from composed shader's bindingLayout — no "existing" layout reuse
```

## Implementation Steps

### Phase 1: Create VariantMeshPool (new file)
1. Create `src/core/gpu/pipeline/VariantMeshPool.ts`
2. Implement mesh storage with named texture resources
3. Implement `buildTextureBindGroup()` with placeholder fallback
4. Implement global uniform buffer (same layout as ObjectRendererGPU's Group 0)
5. Implement model+material bind group (same layout as ObjectRendererGPU's Group 1)

### Phase 2: Dual Registration in ECS Components
1. Add `VariantMeshPool` reference to `GPUContext` (alongside objectRenderer)
2. Update `MeshComponent.initGPU()` to register with both ObjectRendererGPU and VariantMeshPool
3. Update `PrimitiveGeometryComponent.initGPU()` similarly
4. Update texture setting paths to also call `variantMeshPool.setPBRTextures()`
5. Update transform updates to write to both pools

### Phase 3: Migrate VariantRenderer
1. Change constructor from `(objectRenderer)` to `(meshPool)`
2. Replace all `objectRenderer.getMeshRenderData()` calls with meshPool equivalents
3. Replace `getOrCreateProbeBindGroup()` with `meshPool.buildTextureBindGroup()`
4. Remove all special-case probe/texture bind group construction
5. Remove `getMeshTextureEntries()` and `getMeshTextureResource()` methods

### Phase 4: Migrate VariantPipelineManager
1. Change constructor to take `VariantMeshPool`
2. For Group 2, always build layout from `buildTextureBindGroupLayout()` — remove `existingTextureBindGroupLayout` reuse hack
3. Remove `hasReflectionProbe` flag — no longer needed

### Phase 5: Probe Integration
1. Update `ReflectionProbeSystem` / bake flow to set probe textures by name on VariantMeshPool
2. Remove `'textured'` from reflectionProbeFeature dependencies (no longer needed for binding order)
3. Remove `getOrCreateProbeBindGroup()` entirely from VariantRenderer

### Phase 6: Cleanup
1. Remove `getMeshTextureEntries()` from ObjectRendererGPU (was only used by VariantRenderer)
2. Remove probe-related helpers from VariantRenderer
3. ObjectRendererGPU becomes pure legacy — used only by non-composed paths
4. Update documentation

## What Does NOT Change
- `ObjectRendererGPU` — stays exactly as-is for legacy consumers
- `SceneEnvironment` — Group 3 management unchanged
- `ShaderComposer` — same binding index assignment, but now it doesn't matter what order
- `object.wgsl` — legacy monolithic shader unchanged
- `object-template.wgsl` — same injection markers
- All vegetation renderers — still use ObjectRendererGPU directly
- Selection mask/outline — still use ObjectRendererGPU
- BillboardBaker — still creates its own ObjectRendererGPU
- Shadow pass legacy path — still uses ObjectRendererGPU.renderShadowPass()