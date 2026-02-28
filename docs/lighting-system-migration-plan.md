# Lighting System Migration Plan — ECS Edition

> **Revision 2** — Updated for ECS architecture. The original plan targeted `Scene`/`SceneObject`.
> The engine now uses Entity-Component-System (`World`, `Entity`, `LightComponent`).
> This revision preserves all GPU-level design (shaders, buffers, shadow atlas, cookies)
> and rewrites the architectural integration to use ECS primitives.

---

## Overview

Migrate lights from `LightingManager` (demo-layer singleton) to ECS entities with
`LightComponent`, processed by a `LightingSystem`. Enable multi-light rendering
(point, spot) with proper GPU pipeline integration.

### What Already Exists (ECS Infrastructure)

| Component / System | Status | Notes |
|---|---|---|
| `LightComponent` | ✅ Exists | `lightType`, `color`, `intensity`, `castsShadow`, `azimuth/elevation`, `range`, `innerConeAngle/outerConeAngle` |
| `createDirectionalLightEntity()` | ✅ Exists | Factory in `factories.ts` |
| `SystemContext.world` | ✅ Exists | All systems receive `World` reference via context |
| `World.queryNearby()` | ✅ Exists | BVH-accelerated radius query (for light culling) |
| `World.queryFrustum()` | ✅ Exists | BVH frustum culling |
| `FrustumCullSystem` | ✅ Exists | CPU frustum culling integrated into render pipeline |
| `Frustum` class | ✅ Exists | Plane extraction from VP matrix |
| `ShadowRendererGPU` + CSM | ✅ Exists | Full cascade shadow map system |
| `SceneEnvironment` (Group 3) | ✅ Exists | Shadow maps, IBL cubemaps, CSM array |
| `VariantRenderer` + ShaderComposer | ✅ Exists | Composed shader pipeline with feature modules |

### What Needs To Be Built

| Item | Description |
|---|---|
| `LightingSystem` | ECS system (priority 80) that queries light entities, computes directions, packs GPU buffers |
| `LightBufferManager` | GPU buffer manager for point/spot light data |
| `multiLightFeature` | Shader composition feature module for point/spot light loops |
| Viewport data flow change | Read light params from ECS instead of `LightingManager → setLightParams()` |
| Pass integration | `ShadowPass`, `OpaquePass`, `SkyPass` query `context.world` for directional light |
| `LightingManager` removal | Delete demo-layer singleton, remove `Viewport.setLightParams()` |

---

## Architecture: Current vs. Target

### Current Flow (LightingManager)

```
LightingTab.tsx → EnvironmentPanelBridge → LightingManager → Viewport.setLightParams()
                                                                    ↓
                                                        GPUForwardPipeline.render()
                                                        options.lightDirection
                                                        options.sunIntensity
                                                        options.ambientIntensity
```

**Problems:**
- `LightingManager` lives in demo layer, bypasses ECS
- Light params passed as render options, not queried from world
- Cannot select/serialize lights with other entities
- Only single directional light — no point/spot rendering

### Target Flow (ECS)

```
LightingTab.tsx → writes to LightComponent on "Sun" entity
                                    ↓
LightingSystem (priority 80)
  queries: world.query('light')
  computes: direction from azimuth/elevation
  writes:   LightBufferManager GPU buffers
                                    ↓
Render Passes read from world:
  ShadowPass: world.queryFirst('light') → get direction for CSM
  SkyPass: world.queryFirst('light') → get sun direction for sky/IBL
  OpaquePass: LightBufferManager provides light data to shaders
```

---

## LightComponent (Already Exists — Expansion Needed)

The existing `LightComponent` has the basic fields. For full multi-light support, add:

