# Lighting System Migration Plan: Lights as Scene Objects

## Overview

Migrate lights from a separate `LightingManager` to proper `SceneObject` instances managed by `Scene`, enabling unified serialization, selection, and scene graph integration.

> **Updated**: This plan has been revised to account for the Cascaded Shadow Map (CSM) system that was built after the original document was written. The new lighting system preserves and integrates with the existing CSM infrastructure.

---

## Architecture Flow Diagrams

### Current System (Before Migration)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              UI LAYER (Preact)                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────┐                                                       │
│  │   LightingTab.tsx    │  ← User adjusts azimuth, elevation, ambient, etc.    │
│  │   (Environment Panel)│                                                       │
│  └──────────┬───────────┘                                                       │
│             │ onChange()                                                        │
│             ▼                                                                   │
│  ┌──────────────────────────┐                                                   │
│  │ EnvironmentPanelBridge   │  ← Converts UI state to light params             │
│  │ context.onLightingChanged│                                                   │
│  └──────────┬───────────────┘                                                   │
└─────────────┼───────────────────────────────────────────────────────────────────┘
              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DEMO LAYER                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────┐      ┌──────────────────────┐                        │
│  │   LightingManager    │◄─────│   DirectionalLight   │  (SceneObject but      │
│  │  (separate manager)  │      │   PointLight         │   NOT in Scene!)       │
│  │                      │      │   HDRLight           │                        │
│  └──────────┬───────────┘      └──────────────────────┘                        │
│             │ getLightParams()                                                  │
│             ▼                                                                   │
│  ┌──────────────────────┐                                                       │
│  │      Viewport        │  ← Stores params, passes to pipeline                 │
│  │  setLightParams()    │                                                       │
│  └──────────┬───────────┘                                                       │
└─────────────┼───────────────────────────────────────────────────────────────────┘
              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CORE LAYER (GPU Pipeline)                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────┐                                     │
│  │       GPUForwardPipeline.render()      │                                     │
│  │  options.lightDirection                │  ← Light params passed as options  │
│  │  options.sunIntensity                  │                                     │
│  │  options.ambientIntensity              │                                     │
│  └──────────┬─────────────────────────────┘                                     │
│     ┌───────┴───────┬────────────────┬──────────────────┐                      │
│     ▼               ▼                ▼                  ▼                      │
│  ┌────────┐   ┌───────────┐   ┌──────────────┐  ┌─────────────────┐           │
│  │  Sky   │   │  Shadow   │   │  DynamicSky  │  │ SceneEnvironment│           │
│  │Renderer│   │ Renderer  │   │     IBL      │  │  (Group 3)      │           │
│  └────────┘   │ + CSM     │   └──────────────┘  │ bindings 0-8:   │           │
│               └───────────┘                      │ shadow, IBL,    │           │
│                                                  │ CSM array,      │           │
│                                                  │ CSM uniforms    │           │
│                                                  └─────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Problems with Current Architecture:**
- Light objects extend SceneObject but are NOT stored in Scene
- Separate data flow for lights vs. other scene objects
- LightingManager creates coupling between demo layer and core
- Light params passed as render options, not queried from scene
- Cannot select/serialize lights with other scene objects
- Only single directional light supported — no point/spot light rendering in shaders

---

### New System (After Migration)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              UI LAYER (Preact)                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────┐        ┌──────────────────────┐                      │
│  │   Objects Panel      │        │    Object Panel      │                      │
│  │  ├─ ☀️ Sun           │◄──────►│  (LightProperties    │                      │
│  │  ├─ 💡 Point Light   │ select │   Section shown      │                      │
│  │  ├─ 🔦 Spot Light    │        │   when light         │                      │
│  │  └─ 🏠 Models...     │        │   selected)          │                      │
│  └──────────┬───────────┘        └──────────┬───────────┘                      │
│             │ scene.select(lightId)         │ light.intensity = v              │
│             ▼                               ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐          │
│  │                    ObjectPanelBridge                             │          │
│  │                    (detects light selection)                     │          │
│  └──────────────────────────────┬───────────────────────────────────┘          │
│                                 │ direct property mutation                      │
└─────────────────────────────────┼───────────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CORE LAYER (Scene)                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────────┐          │
│  │                           Scene                                   │          │
│  │  objects: Map<string, SceneObject>                                │          │
│  │    ├─ Cubes, Planes, Models...                                    │          │
│  │    └─ ☀️💡🔦 Lights (now included!)                                │          │
│  │                                                                   │          │
│  │  lights: Map<string, Light>  (efficient query index)              │          │
│  │    ├─ DirectionalLight (sun) — primary drives CSM + IBL           │          │
│  │    ├─ PointLight[]                                                │          │
│  │    ├─ SpotLight[]                                                 │          │
│  │    └─ AreaLight[]                                                 │          │
│  │                                                                   │          │
│  │  Query: getDirectionalLight(), getPointLights(), getSpotLights()  │          │
│  └──────────────────────────────┬───────────────────────────────────┘          │
└─────────────────────────────────┼───────────────────────────────────────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              GPU PIPELINE                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│  GPUForwardPipeline.render():                                                   │
│    const dirLight = scene.getDirectionalLight();                               │
│    const pointLights = scene.getPointLights();                                 │
│                                                                                 │
│  ┌─────────────────────┐  ┌───────────────────┐  ┌─────────────────────┐      │
│  │  LightBufferManager │  │  ShadowPass       │  │  DynamicSkyIBL      │      │
│  │  (NEW)              │  │  (existing)        │  │  (existing)         │      │
│  │                     │  │                    │  │                     │      │
│  │  CPU frustum cull   │  │  Gets direction    │  │  Gets direction     │      │
│  │  point/spot lights  │  │  from dirLight in  │  │  from dirLight in   │      │
│  │  Pack into buffers  │  │  Scene (not opts)  │  │  Scene (not opts)   │      │
│  │  Upload to GPU      │  │  CSM unchanged     │  │                     │      │
│  └─────────────────────┘  └───────────────────┘  └─────────────────────┘      │
│                                                                                 │
│  SceneEnvironment (Group 3): UNCHANGED                                         │
│    b0: Shadow map | b1: Shadow sampler | b2-6: IBL | b7: CSM array | b8: CSM  │
│                                                                                 │
│  Light data: packed into Group 0 per-frame uniforms or storage buffers         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Benefits of New Architecture:**
- Lights are true scene objects — stored in Scene alongside models/primitives
- Unified selection — click a light in Objects Panel like any other object
- Unified serialization — lights save/load with scene
- Pipeline queries scene — no more passing light params as render options
- Multi-light support — point/spot lights with proper attenuation
- **CSM preserved** — existing cascade shadow system untouched, driven by primary directional light

