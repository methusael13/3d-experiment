# Architecture Assessment Report

**Project:** 3d-experiment  
**Date:** 2026-02-03 (reviewed 2026-09-03)  
**Goal:** Evaluate the current architecture as a foundation for a graphics engine extensible into a game engine.

---

## 1. Executive Summary

This project is an ambitious WebGPU-based 3D graphics engine written in TypeScript with a scene builder demo application. It features a forward rendering pipeline, an Entity-Component-System (ECS) layer, composable shaders, PBR materials with IBL, cascaded shadow maps, terrain with hydraulic erosion, ocean simulation, vegetation spawning, and a full editor UI in Preact. The codebase is approximately 150+ source files with substantial rendering features.

**Overall Verdict:** The engine has a solid technical foundation with many features implemented well. However, the architecture is in a transitional state — an OOP scene management layer (`Scene` + `SceneObject`) coexists with a newer ECS (`World` + `Entity`), creating duplication and confusion about the canonical data path. The rendering pipeline is well-structured but tightly coupled to the demo application. Resolving the dual-architecture problem and decoupling the engine core from the editor is the most critical architectural work needed.

---

## 2. What the Architecture Does Well

### 2.1 Pass-Based Rendering Pipeline

The `GPUForwardPipeline` implements a clean, pass-based architecture with 11 passes (Shadow, Sky, Ground, Opaque, SSR, Transparent, Overlay, SelectionMask, SelectionOutline, Debug, DebugView) sorted by priority. Each pass implements a `RenderPass` interface, making it straightforward to add, remove, or reorder passes. This is textbook engine architecture.

**Strengths:**
- Clear separation between scene passes (rendered to HDR buffer) and viewport passes (rendered to backbuffer after tonemapping)
- Post-processing pipeline with pluggable effects (SSAO, Composite/Tonemapping)
- HDR rendering with `rgba16float` intermediate buffers

### 2.2 Shader Composition System

The `ShaderComposer` is one of the most impressive subsystems. It implements a feature-based shader composition pipeline:
- Features declare their WGSL snippets (functions, vertex inject, fragment inject) and resource requirements
- Dependencies are resolved via topological sort
- Resources are deduplicated across features with conflict detection
- Binding indices are auto-assigned for textures, with fixed bindings for environment resources
- A template (`object-template.wgsl`) with injection markers is filled programmatically

This enables the `VariantPipelineManager` to generate per-object shader variants based on which features are active (textured, shadow, IBL, wetness, wind, etc.), avoiding uber-shader branching at runtime.

### 2.3 ECS Design

The ECS layer is well-designed for its intended scale:
- **Entity:** Lightweight container with a `Map<ComponentType, Component>` — good for hundreds of entities
- **World:** Manages entities, systems, selection, groups, and spatial queries via a BVH-backed `SceneGraph`
- **Systems:** Priority-sorted, query matching entities by component sets each frame
- **Components:** 21 component types covering transform, mesh, material, bounds, shadow, visibility, group, primitive-geometry, wind, vegetation, biome-mask, terrain, ocean, light, camera, LOD, wetness, SSR, reflection probes, FPS camera, and frustum culling.
- **Factories:** 8 clean entity creation functions (`createEmptyEntity`, `createModelEntity`, `createPrimitiveEntity`, `createTerrainEntity`, `createOceanEntity`, `createPointLightEntity`, `createSpotLightEntity`, `createDirectionalLightEntity`)

The deferred deletion pattern (`flushPendingDeletions`) is a mature solution for GPU resource lifetime — entities are logically removed immediately but GPU cleanup is deferred until after the frame's command buffer is submitted.

### 2.4 Spatial Indexing

The `SceneGraph` provides BVH-accelerated spatial queries:
- `queryNearby()` — sphere intersection
- `queryFrustum()` — frustum culling
- `castRay()` — raycasting for picking
- `setWorldBounds()` — kept in sync by `BoundsSystem`

This is properly integrated with the ECS via `World.queryNearby()`, `World.queryFrustum()`, and `World.raycast()`.

### 2.5 Environment System

The `SceneEnvironment` acts as a unified bind group (Group 3) containing:
- Shadow maps (single + CSM array)
- IBL textures (diffuse cubemap, specular cubemap, BRDF LUT)
- SSR texture
- Light buffers (point lights, spot lights, counts)
- Spot shadow atlas and cookie atlas

This shared environment bind group is a clean design that avoids per-renderer duplication of global resources.