```typescript
class LightComponent extends Component {
  readonly type: ComponentType = 'light';

  lightType: 'directional' | 'point' | 'spot' = 'directional';
  enabled: boolean = true;
  color: [number, number, number] = [1, 1, 1];
  intensity: number = 1.0;
  castsShadow: boolean = false;

  // Directional-specific
  azimuth: number = 45;
  elevation: number = 45;
  ambientIntensity: number = 0.3;

  // Point/Spot-specific
  range: number = 10;

  // Spot-specific
  innerConeAngle: number = Math.PI / 6;   // 30°
  outerConeAngle: number = Math.PI / 4;   // 45°

  // ====== Computed by LightingSystem each frame ======
  /** Computed world-space direction (for directional lights, from azimuth/elevation) */
  direction: [number, number, number] = [0, -1, 0];
  /** Computed effective color (color * intensity) */
  effectiveColor: [number, number, number] = [1, 1, 1];
  /** Intensity factor (0 at night, 1 during day — for directional) */
  sunIntensityFactor: number = 1.0;

  // ====== Shadow atlas (managed by ShadowRendererGPU, not owned) ======
  shadowAtlasIndex: number = -1;

  // ====== Cookie textures (Phase 3.5) ======
  cookieTexturePath: string | null = null;
  cookieAtlasIndex: number = -1;
  cookieIntensity: number = 1.0;
  cookieTiling: [number, number] = [1, 1];
  cookieOffset: [number, number] = [0, 0];
}
```

The `direction`, `effectiveColor`, and `sunIntensityFactor` fields are **written by
LightingSystem** each frame — not by the UI directly. The UI writes `azimuth`, `elevation`,
`intensity`, `color`; the system computes the derived values.

---

## LightingSystem — Replaces LightingManager

```typescript
// src/core/ecs/systems/LightingSystem.ts

class LightingSystem extends System {
  readonly name = 'lighting';
  readonly requiredComponents: readonly ComponentType[] = ['light'];
  priority = 80; // After transform/bounds, before shadow caster / render

  private lightBufferManager: LightBufferManager | null = null;

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    // 1. Process directional lights — compute direction from azimuth/elevation
    for (const entity of entities) {
      const light = entity.getComponent<LightComponent>('light');
      if (!light || !light.enabled) continue;

      if (light.lightType === 'directional') {
        // Compute direction from azimuth/elevation (same math as DirectionalLight.ts)
        const azRad = light.azimuth * Math.PI / 180;
        const elRad = light.elevation * Math.PI / 180;
        const cosEl = Math.cos(elRad);
        light.direction = [
          Math.sin(azRad) * cosEl,
          Math.sin(elRad),
          Math.cos(azRad) * cosEl,
        ];

        // Compute effective color
        light.effectiveColor = [
          light.color[0] * light.intensity,
          light.color[1] * light.intensity,
          light.color[2] * light.intensity,
        ];

        // Sun intensity factor (0 at night when elevation < 0)
        light.sunIntensityFactor = Math.max(0, Math.min(1,
          light.elevation / 10 // Smooth transition near horizon
        ));
      }
    }

    // 2. Pack point/spot lights into GPU buffers (Phase 2+)
    if (this.lightBufferManager) {
      const pointLights = entities.filter(e => {
        const l = e.getComponent<LightComponent>('light');
        return l?.lightType === 'point' && l.enabled;
      });
      const spotLights = entities.filter(e => {
        const l = e.getComponent<LightComponent>('light');
        return l?.lightType === 'spot' && l.enabled;
      });

      this.lightBufferManager.update(pointLights, spotLights);
    }
  }
}
```

---

## Viewport Integration — Reading Light Data from ECS

Currently `Viewport.renderWebGPU()` reads from `this.lightParams` (set by LightingManager).
After migration, it reads from the ECS world:

```typescript
// In Viewport.renderWebGPU():

// BEFORE:
const isHDR = this.lightParams?.type === 'hdr';
const sunIntensity = (this.lightParams as any)?.sunIntensity ?? 20;
const lightDirection = (this.lightParams as any)?.direction;
const lightColor = (this.lightParams as DirectionalLightParams).effectiveColor;

// AFTER:
const dirLightEntity = this._world.queryFirst('light');
const dirLight = dirLightEntity?.getComponent<LightComponent>('light');

const lightDirection = dirLight?.direction ?? [0.3, 0.8, 0.5];
const sunIntensity = (dirLight?.intensity ?? 20) * (dirLight?.sunIntensityFactor ?? 1.0);
const lightColor = dirLight?.effectiveColor ?? [1.0, 1.0, 1.0];
const ambientIntensity = dirLight?.ambientIntensity ?? 0.3;
```