---

## Current State Analysis

### Existing Infrastructure

| Component | Status | Notes |
|-----------|--------|-------|
| `Light` base class | ✅ Exists | Already extends `SceneObject` |
| `DirectionalLight` | ✅ Exists | Azimuth/elevation, intensity, color |
| `PointLight` | ✅ Exists | Position, range, color |
| `HDRLight` | ✅ Exists | Environment map light |
| `ShadowRendererGPU` | ✅ Exists | Full CSM support (2-4 cascades) |
| `CSMUtils.ts` | ✅ Exists | Cascade split calc, frustum fitting |
| `shadow-csm.wgsl` | ✅ Exists | Cascade selection, blending, PCF |
| `SceneEnvironment` | ✅ Exists | Group 3 bind group with CSM bindings 7-8 |
| `ShadowPass` | ✅ Exists | Pass-based architecture for shadow rendering |
| `LightingManager` | ❌ Problem | Demo-layer coupling, bypasses Scene |

### Problem: Inconsistent Architecture

| Object Type | Extends SceneObject? | Managed By |
|-------------|----------------------|------------|
| Primitive (Cube, etc.) | ✅ Yes | `Scene.objects` |
| ModelObject | ✅ Yes | `Scene.objects` |
| GPUTerrainSceneObject | ✅ Yes | `Scene.gpuTerrainObject` |
| OceanSceneObject | ✅ Yes | `Scene.oceanObject` |
| **DirectionalLight** | ✅ Yes | ❌ `LightingManager` (separate) |
| **PointLight** | ✅ Yes | ❌ `LightingManager.pointLights` |
| **HDRLight** | ✅ Yes | ❌ `LightingManager` (separate) |

### Current Bind Group Layout

```
Group 0: Per-frame global uniforms (camera, light direction, time)
Group 1: Per-material or per-renderer uniforms
Group 2: Textures (PBR textures, heightmaps, etc.)
Group 3: Environment (shared SceneEnvironment):
  binding 0: Shadow depth texture (single map)
  binding 1: Shadow comparison sampler
  binding 2: IBL diffuse cubemap
  binding 3: IBL specular cubemap
  binding 4: BRDF LUT texture
  binding 5: IBL cubemap sampler
  binding 6: IBL LUT sampler
  binding 7: CSM shadow map array (depth_2d_array, 4 cascades)
  binding 8: CSM uniforms buffer (matrices + splits + config)
```

---

## 1. Light Type Hierarchy

```
SceneObject
    └── Light (abstract base)
            ├── DirectionalLight    (sun, no position, direction only)
            ├── PointLight          (position + radius, omnidirectional)
            ├── SpotLight           (position + direction + cone angles)  [NEW]
            ├── AreaLight           (position + size + direction)         [NEW]
            ├── MeshLight           (emissive mesh, future)              [FUTURE]
            └── HDRILight           (environment map, no position)
```

### Existing Light Classes (keep & enhance)
- `Light.ts` — Base class, already extends `SceneObject`
- `DirectionalLight.ts` — Sun light
- `PointLight.ts` — Point light
- `HDRLight.ts` — HDR environment

### New Light Classes to Create
- `SpotLight.ts` — Cone-shaped light with inner/outer angles
- `AreaLight.ts` — Rectangular/disk area lights (future)

---

## 2. Light Class Definitions

### 2.1 SpotLight (New)

```typescript
// src/core/sceneObjects/lights/SpotLight.ts

export class SpotLight extends Light {
  public innerConeAngle: number = Math.PI / 6;   // 30°
  public outerConeAngle: number = Math.PI / 4;   // 45°
  public range: number = 10;
  
  constructor(name: string = 'Spot Light') {
    super('spot', name);
    this.castsShadow = true;
  }
  
  getDirection(): vec3 {
    const dir = vec3.create();
    vec3.transformQuat(dir, [0, 0, -1], this.rotationQuat);
    return dir;
  }
  
  getLightParams(): SpotLightParams { /* ... */ }
  serialize(): SerializedSpotLight { /* ... */ }
  deserialize(data: Partial<SerializedSpotLight>): void { /* ... */ }
}
```

### 2.2 Light Cookies (Projection Textures)

Light cookies (also called gobo textures or projection textures) modulate a light's output with a 2D pattern, creating effects like flashlight lens patterns, window blinds shadows, or stained glass projections.

#### Design

- **Texture-based, not procedural** — Arbitrary patterns require artist-authored textures. Procedural math can only approximate simple radial/grid shapes; real flashlight patterns, window frames, foliage shadows etc. need actual image data.
- **Optional per-light** — When no cookie is assigned (`cookieTextureIndex = -1`), the light uses its default smooth attenuation falloff (no texture sample needed).
- **Cookie texture atlas** — All cookie textures are stored in a single `texture_2d_array` managed by `LightBufferManager`. Each light references its layer index.
- **Reuses shadow projection math** — Cookie sampling uses the same light-space projection as shadow mapping. The fragment's world position is projected into the light's clip space and the cookie is sampled at those UV coordinates.

#### Light Class Properties

