# Vegetation Mesh → Variant Renderer Integration Plan

## Problem Statement

The vegetation system uses a **custom standalone shader** (`vegetation-mesh.wgsl`) with its own hardcoded lighting pipeline (hemisphere ambient + basic directional + CSM shadows + multi-light). This produces visually different results compared to the ECS-based **variant renderer** (`VariantPipelineManager` + `ShaderComposer` + composable features), which has proper PBR lighting, IBL, wetness, SSR, reflection probes, and other post-processing features.

When a user imports a mesh as vegetation, it renders with a noticeably different lighting model than the same mesh rendered as a regular ECS object. The goal is to unify vegetation mesh rendering with the variant renderer so vegetation meshes benefit from the full PBR pipeline.

## Architecture Comparison

### Current Vegetation Mesh Renderer
```
VegetationManager → VegetationRenderer → VegetationMeshRenderer
  - Custom vegetation-mesh.wgsl shader
  - Per-instance storage buffer (PlantInstance: position, scale, rotation, renderFlag)
  - GPU culling via VegetationCullingPipeline (compute shader)
  - drawIndexedIndirect from culled buffer
  - Hardcoded lighting: hemisphere ambient + directional + CSM + multi-light
  - No PBR (no metallic/roughness), no IBL, no SSR, no wetness
  - Wind: custom fbm2D wind in shader (per-instance, based on world pos + time)
  - Shadow casting via separate depth-only pipeline
```

### ECS Variant Renderer
```
MeshRenderSystem → VariantRenderer → VariantPipelineManager
  - Composable shader features (shadow, ibl, textured, wind, wetness, ssr, etc.)
  - Per-mesh model matrix + MaterialUniforms (Group 1 bind group)
  - Global ViewProjection + camera data (Group 0 bind group)
  - Per-variant texture bind group (Group 2)
  - Per-variant environment bind group (Group 3)
  - Full PBR pipeline (GGX BRDF, metallic/roughness workflow)
  - Wind: CPU-driven spring simulation (WindSystem) → per-object displacement uniforms
  - DrawIndexed (non-indirect, per-entity)
```

### Key Differences

| Aspect | Vegetation Mesh | Variant Renderer |
|--------|----------------|------------------|
| **Instancing** | GPU storage buffer, thousands of instances per draw | Per-entity draw calls (1 draw per mesh) |
| **Transform** | Instance buffer (pos+scale+rot) | Per-mesh model matrix (mat4x4f) |
| **Wind** | GPU-side (fbm noise in shader, per-vertex) | CPU-side spring simulation → uniform displacement |
| **Lighting** | Hardcoded hemisphere + directional | Full composable PBR + IBL + multi-light |
| **Culling** | GPU compute pass (frustum + distance + hybrid LOD) | CPU frustum culling (FrustumCullSystem) |
| **Draw method** | `drawIndexedIndirect` (GPU-driven) | `drawIndexed` (CPU-driven) |
| **Materials** | Single base color texture | Full PBR (albedo, normal, metallic-roughness, emissive) |

## Proposed Integration: `vegetationInstancingFeature`

### Approach: New Shader Feature for Instanced Vegetation

Rather than removing the vegetation instancing pipeline (which provides critical GPU culling and indirect draw performance for thousands of instances), we add a new **shader feature** `vegetation-instancing` that injects instance buffer reading + vegetation-specific wind into the variant shader composition system.

This lets vegetation meshes render through the **same PBR pipeline** as regular objects while keeping the **GPU culling + indirect draw** performance path.

### Phase 1: Create `vegetationInstancingFeature`

**New file:** `src/core/gpu/shaders/features/vegetationInstancingFeature.ts`

This feature:
1. Declares a `PlantInstance` storage buffer resource (Group 2 / textures group)
2. Declares vegetation-specific uniform resources (wind params, time, maxDistance)
3. Injects vertex code that:
   - Reads the instance buffer by `instance_index`
   - Applies Y-axis rotation + scale from instance data
   - Applies vegetation wind displacement (fbm2D-based, from `vegetation-mesh.wgsl`)
   - Skips instances with wrong renderFlag
4. Passes through to the standard PBR fragment pipeline (no fragment injection needed — the base shader handles PBR lighting)

