# ECS + Shader Composition Migration Plan

## Table of Contents

1. [Overview](#1-overview)
2. [Current Architecture Problems](#2-current-architecture-problems)
3. [Target Architecture](#3-target-architecture)
4. [Phase 1: ECS Foundation](#4-phase-1-ecs-foundation)
5. [Phase 2: Shader Composition System](#5-phase-2-shader-composition-system)
6. [Phase 3: Core Components & Systems](#6-phase-3-core-components--systems)
7. [Phase 4: Migrate Object Types](#7-phase-4-migrate-object-types)
8. [Phase 5: Wind as First Feature Component](#8-phase-5-wind-as-first-feature-component)
9. [Phase 6: Render Pass Integration](#9-phase-6-render-pass-integration)
10. [Phase 7: UI/Bridge Adaptation](#10-phase-7-uibridge-adaptation)
11. [Phase 8: Cleanup & Remove Legacy](#11-phase-8-cleanup--remove-legacy)
12. [File Structure](#12-file-structure)
13. [Risk Mitigation](#13-risk-mitigation)

---

## 1. Overview

Migrate from a deep inheritance hierarchy (`SceneObject → RenderableObject → ModelObject`)
with features baked into entity classes, to an Entity-Component-System (ECS) architecture
with a WGSL shader composition pipeline.

**The goal:** Adding a new behavior/feature (wind, snow, dissolve, particles, etc.) should
**never** require modifying existing entity classes, renderer interfaces, or shader files.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Lightweight ECS (TypeScript class-based, Map-backed) | Not a data-oriented/archetype ECS — our scale (~100s of entities) doesn't need cache-line optimization. TypeScript classes give us IDE support and type safety. |
| WGSL Shader Composition from day one (Option C) | Avoids a future refactor from `if`-branch uniforms to composition. Composes WGSL from feature modules with resource deduplication. |
| Incremental migration with adapter layer | Old `Scene` wraps `World` initially so UI/demos don't break mid-migration. |
| Components are data bags with optional GPU resource exposure | Components hold data; Systems process it; the GPU binding is mediated by `ResourceResolver`. |
| Feature modules use canonical resource names | Prevents duplicate bindings when two features share the same texture/uniform. |

---

## 2. Current Architecture Problems

### Class Hierarchy

```
SceneObject          → transform, visibility, castsShadow, originPivot, groupId
  └─ RenderableObject → localBounds, AABB computation
       └─ ModelObject  → GLB model data, GPU mesh IDs, textures, windSettings
       └─ PrimitiveObject → geometry, material, GPU mesh ID
  └─ GPUTerrainSceneObject → terrain manager reference (proxy)
  └─ OceanSceneObject → ocean manager reference (proxy)
```

### Specific Symptoms

| Problem | Where | Impact |
|---|---|---|
| `windSettings` baked into `ModelObject` | `ModelObject.ts` L34-42 | Every model carries wind state whether it needs it or not. Adding new features means changing the class. |
| `IRenderer.render()` takes 8 params | `types.ts` L100-110 | Every new feature extends the signature and every implementation. |
| `Scene` has type-specific methods | `Scene.ts` | `addPrimitive()`, `addObject()`, `addWebGPUTerrain()`, `addOcean()` — each new type needs a new method with duplicated scene-graph registration. |
| `castsShadow` baked into `SceneObject` | `SceneObject.ts` L38 | Every object carries shadow state even if irrelevant. |
| `OceanSceneObject`/`GPUTerrainSceneObject` are proxies | respective files | They don't share rendering logic with other objects; inheritance doesn't serve them. |
| Monolithic `object.wgsl` with 4 entry points | `object.wgsl` | `fs_main`, `fs_notex`, `fs_main_ibl`, `fs_notex_ibl` — adding any vertex/fragment feature requires duplicating across all variants. |
| `GPUForwardPipeline` hardcodes renderer member fields | `GPUForwardPipeline.ts` | Adding new renderable systems means modifying the pipeline class. |

---

## 3. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  World                                                        │
│  ├── Entity Registry (Map<id, Entity>)                       │
│  ├── System Pipeline (ordered list of Systems)               │
│  ├── Query Engine (query by component set)                   │
│  └── Selection / Group management (migrated from Scene)      │
├──────────────────────────────────────────────────────────────┤
│  Entity                                                       │
│  ├── id, name                                                │
│  └── components: Map<ComponentType, Component>               │
│       ├── TransformComponent (position, rotation, scale)     │
│       ├── MeshComponent (GPU mesh IDs, textures, GLB data)   │
│       ├── MaterialComponent (PBR properties)                 │
│       ├── BoundsComponent (AABB)                             │
│       ├── WindComponent (opt-in wind behavior)               │
│       ├── ShadowComponent (opt-in shadow casting/receiving)  │
│       ├── TerrainComponent (terrain manager ref)             │
│       ├── OceanComponent (ocean manager ref)                 │
│       └── ... future components (particles, audio, physics)  │
├──────────────────────────────────────────────────────────────┤
│  Systems (process entities per frame)                         │
│  ├── TransformSystem — recompute dirty model matrices        │
│  ├── WindSystem — spring physics on WindComponent.displacement│
│  ├── MeshRenderSystem — write uniforms, pick shader variant  │
│  ├── ShadowSystem — determine shadow casters for shadow pass │
│  ├── BoundsSystem — update world-space AABB from transform   │
│  └── ... future systems                                      │
├──────────────────────────────────────────────────────────────┤
│  Shader Composition                                           │
│  ├── ShaderFeature registry (wind, ibl, shadow, snow, ...)   │
│  ├── ShaderComposer (template + injection + resource dedup)  │
│  ├── ShaderVariantCache (key → GPURenderPipeline)            │
│  ├── ResourceResolver (component → GPU bind group entries)   │
│  └── Resource naming registry (canonical names for dedup)    │
└──────────────────────────────────────────────────────────────┘
```

### How Components Map to GPU

```
Bind Group 0 (Global)      ← Pipeline owns (camera, light, shadow flags)
Bind Group 1 (Per-Object)  ← Composed from TransformComponent + MaterialComponent + feature uniforms
Bind Group 2 (Textures)    ← MeshComponent textures + feature textures (deduplicated)
Bind Group 3 (Environment) ← SceneEnvironment (shadow maps + IBL cubemaps)
```

Components don't map 1:1 to shaders. Components provide **data**. The `MeshRenderSystem`
determines which shader variant to use based on which components are present on an entity,
and the `ShaderComposer` assembles the WGSL from feature modules.

---

## 4. Phase 1: ECS Foundation

**Goal:** Create the core ECS primitives. No integration with existing code yet — purely additive.

### Files to Create

```
src/core/ecs/
  types.ts
  Component.ts
  Entity.ts
  System.ts
  World.ts
  index.ts
```

### `types.ts`

```typescript
import type { GPUContext } from '../gpu/GPUContext';
import type { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';

/**
 * Component type identifiers.
 * Using a string union for extensibility — new components just add a new string.
 */
export type ComponentType =
  | 'transform'
  | 'mesh'
  | 'material'
  | 'bounds'
  | 'shadow'
  | 'visibility'
  | 'group'
  | 'primitive-geometry'
  | 'wind'
  | 'terrain'
  | 'ocean'
  | 'light'
  | 'camera'
  | string; // Extensible for future/external components

/**
 * Context provided to systems each frame.
 */
export interface SystemContext {
  ctx: GPUContext;
  time: number;
  deltaTime: number;
  sceneEnvironment: SceneEnvironment;
}
```

### `Component.ts`

```typescript
import type { ComponentType } from './types';

/**
 * Base class for all components.
 * Components are data bags — they hold state but contain minimal logic.
 */
export abstract class Component {
  /** Unique type identifier for this component kind */
  abstract readonly type: ComponentType;

  /**
   * Optional: Expose a named GPU resource for shader binding.
   * Called by ResourceResolver when building bind groups.
   * Return null if this component doesn't provide the named resource.
   */
  getGPUResource?(name: string): GPUBindingResource | null;

  /** Optional: Cleanup when removed from an entity */
  destroy?(): void;

  /** Optional: Serialize for save/load */
  serialize?(): Record<string, unknown>;

  /** Optional: Deserialize from saved data */
  deserialize?(data: Record<string, unknown>): void;
}
```

### `Entity.ts`

```typescript
import type { ComponentType } from './types';
import type { Component } from './Component';

/**
 * An Entity is a lightweight container that holds components.
 * Entities have an ID and a name, but all behavior comes from their components.
 */
export class Entity {
  private static nextId = 1;

  readonly id: string;
  name: string;
  private components = new Map<ComponentType, Component>();

  constructor(name: string = 'Entity') {
    this.id = `entity-${Entity.nextId++}`;
    this.name = name;
  }

  /**
   * Add a component to this entity. Replaces existing component of the same type.
   * Returns the added component for chaining.
   */
  addComponent<T extends Component>(component: T): T {
    // Destroy existing component of same type if present
    const existing = this.components.get(component.type);
    if (existing) {
      existing.destroy?.();
    }
    this.components.set(component.type, component);
    return component;
  }

  /**
   * Remove a component by type. Returns the removed component or undefined.
   */
  removeComponent(type: ComponentType): Component | undefined {
    const component = this.components.get(type);
    if (component) {
      component.destroy?.();
      this.components.delete(type);
    }
    return component;
  }

  /**
   * Get a component by type. Returns undefined if not present.
   */
  getComponent<T extends Component>(type: ComponentType): T | undefined {
    return this.components.get(type) as T | undefined;
  }

  /**
   * Check if this entity has a specific component type.
   */
  hasComponent(type: ComponentType): boolean {
    return this.components.has(type);
  }

  /**
   * Check if this entity has ALL of the specified component types.
   */
  hasAll(...types: ComponentType[]): boolean {
    return types.every(type => this.components.has(type));
  }

  /**
   * Check if this entity has ANY of the specified component types.
   */
  hasAny(...types: ComponentType[]): boolean {
    return types.some(type => this.components.has(type));
  }

  /**
   * Get all component types present on this entity.
   */
  getComponentTypes(): ComponentType[] {
    return Array.from(this.components.keys());
  }

  /**
   * Iterate over all components.
   */
  getComponents(): IterableIterator<Component> {
    return this.components.values();
  }

  /**
   * Get the number of components.
   */
  get componentCount(): number {
    return this.components.size;
  }

  /**
   * Destroy this entity and all its components.
   */
  destroy(): void {
    for (const component of this.components.values()) {
      component.destroy?.();
    }
    this.components.clear();
  }
}
```

### `System.ts`

```typescript
import type { ComponentType, SystemContext } from './types';
import type { Entity } from './Entity';

/**
 * Base class for all systems.
 * Systems process entities that have a specific set of components.
 * They are stateless processors — all state lives in components.
 */
export abstract class System {
  /** Unique system name */
  abstract readonly name: string;

  /** Component types an entity must have for this system to process it */
  abstract readonly requiredComponents: readonly ComponentType[];

  /** Execution priority (lower = earlier). Default 0. */
  priority: number = 0;

  /** Whether this system is currently active. */
  enabled: boolean = true;

  /**
   * Process matching entities for this frame.
   * Called by World.update() with pre-filtered entity list.
   */
  abstract update(entities: Entity[], deltaTime: number, context: SystemContext): void;

  /** Optional: One-time initialization when system is added to World */
  initialize?(context: SystemContext): void;

  /** Optional: Cleanup when system is removed from World */
  destroy?(): void;
}
```

### `World.ts`

```typescript
import type { ComponentType, SystemContext } from './types';
import { Entity } from './Entity';
import type { System } from './System';

/**
 * The World is the top-level container that manages entities and systems.
 * It replaces Scene as the central scene management class.
 */
export class World {
  private entities = new Map<string, Entity>();
  private systems: System[] = [];
  private nextEntityId = 1;

  // ===================== Entity Management =====================

  /**
   * Create a new entity and add it to the world.
   */
  createEntity(name?: string): Entity {
    const entity = new Entity(name);
    this.entities.set(entity.id, entity);
    return entity;
  }

  /**
   * Add an externally-created entity to the world.
   */
  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  /**
   * Remove and destroy an entity.
   */
  destroyEntity(id: string): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;
    entity.destroy();
    this.entities.delete(id);
    return true;
  }

  /**
   * Get an entity by ID.
   */
  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Get all entities as an array.
   */
  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get entity count.
   */
  get entityCount(): number {
    return this.entities.size;
  }

  // ===================== Query =====================

  /**
   * Query entities that have ALL of the specified component types.
   * This is the primary ECS query operation.
   *
   * For our scale (~100s of entities), linear scan is fine.
   * Can be upgraded to archetype-based indexing if needed later.
   */
  query(...componentTypes: ComponentType[]): Entity[] {
    const results: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.hasAll(...componentTypes)) {
        results.push(entity);
      }
    }
    return results;
  }

  /**
   * Query and return the first matching entity, or undefined.
   */
  queryFirst(...componentTypes: ComponentType[]): Entity | undefined {
    for (const entity of this.entities.values()) {
      if (entity.hasAll(...componentTypes)) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * Query entities that have ANY of the specified component types.
   */
  queryAny(...componentTypes: ComponentType[]): Entity[] {
    const results: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.hasAny(...componentTypes)) {
        results.push(entity);
      }
    }
    return results;
  }

  // ===================== System Management =====================

  /**
   * Add a system to the world. Systems are sorted by priority (lower = earlier).
   */
  addSystem(system: System, priority?: number): void {
    if (priority !== undefined) {
      system.priority = priority;
    }
    this.systems.push(system);
    this.systems.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a system by name.
   */
  removeSystem(name: string): boolean {
    const index = this.systems.findIndex(s => s.name === name);
    if (index === -1) return false;
    const system = this.systems[index];
    system.destroy?.();
    this.systems.splice(index, 1);
    return true;
  }

  /**
   * Get a system by name.
   */
  getSystem<T extends System>(name: string): T | undefined {
    return this.systems.find(s => s.name === name) as T | undefined;
  }

  /**
   * Get all registered systems.
   */
  getSystems(): readonly System[] {
    return this.systems;
  }

  // ===================== Update Loop =====================

  /**
   * Run all enabled systems for this frame.
   * Each system receives only the entities that match its required components.
   */
  update(deltaTime: number, context: SystemContext): void {
    for (const system of this.systems) {
      if (!system.enabled) continue;

      // Query matching entities for this system
      const matching = this.query(...system.requiredComponents);
      if (matching.length > 0 || system.requiredComponents.length === 0) {
        system.update(matching, deltaTime, context);
      }
    }
  }

  // ===================== Lifecycle =====================

  /**
   * Destroy all entities and systems.
   */
  destroy(): void {
    // Destroy systems first (they may reference entities)
    for (const system of this.systems) {
      system.destroy?.();
    }
    this.systems = [];

    // Destroy all entities
    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();
  }
}
```

### `index.ts`

```typescript
export { Component } from './Component';
export { Entity } from './Entity';
export { System } from './System';
export { World } from './World';
export type { ComponentType, SystemContext } from './types';
```

### Acceptance Criteria

- Entity create/destroy works correctly
- Add/remove/get components works with type safety
- `world.query('transform', 'mesh')` returns only entities with both components
- Systems execute in priority order
- System receives only matching entities
- Destroying an entity calls destroy() on all its components

---

## 5. Phase 2: Shader Composition System

**Goal:** Build the WGSL composition pipeline that replaces monolithic shader files with
composable feature modules.

### Files to Create

```
src/core/gpu/shaders/
  composition/
    types.ts
    ShaderComposer.ts
    ShaderVariantCache.ts
    ResourceResolver.ts
    resourceNames.ts
    index.ts
  templates/
    object-template.wgsl
  features/
    iblFeature.ts
    shadowFeature.ts
    windFeature.ts
    texturedFeature.ts
    index.ts
```

### `composition/types.ts` — Core Interfaces

```typescript
/**
 * A GPU resource declared by a shader feature.
 * Resources with the same (name, group) are deduplicated during composition.
 */
export interface ShaderResource {
  /** Canonical resource name (from resourceNames.ts). Used for dedup. */
  name: string;

  /** Resource kind */
  kind: 'uniform' | 'texture' | 'sampler' | 'storage';

  /** For uniforms: the WGSL type (e.g., 'f32', 'vec3f', 'mat4x4f') */
  wgslType?: string;

  /** For textures: the WGSL texture type (e.g., 'texture_2d<f32>') */
  textureType?: string;

  /** For samplers: the WGSL sampler type (e.g., 'sampler', 'sampler_comparison') */
  samplerType?: string;

  /** Which bind group this resource belongs to */
  group: 'perObject' | 'environment' | 'textures';

  /** The component type that provides this resource at runtime */
  provider: string;
}

/**
 * A composable shader feature module.
 * Features declare their resource needs and provide WGSL code snippets
 * that get injected into the base template.
 */
export interface ShaderFeature {
  /** Unique feature identifier */
  id: string;

  /** Which shader stage(s) this feature affects */
  stage: 'vertex' | 'fragment' | 'both';

  /** GPU resources this feature requires */
  resources: ShaderResource[];

  /** WGSL function definitions (injected before main functions) */
  functions: string;

  /** WGSL code injected into the vertex shader main body */
  vertexInject?: string;

  /** WGSL code injected into the fragment shader main body (ambient section) */
  fragmentInject?: string;

  /** WGSL code injected after final color computation (post-effects like snow) */
  fragmentPostInject?: string;

  /** Additional VertexOutput fields needed for passing data to fragment */
  varyings?: string;

  /** Other feature IDs that must be composed before this one */
  dependencies?: string[];
}

/**
 * Result of shader composition — contains the WGSL code and layout metadata.
 */
export interface ComposedShader {
  /** The final assembled WGSL source code */
  wgsl: string;

  /** Deduplicated per-object uniform fields (for buffer layout) */
  uniformLayout: Map<string, ShaderResource>;

  /** Deduplicated texture/sampler bindings with assigned indices */
  bindingLayout: Map<string, ShaderResource & { bindingIndex: number }>;

  /** The cache key that produced this shader */
  featureKey: string;

  /** Ordered list of feature IDs that were composed */
  features: string[];
}
```

### `composition/resourceNames.ts` — Canonical Names

```typescript
/**
 * Canonical resource names for shader features.
 * Features MUST use these names to enable automatic deduplication.
 * If two features both declare a resource with the same name and group,
 * the ShaderComposer will emit only one binding.
 */
export const RES = {
  // ==================== Shadow (environment) ====================
  SHADOW_MAP:            'shadowMap',
  SHADOW_SAMPLER:        'shadowSampler',
  CSM_SHADOW_ARRAY:      'csmShadowArray',
  CSM_UNIFORMS:          'csmUniforms',

  // ==================== IBL (environment) ====================
  IBL_DIFFUSE:           'iblDiffuse',
  IBL_SPECULAR:          'iblSpecular',
  IBL_BRDF_LUT:          'iblBrdfLut',
  IBL_CUBEMAP_SAMPLER:   'iblCubemapSampler',
  IBL_LUT_SAMPLER:       'iblLutSampler',

  // ==================== PBR Textures (per-object) ====================
  BASE_COLOR_TEX:        'baseColorTexture',
  BASE_COLOR_SAMP:       'baseColorSampler',
  NORMAL_TEX:            'normalTexture',
  NORMAL_SAMP:           'normalSampler',
  METALLIC_ROUGHNESS_TEX: 'metallicRoughnessTexture',
  METALLIC_ROUGHNESS_SAMP: 'metallicRoughnessSampler',
  OCCLUSION_TEX:         'occlusionTexture',
  OCCLUSION_SAMP:        'occlusionSampler',
  EMISSIVE_TEX:          'emissiveTexture',
  EMISSIVE_SAMP:         'emissiveSampler',

  // ==================== Wind (per-object uniforms) ====================
  WIND_DISPLACEMENT_X:   'windDisplacementX',
  WIND_DISPLACEMENT_Z:   'windDisplacementZ',
  WIND_ANCHOR_HEIGHT:    'windAnchorHeight',
  WIND_STIFFNESS:        'windStiffness',
  WIND_TIME:             'windTime',
  WIND_TURBULENCE:       'windTurbulence',

  // ==================== Terrain (shared by terrain + shadow) ====================
  TERRAIN_HEIGHTMAP:     'terrainHeightmap',
  TERRAIN_NORMALMAP:     'terrainNormalMap',
  ISLAND_MASK_TEX:       'islandMaskTex',
  ISLAND_MASK_SAMP:      'islandMaskSamp',
  ISLAND_MASK_SCALE:     'islandMaskScale',
} as const;

export type ResourceName = typeof RES[keyof typeof RES];
```

### `ShaderComposer.ts` — Core Logic

The composer:
1. Accepts a list of feature IDs
2. Resolves dependencies (topological sort)
3. Collects all `ShaderResource` declarations from active features
4. Deduplicates resources by `(name, group)` — detects type conflicts
5. Assigns binding indices to deduplicated texture/sampler resources
6. Builds the `PerObjectUniforms` struct from deduplicated uniform fields
7. Injects function definitions (dependency-ordered) into the template
8. Injects vertex/fragment code at template markers
9. Returns `ComposedShader` with assembled WGSL + layout metadata

**Template markers in `object-template.wgsl`:**
- `/*{{EXTRA_UNIFORM_FIELDS}}*/` — additional per-object uniform fields
- `/*{{EXTRA_BINDINGS}}*/` — additional texture/sampler declarations (Group 2)
- `/*{{EXTRA_VARYINGS}}*/` — additional VertexOutput fields
- `/*{{FUNCTIONS}}*/` — feature function definitions
- `/*{{VERTEX_FEATURES}}*/` — vertex main body injection
- `/*{{FRAGMENT_AMBIENT}}*/` — ambient lighting injection (IBL vs hemisphere)
- `/*{{FRAGMENT_POST}}*/` — post-color injection (snow, dissolve, etc.)

### `ShaderVariantCache.ts`

```typescript
/**
 * Caches compiled GPU render pipelines by feature key.
 * A feature key is a sorted, '+'-joined list of active features
 * (e.g., "ibl+shadow+textured+wind").
 *
 * Variants are created lazily on first use and cached indefinitely.
 * Call invalidate() if a shader module source changes during development.
 */
class ShaderVariantCache {
  private cache = new Map<string, { pipeline: GPURenderPipeline; composed: ComposedShader }>();

  getOrCreate(featureKey: string, ctx: GPUContext, composer: ShaderComposer): {
    pipeline: GPURenderPipeline;
    composed: ComposedShader;
  };

  has(featureKey: string): boolean;
  invalidate(featureKey?: string): void;
  getStats(): { totalVariants: number; keys: string[] };
  destroy(): void;
}
```

### `ResourceResolver.ts`

```typescript
/**
 * Maps shader resource declarations to actual GPU resources by querying
 * entity components and the scene environment.
 *
 * Given an entity and a ComposedShader's binding layout, produces
 * the GPUBindGroupEntry[] needed for setBindGroup().
 */
class ResourceResolver {
  resolve(
    entity: Entity,
    bindingLayout: Map<string, ShaderResource & { bindingIndex: number }>,
    sceneEnvironment: SceneEnvironment
  ): GPUBindGroupEntry[];
}
```

### Resource Deduplication: How It Works

When two features declare the same resource:

| Scenario | Example | Resolution |
|---|---|---|
| Same name, same type, same provider | Both `terrain-island` and `shadow-terrain` declare `islandMaskTex: texture_2d<f32>` from `TerrainComponent` | ✅ **Dedup** — one declaration, one binding. Both features read the same slot. |
| Same name, different type | Feature A: `islandMask: f32`, Feature B: `islandMask: vec2f` | ❌ **Error at compose time** — clear error message. Developer must rename one. |
| Same data, different names | Feature A: `islandMaskTex`, Feature B: `terrainIslandTexture` | ⚠️ Two bindings pointing to same GPU texture. Wasted binding but functionally correct. Prevented by using `RES` constants. |

### `object-template.wgsl` — Decomposed Template

The current `object.wgsl` (532 lines with 4 entry point variants) is decomposed:
- **Keep** in template: `GlobalUniforms`, `VertexInput`, `VertexOutput` base fields, vertex transform logic, PBR BRDF functions
- **Replace** `MaterialUniforms` with `PerObjectUniforms` (base fields + injection marker)
- **Remove** `fs_notex`, `fs_main_ibl`, `fs_notex_ibl` — these become composed variants
- **Extract** IBL functions → `iblFeature.ts`
- **Extract** shadow functions → `shadowFeature.ts`
- **Extract** texture sampling → `texturedFeature.ts`
- PBR BRDF functions (`distributionGGX`, `geometrySmith`, etc.) stay in the template as they're needed by all variants

### Initial Feature Modules

| Feature ID | Stage | Resources | Injection Point | Replaces |
|---|---|---|---|---|
| `shadow` | fragment | shadow map, shadow sampler, CSM (all env) | `/*{{FUNCTIONS}}*/` + shadow call in fragment | `sampleShadow()` in object.wgsl |
| `ibl` | fragment | IBL diffuse, specular, BRDF LUT, samplers (env) | `/*{{FRAGMENT_AMBIENT}}*/` | `fs_main_ibl` / `fs_notex_ibl` variants |
| `textured` | fragment | base color, normal, metallic-roughness, occlusion, emissive textures (per-object) | texture sampling block in fragment | `fs_main` vs `fs_notex` distinction |
| `wind` | vertex | wind uniforms (per-object) | `/*{{VERTEX_FEATURES}}*/` | Currently not in WebGPU shaders; exists in legacy WebGL path |

### Acceptance Criteria

- Compose `['shadow', 'ibl', 'textured']` → valid WGSL matching current `fs_main_ibl` behavior
- Compose `['shadow', 'textured']` → valid WGSL matching current `fs_main` behavior
- Compose `['shadow']` → valid WGSL matching current `fs_notex` behavior
- Compose `['shadow', 'textured', 'wind']` → valid WGSL with wind vertex injection
- Two features sharing `islandMaskTex` → deduplicated to one binding
- Type conflict detection → throws error at compose time
- All composed WGSL must compile via `device.createShaderModule()` without errors

---

## 6. Phase 3: Core Components & Systems

**Goal:** Implement the essential components that map to existing scene object properties,
and the systems that process them.

### Components to Create

```
src/core/ecs/components/
  TransformComponent.ts
  MeshComponent.ts
  MaterialComponent.ts
  BoundsComponent.ts
  ShadowComponent.ts
  VisibilityComponent.ts
  GroupComponent.ts
  PrimitiveGeometryComponent.ts
  TerrainComponent.ts
  OceanComponent.ts
  LightComponent.ts
  index.ts
```

#### TransformComponent

```typescript
class TransformComponent extends Component {
  readonly type = 'transform';

  position: vec3;
  rotationQuat: quat;
  scale: vec3;
  originPivot: 'top' | 'center' | 'bottom' = 'center';

  // Cached model matrix (recomputed when dirty)
  modelMatrix: mat4;
  dirty: boolean = true;

  // Euler getter/setter for UI compatibility
  get rotation(): vec3;
  set rotation(euler: vec3);

  // Mark dirty when properties change
  setPosition(pos: vec3): void;
  setRotation(rot: vec3): void;
  setScale(scl: vec3): void;
}
```

#### MeshComponent

```typescript
class MeshComponent extends Component {
  readonly type = 'mesh';

  modelPath: string;
  model: GLBModel | null = null;
  gpuMeshIds: number[] = [];
  gpuTextures: UnifiedGPUTexture[] = [];
  gpuContext: GPUContext | null = null;

  // GPU resource management (migrated from ModelObject)
  async initWebGPU(ctx: GPUContext): Promise<void>;
  updateGPUTransform(modelMatrix: mat4): void;
  destroyWebGPU(): void;
  get isGPUInitialized(): boolean;

  // Expose textures for ResourceResolver
  getGPUResource(name: string): GPUBindingResource | null;

  destroy(): void;
}
```

#### MaterialComponent

```typescript
class MaterialComponent extends Component {
  readonly type = 'material';

  albedo: [number, number, number] = [0.7, 0.7, 0.7];
  metallic: number = 0.0;
  roughness: number = 0.5;
  normalScale: number = 1.0;
  occlusionStrength: number = 1.0;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND' = 'OPAQUE';
  alphaCutoff: number = 0.5;
  emissive: [number, number, number] = [0, 0, 0];
  doubleSided: boolean = false;

  // Texture flags (computed from MeshComponent texture presence)
  textureFlags: [number, number, number, number] = [0, 0, 0, 0];
}
```

#### BoundsComponent

```typescript
class BoundsComponent extends Component {
  readonly type = 'bounds';

  localBounds: AABB | null = null;
  worldBounds: AABB | null = null;  // Recomputed by BoundsSystem
  dirty: boolean = true;
}
```

#### ShadowComponent

```typescript
class ShadowComponent extends Component {
  readonly type = 'shadow';

  castsShadow: boolean = true;
  receivesShadow: boolean = true;
}
```

#### VisibilityComponent

```typescript
class VisibilityComponent extends Component {
  readonly type = 'visibility';

  visible: boolean = true;
}
```

#### GroupComponent

```typescript
class GroupComponent extends Component {
  readonly type = 'group';

  groupId: string | null = null;
}
```

#### PrimitiveGeometryComponent

```typescript
class PrimitiveGeometryComponent extends Component {
  readonly type = 'primitive-geometry';

  primitiveType: 'cube' | 'plane' | 'sphere';
  config: PrimitiveConfig;
  geometryData: GeometryData;
  gpuMeshId: number = -1;
  gpuContext: GPUContext | null = null;

  updateGeometry(newConfig: PrimitiveConfig): void;
  initWebGPU(ctx: GPUContext): void;
  destroyWebGPU(): void;
}
```

#### TerrainComponent

```typescript
class TerrainComponent extends Component {
  readonly type = 'terrain';

  manager: TerrainManager;
  canCastShadows: boolean = true;

  getGPUResource(name: string): GPUBindingResource | null;
  destroy(): void;
}
```

#### VegetationComponent

Vegetation is modelled as a component **attached to the terrain entity** rather than
a standalone global system. This reflects the real-world relationship (vegetation grows
*on* terrain) and enables per-terrain vegetation control.

```typescript
class VegetationComponent extends Component {
  readonly type = 'vegetation';

  manager: VegetationManager;
  plantRegistry: PlantRegistry;
  enabled: boolean = true;

  destroy(): void {
    this.manager.destroy();
  }
}
```

#### BiomeMaskComponent

Biome masks are separated from vegetation because they serve multiple purposes:
terrain material blending, vegetation spawn density, and potentially future systems
(snow distribution, audio zones, etc.).

```typescript
class BiomeMaskComponent extends Component {
  readonly type = 'biome-mask';

  generator: BiomeMaskGenerator;
  maskTexture: UnifiedGPUTexture | null = null;

  getGPUResource(name: string): GPUBindingResource | null {
    if (name === 'biomeMaskTex') return this.maskTexture?.view ?? null;
    return null;
  }

  destroy(): void {
    this.generator.destroy();
    this.maskTexture?.destroy();
  }
}
```

#### OceanComponent

```typescript
class OceanComponent extends Component {
  readonly type = 'ocean';

  manager: OceanManager;
  waterLevel: number = 0.2;

  destroy(): void;
}
```

#### LightComponent

```typescript
class LightComponent extends Component {
  readonly type = 'light';

  lightType: 'directional' | 'point' | 'spot';
  color: [number, number, number] = [1, 1, 1];
  intensity: number = 1.0;
  direction?: [number, number, number];
  castsShadow: boolean = false;
}
```

### Systems to Create

```
src/core/ecs/systems/
  TransformSystem.ts
  BoundsSystem.ts
  WindSystem.ts
  VegetationSystem.ts
  MeshRenderSystem.ts
  ShadowCasterSystem.ts
  index.ts
```

#### TransformSystem

- **Required:** `['transform']`
- **Priority:** 0 (runs first)
- **Logic:** For each entity where `transform.dirty`, recompute `modelMatrix` from
  position/rotation/scale (same logic as current `SceneObject.getModelMatrix()`).
  Includes origin pivot offset if `BoundsComponent` is present.

#### BoundsSystem

- **Required:** `['transform', 'bounds']`
- **Priority:** 10 (after transform)
- **Logic:** When transform or bounds is dirty, transform local AABB corners by model
  matrix → update `worldBounds`.

#### MeshRenderSystem

- **Required:** `['transform', 'mesh']`
- **Priority:** 100 (after all logic systems)
- **Logic:**
  1. Determine feature set from entity's components + scene environment state
  2. Compute shader variant key (sorted feature IDs joined by `+`)
  3. Get/create pipeline variant from `ShaderVariantCache`
  4. Build per-object uniform buffer from component data
  5. Build bind group via `ResourceResolver`
  6. Update GPU mesh transforms via `MeshComponent.updateGPUTransform()`

#### VegetationSystem

- **Required:** `['terrain', 'vegetation']`
- **Priority:** 60 (after transform and wind, before render)
- **Logic:** For each entity with both `TerrainComponent` and `VegetationComponent`:
  1. Read heightmap and normal map from `terrain.manager`
  2. If entity also has `BiomeMaskComponent`, read biome mask for spawn density
  3. Call `vegetation.manager.update(dt, terrainData, camera)`
  4. Handle vegetation tile streaming based on camera position

The vegetation system's dependency on terrain data is **implicit by component co-location**:
both components live on the same entity, so the system always has access to both.

```typescript
class VegetationSystem extends System {
  readonly name = 'vegetation';
  readonly requiredComponents = ['terrain', 'vegetation'] as const;
  priority = 60;

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const entity of entities) {
      const terrain = entity.getComponent<TerrainComponent>('terrain');
      const veg = entity.getComponent<VegetationComponent>('vegetation');
      if (!terrain || !veg || !veg.enabled) continue;

      // Biome mask is optional — vegetation works without it (uniform density)
      const biome = entity.getComponent<BiomeMaskComponent>('biome-mask');

      veg.manager.update(dt, {
        heightmap: terrain.manager.getHeightmap(),
        normalMap: terrain.manager.getNormalMap(),
        biomeMask: biome?.maskTexture ?? null,
        terrainSize: terrain.manager.getWorldSize(),
      });
    }
  }
}
```

#### ShadowCasterSystem

- **Required:** `['transform', 'shadow']`
- **Priority:** 90 (before render, after logic)
- **Logic:** Collects entities with `ShadowComponent.castsShadow = true` into a list
  consumed by the shadow render pass.

### Acceptance Criteria

- Create entity with Transform+Mesh+Material → MeshRenderSystem produces correct shader key
- TransformSystem correctly dirty-flags and recomputes model matrix
- BoundsSystem produces correct world-space AABB
- All component `serialize()`/`deserialize()` roundtrip correctly

---

## 7. Phase 4: Migrate Object Types

**Goal:** Replace concrete `SceneObject` subclasses with Entity + Component combinations.
Introduce an adapter layer so `Scene` API continues to work during migration.

### Migration Mapping

| Old Class | New Entity Components |
|---|---|
| `ModelObject` | Transform + Mesh + Material + Bounds + Shadow + Visibility + Group |
| `PrimitiveObject` (Cube/Plane/Sphere) | Transform + PrimitiveGeometry + Material + Bounds + Shadow + Visibility + Group |
| `GPUTerrainSceneObject` | Transform + Terrain + BiomeMask + Vegetation + Bounds + Shadow + Visibility |
| `OceanSceneObject` | Transform + Ocean + Bounds + Visibility |
| `DirectionalLight` | Transform + Light + Visibility |

### WorldSceneAdapter

```
src/core/ecs/WorldSceneAdapter.ts
```

A temporary adapter that wraps `World` to provide the same API as `Scene`.
This allows UI code (bridges, panels) to continue working during migration.

```typescript
class WorldSceneAdapter {
  private world: World;

  // Mirror Scene's API using entities + components
  addPrimitive(type, name, config): Entity;
  addObject(modelPath, name): Promise<Entity>;
  addWebGPUTerrain(ctx, config): Promise<Entity>;
  addOcean(ctx, config): Promise<Entity>;
  removeObject(id): boolean;
  getObject(id): Entity | null;
  getAllObjects(): Entity[];

  // Selection (delegated to World selection state)
  select(id, options): void;
  getSelectedIds(): Set<string>;
  clearSelection(): void;

  // Transform (reads/writes TransformComponent)
  applyTransform(type, value): void;
  getGizmoTarget(): GizmoTarget;
  updateObjectTransform(id): void;

  // Serialization
  serialize(): SerializedScene;
  deserialize(data): Promise<void>;
}
```

### Entity Factory Functions

```typescript
// src/core/ecs/factories.ts

/** Create a model entity from a GLB file */
async function createModelEntity(
  world: World,
  modelPath: string,
  name?: string,
  getModelUrl?: (path: string) => string
): Promise<Entity>;

/** Create a primitive entity (cube, plane, sphere) */
function createPrimitiveEntity(
  world: World,
  primitiveType: PrimitiveType,
  name?: string,
  config?: PrimitiveConfig
): Entity;

/** Create a terrain entity */
async function createTerrainEntity(
  world: World,
  gpuContext: GPUContext,
  config: Partial<TerrainManagerConfig>
): Promise<Entity>;

/** Create an ocean entity */
async function createOceanEntity(
  world: World,
  gpuContext: GPUContext,
  config?: Partial<OceanManagerConfig>
): Promise<Entity>;
```

### Migration Steps

1. Create `World` instance alongside existing `Scene` in `Viewport.ts`
2. Create `WorldSceneAdapter` that delegates to `World`
3. Swap `Scene` reference to `WorldSceneAdapter` in `Viewport.ts` and `SceneBuilderStore.ts`
4. Create entity factory functions
5. Verify all existing functionality works through the adapter
6. Gradually remove adapter methods as consumers switch to direct `World` API

### Acceptance Criteria

- All existing scene operations (add/remove/select/transform objects) work through adapter
- Scene serialization/deserialization produces identical results
- No visual changes in the viewport

---

## 8. Phase 5: Wind as First Feature Component

**Goal:** Extract wind from `ModelObject.windSettings` into `WindComponent` + `WindSystem` +
`windFeature` shader module. This is the end-to-end proof that the ECS + shader composition
pipeline works correctly.

### Steps

1. **Create `WindComponent`** (`src/core/ecs/components/WindComponent.ts`):

```typescript
class WindComponent extends Component {
  readonly type = 'wind';

  enabled: boolean = true;
  influence: number = 1.0;
  stiffness: number = 0.5;
  anchorHeight: number = 0;
  leafMaterialIndices: Set<number> = new Set();
  branchMaterialIndices: Set<number> = new Set();
  displacement: [number, number] = [0, 0];
  velocity: [number, number] = [0, 0];
}
```

2. **Create `WindSystem`** (`src/core/ecs/systems/WindSystem.ts`):
   - Required: `['transform', 'wind']`
   - Priority: 50 (after transform, before render)
   - Holds reference to existing `WindManager` (global wind simulation unchanged)
   - Each frame: calls `windManager.updateObjectPhysics(windComponent, dt)` for each entity

3. **Create `windFeature`** shader module (`src/core/gpu/shaders/features/windFeature.ts`):
   - Resources: `windDisplacementX`, `windDisplacementZ`, `windAnchorHeight`, `windStiffness`,
     `windTime`, `windTurbulence` (all perObject uniforms)
   - Vertex injection: apply wind displacement with quadratic height falloff + leaf flutter
   - No fragment injection needed

4. **Wire into `MeshRenderSystem`:**
   - When entity has `WindComponent`, include `'wind'` in shader variant key
   - Write wind uniform values from `WindComponent.displacement` to GPU buffer

5. **Update UI bridge (`ObjectPanelBridge`):**
   - Wind toggle adds/removes `WindComponent` on the entity
   - Wind parameters read/write to `WindComponent` instead of `ModelObject.windSettings`

6. **Deprecate `ModelObject.windSettings`**

### Acceptance Criteria

- Add tree → no wind component → renders with standard PBR shader (same as before)
- Toggle wind ON → `WindComponent` added → shader variant changes to include wind displacement → tree sways
- Adjust wind parameters → displacement changes accordingly
- Toggle wind OFF → `WindComponent` removed → back to standard shader → tree is static
- Performance: no regression vs. current implementation

---

## 9. Phase 6: Render Pass Integration

**Goal:** Render passes query `World` for entities instead of referencing hardcoded renderers.

### Changes to Existing Passes

| Pass | Current | New |
|---|---|---|
| `OpaquePass` | Calls `objectRenderer.render()` | Queries `world.query('transform', 'mesh')` → groups by shader variant → issues draw calls per variant group |
| `ShadowPass` | Calls `shadowRenderer.render()` with object renderer | Queries `world.query('transform', 'mesh', 'shadow')` → renders shadow casters |
| `TransparentPass` | Reads ocean from scene | Queries `world.query('transform', 'ocean')` |
| `GroundPass` | Reads terrain from scene | Queries `world.query('transform', 'terrain')` |
| `SelectionMaskPass` | Uses objectRenderer selection | Queries selected entities from World's selection state |

**Note:** Terrain and ocean still use their own specialized renderers
(`CDLODRendererGPU`, `WaterRendererGPU`). The ECS doesn't replace these — it provides a
uniform way to find and configure them. The `TerrainComponent` and `OceanComponent` hold
references to these managers.

### RenderContext Update

```typescript
interface RenderContext {
  // ... existing fields ...
  world: World;  // Add World reference so passes can query entities
}
```

### Acceptance Criteria

- All passes render correctly using World queries
- Shadow pass only processes entities with ShadowComponent
- Selection outline works with ECS entities
- No visual differences from pre-migration rendering

---

## 10. Phase 7: UI/Bridge Adaptation

**Goal:** Update Preact UI components and bridge files to work with ECS entities
instead of scene objects.

### Affected Files

| File | Change |
|---|---|
| `ObjectPanelBridge.tsx` | Reads/writes TransformComponent, MaterialComponent, WindComponent |
| `TerrainPanelBridge.tsx` | Reads/writes TerrainComponent |
| `WaterPanelBridge.tsx` | Reads/writes OceanComponent |
| `EnvironmentPanelBridge.tsx` | Reads WindManager (global), light entities |
| `MaterialPanelBridge.tsx` | Reads/writes MaterialComponent |
| `SceneBuilderStore.ts` | Replaces `scene: Scene` with `world: World` |
| `VegetationContent.tsx` | Vegetation system entities |

### Strategy

1. Create utility hooks:
   - `useEntity(id)` — get entity by ID
   - `useComponent<T>(entityId, type)` — get typed component from entity
   - `useQuery(...types)` — query entities by component set

2. Bridges read from components instead of scene objects

3. Type guards replace instanceof checks:
   - `isModelObject(obj)` → `entity.hasComponent('mesh')`
   - `isPrimitiveObject(obj)` → `entity.hasComponent('primitive-geometry')`
   - `obj instanceof OceanSceneObject` → `entity.hasComponent('ocean')`

### Acceptance Criteria

- All panels display correct data from ECS components
- All panel modifications update ECS components and trigger re-renders
- No UI regressions

---

## 11. Phase 8: Cleanup & Remove Legacy

**Goal:** Remove deprecated code once all consumers use the ECS path.

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

### Files to Refactor

| File | Change |
|---|---|
| `src/core/sceneObjects/types.ts` | Remove `IRenderer`, `WindParams`, `ObjectWindSettings`; keep shared types like `AABB`, `PBRMaterial` |
| `src/core/gpu/shaders/object.wgsl` | Replaced by `object-template.wgsl` + feature modules |
| `src/core/gpu/renderers/ObjectRendererGPU.ts` | Remains as GPU-side mesh batch renderer, but driven by `MeshRenderSystem` |
| `src/core/gpu/pipeline/GPUForwardPipeline.ts` | Remains but passes receive `World` reference |

### Files to Keep Unchanged

| File | Reason |
|---|---|
| `src/core/sceneGraph.ts` | Still useful for spatial index (raycasting, frustum culling) |
| All terrain/ocean/vegetation managers | Referenced by components; independent subsystems |
| `water.wgsl`, `vegetation/*.wgsl`, `terrain/*.wgsl` | Separate renderers; shader composition applies to the object PBR pipeline |
| `src/core/gpu/shaders/common/pbr.wgsl` | Shared PBR utility functions |
| `src/core/gpu/shaders/common/shadow-csm.wgsl` | Shared shadow utilities |

### Acceptance Criteria

- No references to deleted files anywhere in the codebase
- All tests pass
- Build succeeds without warnings related to removed code
- No visual or functional regressions

---

## 12. File Structure

### New Files (Complete Tree)

```
src/core/ecs/
  types.ts                              ← ComponentType, SystemContext
  Component.ts                          ← Abstract Component base
  Entity.ts                             ← Entity (id, name, component map)
  System.ts                             ← Abstract System base
  World.ts                              ← World (entity registry, systems, query)
  WorldSceneAdapter.ts                  ← Temporary Scene API adapter (Phase 4, removed Phase 8)
  factories.ts                          ← Entity factory functions
  index.ts                              ← Public API
  components/
    TransformComponent.ts
    MeshComponent.ts
    MaterialComponent.ts
    BoundsComponent.ts
    ShadowComponent.ts
    VisibilityComponent.ts
    GroupComponent.ts
    PrimitiveGeometryComponent.ts
    WindComponent.ts
    VegetationComponent.ts
    BiomeMaskComponent.ts
    TerrainComponent.ts
    OceanComponent.ts
    LightComponent.ts
    index.ts
  systems/
    TransformSystem.ts
    BoundsSystem.ts
    WindSystem.ts
    VegetationSystem.ts
    MeshRenderSystem.ts
    ShadowCasterSystem.ts
    index.ts

src/core/gpu/shaders/
  composition/
    types.ts                            ← ShaderFeature, ShaderResource, ComposedShader
    ShaderComposer.ts                   ← Template injection + resource dedup
    ShaderVariantCache.ts               ← Key → GPURenderPipeline cache
    ResourceResolver.ts                 ← Component → GPU bind group entries
    resourceNames.ts                    ← Canonical resource name constants (RES)
    index.ts
  templates/
    object-template.wgsl               ← Base PBR template with injection markers
  features/
    iblFeature.ts                      ← IBL ambient lighting module
    shadowFeature.ts                   ← Shadow sampling module
    windFeature.ts                     ← Wind vertex displacement module
    texturedFeature.ts                 ← PBR texture sampling module
    index.ts                           ← Feature registry
```

### Existing Files Modified

```
src/core/gpu/pipeline/RenderContext.ts  ← Add world: World reference
src/core/gpu/pipeline/GPUForwardPipeline.ts ← Pass World to RenderContext
src/core/gpu/pipeline/passes/*.ts       ← Query World instead of hardcoded renderers
src/demos/sceneBuilder/Viewport.ts      ← Create World, wire to pipeline
src/demos/sceneBuilder/components/state/SceneBuilderStore.ts ← World instead of Scene
src/demos/sceneBuilder/components/bridges/*.tsx ← Read/write components
```

---

## 13. Risk Mitigation

### Risk 1: Shader Composition Produces Invalid WGSL

**Mitigation:**
- Unit test every feature combination against `device.createShaderModule()`
- Validate composed WGSL has balanced braces, valid struct alignment
- Keep `object.wgsl` as fallback during migration — if composition fails, fall back to monolithic shader
- Log composed WGSL in dev mode for manual inspection

### Risk 2: Performance Regression from Per-Frame Component Queries

**Mitigation:**
- Profile before and after. `Map.values()` iteration over ~100 entities is ~microseconds
- If needed, add simple caching: track a `queryVersion` that increments on entity add/remove,
  and cache query results until version changes
- The query cost is dominated by render time, not JS iteration

### Risk 3: Breaking UI During Migration

**Mitigation:**
- `WorldSceneAdapter` provides identical API to `Scene` — swap is transparent
- Migration is per-panel: one bridge file at a time
- Each phase has clear acceptance criteria that must pass before proceeding
- Git branches per phase with CI validation

### Risk 4: Uniform Buffer Layout Mismatch

**Mitigation:**
- `ComposedShader.uniformLayout` and the CPU-side buffer writer are generated from the
  same `ShaderResource` declarations — single source of truth
- Pad uniform structs to 16-byte alignment (WebGPU requirement) automatically in composer
- Validate buffer size matches struct size at pipeline creation time

### Risk 5: Combinatorial Explosion of Shader Variants

**Mitigation:**
- Current feature set is small (shadow, ibl, textured, wind = 16 combinations max)
- Monitor `ShaderVariantCache.getStats()` in dev mode
- If variants exceed ~50, consider collapsing rarely-used combinations into `if`-branch uniforms
- Future: implement shader variant warmup at scene load time

### Risk 6: Cross-Pass Resource Sharing Bugs

**Mitigation:**
- Resources are identified by canonical names (`RES` constants) — same name = same resource
- `ResourceResolver` validates that the component actually provides the requested resource
- Shadow pass and main pass both resolve `islandMaskTex` from the same `TerrainComponent`
  instance — the GPU texture handle is the same object

---

## Appendix: Migration Timeline Estimate

| Phase | Effort | Dependencies | Notes |
|---|---|---|---|
| Phase 1: ECS Foundation | 1-2 days | None | Purely additive, no risk |
| Phase 2: Shader Composition | 3-4 days | None (parallel with Phase 1) | Highest complexity; template decomposition is the hardest part |
| Phase 3: Core Components & Systems | 2-3 days | Phase 1 | Straightforward data migration |
| Phase 4: Migrate Object Types | 2-3 days | Phase 1, 3 | Adapter pattern minimizes risk |
| Phase 5: Wind Feature Component | 1-2 days | Phase 1, 2, 3, 4 | End-to-end validation of the full stack |
| Phase 5b: Vegetation as Component | 1-2 days | Phase 3, 4 | Attach VegetationComponent + BiomeMaskComponent to terrain entity; create VegetationSystem |
| Phase 6: Render Pass Integration | 2-3 days | Phase 2, 4 | Most render pass changes are small |
| Phase 7: UI/Bridge Adaptation | 2-3 days | Phase 4 | Can be incremental, one panel at a time |
| Phase 8: Cleanup | 1 day | All above | Delete deprecated code, verify no references |

**Total: ~16-23 days** (can be reduced with parallel work on Phases 1+2)

Phases 1-2 can be developed in parallel. Phase 3 can start as soon as Phase 1 is done.
Phase 5 is the critical integration test — if it works, the architecture is validated.
Phase 5b can run in parallel with Phase 5 since vegetation is independent of wind/shader composition.

---

## Appendix B: SceneGraph Integration — Spatial Queries on World

The existing `SceneGraph` (`src/core/sceneGraph.ts`) is a BVH-accelerated spatial index
that already supports ray casting and AABB queries. After ECS migration, it continues to
serve as the spatial query backend — the `World` class exposes convenience methods that
delegate to it.

### What SceneGraph Already Has

```typescript
// Already exists in sceneGraph.ts:
class SceneGraph<T> {
  castRay(rayOrigin: vec3, rayDir: vec3): RayHit<T> | null;     // BVH ray traversal
  queryBounds(queryAABB: AABB): SceneGraphNode<T>[];              // BVH AABB intersection
  // ... add, remove, update, rebuild ...
}
```

### New: queryRadius on SceneGraph

Add a sphere query using BVH broad-phase + distance narrow-phase:

```typescript
// New method on SceneGraph:
queryRadius(center: vec3, radius: number): SceneGraphNode<T>[] {
  // 1. Build AABB containing the sphere
  const queryBox: AABB = {
    min: vec3.fromValues(center[0] - radius, center[1] - radius, center[2] - radius),
    max: vec3.fromValues(center[0] + radius, center[1] + radius, center[2] + radius),
  };

  // 2. BVH broad-phase: O(log n)
  const candidates = this.queryBounds(queryBox);

  // 3. Narrow-phase: filter by actual distance
  const radiusSq = radius * radius;
  return candidates.filter(node => {
    const c = node.worldBounds.center();
    const dx = c[0] - center[0];
    const dy = c[1] - center[1];
    const dz = c[2] - center[2];
    return (dx * dx + dy * dy + dz * dz) <= radiusSq;
  });
}
```

### Spatial Query API on World

`World` wraps the `SceneGraph` for entity-level spatial queries:

```typescript
class World {
  private sceneGraph: SceneGraph;

  // ====== Component-based queries (existing) ======
  query(...types: ComponentType[]): Entity[];
  queryFirst(...types: ComponentType[]): Entity | undefined;

  // ====== Spatial queries (NEW — delegate to SceneGraph BVH) ======

  /** Find all entities within radius of a point */
  queryNearby(center: vec3, radius: number): Entity[] {
    const nodes = this.sceneGraph.queryRadius(center, radius);
    return nodes
      .map(node => this.getEntity(node.id))
      .filter((e): e is Entity => e !== undefined);
  }

  /** Find entities within radius that also have specific components */
  queryNearbyWith(center: vec3, radius: number, ...types: ComponentType[]): Entity[] {
    return this.queryNearby(center, radius)
      .filter(entity => entity.hasAll(...types));
  }

  /** Find all entities intersecting an AABB */
  queryInBounds(aabb: AABB): Entity[] {
    const nodes = this.sceneGraph.queryBounds(aabb);
    return nodes
      .map(node => this.getEntity(node.id))
      .filter((e): e is Entity => e !== undefined);
  }

  /** Raycast through scene, return closest hit entity */
  raycast(origin: vec3, direction: vec3): { entity: Entity; distance: number; hitPoint: vec3 } | null {
    const hit = this.sceneGraph.castRay(origin, direction);
    if (!hit) return null;
    const entity = this.getEntity(hit.node.id);
    if (!entity) return null;
    return { entity, distance: hit.distance, hitPoint: hit.hitPoint };
  }
}
```

### Keeping SceneGraph in Sync

The `BoundsSystem` propagates entity bounds changes to the SceneGraph:

```typescript
class BoundsSystem extends System {
  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const bounds = entity.getComponent<BoundsComponent>('bounds');

      if (transform.dirty || bounds.dirty) {
        bounds.worldBounds = transformAABB(bounds.localBounds, transform.modelMatrix);

        // Sync to SceneGraph for spatial queries
        ctx.sceneGraph.update(entity.id, {
          position: transform.position,
          rotation: transform.rotation,
          localBounds: bounds.localBounds,
        });

        bounds.dirty = false;
      }
    }
  }
}
```

### Usage Summary

| Query | Method | Backing | Use Case |
|---|---|---|---|
| By components | `world.query('mesh', 'shadow')` | Linear scan | Find entities by type/behavior |
| By radius | `world.queryNearby(pos, 20)` | BVH + distance filter | Find nearby NPCs, colliders |
| By radius + type | `world.queryNearbyWith(pos, 20, 'npc')` | BVH + component filter | Find nearby NPCs specifically |
| By AABB | `world.queryInBounds(aabb)` | BVH AABB traversal | Frustum culling, area triggers |
| Raycast | `world.raycast(origin, dir)` | BVH ray traversal | Mouse picking, line-of-sight |

---

## Appendix C: Per-Frame Render Flow (ECS + ObjectRendererGPU)

This section traces a single frame from start to finish, showing how the ECS systems,
`ObjectRendererGPU`, and the shader composition pipeline work together.

### Scene State (Example)

```
World contains:
  Entity "Japanese Maple"     [Transform, Mesh, Material, Bounds, Shadow, Wind]
  Entity "Boulder"            [Transform, Mesh, Material, Bounds, Shadow]
  Entity "Red Cube"           [Transform, PrimitiveGeometry, Material, Bounds]
  Entity "Terrain"            [Transform, Terrain, Vegetation, BiomeMask, Bounds, Shadow]
  Entity "Ocean"              [Transform, Ocean, Bounds]
  Entity "Sun"                [Transform, Light]
```

### Frame Timeline

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: World.update(deltaTime, systemContext)                                │
│  ─────────────────────────────────────────────────────────────────────────      │
│  Systems execute in priority order. Each system queries for its required        │
│  component set and only processes matching entities.                            │
│                                                                                 │
│  Priority 0 — TransformSystem                                                  │
│    queries: ['transform']                                                      │
│    matches: ALL 6 entities                                                     │
│    action:  For each entity where transform.dirty:                             │
│             → Recompute modelMatrix from position/rotation/scale               │
│             → Clear dirty flag                                                 │
│                                                                                 │
│  Priority 10 — BoundsSystem                                                    │
│    queries: ['transform', 'bounds']                                            │
│    matches: Maple, Boulder, Red Cube, Terrain, Ocean (5 entities)              │
│    action:  Transform localBounds by modelMatrix → update worldBounds          │
│                                                                                 │
│  Priority 50 — WindSystem                                                      │
│    queries: ['transform', 'wind']                                              │
│    matches: Japanese Maple (1 entity — only one with WindComponent)             │
│    action:                                                                     │
│      1. windManager.calculateWindForce()  → global wind vector                 │
│      2. windManager.updateObjectPhysics(maple.wind, deltaTime)                 │
│         → spring simulation updates wind.displacement = [0.12, -0.08]          │
│         → wind.velocity dampened                                               │
│      NOTE: Boulder, Red Cube, Terrain, Ocean, Sun are NOT processed            │
│            (they don't have WindComponent)                                      │
│                                                                                 │
│  Priority 60 — VegetationSystem                                                │
│    queries: ['terrain', 'vegetation']                                          │
│    matches: Terrain (1 entity)                                                 │
│    action:                                                                     │
│      1. Read heightmap from terrain.manager                                    │
│      2. Read biomeMask from BiomeMaskComponent (optional, present here)        │
│      3. vegetation.manager.update(dt, terrainData, camera)                     │
│         → Update tile streaming, spawn/despawn based on camera position        │
│                                                                                 │
│  Priority 80 — LightingSystem (post-ECS lighting overhaul)                     │
│    queries: ['transform', 'light']                                             │
│    matches: Sun (1 entity)                                                     │
│    action:                                                                     │
│      1. Find primary directional light                                         │
│      2. Pack light data into GPU buffers via LightBufferManager                │
│                                                                                 │
│  Priority 90 — ShadowCasterSystem                                              │
│    queries: ['transform', 'shadow']                                            │
│    matches: Maple, Boulder, Terrain (3 entities)                               │
│    action:  Collect mesh IDs of shadow casters into a list for ShadowPass      │
│                                                                                 │
│  Priority 100 — MeshRenderSystem                                               │
│    queries: ['transform', 'mesh']                                              │
│    matches: Maple, Boulder (2 entities — PrimitiveGeometry is separate)        │
│    action:  (detailed below)                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: MeshRenderSystem — Shader Variant Selection & GPU Upload              │
│  ─────────────────────────────────────────────────────────────────────────      │
│                                                                                 │
│  For each entity with [Transform, Mesh]:                                       │
│                                                                                 │
│  ┌─ Japanese Maple ─────────────────────────────────────────────────────┐      │
│  │  Components: Transform, Mesh, Material, Bounds, Shadow, Wind         │      │
│  │  Environment: IBL active, Shadows enabled                            │      │
│  │  Has textures: yes (from GLB)                                        │      │
│  │                                                                      │      │
│  │  1. Compute feature set:                                             │      │
│  │     → entity has WindComponent       → include 'wind'                │      │
│  │     → entity has MeshComponent.textures → include 'textured'         │      │
│  │     → sceneEnvironment has IBL       → include 'ibl'                 │      │
│  │     → sceneEnvironment has shadows   → include 'shadow'              │      │
│  │                                                                      │      │
│  │  2. Shader variant key: "ibl+shadow+textured+wind"                   │      │
│  │                                                                      │      │
│  │  3. ShaderVariantCache lookup:                                       │      │
│  │     → Cache miss (first frame with wind) → ShaderComposer.compose()  │      │
│  │     → Injects wind vertex displacement + IBL ambient + shadow        │      │
│  │     → Compiles WGSL → creates GPURenderPipeline → cached             │      │
│  │                                                                      │      │
│  │  4. Write per-object uniforms to GPU:                                │      │
│  │     → modelMatrix from TransformComponent                            │      │
│  │     → albedo, metallic, roughness from MaterialComponent             │      │
│  │     → windDisplacementX = 0.12  ← from WindComponent.displacement    │      │
│  │     → windDisplacementZ = -0.08 ← from WindComponent.displacement    │      │
│  │     → windAnchorHeight = 0.3    ← from WindComponent.anchorHeight    │      │
│  │     → windTime = 12.34          ← from windManager.time              │      │
│  │                                                                      │      │
│  │  5. objectRenderer.setTransform(meshId, modelMatrix)                 │      │
│  └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                 │
│  ┌─ Boulder ────────────────────────────────────────────────────────────┐      │
│  │  Components: Transform, Mesh, Material, Bounds, Shadow               │      │
│  │  NO WindComponent → no 'wind' in feature set                         │      │
│  │                                                                      │      │
│  │  1. Feature set: textured, ibl, shadow                               │      │
│  │  2. Shader variant key: "ibl+shadow+textured"                        │      │
│  │     → Cache hit (already compiled earlier)                           │      │
│  │                                                                      │      │
│  │  3. Write per-object uniforms:                                       │      │
│  │     → modelMatrix, material properties                               │      │
│  │     → NO wind uniforms (not in this variant's struct)                │      │
│  │                                                                      │      │
│  │  4. objectRenderer.setTransform(meshId, modelMatrix)                 │      │
│  └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                 │
│  Group entities by shader variant key:                                         │
│    "ibl+shadow+textured+wind" → [Maple]                                        │
│    "ibl+shadow+textured"      → [Boulder]                                      │
│                                                                                 │
│  This grouping is passed to the render passes so each group uses one           │
│  pipeline set call.                                                            │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: GPUForwardPipeline.render() — Render Passes                           │
│  ─────────────────────────────────────────────────────────────────────────      │
│                                                                                 │
│  The pipeline creates a command encoder and executes passes in order:           │
│                                                                                 │
│  ShadowPass (scene category):                                                  │
│    → Queries world.query('transform', 'mesh', 'shadow') OR reads               │
│      ShadowCasterSystem's collected list                                       │
│    → For each shadow-casting entity:                                           │
│        objectRenderer.renderShadowPass(encoder, meshIds, lightMatrix)          │
│    → Terrain shadow: terrain.manager.renderShadow(encoder, lightMatrix)        │
│    → CSM cascades unchanged                                                    │
│                                                                                 │
│  SkyPass (scene category):                                                     │
│    → skyRenderer.render() — unchanged                                          │
│                                                                                 │
│  GroundPass (scene category):                                                  │
│    → Queries world.queryFirst('terrain')                                       │
│    → terrain.manager.render() — CDLOD renderer unchanged                      │
│                                                                                 │
│  OpaquePass (scene category):                                                  │
│    → For each shader variant group from MeshRenderSystem:                      │
│        pipeline = shaderVariantCache.get(variantKey)                           │
│        passEncoder.setPipeline(pipeline)                                       │
│        passEncoder.setBindGroup(0, globalBindGroup)                            │
│        passEncoder.setBindGroup(3, sceneEnvironment.bindGroup)                 │
│                                                                                 │
│        For each entity in this variant group:                                  │
│          meshIds = entity.getComponent('mesh').gpuMeshIds                      │
│          For each meshId:                                                      │
│            passEncoder.setBindGroup(1, mesh.modelBindGroup)  ← model+material  │
│            passEncoder.setBindGroup(2, mesh.textureBindGroup)                  │
│            passEncoder.setVertexBuffer(0, mesh.vertexBuffer)                   │
│            passEncoder.drawIndexed(mesh.indexCount)                            │
│                                                                                 │
│    → Maple draws with "ibl+shadow+textured+wind" pipeline                     │
│      (shader reads windDisplacementX/Z from uniforms,                          │
│       applies vertex displacement in vs_main)                                  │
│    → Boulder draws with "ibl+shadow+textured" pipeline                         │
│      (no wind code in this shader variant at all — zero cost)                  │
│                                                                                 │
│  VegetationPass (scene category):                                              │
│    → Queries world.queryFirst('terrain', 'vegetation')                         │
│    → vegetation.manager.render(encoder, camera) — own shaders, own pipeline    │
│                                                                                 │
│  TransparentPass (scene category):                                             │
│    → Queries world.queryFirst('ocean')                                         │
│    → ocean.manager.render() — WaterRendererGPU, own shaders                   │
│                                                                                 │
│  ─── POST-PROCESSING ───                                                       │
│    → SSAO, tonemapping, gamma — unchanged                                      │
│                                                                                 │
│  ─── VIEWPORT PASSES (after post-processing) ───                               │
│  OverlayPass:                                                                  │
│    → Grid, gizmos — unchanged                                                 │
│  SelectionMaskPass:                                                            │
│    → Queries world selection state for selected entity IDs                     │
│    → Gets meshIds from selected entities' MeshComponent                        │
│  SelectionOutlinePass:                                                         │
│    → Renders outline from mask — unchanged                                     │
│                                                                                 │
│  Submit command buffer → GPU executes                                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### What ObjectRendererGPU Does vs. Doesn't Do

`ObjectRendererGPU` remains the **GPU-side mesh pool**. It manages vertex buffers, index
buffers, uniform buffers, and bind groups. It does NOT change structurally.

| Responsibility | Owner |
|---|---|
| Uploading mesh geometry to GPU | `ObjectRendererGPU.addMesh()` — called by `MeshComponent.initWebGPU()` |
| Writing model matrices to GPU | `ObjectRendererGPU.setTransform()` — called by `MeshRenderSystem` |
| Writing material uniforms to GPU | `ObjectRendererGPU` (internal) or `MeshRenderSystem` writes composed uniform buffer |
| Pipeline selection (which shader) | `ShaderVariantCache` — replaces 8 hardcoded pipelines |
| Draw call issuing | Render passes call `objectRenderer.renderMeshes()` with explicit pipeline + mesh IDs |
| Shadow pass rendering | `ObjectRendererGPU.renderShadowPass()` — unchanged |
| Selection mask rendering | `ObjectRendererGPU.renderSelectionMask()` — mesh IDs from World selection state |

### New Method on ObjectRendererGPU

```typescript
/** Render specific meshes with an externally-provided pipeline (from ShaderVariantCache) */
renderMeshes(
  passEncoder: GPURenderPassEncoder,
  meshIds: number[],
  pipeline: GPURenderPipeline,
  environmentBindGroup: GPUBindGroup
): void;
```

The existing `renderWithSceneEnvironment()` remains during migration as a convenience
wrapper that uses the old hardcoded pipelines. It's deprecated once the shader composition
system is fully wired.

### Data Flow Summary

```
WindManager (global)                    MeshRenderSystem
  │ calculateWindForce()                     │
  ▼                                          │
WindSystem                                   │
  │ updateObjectPhysics()                    │
  │ per entity with [wind]                   │
  ▼                                          │
WindComponent.displacement = [0.12, -0.08]   │
                                             │
  ┌──────────────────────────────────────────┘
  │  reads WindComponent.displacement
  │  reads MaterialComponent.albedo/metallic/roughness
  │  reads TransformComponent.modelMatrix
  ▼
Per-Object Uniform Buffer (GPU)
  ├── modelMatrix (from TransformComponent)
  ├── albedo, metallic, roughness (from MaterialComponent)
  ├── windDisplacementX = 0.12 (from WindComponent)
  ├── windDisplacementZ = -0.08 (from WindComponent)
  ├── windAnchorHeight = 0.3 (from WindComponent)
  └── windTime = 12.34 (from WindManager)
           │
           ▼
Composed Shader (variant: "ibl+shadow+textured+wind")
  vs_main:
    localPos = applyWind(localPos, perObject.windTime)  ← reads wind uniforms
    worldPos = perObject.model * vec4f(localPos, 1.0)
  fs_main:
    shadow = sampleShadow(...)                          ← shadow feature
    direct = pbrDirectional(...)
    ambient = sampleIBL(...)                            ← IBL feature
    texColor = textureSample(baseColorTexture, ...)     ← textured feature
    return vec4f(color, alpha)
```

---

## Appendix D: Lighting System Overhaul (Post-ECS Follow-Up)

> **Reference:** `docs/lighting-system-migration-plan.md` — the original lighting plan was designed
> around the `Scene`/`SceneObject` hierarchy. With ECS, the architectural half of that plan is
> subsumed; only the feature work (multi-light GPU pipeline, new light types) remains.

### How Lighting Maps to ECS

The lighting plan solved two problems:
1. **Architectural** — Move lights from `LightingManager` into `Scene`
2. **Feature** — Add point/spot/area lights with proper GPU pipeline

ECS solves problem #1 completely. Lights become entities with a `LightComponent`. The
lighting overhaul post-ECS only needs to solve problem #2.

### LightComponent (Expanded for Multi-Light)

The basic `LightComponent` created during ECS Phase 3 expands to cover all light types:

```typescript
class LightComponent extends Component {
  readonly type = 'light';

  lightType: 'directional' | 'point' | 'spot' | 'area' | 'hdr';
  enabled: boolean = true;
  color: [number, number, number] = [1, 1, 1];
  intensity: number = 1.0;
  castsShadow: boolean = false;

  // Directional-specific
  azimuth?: number;            // 0-360°
  elevation?: number;          // -90 to 90°
  ambientIntensity?: number;

  // Point/Spot-specific
  range?: number;

  // Spot-specific
  innerConeAngle?: number;
  outerConeAngle?: number;

  // Cookie (spot/directional)
  cookieTexturePath?: string | null;
  cookieAtlasIndex?: number;
  cookieIntensity?: number;
  cookieTiling?: [number, number];

  // Area-specific (future)
  width?: number;
  height?: number;
  shape?: 'rect' | 'disk';

  // Shadow atlas (managed by ShadowSystem, not owned by component)
  shadowAtlasIndex: number = -1;
}
```

### LightingSystem — Replaces LightingManager

```typescript
class LightingSystem extends System {
  readonly name = 'lighting';
  readonly requiredComponents = ['transform', 'light'] as const;
  priority = 80; // After transform, before render

  private lightBufferManager: LightBufferManager;

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    // 1. Find the primary directional light
    const dirLightEntity = entities.find(e => {
      const lc = e.getComponent<LightComponent>('light');
      return lc.lightType === 'directional' && lc.enabled;
    });

    // 2. Collect point/spot lights with CPU frustum culling
    const pointEntities = entities.filter(e => {
      const lc = e.getComponent<LightComponent>('light');
      return lc.lightType === 'point' && lc.enabled;
    });
    const spotEntities = entities.filter(e => {
      const lc = e.getComponent<LightComponent>('light');
      return lc.lightType === 'spot' && lc.enabled;
    });

    // 3. Pack into GPU buffers
    this.lightBufferManager.update(dirLightEntity, pointEntities, spotEntities, ctx.cameraFrustum);
  }
}
```

### Multi-Light Shader Feature Module

Multi-light support integrates naturally as a shader composition feature:

```typescript
const multiLightFeature: ShaderFeature = {
  id: 'multi-light',
  stage: 'fragment',
  resources: [
    { name: 'lightCounts', kind: 'uniform', wgslType: 'LightCounts',
      group: 'environment', provider: 'LightingSystem' },
    { name: 'pointLightsBuffer', kind: 'storage',
      group: 'environment', provider: 'LightingSystem' },
    { name: 'spotLightsBuffer', kind: 'storage',
      group: 'environment', provider: 'LightingSystem' },
  ],
  functions: `
    fn evaluatePointLight(light: PointLightData, worldPos: vec3f, N: vec3f, V: vec3f,
                          albedo: vec3f, metallic: f32, roughness: f32) -> vec3f {
      let L = light.position - worldPos;
      let distance = length(L);
      if (distance > light.range) { return vec3f(0.0); }
      let Lnorm = L / distance;
      let attenuation = pow(saturate(1.0 - pow(distance / light.range, 4.0)), 2.0);
      return pbrDirectional(N, V, Lnorm, albedo, metallic, roughness,
                            light.color * light.intensity) * attenuation;
    }

    fn evaluateSpotLight(light: SpotLightData, worldPos: vec3f, N: vec3f, V: vec3f,
                         albedo: vec3f, metallic: f32, roughness: f32) -> vec3f {
      // Point attenuation + cone falloff
      let L = light.position - worldPos;
      let distance = length(L);
      if (distance > light.range) { return vec3f(0.0); }
      let Lnorm = L / distance;
      let attenuation = pow(saturate(1.0 - pow(distance / light.range, 4.0)), 2.0);
      let theta = dot(Lnorm, normalize(-light.direction));
      let spotFalloff = saturate((theta - light.outerCos) / (light.innerCos - light.outerCos));
      return pbrDirectional(N, V, Lnorm, albedo, metallic, roughness,
                            light.color * light.intensity) * attenuation * spotFalloff;
    }

    fn evaluateAllLights(worldPos: vec3f, N: vec3f, V: vec3f,
                         albedo: vec3f, metallic: f32, roughness: f32) -> vec3f {
      var totalLight = vec3f(0.0);
      for (var i = 0u; i < lightCounts.numPoint; i++) {
        totalLight += evaluatePointLight(pointLightsBuffer[i], worldPos, N, V,
                                         albedo, metallic, roughness);
      }
      for (var i = 0u; i < lightCounts.numSpot; i++) {
        totalLight += evaluateSpotLight(spotLightsBuffer[i], worldPos, N, V,
                                        albedo, metallic, roughness);
      }
      return totalLight;
    }
  `,
  fragmentInject: `
    color += evaluateAllLights(input.worldPosition, N, V, albedo, metallic, roughness);
  `,
};
```

The `multi-light` feature is included in the shader variant key whenever the scene has
non-directional light entities. The `MeshRenderSystem` checks
`world.query('light').length > directionalCount` to decide.

### Mapping: Original Lighting Phases → Post-ECS Steps

| Original Lighting Phase | Post-ECS Step | Notes |
|---|---|---|
| Phase 1: Scene Light Management | **Done by ECS** | Lights are entities. `world.query('light')` replaces `Scene.getPointLights()`. `LightingManager` deleted in ECS Phase 8. |
| Phase 2: New Light Types (SpotLight) | **Step 1** | Create spot light factory function, expand `LightComponent` fields. |
| Phase 3: GPU Pipeline Integration | **Steps 2-3** | Create `LightingSystem` + `LightBufferManager`. Register `multiLightFeature` in shader composer. |
| Phase 3.5: Shadow Atlas + Cookies | **Step 4** | Optional `CookieComponent` on spot lights. Shadow atlas managed by `ShadowRendererGPU`, indices stored in `LightComponent.shadowAtlasIndex`. |
| Phase 4: UI + Viewport Visualization | **Step 5** | `LightVisualizerGPU` queries `world.query('light')`. Light properties panel reads `LightComponent`. Selection works automatically via ECS. |
| Phase 5: Deprecation | **Done by ECS Phase 8** | `LightingManager` already deleted. |

### Recommended Implementation Order (Post-ECS)

```
Step 1: Expand LightComponent with point/spot fields + factory functions  (1 day)
Step 2: Create LightingSystem + LightBufferManager                        (2 days)
Step 3: Create multiLightFeature shader module                            (2 days)
Step 4: Shadow atlas + cookie textures                                    (2-3 days)
Step 5: LightVisualizerGPU (viewport helpers)                            (2 days)
Step 6: Light properties UI panel                                         (1-2 days)

Total: ~10-12 days (post-ECS)
```

### What Becomes Simpler with ECS

| Task | Without ECS | With ECS |
|---|---|---|
| Adding a point light | `Scene.addPointLight()` + update `lights` map | `world.createEntity()` + `addComponent(new LightComponent(...))` |
| Finding shadow-casting lights | `scene.getShadowCastingLights()` | `world.query('light').filter(...)` |
| Light selection + gizmo | Custom handling per light type | Automatic — entities support selection |
| Serializing lights | Separate `lights[]` array in scene file | Components serialize generically |
| Multi-light shader support | Modify monolithic `object.wgsl` | Register `multiLightFeature`, composer injects light loops |
| Adding area lights later | New class, new `Scene.addAreaLight()`, update serialization | Expand `LightComponent` fields, new factory |