```typescript
// On SpotLight (and optionally DirectionalLight for "sun cookie" effects):
class SpotLight extends Light {
  // ... existing properties ...
  
  /** Asset path to cookie texture (from asset library), null = no cookie */
  cookieTexturePath: string | null = null;
  
  /** Atlas layer index, assigned by LightBufferManager. -1 = no cookie loaded */
  cookieAtlasIndex: number = -1;
  
  /** Cookie texture intensity multiplier (0-1, default 1) */
  cookieIntensity: number = 1.0;
  
  /** Cookie UV tiling (allows repeating pattern) */
  cookieTiling: [number, number] = [1, 1];
  
  /** Cookie UV offset */
  cookieOffset: [number, number] = [0, 0];
}
```

#### GPU Struct

```wgsl
struct SpotLightData {
  // ... existing fields ...
  cookieAtlasIndex: i32,     // -1 = no cookie, use default falloff
  cookieIntensity: f32,
  cookieTiling: vec2f,
  cookieOffset: vec2f,
};
```

#### Shader Sampling

```wgsl
fn sampleLightCookie(light: SpotLightData, worldPos: vec3f) -> vec3f {
  if (light.cookieAtlasIndex < 0) { return vec3f(1.0); }  // No cookie
  
  // Project world position into light space (same matrix used for shadow)
  let lightClip = light.lightSpaceMatrix * vec4f(worldPos, 1.0);
  var uv = lightClip.xy / lightClip.w * 0.5 + 0.5;
  
  // Apply tiling and offset
  uv = uv * light.cookieTiling + light.cookieOffset;
  
  // Sample cookie atlas (using regular sampler, not comparison)
  let cookie = textureSample(cookieAtlas, cookieSampler, uv, light.cookieAtlasIndex);
  return cookie.rgb * light.cookieIntensity;
}

// In lighting loop:
let cookieColor = sampleLightCookie(light, worldPos);
let lightContribution = light.color * light.intensity * attenuation * spotFalloff * cookieColor;
```

#### Cookie Atlas Management

```typescript
// In LightBufferManager:
class LightBufferManager {
  private cookieAtlas: GPUTexture;  // texture_2d_array
  private cookieAtlasLayers: Map<string, number>;  // assetPath → layer index
  private nextCookieLayer: number = 0;
  
  /** Load cookie texture from asset path into atlas, return layer index */
  async loadCookie(assetPath: string): Promise<number> {
    if (this.cookieAtlasLayers.has(assetPath)) {
      return this.cookieAtlasLayers.get(assetPath)!;
    }
    const layer = this.nextCookieLayer++;
    // Load texture and copy to atlas layer
    this.cookieAtlasLayers.set(assetPath, layer);
    return layer;
  }
  
  /** Assign cookie atlas indices to lights before GPU upload */
  async updateCookies(lights: SpotLight[]): Promise<void> {
    for (const light of lights) {
      if (light.cookieTexturePath && light.cookieAtlasIndex < 0) {
        light.cookieAtlasIndex = await this.loadCookie(light.cookieTexturePath);
      }
    }
  }
}
```

#### UI: Cookie Picker in Light Properties

The `LightPropertiesSection` component uses `AssetPickerModal` (existing) to let users browse and select cookie textures from the asset library:

```tsx
// In LightPropertiesSection (shown when a SpotLight is selected):

import { AssetPickerModal } from '../../ui/AssetPickerModal';

function SpotLightCookieSection({ light, onChange }) {
  const [showPicker, setShowPicker] = useState(false);
  
  return (
    <Section title="Light Cookie">
      {/* Cookie texture preview + pick button */}
      <div class={styles.cookieRow}>
        {light.cookieTexturePath ? (
          <div class={styles.cookiePreview}>
            <img src={`/api/assets/preview/${encodeURIComponent(light.cookieTexturePath)}`} />
            <button onClick={() => onChange({ cookieTexturePath: null, cookieAtlasIndex: -1 })}>
              ✕ Remove
            </button>
          </div>
        ) : (
          <button onClick={() => setShowPicker(true)}>
            🎨 Select Cookie Texture
          </button>
        )}
      </div>
      
      {/* Cookie intensity slider (only shown when cookie is assigned) */}
      {light.cookieTexturePath && (
        <>
          <label>Intensity</label>
          <input type="range" min={0} max={1} step={0.01}
            value={light.cookieIntensity}
            onInput={e => onChange({ cookieIntensity: parseFloat(e.target.value) })}
          />
          <label>Tiling U</label>
          <input type="range" min={0.1} max={10} step={0.1}
            value={light.cookieTiling[0]}
            onInput={e => onChange({ cookieTiling: [parseFloat(e.target.value), light.cookieTiling[1]] })}
          />
          <label>Tiling V</label>
          <input type="range" min={0.1} max={10} step={0.1}
            value={light.cookieTiling[1]}
            onInput={e => onChange({ cookieTiling: [light.cookieTiling[0], parseFloat(e.target.value)] })}
          />
        </>
      )}
      
      {/* Asset Picker Modal — filtered to textures only */}
      <AssetPickerModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={(asset) => {
          onChange({ cookieTexturePath: asset.path, cookieAtlasIndex: -1 });
          // cookieAtlasIndex will be assigned by LightBufferManager on next frame
        }}
        title="Select Cookie Texture"
        filterType="texture"
      />
    </Section>
  );
}
```

The `AssetPickerModal` is called with `filterType="texture"` to show only texture assets. The user can browse, search, preview, and select a cookie texture. On selection, the asset path is stored on the light; `LightBufferManager` loads it into the cookie atlas on the next frame.

#### Phase Placement

Light cookies are part of **Phase 3.5** (alongside shadow atlas), since:
- Phase 3 spot lights work fine without cookies (smooth cone falloff is the default)
- Cookie atlas is a parallel concept to shadow atlas (both are `texture_2d_array`)
- Both can share the same `LightBufferManager` management code

---

### 2.3 AreaLight (New, Future)