**Resources declared:**
```typescript
resources: [
  // Instance storage buffer
  { name: 'vegInstances', kind: 'storage', group: 'textures', provider: 'VegetationComponent' },
  // Wind uniforms (per-draw dynamic)
  { name: 'vegWindStrength', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegWindFrequency', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegWindDirection', kind: 'uniform', wgslType: 'vec2f', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegGustStrength', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegGustFrequency', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegTime', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegMaxDistance', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
  { name: 'vegWindMultiplier', kind: 'uniform', wgslType: 'f32', group: 'perObject', provider: 'VegetationComponent' },
]
```

**Vertex injection:**
```wgsl
// Read instance data from storage buffer
let vegInstance = vegInstances[instance_index];
// Skip non-mesh instances
if (vegInstance.rotationAndType.z < 0.5) {
  output.position = vec4f(0.0);
  return output;
}
// Apply Y-axis rotation + scale + world offset
let vegScale = vegInstance.positionAndScale.w;
let vegRot = vegInstance.rotationAndType.x;
let cosR = cos(vegRot); let sinR = sin(vegRot);
localPos = vec3f(localPos.x * cosR - localPos.z * sinR, localPos.y, localPos.x * sinR + localPos.z * cosR) * vegScale;
// Override model matrix position with instance world position
let vegWorldBase = vegInstance.positionAndScale.xyz;
worldPos = vegWorldBase + localPos + vec3f(0.0, vegScale * 0.5, 0.0);
// Vegetation wind (fbm-based, replaces standard wind feature)
worldPos = applyVegMeshWind(worldPos, saturate(localPos.y * 2.0), material.vegWindMultiplier);
```

### Phase 2: Create `VegetationMeshVariantRenderer`

**New file:** `src/core/vegetation/VegetationMeshVariantRenderer.ts`

This replaces `VegetationMeshRenderer.renderIndirect()` with a variant-based path:

```typescript
class VegetationMeshVariantRenderer {
  /**
   * For each plant type with a mesh, creates a temporary VariantMeshPool entry
   * (or pool of reusable entries) that:
   * 1. Registers each submesh into the pool with proper PBR materials
   * 2. Sets the vegetation instance storage buffer as a texture-group resource
   * 3. Gets-or-creates a variant pipeline with features:
   *    ['vegetation-instancing', 'textured', 'shadow', 'ibl', 'multi-light']
   * 4. Issues drawIndexedIndirect using the culled draw args buffer
   */
  renderIndirect(
    passEncoder: GPURenderPassEncoder,
    mesh: VegetationMesh,
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    wind: WindParams,
    time: number,
    // ... environment state
  ): number;
}
```

**Key difference from standard VariantRenderer.renderColor():** Instead of `drawIndexed(indexCount, 1)`, it uses `drawIndexedIndirect(drawArgsBuffer, offset)` — the instance count comes from the GPU culling pipeline.

### Phase 3: Adapt VariantPipelineManager for Indirect Draw

The pipeline manager creates render pipelines that are agnostic to draw call type. No changes are needed to the pipeline itself — `drawIndexedIndirect` uses the same pipeline as `drawIndexed`. The only requirement is that the shader's `instance_index` builtin corresponds to the indirect draw's instance offset.

**Changes needed:**
1. `VariantPipelineManager` — No changes (pipelines are draw-method-agnostic)
2. `VariantMeshPool` — Add a method to register "virtual" mesh entries for vegetation that share a Group 1 bind group but use the instance buffer from Group 2
3. `ShaderComposer` / base template — Support the `vegetation-instancing` feature's vertex injection that replaces the standard model-matrix transform

### Phase 4: Modify Base Shader Template

The base shader template currently applies a model matrix transform:
```wgsl
let worldPos4 = globals.model * vec4f(localPos, 1.0);
worldPos = worldPos4.xyz;
```

When `vegetation-instancing` feature is active, this needs to be skipped in favor of the instance-buffer-based transform. Two approaches:

**Option A: Vertex injection replaces model matrix** (simpler)
The `vegetationInstancingFeature.vertexInject` runs *before* the model matrix multiplication, and sets `localPos` to already be in world space. The model matrix is set to identity for vegetation mesh entries.

