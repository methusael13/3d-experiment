# ECS Full Migration Plan — From Additive to Complete

> **Reference:** [`docs/ecs-migration-plan.md`](./ecs-migration-plan.md) — the main ECS + Shader Composition migration plan.
>
> **Status:** Phases 1–7 of the main plan are implemented as purely additive code.
> This document covers the remaining work to complete the migration: wiring the
> ECS into the live application, migrating consumers from `Scene`/`SceneObject`
> to `World`/`Entity`, and deleting the legacy code.

---

## Table of Contents

1. [Current State Summary](#1-current-state-summary)
2. [Systems That Stay Untouched](#2-systems-that-stay-untouched)
3. [Step 1: Viewport — Create World & Wire Systems](#3-step-1-viewport--create-world--wire-systems)
4. [Step 2: SceneBuilderStore — Replace Scene with World](#4-step-2-scenebuilderstore--replace-scene-with-world)
5. [Step 3: Bridge Files — Read Components](#5-step-3-bridge-files--read-components)
6. [Step 4: Gizmo System](#6-step-4-gizmo-system)
7. [Step 5: Scene Serializer](#7-step-5-scene-serializer)
8. [Step 6: Delete Legacy Code (Phase 8)](#8-step-6-delete-legacy-code-phase-8)
9. [Migration Order & Dependencies](#9-migration-order--dependencies)
10. [Risk Mitigation](#10-risk-mitigation)

---

## 1. Current State Summary

### What's Been Built (Phases 1–7)

| Layer | Files | Status |
|---|---|---|
| ECS Core | `World`, `Entity`, `Component`, `System` | ✅ Complete |
| Components (12) | Transform, Mesh, Material, Bounds, Shadow, Visibility, Group, PrimitiveGeometry, Wind, Light, Terrain, Ocean | ✅ Complete |
| Systems (5) | TransformSystem, BoundsSystem, WindSystem, MeshRenderSystem, ShadowCasterSystem | ✅ Complete |
| Shader Composition | ShaderComposer, ShaderVariantCache, ResourceResolver, 4 features, template WGSL | ✅ Complete |
| Entity Factories | createModelEntity, createPrimitiveEntity, createTerrainEntity, createOceanEntity, createDirectionalLightEntity | ✅ Complete |
| WorldSceneAdapter | Scene-compatible API wrapping World | ✅ Complete |
| RenderContext | `world?: World` field added | ✅ Complete |
| Render Passes | OpaquePass + TransparentPass query World with fallback to Scene | ✅ Complete |
| UI Hooks | `useEntity`, `useComponent`, `useQuery`, `hasComponent` | ✅ Complete |

### What's NOT Wired In Yet

- **Nobody creates a `World` instance** — it exists as infrastructure but is never instantiated
- **Nobody calls `world.update()`** — systems never run
- **Nobody passes `world` to `RenderContextOptions`** — render passes always fall back to `ctx.scene`
- **All UI still reads from `Scene`/`SceneObject`** — bridge files untouched

---

## 2. Systems That Stay Untouched

These subsystems are self-contained and already accessible through ECS component wrappers.
**No code changes required** inside these directories:

| Directory | What It Does | ECS Access |
|---|---|---|
| `src/core/terrain/` | CDLOD terrain: heightmap gen, erosion, quadtree, tile cache, GPU culling | `TerrainComponent.manager` |
| `src/core/vegetation/` | Vegetation spawning, GPU culling, billboard/mesh/grass-blade renderers | Future `VegetationComponent.manager` |
| `src/core/ocean/` | Ocean FFT, water renderer | `OceanComponent.manager` |
| `src/core/gpu/renderers/ObjectRendererGPU.ts` | GPU mesh pool (vertex buffers, bind groups, draw calls) | `MeshComponent` / `PrimitiveGeometryComponent` call its API |
| `src/core/gpu/renderers/ShadowRendererGPU.ts` | CSM shadow maps, light space matrices | Pipeline-level, unchanged |
| `src/core/gpu/renderers/shared/SceneEnvironment.ts` | IBL cubemaps + shadow texture bind group | Pipeline-level, unchanged |
| `src/core/gpu/shaders/` (terrain, water, vegetation) | All non-object shaders | Independent of entity model |
| `src/core/sceneGraph.ts` | BVH spatial index | Fed by `BoundsSystem` instead of `Scene.updateObjectTransform()` |
| `src/core/gpu/pipeline/RenderPass.ts` | Pass interface + priority constants | Unchanged |
| `src/core/gpu/pipeline/GPUForwardPipeline.ts` | Pipeline orchestration | Minor: pass `world` to RenderContextOptions |

---

## 3. Step 1: Viewport — Create World & Wire Systems

**File:** `src/demos/sceneBuilder/Viewport.ts`
**Effort:** ~2 hours
**Dependencies:** None (first step)

### Changes

```typescript
// In Viewport constructor or initialize():
import { World } from '../../core/ecs/World';
import { TransformSystem, BoundsSystem, WindSystem, ShadowCasterSystem, MeshRenderSystem } from '../../core/ecs/systems';

// Create World
this.world = new World();

// Register systems in priority order
this.world.addSystem(new TransformSystem());       // priority 0
this.world.addSystem(new BoundsSystem());           // priority 10
this.world.addSystem(new WindSystem(this.windManager)); // priority 50
this.world.addSystem(new ShadowCasterSystem());     // priority 90
this.world.addSystem(new MeshRenderSystem());       // priority 100
```

### Per-Frame Update

In the render loop (before `pipeline.render()`):

```typescript
// Feed per-frame data to systems
const shadowCasterSystem = this.world.getSystem<ShadowCasterSystem>('shadow-caster');
if (shadowCasterSystem) {
  shadowCasterSystem.cameraPosition = this.camera.getPosition();
}

const meshRenderSystem = this.world.getSystem<MeshRenderSystem>('mesh-render');
if (meshRenderSystem) {
  meshRenderSystem.iblActive = this.sceneEnvironment?.hasIBL() ?? false;
  meshRenderSystem.shadowsActive = this.renderOptions.shadowEnabled;
}

// Run all systems
this.world.update(deltaTime, {
  ctx: this.gpuContext,
  time: this.time,
  deltaTime,
  sceneEnvironment: this.sceneEnvironment,
});
```

### Pass World to Render Pipeline

```typescript
// In the pipeline.render() call or RenderContextOptions:
const renderContextOpts = {
  // ... existing fields ...
  world: this.world,  // NEW
};
```

### Expose World

```typescript
// Public accessor for store/bridges:
get world(): World { return this._world; }
```

### Acceptance Criteria

- [ ] `World` instance exists on Viewport
- [ ] All 5 systems registered and executing each frame
- [ ] `world` passed to RenderContextOptions
- [ ] OpaquePass and TransparentPass use ECS query path when world is set
- [ ] No visual changes (scene still rendered via `ctx.scene` fallback for objects)

---

## 4. Step 2: SceneBuilderStore — Replace Scene with World

**File:** `src/demos/sceneBuilder/components/state/SceneBuilderStore.ts`
**Effort:** ~3 hours
**Dependencies:** Step 1 (World exists on Viewport)

### Key Changes

#### Add World reference

```typescript
// In store interface:
world: World | null;

// In createSceneBuilderStore():
let world: World | null = null;

// Getter/setter:
get world() { return world; },
set world(w) { world = w; },
```

#### Dual-mode sync

During migration, keep both `scene` and `world`. `syncFromScene()` becomes `syncFromWorld()`:

```typescript
function syncFromWorld(): void {
  if (!world) return syncFromScene(); // Fallback

  batch(() => {
    objects.value = world.getAllEntities();  // Entity[] instead of AnySceneObject[]
    // Selection state from WorldSceneAdapter
    // Groups from WorldSceneAdapter
    transformVersion.value++;
  });
}
```

#### Object initialization

Replace `initObjectWebGPU()` pattern:

```typescript
// Old: isPrimitiveObject(obj) → primitive.initWebGPU(ctx)
// New: entity.hasComponent('mesh') → mesh.initWebGPU(ctx)
//      entity.hasComponent('primitive-geometry') → prim.initWebGPU(ctx)

function initEntityWebGPU(entity: Entity): void {
  const gpuContext = viewport?.getWebGPUContext();
  if (!gpuContext) return;

  const mesh = entity.getComponent<MeshComponent>('mesh');
  if (mesh && !mesh.isGPUInitialized) {
    mesh.initWebGPU(gpuContext);
  }

  const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
  if (prim && !prim.isGPUInitialized) {
    prim.initWebGPU(gpuContext);
  }
}
```

#### Setup callbacks

Replace `scene.onObjectAdded` with World-level hooks or use the `WorldSceneAdapter` callbacks:

```typescript
function setupWorldCallbacks(): void {
  const adapter = new WorldSceneAdapter(world);
  adapter.onEntityAdded = (entity) => {
    syncFromWorld();
    initEntityWebGPU(entity);
    updateCameraFromSceneBounds();
  };
  adapter.onEntityRemoved = () => {
    syncFromWorld();
    updateCameraFromSceneBounds();
  };
}
```

### Acceptance Criteria

- [ ] Store holds `world` reference
- [ ] `objects` signal populated from World entities
- [ ] Selection works through World/WorldSceneAdapter
- [ ] GPU initialization works for mesh + primitive entities
- [ ] All panels still render correctly

---

## 5. Step 3: Bridge Files — Read Components

**Files:** `src/demos/sceneBuilder/components/bridges/*.tsx`
**Effort:** ~1-2 hours per bridge (7 bridges total)
**Dependencies:** Step 2 (Store has World)

### Migration Pattern

Each bridge replaces:
```typescript
// OLD: Read from SceneObject
const obj = store.firstSelectedObject.value;
if (isModelObject(obj)) {
  const pos = obj.position;
  const wind = obj.windSettings;
}

// NEW: Read from ECS Components
const entity = store.firstSelectedEntity.value;
const transform = entity?.getComponent<TransformComponent>('transform');
const wind = entity?.getComponent<WindComponent>('wind');
const pos = transform?.position;
```

### Bridge-by-Bridge Plan

| Bridge | Component Reads | Component Writes |
|---|---|---|
| **ObjectPanelBridge** | `TransformComponent` (position, rotation, scale), `MaterialComponent`, `WindComponent`, `MeshComponent` (model info), `PrimitiveGeometryComponent` (primitive config) | Transform setters, wind enable/disable, material updates |
| **TerrainPanelBridge** | `TerrainComponent.manager` → config reads | `manager.updateConfig()`, `manager.generate()` |
| **WaterPanelBridge** | `OceanComponent.manager` → config reads | `manager.updateConfig()` |
| **EnvironmentPanelBridge** | `WindSystem.getWindManager()` for global wind, `LightComponent` for lights | WindManager property writes, light entity updates |
| **MaterialPanelBridge** | `MaterialComponent` (albedo, metallic, roughness) | `MaterialComponent` property writes |
| **BiomeMaskPanelBridge** | Terrain entity's biome mask data | Biome mask generation triggers |
| **MenuBarBridge** | Uses WorldSceneAdapter for add/remove/duplicate | Factory functions + adapter |

### Type Guard Replacements

```typescript
// Old                              → New
isModelObject(obj)                  → entity.hasComponent('mesh')
isPrimitiveObject(obj)              → entity.hasComponent('primitive-geometry')
obj instanceof OceanSceneObject     → entity.hasComponent('ocean')
isGPUTerrainObject(obj)             → entity.hasComponent('terrain')
obj.objectType === 'model'          → entity.hasComponent('mesh')
```

### Acceptance Criteria (per bridge)

- [ ] Panel displays correct data from ECS components
- [ ] Panel modifications update ECS components
- [ ] No UI regressions
- [ ] No `SceneObject` imports remaining in the bridge

---

## 6. Step 4: Gizmo System

**File:** `src/demos/sceneBuilder/gizmos/TransformGizmoManager.ts`
**Effort:** ~1 hour
**Dependencies:** Step 2 (Store has World)

### Changes

The gizmo manager reads selected object transforms and writes back deltas.

```typescript
// Old: reads obj.position, obj.rotationQuat, obj.scale
// New: reads TransformComponent.position/rotationQuat/scale

// getGizmoTarget() already implemented on WorldSceneAdapter
// applyTransform() already implemented on WorldSceneAdapter
```

If the gizmo manager currently accesses `Scene` directly, switch to `WorldSceneAdapter`
methods which are already implemented with identical API.

### Acceptance Criteria

- [ ] Translate/rotate/scale gizmos work with ECS entities
- [ ] Multi-selection transform works
- [ ] No visual regression in gizmo rendering

---

## 7. Step 5: Scene Serializer

**File:** `src/loaders/SceneSerializer.ts`
**Effort:** ~2 hours
**Dependencies:** Step 2 (Store has World)

### Changes

The serializer needs to save/load entities with their components instead of SceneObjects.

#### Save Path

```typescript
function serializeWorld(world: World): SerializedScene {
  const serializedEntities = [];

  for (const entity of world.getAllEntities()) {
    const transform = entity.getComponent<TransformComponent>('transform');
    const material = entity.getComponent<MaterialComponent>('material');
    const mesh = entity.getComponent<MeshComponent>('mesh');
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    const wind = entity.getComponent<WindComponent>('wind');
    const group = entity.getComponent<GroupComponent>('group');

    serializedEntities.push({
      id: entity.id,
      name: entity.name,
      transform: transform?.serialize(),
      material: material?.serialize(),
      modelPath: mesh?.modelPath,
      primitiveType: prim?.primitiveType,
      primitiveConfig: prim?.config,
      wind: wind?.serialize(),
      groupId: group?.groupId,
      type: mesh ? 'model' : prim ? 'primitive' : 'unknown',
    });
  }

  return { entities: serializedEntities, groups: [...] };
}
```

#### Load Path

Use entity factory functions:

```typescript
for (const data of serializedScene.entities) {
  if (data.type === 'model') {
    const entity = createModelEntity(world, { modelPath: data.modelPath, ... });
    entity.getComponent<TransformComponent>('transform')?.deserialize(data.transform);
  } else if (data.type === 'primitive') {
    const entity = createPrimitiveEntity(world, { ... });
    // ...
  }
}
```

### Backward Compatibility

During migration, support loading old `SerializedScene` format (with `objects[]`)
by detecting the format and delegating to either the old or new deserializer.

### Acceptance Criteria

- [ ] Save produces valid JSON with entity/component data
- [ ] Load restores scene correctly
- [ ] Old save files still load (backward compatible)

---

## 8. Step 6: Delete Legacy Code (Phase 8)

**Effort:** ~30 minutes
**Dependencies:** All steps above complete + verified

### Files to Delete

| File | Replaced By |
|---|---|
| `src/core/sceneObjects/SceneObject.ts` | `Entity` + `TransformComponent` |
| `src/core/sceneObjects/RenderableObject.ts` | `Entity` + `BoundsComponent` |
| `src/core/sceneObjects/ModelObject.ts` | `MeshComponent` + entity factories |
| `src/core/sceneObjects/PrimitiveObject.ts` | `PrimitiveGeometryComponent` |
| `src/core/sceneObjects/GPUTerrainSceneObject.ts` | `TerrainComponent` |
| `src/core/sceneObjects/OceanSceneObject.ts` | `OceanComponent` |
| `src/core/Scene.ts` | `World` |
| `src/core/ecs/WorldSceneAdapter.ts` | Direct `World` usage |
| `src/core/sceneObjects/primitives/` (directory) | `PrimitiveGeometryComponent` |

### Files to Refactor

| File | Change |
|---|---|
| `src/core/sceneObjects/types.ts` | Remove `IRenderer`, `WindParams`, `ObjectWindSettings`; keep `AABB`, `PBRMaterial`, `GeometryData`, `PrimitiveConfig`, `PrimitiveType` |
| `src/core/sceneObjects/index.ts` | Remove class exports; keep shared type exports |
| `src/core/gpu/shaders/object.wgsl` | Keep as fallback during testing; eventually replaced by `object-template.wgsl` + composition |

### Files to Keep Unchanged

| File | Reason |
|---|---|
| `src/core/sceneGraph.ts` | Spatial index, fed by BoundsSystem |
| All terrain/ocean/vegetation managers | Referenced by components; independent |
| `water.wgsl`, `vegetation/*.wgsl`, `terrain/*.wgsl` | Separate renderers, independent |
| `src/core/gpu/shaders/common/pbr.wgsl` | Shared PBR functions |
| `src/core/gpu/shaders/common/shadow-csm.wgsl` | Shared shadow utilities |

### Verification

- [ ] `grep -r "SceneObject" src/` returns zero hits (excluding types.ts shared types)
- [ ] `grep -r "from.*Scene'" src/core/` returns zero hits (excluding ECS adapter if still present)
- [ ] `npx tsc --noEmit` passes
- [ ] Application runs with no visual regressions

---

## 9. Migration Order & Dependencies

```
Step 1: Viewport (create World, wire systems)
    │
    ▼
Step 2: SceneBuilderStore (world reference, dual-mode sync)
    │
    ├──▶ Step 3: Bridge files (can be done one at a time, in parallel)
    │     ├── ObjectPanelBridge
    │     ├── TerrainPanelBridge
    │     ├── WaterPanelBridge
    │     ├── EnvironmentPanelBridge
    │     ├── MaterialPanelBridge
    │     ├── BiomeMaskPanelBridge
    │     └── MenuBarBridge
    │
    ├──▶ Step 4: Gizmo system (parallel with bridges)
    │
    └──▶ Step 5: Scene serializer (parallel with bridges)
              │
              ▼
         Step 6: Delete legacy (after ALL above verified)
```

### Critical Path

**Viewport → Store → (Bridges + Gizmo + Serializer) → Delete Legacy**

Steps 3, 4, and 5 can be done in parallel once Step 2 is complete.
Bridge files can be migrated one at a time — each bridge is independent.

---

## 10. Risk Mitigation

### Risk: Visual regression during dual-mode period

**Mitigation:** The fallback pattern in render passes (`ctx.world ? queryECS : queryScene`) means both paths coexist. Remove the Scene path only after all entities are created in World.

### Risk: Store signal reactivity breaks with Entity references

**Mitigation:** Entities are reference-stable (same object until destroyed). Signals holding `Entity[]` will trigger re-renders when the array reference changes (on add/remove). Component property reads inside computed signals will NOT auto-track — use `transformVersion` bump pattern already in the store.

### Risk: Serializer breaks old save files

**Mitigation:** Detect format version in the serialized JSON. If `objects[]` key exists → old format → use legacy deserializer. If `entities[]` key exists → new format.

### Risk: Bridge migration takes longer than expected

**Mitigation:** Each bridge is independent. If one bridge is complex, skip it and do the next one. The fallback pattern means unmigrated bridges continue to work through `Scene`.

---

## Effort Summary

| Step | Effort | Parallel? |
|---|---|---|
| Step 1: Viewport wiring | 2 hours | No (first) |
| Step 2: Store migration | 3 hours | No (second) |
| Step 3: Bridge files (×7) | 7–14 hours | Yes (each independent) |
| Step 4: Gizmo system | 1 hour | Yes |
| Step 5: Scene serializer | 2 hours | Yes |
| Step 6: Delete legacy | 30 min | No (last) |
| **Total** | **~16–22 hours** | |

With parallel execution on Steps 3–5, the calendar time is approximately:
- Day 1: Viewport + Store (5 hours)
- Day 2-3: Bridges + Gizmo + Serializer (10-17 hours)
- Day 4: Delete legacy + final verification (1 hour)