The `LightingSystem` has already computed `direction`, `effectiveColor`, and
`sunIntensityFactor` during the ECS update pass — the Viewport just reads the results.

### Render Pass Changes

All passes already have `ctx.world` available. Changes are minimal:

| Pass | Current Source | New Source |
|---|---|---|
| `ShadowPass` | `ctx.options.lightDirection` | `ctx.world.queryFirst('light').getComponent('light').direction` |
| `SkyPass` | `ctx.options.sunIntensity` | Read from light entity |
| `OpaquePass` | `renderParams.lightDirection` | Read from light entity |
| `TransparentPass` | `ctx.options.sunDirection` | Read from light entity |
| `DynamicSkyIBL` | `sunDirection` param | Read from light entity |

---

## GPU Pipeline: Multi-Light Support

### Light Data Structures (WGSL)

```wgsl
struct PointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct SpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,
  cookieAtlasIndex: i32,
  cookieIntensity: f32,
};

struct LightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};
```

### LightBufferManager

```typescript
// src/core/gpu/renderers/LightBufferManager.ts

export class LightBufferManager {
  private lightCountsBuffer: GPUBuffer;
  private pointLightsBuffer: GPUBuffer;    // storage buffer
  private spotLightsBuffer: GPUBuffer;     // storage buffer

  /**
   * Update GPU buffers from ECS light entities.
   * CPU frustum culling filters to visible lights only.
   */
  update(pointEntities: Entity[], spotEntities: Entity[]): void {
    // Pack position/range/color/intensity into typed arrays
    // Upload to GPU storage buffers
  }

  getBindGroupEntries(): GPUBindGroupEntry[] { /* ... */ }
}
```

### Multi-Light Shader Feature

Integrates into the existing shader composition system as a feature module:

```typescript
// src/core/gpu/shaders/features/multiLightFeature.ts

const multiLightFeature: ShaderFeature = {
  id: 'multi-light',
  stage: 'fragment',
  resources: [
    { name: 'lightCounts', kind: 'uniform', group: 'environment', provider: 'LightingSystem' },
    { name: 'pointLightsBuffer', kind: 'storage', group: 'environment', provider: 'LightingSystem' },
    { name: 'spotLightsBuffer', kind: 'storage', group: 'environment', provider: 'LightingSystem' },
  ],
  functions: `/* point/spot attenuation + cone falloff + evaluateAllLights() */`,
  fragmentInject: `color += evaluateAllLights(worldPos, N, V, albedo, metallic, roughness);`,
};
```

The `MeshRenderSystem` includes `'multi-light'` in the shader variant key when the world
has point/spot light entities. The ShaderComposer injects the light evaluation loop.

---

## Shadow Architecture

### CSM (Unchanged)

The existing CSM system continues to work exclusively with the primary directional light.
`ShadowPass` queries `context.world.queryFirst('light')` instead of reading from options.

### Shadow Atlas (Phase 3.5)

For spot/point light shadows, `ShadowRendererGPU` manages a centralized shadow atlas:

```
ShadowRendererGPU:
  ├── CSM cascade array (4 layers) ← primary directional only
  └── Shadow atlas (texture_depth_2d_array) ← all other lights
       Layer 0: SpotLight #1
       Layer 1: SpotLight #2
       ...
```

Light entities store `shadowAtlasIndex` (assigned by `ShadowRendererGPU`), never own
GPU textures directly.

### Cookie Textures (Phase 3.5)

Light cookies modulate output with a 2D pattern. Managed as a `texture_2d_array` atlas
by `LightBufferManager`. Sampling reuses the shadow projection math.

---

## UI Changes

### LightingTab → Reads/Writes LightComponent