**Option B: Conditional code path** (more complex)
Add a `VEGETATION_INSTANCE_MODE` marker in the base template that the feature can use to short-circuit the model matrix path.

**Recommended: Option A** — Set model matrix to identity in the vegetation mesh pool entries, and have the instance feature's vertex injection compute world-space position directly. This requires zero changes to the base shader template.

### Phase 5: VegetationRenderer Integration

Modify `VegetationRenderer._renderIndirect()` to use the new variant-based path:

```typescript
// In VegetationRenderer._renderIndirect():
if (plant.mesh) {
  if (this.useVariantRenderer && this.variantMeshRenderer) {
    // New path: PBR variant rendering
    drawCalls += this.variantMeshRenderer.renderIndirect(
      passEncoder, plant.mesh, cullResult.meshBuffer.buffer,
      cullResult.drawArgsBuffer.buffer, plantWind, time, maxDistance, light,
    );
  } else {
    // Legacy path: custom vegetation-mesh.wgsl
    drawCalls += this.meshRenderer.renderIndirect(...);
  }
}
```

### Phase 6: Shadow Casting via Variant Depth Pipeline

The variant renderer already has `getOrCreateDepthOnly()` which creates depth-only pipelines. For vegetation mesh shadow casting:

1. Use `VariantPipelineManager.getOrCreateDepthOnly(['vegetation-instancing'])` 
2. Issue `drawIndexedIndirect` with the same culled draw args buffer
3. This replaces the custom `vegetation-mesh-depth.wgsl` shader

## ECS Components & Systems

### New Component: `VegetationInstanceComponent`

**File:** `src/core/ecs/components/VegetationInstanceComponent.ts`

The variant renderer is entirely ECS-driven — `MeshRenderSystem.determineFeatures()` inspects entity components to decide which shader features to enable. For vegetation meshes to route through the variant pipeline, each "vegetation draw group" (a plant type × tile combination) needs to exist as an ECS entity with a `VegetationInstanceComponent`.

```typescript
export class VegetationInstanceComponent extends Component {
  readonly type = 'vegetation-instance' as ComponentType;

  /** Reference to the GPU culled instance buffer for this plant group */
  culledInstanceBuffer: GPUBuffer | null = null;
  
  /** Reference to the GPU indirect draw args buffer */
  drawArgsBuffer: GPUBuffer | null = null;
  
  /** Sub-mesh index within the draw args buffer (for offset calculation) */
  subMeshIndex: number = 0;
  
  /** Wind parameters (shared across all instances of this plant type) */
  windStrength: number = 0;
  windFrequency: number = 1;
  windDirection: [number, number] = [1, 0];
  gustStrength: number = 0;
  gustFrequency: number = 0.5;
  windMultiplier: number = 1.0;
  
  /** Current animation time (from global wind system) */
  time: number = 0;
  
  /** Max render distance (used for distance fade in vertex shader) */
  maxDistance: number = 200;
  
  /** Whether this vegetation group is currently active (has instances to draw) */
  active: boolean = false;
}
```

**Why per-entity rather than a single global component?**
Each plant type × tile combination has its own culled instance buffer and draw args buffer. The variant renderer issues one `drawIndexedIndirect` per submesh per plant group. By creating lightweight entities for each active vegetation draw group, `MeshRenderSystem` can group them by feature key and batch pipeline switches normally.

### New System: `VegetationInstanceSystem`

**File:** `src/core/ecs/systems/VegetationInstanceSystem.ts`

This system bridges VegetationManager's per-frame output into the ECS world:

```typescript
export class VegetationInstanceSystem extends System {
  readonly name = 'vegetation-instance';
  readonly requiredComponents = ['vegetation-instance', 'mesh'] as const;
  priority = 95; // After wind (50), before MeshRenderSystem (100)

  /** Reference to VegetationManager for reading culled buffer state */
  private vegManager: VegetationManager | null = null;

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    // 1. Sync vegetation state from VegetationManager's prepareFrame() output
    //    into VegetationInstanceComponent properties on each entity
    // 2. Upload vegetation-specific uniforms (wind params, time, maxDistance)
    //    to the MaterialUniforms extra region (same pattern as WindSystem)
    // 3. Update the instance buffer + draw args buffer references
    //    on VegetationInstanceComponent
    // 4. Mark inactive entities (no instances this frame) so MeshRenderSystem skips them
  }
}
```