### 2.6 Advanced Rendering Features

For a WebGPU project, the feature set is impressive:
- **PBR rendering** with metallic-roughness workflow, normal maps, occlusion, emissive
- **Image-Based Lighting (IBL)** with dynamic sky → cubemap → diffuse convolution + specular prefiltering
- **Cascaded Shadow Maps (CSM)** with up to 4 cascades and blend fraction
- **Screen-Space Reflections (SSR)** with quality levels and LOD-gated per-entity control
- **Reflection probes** with bake/capture lifecycle
- **Multi-light support** with point lights, spot lights, cookie textures, and spot shadow atlas
- **Terrain** with CDLOD, GPU culling, hydraulic erosion simulation, biome textures, quadtree LOD
- **Ocean/Water** with Gerstner waves, refraction (scene color copy), SSR integration
- **Vegetation** with billboard rendering, grass blade generation, mesh instances, GPU culling, biome masks
- **Post-processing** with SSAO and ACES tonemapping

### 2.7 Dual Mesh Pool (Transition Strategy)

The `GPUContext.addMesh()` dual-pool facade keeps both `ObjectRendererGPU` (legacy) and `VariantMeshPool` (composed shader path) in sync with a single call. This is a pragmatic migration strategy that avoids a big-bang rewrite.

### 2.8 Tooling and Build

- Vite for fast dev/build with hot reload
- TypeScript throughout (strict enough)
- WGSL shaders imported as raw strings via Vite plugin
- Asset server with SQLite-backed indexing, file watching, and preview generation
- Preact for lightweight UI (smaller than React)

---

## 3. Where the Architecture Could Do Better

### 3.1 Dual Scene Management — The Core Problem

The single biggest architectural issue is the coexistence of two parallel scene management systems:

| Aspect | OOP Layer (`Scene` + `SceneObject`) | ECS Layer (`World` + `Entity`) |
|---|---|---|
| Location | `src/core/Scene.ts`, `src/core/sceneObjects/` | `src/core/ecs/` |
| Selection | `Scene.selectedIds` | `World.selectedIds` |
| Groups | `Scene.groups` | `World.groups` |
| Spatial | `Scene.sceneGraph` | `World._sceneGraph` |
| Serialization | `Scene.serialize()` / `deserialize()` | Not yet implemented |
| Transform sync | `Scene.updateObjectTransform()` | `TransformSystem` |
| Used by | Demo SceneBuilderStore (for some operations) | Viewport, rendering pipeline |

Both maintain their own `SceneGraph`, both track selection, both manage groups. The `Scene` class is ~1,280 lines of selection/group/transform/serialization logic that largely duplicates what `World` does. The `SceneObject` hierarchy (13 classes including abstract bases) duplicates the component data that the ECS holds.

**Impact:** This creates confusion about which is the source of truth, forces double bookkeeping, and blocks clean separation of the engine from the demo.

**Recommendation:** Complete the ECS migration. The `docs/ecs-migration-plan.md` and `docs/ecs-full-migration-plan.md` already exist — execute them. The `Scene` class and `SceneObject` hierarchy should become thin wrappers or be eliminated entirely.

### 3.2 Viewport Is a God Object

`Viewport.ts` (~1,295 lines) combines:
- WebGPU initialization
- ECS World ownership and system registration (12 systems)
- Camera management (orbit, FPS, debug)
- Input management
- Gizmo management
- Render loop orchestration
- Light buffer wiring
- Reflection probe wiring
- Frustum cull matrix computation
- Debug camera overlay rendering
- 23 public setter methods for pipeline config forwarding

This is a textbook god object. For a game engine, the Viewport's responsibilities should be split:

- **Engine Core** should own the World and system registration
- **Renderer** should own the pipeline and render loop
- **Application** should own the camera controllers and input
- **Editor** should own gizmos, debug cameras, and light visualizers

### 3.3 No Engine Entry Point / Application Layer Separation

There is no `Engine` class. The "engine" is an implicit collection of:
- `GPUContext` (singleton) — GPU device
- `World` — ECS
- `GPUForwardPipeline` — rendering
- `createAnimationLoop()` — frame timing

These are wired together inside `Viewport.ts`, which lives in `src/demos/sceneBuilder/`. A game engine needs a clean `Engine` or `Runtime` entry point that:
1. Initializes the GPU
2. Creates the World
3. Registers systems
4. Runs the update/render loop
5. Is agnostic to whether it powers an editor or a game