```typescript
// src/core/sceneObjects/lights/AreaLight.ts

export class AreaLight extends Light {
  public width: number = 1;
  public height: number = 1;
  public shape: 'rect' | 'disk' = 'rect';
  
  constructor(name: string = 'Area Light') {
    super('area', name);
  }
  
  getDirection(): vec3 { /* from rotationQuat */ }
  getArea(): number { /* π*r² for disk, w*h for rect */ }
}
```

---

## 3. Scene Integration

### 3.1 Scene.ts Changes

Add a `lights` map as an efficient query index alongside the existing `objects` map. Lights are stored in BOTH maps (they are scene objects), but the `lights` map enables fast type-filtered queries.

```typescript
export class Scene {
  private objects = new Map<string, AnySceneObject>();
  
  // NEW: Specialized light storage for efficient queries
  private lights = new Map<string, Light>();
  private primaryDirectionalLight: DirectionalLight | null = null;
  private environmentLight: HDRLight | null = null;
  
  // Light Management
  addLight<T extends Light>(light: T): T {
    this.addSceneObject(light);           // Add to objects map + scene graph
    this.lights.set(light.id, light);     // Also track in lights map
    if (light.lightType === 'directional' && !this.primaryDirectionalLight) {
      this.primaryDirectionalLight = light as DirectionalLight;
    }
    this.callbacks.onLightAdded?.(light);
    return light;
  }
  
  removeLight(id: string): boolean { /* ... */ }
  
  // Factory Methods
  addDirectionalLight(name?: string): DirectionalLight { /* ... */ }
  addPointLight(name?: string): PointLight { /* ... */ }
  addSpotLight(name?: string): SpotLight { /* ... */ }
  
  // Query Methods
  getDirectionalLight(): DirectionalLight | null { return this.primaryDirectionalLight; }
  getPointLights(): PointLight[] { /* filter lights map */ }
  getSpotLights(): SpotLight[] { /* filter lights map */ }
  getAllLights(): Light[] { /* all from lights map */ }
  getEnabledLights(): Light[] { /* filter enabled */ }
  getShadowCastingLights(): Light[] { /* filter castsShadow */ }
}
```

### 3.2 Serialization Changes

```typescript
export interface SerializedScene {
  objects: Array<SerializedPrimitiveObject | SerializedModelObject | SerializedTerrainObject>;
  lights: SerializedLight[];  // NEW
  groups: SerializedGroup[];
}
```

---

## 4. Shadow Architecture

### 4.1 Design Principles

**CSM is single-light only.** The existing CSM system (`ShadowRendererGPU` cascade array + `shadow-csm.wgsl`) applies exclusively to the primary directional light (the sun). This is because:
- Each cascade requires a full scene depth render pass (4 cascades = 4 passes)
- Multiple CSM lights would be 4N shadow passes — unacceptable for real-time
- Game engines (Unity, Unreal, Filament) all restrict CSM to the main directional light

**Lights don't own GPU textures.** Light scene objects hold configuration (intensity, color, range, castsShadow) but never own GPU resources directly. Shadow maps are managed centrally by `ShadowRendererGPU`.

**Non-CSM shadows use a centralized shadow atlas** (future phase). When spot/point lights need shadows, `ShadowRendererGPU` allocates slots in a `texture_depth_2d_array` (the shadow atlas). Each light gets an atlas index, not its own texture.

### 4.2 Shadow Map Strategy Per Light Type

| Light Type | Shadow Technique | Phase | Notes |
|------------|-----------------|-------|-------|
| Directional (primary) | CSM (4 cascades) | ✅ Exists | `ShadowRendererGPU` owns cascade array |
| Directional (additional) | Single ortho shadow map | Future | Rare use case |
| Spot | Single 2D perspective map in atlas | Phase 3.5 | One atlas layer per spot light |
| Point | Cube shadow map (6 atlas layers) | Future | Expensive, 6 passes per light |
| Area | VSM/PCSS approximation | Future | Advanced technique |

### 4.3 Centralized Shadow Atlas (Phase 3.5)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ShadowRendererGPU (enhanced)                       │
│                                                                       │
│  ┌─────────────────────────────────────────┐                         │
│  │  Primary CSM System (unchanged)          │  ← 1 directional light │
│  │  - cascadeArrayTexture (4 layers)        │                        │
│  │  - csmUniformBuffer                      │                        │
│  │  - cascadeViews[]                        │                        │
│  └─────────────────────────────────────────┘                         │
│                                                                       │
│  ┌─────────────────────────────────────────┐                         │
│  │  Shadow Atlas (NEW - texture array)      │  ← All other lights    │
│  │                                          │                        │
│  │  Layer 0: SpotLight #1 (2D perspective)  │                        │
│  │  Layer 1: SpotLight #2 (2D perspective)  │                        │
│  │  Layer 2: PointLight #1 face +X          │                        │
│  │  ...                                     │                        │
│  │  Layer N: (dynamically allocated)        │                        │
│  └─────────────────────────────────────────┘                         │
│                                                                       │
│  Methods:                                                             │
│    allocateShadowSlot(light) → atlasIndex                            │
│    freeShadowSlot(light)                                             │
│    renderAllShadows(encoder, scene)                                  │
│      1. Primary directional → CSM (existing path)                    │
│      2. Other shadow casters → atlas layers                          │
│      3. Upload shadow metadata to GPU buffer                         │
└──────────────────────────────────────────────────────────────────────┘
```

Light objects reference their shadow slot, never own textures:

```typescript
class Light extends SceneObject {
  castsShadow: boolean = false;
  shadowAtlasIndex: number = -1;  // Assigned by ShadowRendererGPU, -1 = no slot
}
```

In shaders, lights sample the atlas by index:

```wgsl
struct SpotLightData {
  position: vec3f, range: f32,
  direction: vec3f, intensity: f32,
  color: vec3f, innerCos: f32,
  outerCos: f32,
  shadowAtlasIndex: i32,       // -1 = no shadow
  lightSpaceMatrix: mat4x4f,   // For shadow coord transform
  _pad: vec2f,
};