**Per-frame lifecycle:**
1. `VegetationManager.prepareFrame()` runs GPU culling compute passes (unchanged)
2. `VegetationInstanceSystem.update()` syncs culled buffer references into ECS entities
3. `MeshRenderSystem.update()` sees `VegetationInstanceComponent` → adds `'vegetation-instancing'` to feature list
4. Variant renderer issues `drawIndexedIndirect` instead of `drawIndexed` for these entities

### MeshRenderSystem Changes

Add vegetation detection to `determineFeatures()`:

```typescript
// In MeshRenderSystem.determineFeatures():
const vegInstance = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
if (vegInstance?.active) {
  features.push('vegetation-instancing');
  // Vegetation instancing replaces standard wind — they're mutually exclusive
  // (vegetation uses GPU-computed wind, not CPU spring simulation)
}
```

And in `uploadFeatureUniforms()`, add a vegetation uniform upload method:

```typescript
private uploadVegetationUniforms(entity: Entity, ctx: GPUContext): void {
  const vegComp = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
  if (!vegComp?.active) return;
  
  const buf = new Float32Array(12); // vegetation wind params block
  buf[0] = vegComp.windStrength;
  buf[1] = vegComp.windFrequency;
  buf[2] = vegComp.windDirection[0];
  buf[3] = vegComp.windDirection[1];
  buf[4] = vegComp.gustStrength;
  buf[5] = vegComp.gustFrequency;
  buf[6] = vegComp.time;
  buf[7] = vegComp.maxDistance;
  buf[8] = vegComp.windMultiplier;
  // ... write to material extra uniforms at correct offset
}
```

### Entity Lifecycle

**Creation:** When VegetationManager loads a plant type with a mesh, it creates lightweight "vegetation draw group" entities in the ECS World:
- One entity per plant-type × active-tile
- Each entity gets: `TransformComponent` (identity), `MeshComponent` (references submesh geometry), `MaterialComponent` (PBR materials from the mesh), `VegetationInstanceComponent` (culled buffers)

**Per-frame update:** `VegetationInstanceSystem` refreshes buffer references and wind params from VegetationManager output.

**Destruction:** When tiles are unloaded or plant types removed, the corresponding entities are removed from the World.

### VariantRenderer Changes

The `VariantRenderer.renderColor()` method needs a branch for vegetation-instancing entities:

```typescript
// In VariantRenderer.renderColor(), when iterating entities in a variant group:
const vegComp = entity.getComponent<VegetationInstanceComponent>('vegetation-instance');
if (vegComp?.active && vegComp.drawArgsBuffer) {
  // Set instance buffer as texture-group resource
  // Issue drawIndexedIndirect instead of drawIndexed
  passEncoder.drawIndexedIndirect(vegComp.drawArgsBuffer, vegComp.meshArgsOffset);
} else {
  // Standard per-entity drawIndexed path
  passEncoder.drawIndexed(drawParams.indexCount, 1, ...);
}
```

## Implementation Order

1. **Create `VegetationInstanceComponent`** — ECS component holding culled buffer refs + wind params
2. **Create `VegetationInstanceSystem`** — bridges VegetationManager output into ECS entities
3. **Register resource names** in `resourceNames.ts` for vegetation instancing uniforms
4. **Create `vegetationInstancingFeature.ts`** with instance buffer reading + vegetation wind functions
5. **Register the feature** in `features/index.ts`
6. **Update `MeshRenderSystem.determineFeatures()`** to detect `VegetationInstanceComponent`
7. **Update `VariantRenderer.renderColor()`** to handle `drawIndexedIndirect` for vegetation entities
8. **Create `VegetationMeshVariantRenderer.ts`** — orchestrates entity creation/destruction for vegetation draw groups
9. **Add a toggle** in VegetationRenderer to switch between legacy and variant rendering
10. **Test**: Verify vegetation meshes render with PBR lighting matching regular objects
11. **Shadow casting**: Route vegetation depth-only through variant depth pipeline
12. **Cleanup**: Once validated, deprecate the old `VegetationMeshRenderer` + `vegetation-mesh.wgsl`

## Risks & Considerations