### 3.4 Camera Is Not an ECS Entity

The main orbit camera (`CameraController` → `CameraObject`) exists outside the ECS. The FPS camera has a partial ECS integration (`FPSCameraComponent` + `FPSCameraSystem`), but the orbit camera is managed entirely by `CameraController` in the demo layer. The rendering pipeline takes a `GPUCamera` interface that is adapted from `CameraObject`.

For a game engine, the camera should be an entity with a `CameraComponent`, and the renderer should read camera matrices from ECS queries — not from an ad-hoc adapter pattern.

### 3.5 Component Type System Is Stringly-Typed

`ComponentType` is a string union:
```typescript
type ComponentType = 'transform' | 'mesh' | 'material' | ... | 'frustum-cull';
```

This works but has downsides:
- No compile-time enforcement of which component types a system operates on
- `entity.getComponent<T>('type')` requires the caller to manually specify the generic type
- Adding new component types requires modifying the union

A more robust approach would use class-based type tokens or a registry pattern that maps component classes to type IDs automatically, enabling `entity.get(TransformComponent)` with full type inference.

### 3.6 ECS Queries Are Unindexed

`World.query()` performs a linear scan of all entities each frame for each system. The code comments acknowledge this:
> "For our scale (~100s of entities), linear scan is fine."

This is true today but will become a bottleneck with thousands of entities (a game engine target). Consider:
- Archetype-based indexing (like bitECS, flecs)
- Dirty-flag tracking to skip unchanged systems
- Caching query results between frames

### 3.7 Pipeline ↔ Demo Coupling

The `GPUForwardPipeline` imports `WebGPUShadowSettings` from `@/demos/sceneBuilder/components/panels/RenderingPanel`. A core engine module should never import from a demo. This type should be defined in the engine core and re-exported or consumed by the demo.

Similarly, the pipeline's `RenderOptions` interface contains editor-specific options like `showGrid`, `showAxes`, `showShadowThumbnail` — these should be viewport/editor concerns, not engine concerns.

### 3.8 Terrain/Ocean Not Fully ECS-Integrated

Terrain and ocean have partial ECS integration:
- `TerrainComponent` wraps a `TerrainManager` (good)
- `OceanComponent` wraps an `OceanManager` (good)
- But `Scene.addWebGPUTerrain()` / `Scene.addOcean()` still exist as imperative methods
- The rendering pipeline reads terrain/ocean from `ctx.scene` during pass execution, not from ECS queries

The OpaquePass and TransparentPass should query terrain/ocean entities from the World, not reach into a legacy Scene object.

### 3.9 Shader Composition Doesn't Cover All Renderers

The `ShaderComposer` + `VariantPipelineManager` compose shaders for object rendering. But terrain (`cdlod.wgsl`), water (`water.wgsl`), vegetation (`vegetation-mesh.wgsl`, `billboard.wgsl`), grid (`grid.wgsl`), and sky all have hand-written standalone shaders. These don't benefit from the composition system.

For a game engine, consider extending the composition system or providing a parallel system for these specialized renderers to share common modules (PBR, shadows, IBL) via WGSL includes or imports.

### 3.10 Minimal Test Coverage

Only `mathUtils.test.ts`, `utils.test.js`, and `AssetIndexer.test.ts` exist. There are no tests for:
- ECS (World, Entity, queries, system execution)
- Shader composition
- Scene graph / BVH
- Pipeline passes
- Component logic

For a game engine foundation, the ECS and shader composition system need thorough unit tests.

---

## 4. Where the Architecture Has Gone Wrong

### 4.1 GPUContext Singleton Anti-Pattern

`GPUContext` is a singleton with `static getInstance()`. This:
- Prevents multi-window / multi-viewport rendering
- Makes unit testing difficult (no mocking/injection)
- Creates hidden global state
- Stores shared renderers (`ObjectRendererGPU`, `VariantMeshPool`) on the singleton

A game engine needs dependency injection. `GPUContext` should be an instance passed explicitly, not a global.

### 4.2 Circular Responsibility Between Viewport and World

The `Viewport` creates the `World` and registers all systems — but it also manually feeds data into systems each frame:
```typescript
shadowCasterSystem.cameraPosition = [...];
lodSystem.setCameraPosition(...);
meshRenderSystem.iblActive = this.dynamicIBLEnabled;
meshRenderSystem.windSystem = this._world.getSystem<WindSystem>('wind');
frustumCullSys.setViewProjectionMatrix(sceneVP);
lightingSystem.setViewProjectionMatrix(sceneVP);
```