fn sampleSpotShadow(light: SpotLightData, worldPos: vec3f) -> f32 {
  if (light.shadowAtlasIndex < 0) { return 1.0; }
  let shadowCoord = /* transform worldPos by lightSpaceMatrix */;
  return textureSampleCompareLevel(
    shadowAtlas, shadowSampler,
    shadowCoord.xy, light.shadowAtlasIndex, shadowCoord.z - bias
  );
}
```

---

## 5. GPU Pipeline Changes

### 5.1 Light Data in Shaders

Light data is packed into per-frame uniform/storage buffers. **The existing Group 3 (SceneEnvironment) is NOT modified** — it continues to hold shadow maps, IBL, and CSM resources. Light data goes into Group 0 (expanded per-frame uniforms) or a new storage buffer binding in an appropriate group.

```wgsl
// Light structures for GPU

struct DirectionalLightData {
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  ambient: f32,
};

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
  innerCos: f32,      // cos(innerConeAngle)
  outerCos: f32,      // cos(outerConeAngle)
  shadowAtlasIndex: i32,
  _pad: vec2f,
};

struct LightCounts {
  numDirectional: u32,
  numPoint: u32,
  numSpot: u32,
  _pad: u32,
};
```

### 5.2 LightBufferManager

```typescript
// src/core/gpu/renderers/LightBufferManager.ts

export class LightBufferManager {
  private lightCountsBuffer: GPUBuffer;
  private pointLightsBuffer: GPUBuffer;
  private spotLightsBuffer: GPUBuffer;
  
  /**
   * Update light buffers from scene each frame.
   * Performs CPU frustum culling on point/spot lights before upload.
   */
  update(scene: Scene, cameraFrustum: Frustum): void {
    const dirLight = scene.getDirectionalLight();
    const allPoints = scene.getPointLights().filter(l => l.enabled);
    const allSpots = scene.getSpotLights().filter(l => l.enabled);
    
    // CPU frustum cull: only upload lights whose bounding sphere
    // intersects the camera frustum
    const visiblePoints = allPoints.filter(l => 
      frustumContainsSphere(cameraFrustum, l.position, l.range)
    );
    const visibleSpots = allSpots.filter(l =>
      frustumContainsSphere(cameraFrustum, l.position, l.range)
    );
    
    // Pack into GPU buffers
    this.writeLightCounts(dirLight ? 1 : 0, visiblePoints.length, visibleSpots.length);
    this.writePointLights(visiblePoints);
    this.writeSpotLights(visibleSpots);
  }
}
```

### 5.3 GPUForwardPipeline Changes

The pipeline transitions from reading light params from `RenderOptions` to querying `Scene`:

```typescript
// In GPUForwardPipeline.render()

// BEFORE (current):
const lightDir = mergedOptions.lightDirection;
this.dynamicSkyIBL.update(encoder, sunDirection, mergedOptions.sunIntensity, deltaTime);

// AFTER (migrated):
const dirLight = scene?.getDirectionalLight();
if (dirLight && dirLight.enabled) {
  const params = dirLight.getLightParams();
  const sunDirection = params.direction;
  this.dynamicSkyIBL.update(encoder, sunDirection, params.intensity, deltaTime);
}

// Light buffer update (new)
this.lightBufferManager.update(scene, cameraFrustum);
```

### 5.4 ShadowPass Changes

`ShadowPass` currently gets `lightDirection` from `RenderOptions`. After migration:

```typescript
// In ShadowPass.execute()

// BEFORE:
const lightDir = context.options.lightDirection;
shadowRenderer.updateLightMatrix({ lightDirection: lightDir, ... });

// AFTER:
const dirLight = context.scene?.getDirectionalLight();
if (dirLight && dirLight.enabled && dirLight.castsShadow) {
  const direction = dirLight.getDirection();
  shadowRenderer.updateLightMatrix({ lightDirection: direction, ... });
}
// CSM cascade computation is unchanged — ShadowRendererGPU handles it internally
```

---

## 6. Serialization

### 6.1 SerializedScene Changes

```typescript
export interface SerializedScene {
  objects: Array<SerializedPrimitiveObject | SerializedModelObject | SerializedTerrainObject>;
  lights: SerializedLight[];  // NEW
  groups: SerializedGroup[];
}
```

### 6.2 Scene.serialize()

```typescript
serialize(): SerializedScene {
  // ... existing object serialization ...
  
  const serializedLights: SerializedLight[] = [];
  for (const light of this.lights.values()) {
    serializedLights.push(light.serialize());
  }
  
  return { objects: serializedObjects, lights: serializedLights, groups: serializedGroups };
}
```

### 6.3 Scene.deserialize()

```typescript
async deserialize(data: SerializedScene | null): Promise<void> {
  this.clear();
  if (!data) return;
  
  // ... existing object deserialization ...
  
  if (data.lights) {
    for (const lightData of data.lights) {
      let light: Light | null = null;
      switch (lightData.type) {
        case 'directional': light = this.addDirectionalLight(lightData.name); break;
        case 'point': light = this.addPointLight(lightData.name); break;
        case 'spot': light = this.addSpotLight(lightData.name); break;
        // ... etc.
      }
      if (light) {
        light.deserialize(lightData);
        this.updateObjectTransform(light.id);
      }
    }
  }
}
```

---

## 7. UI Changes

### 7.1 Objects Panel — Show Lights in Hierarchy

```tsx
const LIGHT_ICONS: Record<LightType, string> = {
  directional: '☀️',
  point: '💡',
  spot: '🔦',
  area: '▢',
  hdr: '🌄',
};