The existing `LightingTab.tsx` (Environment Panel) currently writes to `LightingManager`.
After migration, it reads/writes directly to the `LightComponent` on the directional
light entity:

```typescript
// Get the directional light entity from world
const lightEntity = world.queryFirst('light');
const lightComp = lightEntity?.getComponent<LightComponent>('light');

// Read current values for UI
const azimuth = lightComp?.azimuth ?? 45;
const elevation = lightComp?.elevation ?? 45;

// Write changes
lightComp.azimuth = newAzimuth;
lightComp.elevation = newElevation;
// LightingSystem computes direction/effectiveColor next frame
```

### Objects Panel — Light Entities in Hierarchy

Light entities appear in the Objects Panel like any other entity:

```
Objects
├── ☀️ Sun (Directional Light)
├── 💡 Point Light 1
├── 🔦 Spot Light 1
├── 🏠 Mountain House
├── 🌳 Japanese Maple
└── 🪨 Boulder
```

Selection, deletion, duplication, and serialization work automatically via ECS.

### Light Properties in Object Panel

When a light entity is selected, the Object Panel shows a `LightPropertiesSubPanel`:

- **All lights**: Enabled toggle, intensity slider, color picker, cast shadows toggle
- **Directional**: Azimuth (0-360°), elevation (-90 to 90°), ambient intensity
- **Point**: Range slider
- **Spot**: Range, inner/outer cone angles, cookie texture picker

### Add Light Menu

```typescript
// In MenuBar:
{ id: 'directional-light', label: '☀️ Directional Light', onClick: () => createDirectionalLightEntity(world) },
{ id: 'point-light', label: '💡 Point Light', onClick: () => createPointLightEntity(world) },
{ id: 'spot-light', label: '🔦 Spot Light', onClick: () => createSpotLightEntity(world) },
```

---

## Viewport Light Visualization

### LightVisualizerGPU

A new renderer following the `GizmoRendererGPU` pattern (unlit wireframe overlays, no depth test):

| Light Type | Visualization |
|---|---|
| Directional | Arrow + parallel rays showing direction |
| Point | 3 wireframe circles (XY, XZ, YZ) at `light.range` radius |
| Spot | Wireframe cone (inner + outer angles) + range |

Renders during the overlay pass alongside gizmos. Queries `world.query('light')` for entities.

### Light Selection (CPU Raycast)

On click, test ray against light position bounding spheres (small fixed radius).
Same approach as existing gizmo hit testing.

---

## Entity Factory Functions

```typescript
// src/core/ecs/factories.ts

function createDirectionalLightEntity(world: World, options?: {
  azimuth?: number;
  elevation?: number;
  intensity?: number;
  ambient?: number;
}): Entity;  // Already exists

function createPointLightEntity(world: World, options?: {
  position?: [number, number, number];
  range?: number;
  color?: [number, number, number];
  intensity?: number;
}): Entity;  // New

function createSpotLightEntity(world: World, options?: {
  position?: [number, number, number];
  direction?: [number, number, number];
  range?: number;
  innerAngle?: number;
  outerAngle?: number;
  color?: [number, number, number];
  intensity?: number;
}): Entity;  // New
```

---

## Migration Phases

### Phase 1: LightingSystem + Viewport Data Flow (Foundation)

**Goal**: Replace `LightingManager → Viewport.setLightParams()` with ECS-based flow.
No visual changes — same directional light, same behavior.

- [ ] Create `LightingSystem` (priority 80) — computes direction/effectiveColor from LightComponent
- [ ] Register `LightingSystem` in `Viewport.ts` constructor
- [ ] Create default directional light entity at world initialization (replaces LightingManager auto-create)
- [ ] Update `Viewport.renderWebGPU()` to read light params from world query instead of `this.lightParams`
- [ ] Update `ShadowPass` to query `context.world` for directional light direction
- [ ] Update `SkyPass` / `DynamicSkyIBL` to read sun direction from world
- [ ] Update `TransparentPass` (water) to read sun direction from world
- [ ] Update `LightingTab.tsx` to read/write `LightComponent` on the light entity
- [ ] Remove `Viewport.setLightParams()` method
- [ ] Remove `LightingManager` class and file
- [ ] Remove `options.lightDirection` / `options.sunIntensity` from `RenderOptions`