### Performance
- The variant renderer uses 4 bind groups vs. the current 2. More bind group switches per draw.
- The PBR fragment shader is heavier than the simplified vegetation fragment.
- **Mitigation:** Profile both paths. The GPU culling + indirect draw still eliminates most overhead. The fragment cost increase is offset by correct PBR lighting.

### Instance Buffer Compatibility
- The variant shader's Group 2 normally holds textures. Adding a storage buffer (instance data) here is supported by the `buildTextureBindGroupLayout()` function which already handles `storage` resources.
- The culled instance buffer is a raw `GPUBuffer`, not a `UnifiedGPUBuffer`. Need to wrap or adapt the bind group creation.

### Alpha Cutout
- The current vegetation shader does `if (baseColor.a < 0.5) { discard; }`. The variant base shader doesn't have alpha test by default.
- **Solution:** Either add an `alpha-cutout` feature or handle this in the `textured` feature with a material flag.

### Wind Model Difference
- Current vegetation wind: GPU-computed per-vertex from world position + time (coherent across all instances)
- ECS wind: CPU spring simulation per-entity → per-object displacement uniform
- The `vegetationInstancingFeature` keeps the GPU-computed wind model since all instances share the same wind parameters. This is intentionally different from the per-object ECS wind model.
- The existing `windFeature` should be excluded when `vegetation-instancing` is active (they're mutually exclusive).

### Model Matrix Override
- Setting model matrix to identity for vegetation instances means the standard worldPos/worldNormal computations in the base shader are effectively passthrough.
- The instance feature's vertex injection must compute world-space normal correctly (apply Y-rotation to normal).

## Dead Code Cleanup

Once the variant renderer path is fully validated and the legacy toggle is removed, the following dead code can be cleaned up:

### Files to Delete

| File | Reason |
|------|--------|
| `src/core/gpu/shaders/vegetation/vegetation-mesh.wgsl` | Replaced by composed variant shader with `vegetationInstancingFeature` |
| `src/core/gpu/shaders/vegetation/vegetation-mesh-depth.wgsl` | Replaced by variant depth-only pipeline (`getOrCreateDepthOnly`) |
| `src/core/vegetation/VegetationMeshRenderer.ts` | Entire class replaced by variant renderer + `VegetationMeshVariantRenderer` bridge |

### Code to Remove from Existing Files

| File | What to Remove |
|------|----------------|
| `VegetationRenderer.ts` | `meshRenderer` field, `_renderDirect()` mesh path, `renderDepthOnly()` mesh delegation, `setShadowRenderer()` passthrough, `prepareShadowPasses()` mesh delegation, import of `VegetationMeshRenderer` |
| `VegetationManager.ts` | Any direct references to `VegetationMeshRenderer` (if it creates/manages one) |

### Code That Stays (Unaffected)

- **`VegetationCullingPipeline.ts`** — Still produces culled instance buffers and indirect draw args (core to both old and new paths)
- **`VegetationBillboardRenderer.ts`** — Billboards keep their standalone shader (fundamentally different geometry)
- **`VegetationGrassBladeRenderer.ts`** — Grass blades keep their standalone shader
- **Shader files**: `spawn.wgsl`, `cull.wgsl`, `prepare-cull-dispatch.wgsl`, `billboard.wgsl`, `grass-blade.wgsl`, `biome-mask.wgsl` — all still needed
- **Vegetation infrastructure**: `VegetationSpawner.ts`, `VegetationTileCache.ts`, `PlantRegistry.ts`, `BiomeMaskGenerator.ts`, `BillboardBaker.ts`, `AtlasTextureCompositor.ts`, `AtlasRegionDetector.ts` — all still needed

### Summary

The cleanup is contained: **3 files deleted** + **removing mesh-specific code paths from `VegetationRenderer.ts`**. The bulk of the vegetation system (spawning, GPU culling, billboards, grass blades, tile caching, biome masks) remains untouched.

## Success Criteria

1. Vegetation meshes render with the same PBR lighting quality as regular imported objects
2. IBL, shadow, multi-light, and other environment features work on vegetation meshes
3. GPU culling + indirect draw performance is preserved
4. Wind animation continues to work (using the vegetation-specific GPU wind model)
5. Shadow casting works through the variant depth pipeline
6. No regression in rendering of billboard or grass-blade vegetation types