// In ObjectsPanel, detect light objects
if (obj.objectType === 'light') {
  icon = LIGHT_ICONS[(obj as Light).lightType];
}
```

### 7.2 Object Panel — Light Properties Section

When a light is selected, show light-specific sliders/controls:

- **All lights**: Enabled toggle, Intensity slider, Color picker, Cast Shadows toggle
- **Directional**: Azimuth (0-360°), Elevation (-90 to 90°), Ambient intensity
- **Point**: Range slider
- **Spot**: Range, Inner Cone Angle, Outer Cone Angle, Cookie Texture (via `AssetPickerModal` with `filterType="texture"`), Cookie Intensity, Cookie Tiling

### 7.3 Add Light Menu

```tsx
const lightMenuItems = [
  { label: '☀️ Directional Light', action: () => scene.addDirectionalLight() },
  { label: '💡 Point Light', action: () => scene.addPointLight() },
  { label: '🔦 Spot Light', action: () => scene.addSpotLight() },
  { label: '🌄 Environment (HDR)', action: () => scene.addEnvironmentLight() },
];
```

---

## 8. Viewport Light Visualization

### 8.1 Design Principles

- **Viewport-only overlays** — Light visualizations are rendered as unlit wireframe/solid overlays in the viewport. No geometry is registered in the scene or scene graph for these.
- **Same pattern as GizmoRendererGPU** — Uses the existing gizmo shader (`gizmo.wgsl`) with line and triangle pipelines, no depth testing, rendered on top of scene content.
- **Visibility controls** — Light visualizations should be toggleable globally (ViewportToolbar) and individually (per light). Selected lights show enhanced visualization.
- **Color-coded** — Each light type uses its own color scheme. Selected lights use a brighter/highlighted color.

### 8.2 Visualization Per Light Type

| Light Type | Visualization | Geometry |
|------------|--------------|----------|
| Directional | Arrow showing light direction + dashed parallel rays | Lines: direction arrow from light icon position, 3-5 parallel ray lines |
| Point | Wireframe sphere showing range | Lines: 3 orthogonal circle outlines at `light.range` radius |
| Spot | Wireframe cone showing inner/outer angles + range | Lines: cone outline (8-12 edge lines from apex to base circle), inner cone circle, outer cone circle |
| Area (rect) | Wireframe rectangle showing emitter shape + direction arrow | Lines: rectangle outline at light size + normal direction arrow |
| Area (disk) | Wireframe circle showing emitter shape + direction arrow | Lines: circle outline at light radius + normal direction arrow |

### 8.3 LightVisualizerGPU

A new renderer that follows the same architecture as `GizmoRendererGPU`:

```typescript
// src/core/gpu/renderers/LightVisualizerGPU.ts

export class LightVisualizerGPU {
  private ctx: GPUContext;
  
  // Reuses gizmo.wgsl shader (unlit colored geometry)
  private linePipeline: RenderPipelineWrapper;    // For wireframe outlines
  private trianglePipeline: RenderPipelineWrapper; // For solid icon shapes
  
  // Pre-built geometry buffers (unit-sized, scaled by model matrix)
  private directionArrowBuffer: UnifiedGPUBuffer;   // Arrow + parallel rays
  private wireframeSphereBuffer: UnifiedGPUBuffer;   // 3 circle outlines (XY, XZ, YZ)
  private wireframeConeBuffer: UnifiedGPUBuffer;     // Cone outline (edge lines + base circle)
  private wireframeRectBuffer: UnifiedGPUBuffer;     // Rectangle outline
  private wireframeDiskBuffer: UnifiedGPUBuffer;     // Circle outline
  private lightIconBuffer: UnifiedGPUBuffer;         // Small icon shape (for all lights)
  
  // Uniform buffers (same layout as gizmo: VP + model + color)
  private uniformBuffer: UnifiedGPUBuffer;
  private bindGroup: GPUBindGroup;
  
  constructor(ctx: GPUContext) {
    // Creates pipelines identical to GizmoRendererGPU:
    // - No depth stencil (overlay)
    // - cullMode: 'none'
    // - colorFormats: [ctx.format] (swap chain)
    // - Uses gizmo.wgsl shader
  }
  
  /**
   * Render all light visualizations for the viewport.
   * Called during the overlay pass, after gizmos.
   * 
   * @param lights - All lights from scene.getAllLights()
   * @param selectedIds - Currently selected object IDs
   * @param vpMatrix - Camera view-projection matrix
   * @param showAll - Whether to show all light visualizations (viewport toggle)
   */
  renderLightVisualizations(
    passEncoder: GPURenderPassEncoder,
    lights: Light[],
    selectedIds: Set<string>,
    vpMatrix: mat4,
    showAll: boolean
  ): void {
    for (const light of lights) {
      if (!light.enabled) continue;
      
      const isSelected = selectedIds.has(light.id);
      // Show if: globally enabled, OR this light is selected
      if (!showAll && !isSelected) continue;
      
      const alpha = isSelected ? 1.0 : 0.4; // Dim unselected lights
      
      switch (light.lightType) {
        case 'directional':
          this.renderDirectionalViz(passEncoder, light as DirectionalLight, vpMatrix, isSelected, alpha);
          break;
        case 'point':
          this.renderPointViz(passEncoder, light as PointLight, vpMatrix, isSelected, alpha);
          break;
        case 'spot':
          this.renderSpotViz(passEncoder, light as SpotLight, vpMatrix, isSelected, alpha);
          break;
        case 'area':
          this.renderAreaViz(passEncoder, light as AreaLight, vpMatrix, isSelected, alpha);
          break;
      }
    }
  }
  
  /** Directional: arrow + parallel rays from a fixed position */
  private renderDirectionalViz(pass: GPURenderPassEncoder, light: DirectionalLight, vp: mat4, selected: boolean, alpha: number): void {
    // Model matrix: positioned at light's scene position, rotated to face light direction
    // Color: warm yellow [1.0, 0.9, 0.3, alpha]
    // Selected: brighter [1.0, 0.95, 0.5, 1.0]
    // Geometry: direction arrow (line-list) + 3-5 parallel rays indicating direction
  }
  