Systems shouldn't be manually fed data by the frame loop. Instead:
- Camera position/matrices should come from a camera entity (queryable by systems)
- Feature flags (IBL active, shadows active) should be in a `RenderSettings` component on a singleton entity
- System cross-references should be resolved at init time, not per-frame

### 4.3 Mixed Responsibilities in Systems

`MeshRenderSystem` is both a logic system and a render-data-preparation system. It:
- Queries ECS entities
- Computes shader variant feature sets per entity
- Groups entities by variant
- Writes GPU uniform data (transforms, wind, wetness)
- Receives global feature flags (`iblActive`, `shadowsActive`, `multiLightActive`) via manual property assignment from the Viewport

The system explicitly does *not* issue draw calls — it prepares `ShaderVariantGroup` data structures consumed by render passes. However, it still uploads GPU uniforms directly (via `ObjectRendererGPU.writeMeshExtraUniforms()`), blurring the line between ECS logic and GPU operations. A cleaner separation: ECS systems compute *data*; the rendering pipeline *consumes* that data. The MeshRenderSystem should populate render-list data structures that the pipeline reads, without directly writing to GPU buffers.

### 4.4 `SceneObject` ID Collision Risk

Both `SceneObject` and `Entity` use independent static counters:
```typescript
// SceneObject
public readonly id: string = `object-${SceneObject.nextId++}`;
// Entity
readonly id: string = `entity-${Entity.nextId++}`;
```

During the dual-architecture period, both `object-*` and `entity-*` IDs exist in the scene graph. If any code assumes a unified namespace, this will cause bugs. After the ECS migration, `SceneObject.nextId` should be retired.

### 4.5 Bridge Pattern Creates Unnecessary Indirection

The demo UI uses a "bridge" pattern (`ObjectPanelBridge.tsx`, `TerrainPanelBridge.tsx`, `MaterialPanelBridge.tsx`, etc.) that sits between Preact components and the `SceneBuilderStore`. There are 10+ bridge files. This pattern was likely introduced to decouple the UI from the engine, but in practice the bridges are thin pass-throughs that add file count and indirection without significant value. The store itself should be the bridge.

### 4.6 Animation Loop Doesn't Support Fixed Timestep

The `createAnimationLoop()` provides only variable `deltaTime` from `requestAnimationFrame`. A game engine needs:
- **Fixed timestep** for physics and simulation (e.g., 60 Hz)
- **Variable timestep** for rendering
- **Accumulator pattern** to decouple simulation from frame rate

The current loop will cause simulation instability (terrain erosion, ocean waves, wind) at varying frame rates.

### 4.7 No Resource / Asset Management Abstraction

Assets (models, textures, HDR images) are loaded via ad-hoc loaders (`GLBLoader`, `HDRLoader`, `OBJLoader`, `TextureLoader`) with no:
- Unified asset handle / reference system
- Automatic GPU resource lifecycle management
- Async loading queue with priorities
- Cache invalidation
- Hot-reload support

For a game engine, an `AssetManager` that provides handles, ref-counting, async loading, and cache management is essential.

### 4.8 No Event / Messaging System

Systems communicate via:
- Direct property assignment (`meshRenderSystem.windSystem = ...`)
- Callback setters (`scene.onSelectionChanged = fn`)
- Manual per-frame data feeding in Viewport

There is no event bus, message queue, or signal system for decoupled communication. A game engine needs at minimum a typed event emitter for engine-wide events (entity created, component added, system registered, asset loaded, etc.).

---

## 5. Prioritized Recommendations

### Priority 1: Architectural (Must-do for Game Engine)

1. **Complete ECS migration** — Eliminate `Scene` class and `SceneObject` hierarchy. Make `World` the single source of truth. Implement ECS serialization.
2. **Create an `Engine` class** — Extract from `Viewport` the core loop: GPU init → World creation → system registration → update/render. Make it demo-agnostic.
3. **Replace GPUContext singleton** — Use constructor injection. Pass `GPUContext` instances explicitly.
4. **Implement fixed-timestep loop** — Separate simulation updates (fixed dt) from render updates (variable dt).
5. **Make camera an ECS entity** — One `CameraComponent` containing view/projection matrices, queried by systems and the render pipeline.

### Priority 2: Structural (Should-do)