**Compatibility**: Existing CSM, IBL, sky rendering work identically — only the data source changes.

### Phase 2: Point/Spot Light GPU Pipeline

**Goal**: Multi-light rendering with proper attenuation.

- [ ] Create `LightBufferManager` (GPU storage buffers for point/spot lights)
- [ ] Create `multiLightFeature` shader module (attenuation functions + light loop)
- [ ] Register feature in ShaderComposer
- [ ] Update `MeshRenderSystem` to include `'multi-light'` in variant key when point/spot lights exist
- [ ] Create `createPointLightEntity()` and `createSpotLightEntity()` factories
- [ ] CPU frustum culling for point/spot lights using `World.queryNearby()` or `Frustum.intersectsAABB()`
- [ ] Add light count limit (~16 initially, sufficient for editor)

### Phase 3: Shadow Atlas + Cookies

**Goal**: Spot/point light shadows and cookie texture projection.

- [ ] Create shadow atlas `texture_depth_2d_array` in `ShadowRendererGPU`
- [ ] Implement `allocateShadowSlot()` / `freeShadowSlot()`
- [ ] Render spot light shadow maps into atlas layers
- [ ] Create cookie atlas `texture_2d_array` in `LightBufferManager`
- [ ] Cookie sampling in spot light shader (reuses light-space projection)
- [ ] Cookie picker UI using existing `AssetPickerModal`

### Phase 4: UI + Viewport Visualization

**Goal**: Full editor integration.

- [ ] Light entities in Objects Panel with type icons (☀️💡🔦)
- [ ] `LightPropertiesSubPanel` in Object Panel
- [ ] "Add Light" submenu in MenuBar
- [ ] Create `LightVisualizerGPU` renderer (wireframe sphere/cone/arrow)
- [ ] Integrate into overlay pass
- [ ] CPU raycast selection for light handles
- [ ] "Show Light Helpers" toggle

---

## Light Count Limits

| Phase | Max Visible Lights | Technique |
|---|---|---|
| Phase 2 | ~8-16 | Forward + CPU frustum culling |
| Phase 3 | ~8-16 | + Shadow atlas for spot/point |
| Future | ~500-1000 | Forward+ tiled shading (compute) |
| Future | ~4000+ | Clustered forward (3D data structure) |

For a scene builder / 3D editor, 8-16 lights is sufficient. CPU frustum culling
(trivial sphere-frustum test, infrastructure already built) ensures off-screen
lights don't waste GPU cycles.

---

## File Structure

```
src/core/ecs/
  systems/
    LightingSystem.ts                    ← NEW (Phase 1)
  components/
    LightComponent.ts                    ← EXISTS (expand computed fields)

src/core/gpu/
  renderers/
    LightBufferManager.ts                ← NEW (Phase 2)
    LightVisualizerGPU.ts                ← NEW (Phase 4)
  shaders/
    features/
      multiLightFeature.ts               ← NEW (Phase 2)
    common/
      lights.wgsl                        ← NEW (Phase 2) — light structs + attenuation

src/demos/sceneBuilder/
  lightingManager.ts                     ← DELETE (Phase 1)
```

---

## Implementation Order Estimate

| Phase | Effort | Dependencies |
|---|---|---|
| Phase 1: LightingSystem + data flow | 2-3 days | None (current ECS is sufficient) |
| Phase 2: Multi-light GPU pipeline | 3-4 days | Phase 1 |
| Phase 3: Shadow atlas + cookies | 2-3 days | Phase 2 |
| Phase 4: UI + visualization | 2-3 days | Phase 1 |

**Total: ~9-13 days**

Phase 4 (UI) can run in parallel with Phase 2/3 since it only needs the data flow
from Phase 1.