  /** Point: 3 wireframe circles at light.range radius */
  private renderPointViz(pass: GPURenderPassEncoder, light: PointLight, vp: mat4, selected: boolean, alpha: number): void {
    // Model matrix: positioned at light.position, scaled by light.range
    // Color: light's color with alpha
    // Geometry: wireframeSphereBuffer (3 orthogonal unit circles, scaled by range)
  }
  
  /** Spot: wireframe cone showing inner/outer angles */
  private renderSpotViz(pass: GPURenderPassEncoder, light: SpotLight, vp: mat4, selected: boolean, alpha: number): void {
    // Model matrix: positioned at light.position, rotated to light direction, scaled by range
    // Color: light's color with alpha (outer cone dimmer than inner)
    // Geometry: 
    //   - 8-12 edge lines from apex to outer cone base circle
    //   - Outer base circle at outerConeAngle
    //   - Inner base circle at innerConeAngle (if selected, for detail)
  }
  
  /** Area: wireframe rectangle/disk + direction arrow */
  private renderAreaViz(pass: GPURenderPassEncoder, light: AreaLight, vp: mat4, selected: boolean, alpha: number): void {
    // Model matrix: positioned at light.position, rotated to light direction
    // Color: light's color with alpha
    // Geometry: rect or disk outline + normal direction arrow
  }
  
  destroy(): void { /* cleanup all buffers */ }
}
```

### 8.4 Pre-built Geometry Details

All geometry is unit-sized and scaled via the model matrix:

**Wireframe Sphere** (for point lights):
- 3 circles (XY, XZ, YZ planes), each with 48-64 line segments
- Unit radius, scaled by `light.range` in model matrix

**Wireframe Cone** (for spot lights):
- 8 edge lines from origin to base circle points
- Base circle with 32-48 segments at distance 1.0 along Z
- Base radius = `tan(outerConeAngle)` (computed per-light, applied via model matrix scale)
- Optional inner cone circle (same structure, smaller radius)

**Direction Arrow** (for directional lights):
- Main arrow line (0,0,0) → (0,0,-1) with arrowhead triangles
- 3-5 parallel lines offset from center, same direction
- Conveys "infinite parallel rays" visually

**Light Icon** (small billboard at light position):
- Small cross/star shape drawn as lines
- Always rendered at light position as a clickable handle
- Constant screen-space size (scale by distance from camera)

### 8.5 Integration with Pipeline

The light visualizer renders during the **overlay pass**, same as gizmos:

```typescript
// In GPUForwardPipeline or Viewport overlay rendering:

// Existing overlay pass (no depth):
const overlayPass = encoder.beginRenderPass({ colorAttachments: [...], /* no depthStencil */ });

// Existing: render gizmos
gizmoRenderer.renderTranslateLines(overlayPass, ...);

// NEW: render light visualizations
lightVisualizer.renderLightVisualizations(
  overlayPass,
  scene.getAllLights(),
  scene.getSelectedIds(),
  viewProjectionMatrix,
  viewportSettings.showLightHelpers  // Toggle from ViewportToolbar
);