6. **Decouple pipeline from demo** — Move `RenderOptions` and settings types into `core/gpu/pipeline/`. Remove imports from `demos/`.
7. **Implement an event system** — Typed event emitter in the engine core for entity lifecycle, component changes, and system communication.
8. **Add asset management** — `AssetManager` with handles, caching, async queue, and ref-counting.
9. **Improve component type safety** — Replace string union with class-based type tokens for compile-time safety.
10. **Extend shader composition** — Allow terrain, water, and vegetation shaders to share common modules (PBR, shadows, IBL) from the composition system.

### Priority 3: Quality (Nice-to-have)

11. **Add unit tests** — ECS, shader composition, scene graph at minimum.
12. **Index ECS queries** — Archetype or bitset indexing for `World.query()` performance at scale.
13. **Simplify bridge pattern** — Merge bridge files into stores or hooks.
14. **Document the rendering pipeline** — A pipeline stage diagram with bind group layouts, texture flow, and pass dependencies.
15. **Profile and optimize** — GPU timestamp queries for pass-level profiling, draw call batching metrics.

---

## 6. Architecture Diagram (Current State)

```
┌─────────────────────────────────────────────────────────┐
│                    Demo Layer (Preact)                    │
│  SceneBuilderApp → SceneBuilderStore → Bridge files      │
│                         ↕                                │
│  Panels (Object, Material, Terrain, Water, Vegetation)   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────┐
│                   Viewport (God Object)                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐  │
│  │ Camera   │  │ Input     │  │ Gizmo Manager        │  │
│  │ Controller│  │ Manager   │  │ (Translate/Rotate/   │  │
│  └──────────┘  └───────────┘  │  Scale)              │  │
│                               └──────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │              ECS World                            │   │
│  │  Entities ←→ Components ←→ Systems               │   │
│  │  SceneGraph (BVH) for spatial queries             │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │              OOP Scene (LEGACY)                    │   │
│  │  SceneObjects ←→ SceneGraph (BVH)                 │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────┐
│              GPU / Rendering Layer                        │
│  ┌───────────────────────────────────┐                   │
│  │     GPUForwardPipeline            │                   │
│  │  ShadowPass → SkyPass → Ground   │                   │
│  │  → OpaquePass → SSRPass          │                   │
│  │  → TransparentPass → Overlay     │                   │
│  │  → SelectionMask → Outline       │                   │
│  │  → DebugPass → DebugViewPass     │                   │
│  │         ↓                         │                   │
│  │  PostProcessPipeline              │                   │
│  │  (SSAO → Composite/Tonemap)      │                   │
│  └───────────────────────────────────┘                   │
│  ┌───────────────┐  ┌────────────────────────────────┐   │
│  │ SceneEnvironment │  │ ShaderComposer + Features    │   │
│  │ (Group 3 bind  │  │ (variant shader generation)   │   │
│  │  group: shadow,│  └────────────────────────────────┘   │
│  │  IBL, lights,  │  ┌────────────────────────────────┐   │
│  │  SSR)          │  │ VariantMeshPool +              │   │
│  └───────────────┘  │ VariantPipelineManager          │   │
│                      └────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐    │
│  │ GPUContext (Singleton — device, queue, format)     │   │
│  │ + ObjectRendererGPU (legacy)                       │   │
│  │ + VariantMeshPool (composed shaders)               │   │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┼────────────────────────────────┐
│              Domain Subsystems                           │
│  ┌──────────┐ ┌──────────┐ ┌────────────────────────┐   │
│  │ Terrain  │ │ Ocean    │ │ Vegetation             │   │
│  │ Manager  │ │ Manager  │ │ Manager + Spawner      │   │
│  │ CDLOD    │ │ Gerstner │ │ Billboard/Mesh/Grass   │   │
│  │ Erosion  │ │ Waves    │ │ GPU Culling            │   │
│  │ Streaming│ │          │ │ Biome Masks            │   │
│  └──────────┘ └──────────┘ └────────────────────────┘   │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Loaders: GLB, OBJ, HDR, SceneSerializer            │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 7. Conclusion

This project has achieved an impressive amount of graphics engineering. The shader composition system, pass-based pipeline, and ECS design show strong architectural thinking. The primary challenge is completing the architectural transition from OOP scene management to ECS, and extracting a clean engine core from the demo application. Resolving these two concerns would transform this from a capable graphics demo into a genuine game engine foundation.