overlayPass.end();
```

### 8.6 Interaction: Clicking Light Visualizations

Light icons/handles need to be **clickable for selection**. Two approaches:

1. **CPU raycast against light positions** (recommended for Phase 4):
   - Each light has a known position (or direction for directional)
   - On mouse click, test ray against light bounding spheres (small fixed radius for point/spot, screen-projected for directional)
   - Simple, no additional GPU work

2. **GPU picking buffer** (future):
   - Render light IDs to a pick buffer during the visualization pass
   - Read back pixel under cursor to determine clicked light

Phase 4 should use approach 1 (CPU raycast) — it's simpler and consistent with how gizmo interaction already works.

---

## 9. Migration Phases

### Phase 1: Scene Light Management (Foundation)
**Goal**: Add light storage and query methods to Scene without breaking existing code.

- [ ] Add `lights` map to `Scene.ts`
- [ ] Add light factory methods (`addDirectionalLight()`, `addPointLight()`, etc.)
- [ ] Add light query methods (`getDirectionalLight()`, `getPointLights()`, etc.)
- [ ] Add `onLightAdded`, `onLightRemoved`, `onLightChanged` callbacks
- [ ] Update `removeObject()` to handle light cleanup
- [ ] Update `clear()` to clear lights map

**Compatibility**: `LightingManager` still works, Scene methods are additive.

### Phase 2: New Light Types
**Goal**: Implement SpotLight class.

- [ ] Create `src/core/sceneObjects/lights/SpotLight.ts`
- [ ] Update `src/core/sceneObjects/lights/types.ts` with new types
- [ ] Update `src/core/sceneObjects/lights/index.ts` exports
- [ ] Add unit tests for new light classes

### Phase 3: GPU Pipeline Integration
**Goal**: Pipeline queries Scene for lights instead of receiving params via options. CSM continues working unchanged.

- [ ] Create `src/core/gpu/renderers/LightBufferManager.ts`
- [ ] Create `src/core/gpu/shaders/common/lights.wgsl` (point/spot light structs and attenuation functions)
- [ ] Update `GPUForwardPipeline.render()` to query `scene.getDirectionalLight()` instead of `options.lightDirection`
- [ ] Update `ShadowPass` to get light direction from `scene.getDirectionalLight()` — CSM computation unchanged
- [ ] Update `DynamicSkyIBL` to get sun direction from scene instead of render options
- [ ] Add CPU frustum culling in `LightBufferManager.update()` (sphere-vs-frustum for point/spot)
- [ ] Update PBR shader to loop over point/spot lights with attenuation
- [ ] Update terrain shader for multi-light support
- [ ] Verify CSM shadows still work correctly after all changes

**Critical constraint**: Group 3 (`SceneEnvironment`) is NOT modified. Light data goes into Group 0 per-frame uniforms or storage buffers.

### Phase 3.5: Shadow Atlas & Light Cookies
**Goal**: Add shadow atlas for spot/point light shadows and cookie texture projection.

- [ ] Create shadow atlas `texture_depth_2d_array` in `ShadowRendererGPU`
- [ ] Implement `allocateShadowSlot()` / `freeShadowSlot()` for dynamic layer management
- [ ] Render spot light shadow maps into atlas layers
- [ ] Expose shadow atlas as new binding in `SceneEnvironment` Group 3 (binding 9+)
- [ ] Create cookie atlas `texture_2d_array` in `LightBufferManager`
- [ ] Implement `loadCookie()` / `updateCookies()` for cookie atlas management
- [ ] Add cookie sampling to spot light shader (reuses light-space projection from shadow)
- [ ] Add `SpotLightCookieSection` UI with `AssetPickerModal` (`filterType="texture"`) for cookie selection
- [ ] Add cookie intensity, tiling, and offset sliders to light properties panel
- [ ] Serialize/deserialize cookie texture paths with light data

### Phase 4: UI Migration & Viewport Visualization
**Goal**: Integrate lights into the scene hierarchy, property panels, and viewport overlays.

- [ ] Update Objects Panel to show lights with appropriate icons
- [ ] Create `LightPropertiesSection` component for Object Panel
- [ ] Add "Add Light" submenu to MenuBar
- [ ] Remove or repurpose Environment Panel's Lighting tab
- [ ] Update gizmo to work with light rotation/position
- [ ] Create `LightVisualizerGPU` renderer (follows `GizmoRendererGPU` pattern)
- [ ] Build pre-built geometry buffers (wireframe sphere, cone, direction arrow, light icon)
- [ ] Integrate into overlay render pass (alongside gizmos)
- [ ] Add "Show Light Helpers" toggle to ViewportToolbar
- [ ] Implement CPU raycast selection for light icons/handles

### Phase 5: Deprecation
**Goal**: Remove `LightingManager` and old data flow.

- [ ] Mark `LightingManager` as `@deprecated`
- [ ] Update all demo code to use Scene light APIs
- [ ] Remove `Viewport.setLightParams()` method
- [ ] Remove `options.lightDirection` from `RenderOptions`
- [ ] Remove `LightingManager` class and file
- [ ] Update documentation

---

## 10. Light Count Limits & Scalability

### Forward Rendering Light Limits

| Approach | Max Visible Lights | Notes |
|----------|-------------------|-------|
| Naive Forward (Phase 3) | ~8-16 | Every pixel evaluates ALL lights |
| Forward + CPU Frustum Culling (Phase 3) | ~64-128 | Only visible lights uploaded |
| Forward+ Tiled (Phase 6) | ~500-1000 | GPU compute culls lights per tile |
| Clustered Forward (Phase 7) | ~4000+ | 3D clusters for tight per-pixel lists |

### Why 8-16 Lights is Fine Initially

For a **scene builder / 3D editor**, 8-16 lights is plenty for typical use. CPU frustum culling (included in Phase 3) is trivial to implement and ensures off-screen lights don't waste GPU cycles.

**No prerequisites needed for Phase 3 multi-light support:**
- ❌ No Forward+ tiled shading needed
- ❌ No clustered forward needed
- ❌ No light BVH / spatial acceleration needed
- ✅ CPU frustum cull (simple sphere-frustum test) is included in Phase 3

### Scaling Path (Future)

| Phase | Max Lights | Technique |
|-------|------------|-----------|
| 3 | ~8-16 | Forward + CPU frustum culling |
| 3.5 | ~8-16 | + Shadow atlas for spot/point shadows |
| 6 | ~500-1000 | Forward+ tiled shading (compute) |
| 7 | ~4000+ | Clustered forward (3D data structure) |

---

## 11. Shadow Atlas Details (Phase 3.5)

### When to Build

Shadow atlas is **NOT needed for Phase 3**. In Phase 3, only the primary directional light casts shadows via CSM. Point and spot lights contribute lighting but are unshadowed — this is perfectly acceptable for a scene builder.

Phase 3.5 adds shadow atlas when users need shadowed spot/point lights.

### Atlas Design

- Single `texture_depth_2d_array` with configurable max layers (e.g., 16)
- Each spot light uses 1 layer, each point light uses 6 layers (cube faces)
- `ShadowRendererGPU` manages allocation/deallocation
- Shadow atlas is exposed via a new binding in `SceneEnvironment` Group 3 (binding 9+)
- Lights store only `shadowAtlasIndex` — never own GPU textures

---

## 12. Testing Checklist

### Unit Tests
- [ ] `DirectionalLight.getLightParams()` returns correct direction
- [ ] `PointLight.getLightParams()` returns position and range
- [ ] `SpotLight.getLightParams()` returns correct cone angles
- [ ] `Scene.addLight()` adds to both `objects` and `lights` maps
- [ ] `Scene.removeLight()` cleans up all references
- [ ] `Scene.getDirectionalLight()` returns primary sun

### Integration Tests
- [ ] Lights appear in Objects Panel hierarchy
- [ ] Selecting a light shows properties in Object Panel
- [ ] Deleting a light removes it from scene and rendering
- [ ] Scene serialization includes lights
- [ ] Scene deserialization restores lights correctly
- [ ] **CSM shadows continue to work after migration** (critical regression test)
- [ ] Dynamic IBL updates when directional light changes

### Visual Tests
- [ ] Directional light illuminates scene correctly
- [ ] Point light attenuation looks correct
- [ ] Spot light cone falloff renders properly
- [ ] Multiple lights combine correctly (additive)
- [ ] CSM cascade transitions remain smooth
- [ ] Light cookie projects pattern onto surfaces correctly
- [ ] Cookie tiling/offset parameters affect projection as expected
- [ ] Spot light without cookie uses smooth default falloff

---

## 13. References

- **Three.js Light System**: https://threejs.org/docs/#api/en/lights/Light
- **Unity Lights**: https://docs.unity3d.com/Manual/Lighting.html
- **Filament Lights**: https://google.github.io/filament/Filament.html#lighting
- **WebGPU Best Practices**: https://toji.dev/webgpu-best-practices/
