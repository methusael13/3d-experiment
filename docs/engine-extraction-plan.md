# Engine Extraction & Viewport Decomposition Plan

**Date:** 2026-03-28  
**Status:** Proposed  
**Addresses:** Architecture Assessment §3.2 (Viewport God Object), §3.3 (No Engine Entry Point)

---

## 1. Problem Statement

The architecture assessment identifies two tightly coupled problems:

### 1.1 Viewport Is a God Object (§3.2)

`src/demos/sceneBuilder/Viewport.ts` (~1,295 lines) combines at least 10 distinct responsibilities:

| # | Responsibility | Lines (approx) |
|---|---|---|
| 1 | WebGPU initialization (`initWebGPU`) | 60 |
| 2 | ECS World creation + 17 system registrations | 80 |
| 3 | Camera management (orbit, FPS, debug) | 100 |
| 4 | Input management (`InputManager`, `ActionInputManager`) | 30 |
| 5 | Gizmo management (`TransformGizmoManager`) | 80 |
| 6 | Render loop orchestration (`renderWebGPU`) | 180 |
| 7 | Light/reflection probe wiring | 40 |
| 8 | Debug overlay rendering (5 separate overlay methods) | 200 |
| 9 | Per-frame system data feeding (camera pos, VP matrices, flags) | 70 |
| 10 | 23+ public setter methods forwarding config to pipeline | 250 |

### 1.2 No Engine Entry Point (§3.3)

There is no `Engine` class. The "engine" is an implicit collection of:
- `GPUContext` (singleton) — GPU device
- `World` — ECS
- `GPUForwardPipeline` — rendering
- `createAnimationLoop()` — frame timing
- `LightBufferManager` — light GPU buffers
- `ReflectionProbeCaptureRenderer` — probe baking

All of these are instantiated and wired together inside `Viewport.ts`, which lives in `src/demos/sceneBuilder/`. This means:
- A game runtime cannot use the engine without importing editor code
- The engine's lifecycle is coupled to a UI component's lifecycle
- There is no clean boundary between "engine" and "application"

---

## 2. Goals

1. **Create a reusable `Engine` class** in `src/core/` that can power both the scene builder editor and a standalone game runtime
2. **Decompose the Viewport** into focused, single-responsibility classes
3. **Maintain backward compatibility** — the `ViewportContainer.tsx` public API should require minimal changes
4. **Zero feature regression** — every feature that works today must work identically after refactoring
5. **Incremental migration** — the refactor can be done in discrete, testable steps

---

## 3. Target Architecture

### 3.1 Architecture Diagram (After)

```
┌──────────────────────────────────────────────────────────┐
│                    Demo Layer (Preact)                     │
│  SceneBuilderApp → SceneBuilderStore → Bridge files       │
│  Panels (Object, Material, Terrain, Water, Vegetation)    │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────┼─────────────────────────────────┐
│              EditorViewport (Thin Shell)                   │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐   │
│  │ Camera   │  │ Input     │  │ TransformGizmo       │   │
│  │Controller│  │ Manager   │  │ Manager              │   │
│  └──────────┘  └───────────┘  └──────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐    │
│  │ EditorOverlayManager                              │    │
│  │  • Light helpers  • Player helpers                │    │
│  │  • Skeleton debug • Camera frustum                │    │
│  │  • Gizmo overlay                                  │    │
│  └──────────────────────────────────────────────────┘    │
└────────────────────────┬─────────────────────────────────┘
                         │ owns / delegates to
┌────────────────────────┼─────────────────────────────────┐
│                    Engine (Core)                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │ World + SystemRegistry                            │    │
│  │  17 systems in priority order                     │    │
│  │  SceneGraph (BVH) for spatial queries             │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ GPUForwardPipeline + PostProcess                  │    │
│  │  Pass-based rendering, HDR, tonemapping           │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ LightBufferManager + SceneEnvironment wiring      │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ AnimationLoop (update + render cycle)             │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ ReflectionProbeCaptureRenderer                    │    │
│  └──────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ GPUContext (device, queue, format)                 │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### 3.2 File Layout

```
src/core/
  Engine.ts                          ← NEW: Engine entry point
  EngineConfig.ts                    ← NEW: Engine configuration types
  SystemRegistry.ts                  ← NEW: Default system registration
  animationLoop.ts                   (existing, unchanged)
  ecs/                               (existing, unchanged)
  gpu/
    pipeline/
      types.ts                       ← NEW: Moved RenderOptions, ShadowSettings, etc.
      GPUForwardPipeline.ts          (existing, minor type import changes)
      ...

src/demos/sceneBuilder/
  EditorViewport.ts                  ← NEW: Thin editor shell (~300 lines)
  EditorOverlayManager.ts           ← NEW: Debug overlay rendering
  Viewport.ts                        ← DEPRECATED then DELETED
  CameraController.ts               (existing, unchanged)
  InputManager.ts                    (existing, unchanged)
  DebugCameraController.ts          (existing, unchanged)
  gizmos/                            (existing, unchanged)
  components/
    viewport/
      ViewportContainer.tsx          (updated import: Viewport → EditorViewport)
```

---

## 4. New Classes — Detailed Design

### 4.1 `Engine` (`src/core/Engine.ts`)

The Engine is the **demo-agnostic core runtime**. It can be instantiated by an editor, a game, a benchmark, or a headless test.

```typescript
export interface EngineOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  onFps?: (fps: number) => void;
  /** If provided, used instead of default system registration */
  systemRegistrar?: (world: World, engine: Engine) => void;
}

export class Engine {
  // ── Public readonly accessors ──
  readonly gpuContext: GPUContext;
  readonly world: World;
  readonly pipeline: GPUForwardPipeline;
  readonly lightBufferManager: LightBufferManager;
  readonly reflectionProbeCaptureRenderer: ReflectionProbeCaptureRenderer;

  // ── Internal state ──
  private animationLoop: AnimationLoop | null = null;
  private time = 0;
  private dynamicIBLEnabled = true;
  private renderWidth: number;
  private renderHeight: number;

  // ── Lifecycle ──
  
  /**
   * Async factory — initializes WebGPU, creates pipeline, registers systems.
   * Replaces Viewport.init() + Viewport.initWebGPU().
   */
  static async create(options: EngineOptions): Promise<Engine>;

  /**
   * Start the engine's animation loop.
   * @param onFrame - Called each frame with (deltaTime). The caller provides camera + options.
   *                  This is how the application layer feeds camera data to the engine.
   */
  start(onFrame: (dt: number) => void): void;

  /**
   * Stop the animation loop (but don't destroy resources).
   */
  stop(): void;

  /**
   * Run one frame: update ECS, render pipeline, flush deletions.
   * This is the core method that replaces Viewport.renderWebGPU().
   * 
   * @param dt - Delta time in seconds
   * @param camera - View camera (what appears on screen)
   * @param renderOptions - Per-frame render config
   * @param sceneCamera - Optional separate scene camera (for debug camera mode)
   */
  update(dt: number, camera: GPUCamera, renderOptions: CoreRenderOptions, sceneCamera?: GPUCamera): void;

  /**
   * Resize render targets.
   */
  resize(renderWidth: number, renderHeight: number): void;

  /**
   * Clean up all GPU resources, stop loop, destroy world.
   */
  destroy(): void;

  // ── Pipeline configuration (forwarded to GPUForwardPipeline) ──
  
  setShadowSettings(settings: ShadowSettings): void;
  setSSAOSettings(settings: SSAOSettings): void;
  setSSRSettings(settings: SSRSettings): void;
  setCompositeSettings(config: Partial<CompositeEffectConfig>): void;
  setAtmosphericFogSettings(settings: AtmosphericFogConfig): void;
  setCloudSettings(settings: Partial<CloudConfig>): void;
  setGodRaySettings(settings: Partial<GodRayConfig>): void;
  setWeatherPreset(name: string, duration?: number): void;
  clearWeatherPreset(): void;
  setDebugViewMode(mode: string): void;
  setDynamicIBL(enabled: boolean): void;
  
  // ── Accessors for pipeline internals (needed by editor overlays, etc.) ──
  
  getSceneEnvironment(): SceneEnvironment;
  getShadowRenderer(): ShadowRenderer;
  getDebugTextureManager(): DebugTextureManager;
  getLastDrawCallsCount(): number;
  getMergedRenderOptions(options: CoreRenderOptions): CoreRenderOptions;
}
```

#### What moves INTO Engine from Viewport:

| Viewport method/block | Engine equivalent |
|---|---|
| `initWebGPU()` | `Engine.create()` static factory |
| `this._world = new World()` + 17 `addSystem()` calls | `Engine.create()` → `SystemRegistry.registerDefaultSystems()` |
| `this.gpuPipeline = new GPUForwardPipeline(...)` | `Engine.create()` |
| `this.lightBufferManager = new LightBufferManager(...)` + wiring | `Engine.create()` |
| `this.reflectionProbeCaptureRenderer = new ReflectionProbeCaptureRenderer(...)` | `Engine.create()` |
| `renderWebGPU()` — ECS update + pipeline render + flush | `Engine.update()` |
| `startRendering()` / `createAnimationLoop()` | `Engine.start()` |
| `destroy()` — GPU resource cleanup | `Engine.destroy()` |
| `resize()` — pipeline resize | `Engine.resize()` |
| 23 setter methods (`setWebGPUShadowSettings`, etc.) | `Engine.set*()` forwarding methods |
| Per-frame system data feeding block | `Engine.update()` internal: `feedSystemData()` |

#### What does NOT go into Engine:

- Camera controllers (CameraController, DebugCameraController, FPS camera logic)
- Input management (InputManager, ActionInputManager)
- Gizmo management (TransformGizmoManager)
- Click handling / raycasting for selection
- Debug overlay rendering (light helpers, skeleton, frustum, gizmo)
- Canvas sizing / CSS / DPR handling
- Overlay container management
- Viewport mode (solid/wireframe), showGrid, showAxes
- FPS/debug camera mode toggling

### 4.2 `SystemRegistry` (`src/core/SystemRegistry.ts`)

Extracts the ~80-line system registration block from Viewport's constructor into a reusable function.

```typescript
import { World } from './ecs/World';
import type { InputManager } from '../demos/sceneBuilder/InputManager';
// ... system imports

export interface SystemRegistryOptions {
  /** Input manager for PlayerSystem. If not provided, PlayerSystem is not registered. */
  inputManager?: InputManager;
}

/**
 * Register the default set of engine systems in the correct priority order.
 * 
 * Priority order:
 *   PlayerSystem(5) → TransformSystem(7) → BoundsSystem(10) →
 *   LODSystem(10) → CharacterMovementSystem(20) → TerrainCollisionSystem(25) →
 *   CameraSystem(30) → WindSystem(50) → WetnessSystem(55) →
 *   LightingSystem(80) → FrustumCullSystem(85) → ShadowCasterSystem(90) →
 *   AnimationSystem(95) → VegetationInstanceSystem(95) → SSRSystem(95) →
 *   ReflectionProbeSystem(96) → MeshRenderSystem(100)
 */
export function registerDefaultSystems(world: World, options?: SystemRegistryOptions): void;
```

**Design decision**: The `InputManager` is currently in `src/demos/sceneBuilder/`. For now, we accept this coupling since `PlayerSystem` needs it. A future refactor could move `InputManager` to `src/core/input/` (it's already partially there with `ActionInputManager`).

### 4.3 `EngineConfig` (`src/core/EngineConfig.ts`)

Types that currently live in the demo layer but belong in core:

```typescript
/**
 * Core render options — engine-level concerns only.
 * Editor-specific options (showGrid, showAxes) are NOT included here.
 */
export interface CoreRenderOptions {
  skyMode?: 'sun' | 'hdr';
  sunIntensity?: number;
  hdrExposure?: number;
  wireframe?: boolean;
  ambientIntensity?: number;
  lightDirection?: [number, number, number];
  lightColor?: [number, number, number];
  dynamicIBL?: boolean;
  shadowEnabled?: boolean;
}

/**
 * Extended render options that include editor-specific hints.
 * Used by EditorViewport, not by Engine directly.
 */
export interface EditorRenderOptions extends CoreRenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
  showShadowThumbnail?: boolean;
}

/**
 * Shadow configuration (moved from RenderingPanel).
 */
export interface ShadowSettings {
  enabled: boolean;
  mapSize: number;
  bias: number;
  normalBias: number;
  radius: number;
  csmEnabled: boolean;
  cascadeCount: number;
  cascadeSplitLambda: number;
}

/**
 * SSAO configuration.
 */
export interface SSAOSettings {
  enabled: boolean;
  radius?: number;
  bias?: number;
  kernelSize?: number;
  intensity?: number;
}

/**
 * SSR configuration.
 */
export interface SSRSettings {
  enabled: boolean;
  quality?: 'low' | 'medium' | 'high';
}
```

### 4.4 `EditorOverlayManager` (`src/demos/sceneBuilder/EditorOverlayManager.ts`)

Extracts all debug/editor overlay rendering logic from Viewport into a focused class.

```typescript
export class EditorOverlayManager {
  // ── GPU renderers ──
  private lightVisualizer: LightVisualizerGPU | null = null;
  private playerVisualizer: PlayerVisualizerGPU | null = null;
  private skeletonDebugRenderer: SkeletonDebugRenderer | null = null;
  private skeletonGizmoRenderer: GizmoRendererGPU | null = null;
  private cameraFrustumRenderer: CameraFrustumRendererGPU | null = null;

  constructor(gpuContext: GPUContext);

  // ── Settings ──
  
  setShowLightHelpers(show: boolean): void;

  // ── Render methods ──
  // Each creates its own command encoder + render pass overlay on the backbuffer.
  
  /**
   * Render light helper wireframes (arrows, spheres, cones).
   * Extracted from Viewport.renderLightHelperOverlay().
   */
  renderLightHelpers(
    world: World,
    vpMatrix: Float32Array,
    cameraPosition: [number, number, number],
    logicalHeight: number,
    fpsMode: boolean,
  ): void;

  /**
   * Render player helper wireframes (sphere + look-direction arrow).
   * Extracted from Viewport.renderPlayerHelperOverlay().
   */
  renderPlayerHelpers(
    world: World,
    vpMatrix: Float32Array,
    cameraPosition: [number, number, number],
    logicalHeight: number,
    fpsMode: boolean,
  ): void;

  /**
   * Render skeleton debug overlay (bone lines + joint octahedra).
   * Extracted from Viewport.renderSkeletonDebugOverlay().
   */
  renderSkeletonDebug(world: World, vpMatrix: Float32Array): void;

  /**
   * Render debug camera frustum + CSM cascade visualization.
   * Extracted from Viewport.renderDebugCameraOverlay().
   */
  renderCameraFrustum(
    sceneCamera: CameraObject,
    debugCamera: CameraObject,
    pipeline: GPUForwardPipeline,
    world: World,
  ): void;

  /**
   * Render transform gizmo overlay.
   * Extracted from Viewport.renderGizmoOverlay().
   */
  renderGizmo(gizmo: TransformGizmoManager, vpMatrix: Float32Array): void;

  /**
   * Render all active overlays in the correct order.
   * Convenience method that calls individual render methods.
   */
  renderAllOverlays(params: OverlayRenderParams): void;

  destroy(): void;
}

export interface OverlayRenderParams {
  world: World;
  vpMatrix: Float32Array;
  cameraPosition: [number, number, number];
  logicalHeight: number;
  fpsMode: boolean;
  debugCameraMode: boolean;
  sceneCamera?: CameraObject;
  debugCamera?: CameraObject;
  pipeline?: GPUForwardPipeline;
  gizmo?: TransformGizmoManager;
}
```

### 4.5 `EditorViewport` (`src/demos/sceneBuilder/EditorViewport.ts`)

The thin editor shell that replaces the current `Viewport`. Target: ~300-400 lines.

```typescript
export class EditorViewport {
  // ── Core engine (delegated) ──
  readonly engine: Engine;

  // ── Editor-specific concerns ──
  private readonly canvas: HTMLCanvasElement;
  private cameraController: CameraController | null = null;
  private inputManager: InputManager;
  private transformGizmo: TransformGizmoManager | null = null;
  private overlayManager: EditorOverlayManager | null = null;
  private debugCameraController: DebugCameraController | null = null;

  // ── Editor state ──
  private fpsMode = false;
  private debugCameraMode = false;
  private showGrid = true;
  private showAxes = true;
  private viewportMode: 'solid' | 'wireframe' = 'solid';
  private windParams: WindParams;
  private overlayContainer: HTMLElement | null = null;
  private lastMousePos: Vec2 = [0, 0];
  private sceneGraph: SceneGraph | null = null;

  // ── Dimensions / DPR ──
  private logicalWidth: number;
  private logicalHeight: number;
  private dpr: number;
  private resolutionScale = 1.0;

  // ── Callbacks (same as current Viewport) ──
  private readonly onFps: (fps: number) => void;
  private readonly onObjectClicked: (objectId: string, shiftKey: boolean) => void;
  // ... etc.

  constructor(canvas: HTMLCanvasElement, options: EditorViewportOptions);

  // ── Lifecycle ──
  async init(): Promise<boolean>;
  destroy(): void;

  // ── Camera (editor concern) ──
  private initCamera(): void;
  getCameraState(): CameraState | null;
  setCameraState(state: CameraState): void;
  resetCameraOrigin(): void;
  setCameraView(view: string): void;
  updateCameraForSceneBounds(sceneRadius: number): void;
  setFPSMode(enabled: boolean): void;
  setDebugCameraMode(enabled: boolean): void;

  // ── Gizmo (editor concern) ──
  private initGizmo(): void;
  setGizmoTarget(...): void;
  setGizmoMode(mode: GizmoMode): void;
  setGizmoOrientation(orientation: GizmoOrientation): void;
  setGizmoEnabled(enabled: boolean): void;
  setLayerBounds(bounds: TerrainLayerBounds | null): void;
  startUniformScale(...): void;
  cancelUniformScale(): Vec3;

  // ── Input (editor concern) ──
  private handleCanvasClick(x: number, y: number, shiftKey: boolean): void;
  private raycastLightHandles(rayOrigin: number[], rayDir: number[]): string | null;
  getInputManager(): InputManager | null;

  // ── Viewport settings (editor concern) ──
  setViewportMode(mode: 'solid' | 'wireframe'): void;
  setShowGrid(show: boolean): void;
  setShowAxes(show: boolean): void;
  setShowLightHelpers(show: boolean): void;
  setWindParams(params: Partial<WindParams>): void;
  resize(width: number, height: number): void;
  setResolutionScale(scale: number): void;

  // ── Pipeline config (delegated to engine) ──
  setWebGPUShadowSettings(s: ShadowSettings): void { this.engine.setShadowSettings(s); }
  setSSAOSettings(s: SSAOSettings): void { this.engine.setSSAOSettings(s); }
  setSSRSettings(s: SSRSettings): void { this.engine.setSSRSettings(s); }
  setCompositeSettings(c: CompositeEffectConfig): void { this.engine.setCompositeSettings(c); }
  setAtmosphericFogSettings(s: AtmosphericFogConfig): void { this.engine.setAtmosphericFogSettings(s); }
  setGodRaySettings(s: GodRayConfig): void { this.engine.setGodRaySettings(s); }
  setCloudSettings(s: CloudConfig): void { this.engine.setCloudSettings(s); }
  setWeatherPreset(name: string, duration?: number): void { this.engine.setWeatherPreset(name, duration); }
  clearWeatherPreset(): void { this.engine.clearWeatherPreset(); }
  setDynamicIBL(enabled: boolean): void { this.engine.setDynamicIBL(enabled); }
  setDebugViewMode(mode: string): void { this.engine.setDebugViewMode(mode); }

  // ── Accessors (delegated) ──
  get world(): World { return this.engine.world; }
  getWebGPUContext(): GPUContext | null { return this.engine.gpuContext; }
  getDebugTextureManager() { return this.engine.getDebugTextureManager(); }
  getShadowRenderer() { return this.engine.getShadowRenderer(); }

  // ── Per-frame render (editor orchestration) ──
  private render(deltaTime: number): void;
  private buildCameraAdapter(): { viewCamera: GPUCamera; sceneCamera?: GPUCamera };
  private buildRenderOptions(): EditorRenderOptions;
}
```

**Key difference from current Viewport**: The `render()` method becomes:
1. Build camera adapter (orbit / FPS / debug)
2. Build render options (showGrid, showAxes, wireframe, lighting)
3. Call `engine.update(dt, camera, options, sceneCamera)`
4. Read draw call count from engine
5. Call `overlayManager.renderAllOverlays(...)` for editor overlays

---

## 5. Per-Frame Data Feeding

One of the assessment's criticisms (§4.2) is that the Viewport manually feeds data into systems each frame:

```typescript
// Current: in Viewport.renderWebGPU()
shadowCasterSystem.cameraPosition = [...];
lodSystem.setCameraPosition(...);
meshRenderSystem.iblActive = this.dynamicIBLEnabled;
meshRenderSystem.windSystem = this._world.getSystem<WindSystem>('wind');
frustumCullSys.setViewProjectionMatrix(sceneVP);
lightingSystem.setViewProjectionMatrix(sceneVP);
```

### Where this moves in the new architecture:

**Into `Engine.update()`** — these are engine concerns, not editor concerns. The Engine knows the camera (it's passed as a parameter) and the pipeline state (it owns the pipeline).

```typescript
// Engine.update() internal method
private feedSystemData(sceneCamera: GPUCamera): void {
  const camPos = sceneCamera.getPosition();
  const sceneVP = this.computeVPMatrix(sceneCamera);
  
  // Frustum culling
  const frustumCullSys = this.world.getSystem<FrustumCullSystem>('frustum-cull');
  frustumCullSys?.setViewProjectionMatrix(sceneVP);
  
  // Lighting
  const lightingSys = this.world.getSystem<LightingSystem>('lighting');
  lightingSys?.setViewProjectionMatrix(sceneVP);
  
  // Shadow caster
  const shadowSys = this.world.getSystem<ShadowCasterSystem>('shadow-caster');
  if (shadowSys) shadowSys.cameraPosition = [camPos[0], camPos[1], camPos[2]];
  
  // LOD
  const lodSys = this.world.getSystem<LODSystem>('lod');
  lodSys?.setCameraPosition(camPos[0], camPos[1], camPos[2]);
  
  // Mesh render system feature flags
  const meshRenderSys = this.world.getSystem<MeshRenderSystem>('mesh-render');
  if (meshRenderSys) {
    meshRenderSys.iblActive = this.dynamicIBLEnabled;
    meshRenderSys.shadowsActive = true; // or from settings
    if (!meshRenderSys.windSystem) {
      meshRenderSys.windSystem = this.world.getSystem<WindSystem>('wind') ?? null;
    }
  }
}
```

> **Future improvement** (not in this refactor): Replace per-frame property assignment with a singleton `RenderSettingsComponent` entity that systems query. This removes the Engine→System coupling entirely. Deferred because it requires changes to every system that reads these values.

---

## 6. Type Migration

### Types that move from demo → core:

| Type | Current Location | New Location |
|---|---|---|
| `WebGPUShadowSettings` | `src/demos/.../RenderingPanel/index.ts` | `src/core/EngineConfig.ts` as `ShadowSettings` |
| `SSAOSettings` | `src/demos/.../RenderingPanel/index.ts` | `src/core/EngineConfig.ts` |
| `SSRSettings` | `src/demos/.../RenderingPanel/index.ts` | `src/core/EngineConfig.ts` |
| `RenderOptions` (core fields) | `GPUForwardPipeline.ts` | `src/core/EngineConfig.ts` as `CoreRenderOptions` |
| `RenderOptions` (editor fields) | (inline in Viewport) | `src/core/EngineConfig.ts` as `EditorRenderOptions` |

The demo's `RenderingPanel/index.ts` will re-export from core or import directly from `EngineConfig`.

### Import that currently violates boundaries:

```typescript
// GPUForwardPipeline.ts currently imports from demo:
import { WebGPUShadowSettings } from '@/demos/sceneBuilder/components/panels/RenderingPanel';
```

After refactor:
```typescript
// GPUForwardPipeline.ts imports from core:
import type { ShadowSettings } from '@/core/EngineConfig';
```

---

## 7. Migration Steps

### Phase 1: Foundation (no breaking changes)

| Step | Action | Risk |
|---|---|---|
| 1.1 | Create `src/core/EngineConfig.ts` with type definitions | None — new file |
| 1.2 | Update `GPUForwardPipeline.ts` to import from `EngineConfig` instead of `RenderingPanel` | Low — type-only change |
| 1.3 | Update `RenderingPanel/index.ts` to re-export from `EngineConfig` (backward compat) | None |
| 1.4 | Create `src/core/SystemRegistry.ts` | None — new file |

### Phase 2: Engine Class

| Step | Action | Risk |
|---|---|---|
| 2.1 | Create `src/core/Engine.ts` with full implementation | None — new file, not yet consumed |
| 2.2 | Write smoke test: `Engine.create()` → `engine.update()` → `engine.destroy()` | Low |

### Phase 3: Editor Decomposition

| Step | Action | Risk |
|---|---|---|
| 3.1 | Create `src/demos/sceneBuilder/EditorOverlayManager.ts` | None — new file |
| 3.2 | Create `src/demos/sceneBuilder/EditorViewport.ts` that wraps Engine | None — new file |
| 3.3 | Update `ViewportContainer.tsx` to use `EditorViewport` | Medium — integration point |
| 3.4 | Update `SceneBuilderStore` to reference `EditorViewport` | Medium — integration point |
| 3.5 | Verify all panel bridges still work | Medium — need to check each bridge |

### Phase 4: Cleanup

| Step | Action | Risk |
|---|---|---|
| 4.1 | Deprecate old `Viewport.ts` (add `@deprecated` notice) | None |
| 4.2 | Run full build + manual testing | Required |
| 4.3 | Delete old `Viewport.ts` once confident | Low after testing |

---

## 8. Compatibility Checklist

The `EditorViewport` must expose the same public API as the current `Viewport` to minimize changes in consuming code. Here is every public method/property on the current Viewport and where it maps:

| Current Viewport API | EditorViewport | Delegate to |
|---|---|---|
| `init()` | `init()` | Creates Engine, then init |
| `destroy()` | `destroy()` | Engine.destroy() + local cleanup |
| `world` (getter) | `world` (getter) | Engine.world |
| `resize(w, h)` | `resize(w, h)` | Engine.resize() + local canvas |
| `setResolutionScale(s)` | `setResolutionScale(s)` | Local + Engine.resize() |
| `getResolutionScale()` | `getResolutionScale()` | Local |
| `getDevicePixelRatio()` | `getDevicePixelRatio()` | Local |
| `getRenderResolution()` | `getRenderResolution()` | Local |
| `getWebGPUContext()` | `getWebGPUContext()` | Engine.gpuContext |
| `getDebugTextureManager()` | `getDebugTextureManager()` | Engine |
| `getShadowRenderer()` | `getShadowRenderer()` | Engine |
| `setWebGPUShadowSettings(s)` | `setWebGPUShadowSettings(s)` | Engine |
| `setDynamicIBL(e)` | `setDynamicIBL(e)` | Engine |
| `setSSAOSettings(s)` | `setSSAOSettings(s)` | Engine |
| `setDebugViewMode(m)` | `setDebugViewMode(m)` | Engine |
| `setSSRSettings(s)` | `setSSRSettings(s)` | Engine |
| `setCompositeSettings(c)` | `setCompositeSettings(c)` | Engine |
| `setAtmosphericFogSettings(s)` | `setAtmosphericFogSettings(s)` | Engine |
| `setGodRaySettings(s)` | `setGodRaySettings(s)` | Engine |
| `setWeatherPreset(n, d)` | `setWeatherPreset(n, d)` | Engine |
| `clearWeatherPreset()` | `clearWeatherPreset()` | Engine |
| `setCloudSettings(s)` | `setCloudSettings(s)` | Engine |
| `setGizmoTarget(...)` | `setGizmoTarget(...)` | Local gizmo |
| `setGizmoTargetWithQuat(...)` | `setGizmoTargetWithQuat(...)` | Local gizmo |
| `setGizmoTargetPositionAndScale(...)` | `setGizmoTargetPositionAndScale(...)` | Local gizmo |
| `setGizmoEnabled(e)` | `setGizmoEnabled(e)` | Local gizmo |
| `setGizmoMode(m)` | `setGizmoMode(m)` | Local gizmo |
| `setGizmoOrientation(o)` | `setGizmoOrientation(o)` | Local gizmo |
| `setGizmoParentWorldRotation(r)` | `setGizmoParentWorldRotation(r)` | Local gizmo |
| `setLayerBounds(b)` | `setLayerBounds(b)` | Local gizmo + world |
| `setOnLayerBoundsChange(cb)` | `setOnLayerBoundsChange(cb)` | Local gizmo |
| `setFPSMode(e)` | `setFPSMode(e)` | Local |
| `setDebugCameraMode(e)` | `setDebugCameraMode(e)` | Local |
| `isDebugCameraMode()` | `isDebugCameraMode()` | Local |
| `setViewportMode(m)` | `setViewportMode(m)` | Local |
| `setWindParams(p)` | `setWindParams(p)` | Local → WindSystem |
| `setShowGrid(s)` | `setShowGrid(s)` | Local |
| `setShowAxes(s)` | `setShowAxes(s)` | Local |
| `setShowLightHelpers(s)` | `setShowLightHelpers(s)` | EditorOverlayManager |
| `setOverlayContainer(c)` | `setOverlayContainer(c)` | Local |
| `setSceneGraph(sg)` | `setSceneGraph(sg)` | Local |
| `getCameraState()` | `getCameraState()` | Local camera |
| `setCameraState(s)` | `setCameraState(s)` | Local camera |
| `resetCameraOrigin()` | `resetCameraOrigin()` | Local camera |
| `setCameraView(v)` | `setCameraView(v)` | Local camera |
| `updateCameraForSceneBounds(r)` | `updateCameraForSceneBounds(r)` | Local camera |
| `startUniformScale(...)` | `startUniformScale(...)` | Local gizmo |
| `cancelUniformScale()` | `cancelUniformScale()` | Local gizmo |
| `projectObjectToScreen(p)` | `projectObjectToScreen(p)` | Local camera |
| `getLastMousePos()` | `getLastMousePos()` | Local |
| `getInputManager()` | `getInputManager()` | Local |
| `isUniformScaleActive()` | `isUniformScaleActive()` | Local gizmo |
| `isGizmoDragging()` | `isGizmoDragging()` | Local gizmo |
| `isWebGPUTestMode()` | `isWebGPUTestMode()` | returns true |
| `getWebGPUTerrainManager()` | `getWebGPUTerrainManager()` | returns null (deprecated) |
| `adaptCamera(cam)` | `adaptCamera(cam)` | Local utility |
| `engineAnimationLoop` (getter) | `engineAnimationLoop` (getter) | Engine loop |

---

## 9. What This Does NOT Address

This refactoring is scoped to the two assessment items. The following are **deferred** to future work:

| Issue | Assessment § | Why deferred |
|---|---|---|
| GPUContext singleton | §4.1 | Requires changes across 50+ files that call `GPUContext.getInstance()`. Separate refactor. |
| Complete ECS migration (remove Scene/SceneObject) | §3.1 | Orthogonal concern. Can proceed independently. |
| Camera as ECS entity | §3.4 | Requires changing how the pipeline receives camera data. Good follow-up after Engine exists. |
| Component type safety (string → class tokens) | §3.5 | Requires changes to all 28 component types. Separate refactor. |
| Event/messaging system | §4.8 | Valuable but not blocking Engine extraction. |
| Fixed timestep loop | §4.6 | Can be added to Engine after extraction (it's a contained change). |
| Asset management | §4.7 | Orthogonal, large feature. |

---

## 10. Success Criteria

1. ✅ `Engine` class exists in `src/core/` and can be instantiated independently of any demo code
2. ✅ A hypothetical `GameRuntime` could do: `const engine = await Engine.create({ canvas }); engine.start(...)` without importing anything from `src/demos/`
3. ✅ `EditorViewport` is <400 lines (vs current Viewport's ~1,295)
4. ✅ All existing scene builder functionality works identically
5. ✅ `GPUForwardPipeline` no longer imports from `src/demos/`
6. ✅ Build passes with no type errors
7. ✅ No visual regressions in the scene builder

---

## 11. Estimated Effort

| Phase | Estimated effort | Complexity |
|---|---|---|
| Phase 1: Foundation | Small | Low |
| Phase 2: Engine class | Medium | Medium (core logic extraction) |
| Phase 3: Editor decomposition | Medium-Large | Medium-High (integration points) |
| Phase 4: Cleanup | Small | Low |
| **Total** | **Medium-Large** | |

The main risk is in Phase 3.3 (ViewportContainer integration) — ensuring the frame rendering pipeline produces identical output through the new indirection layer. The mitigation is to diff-test the render output before/after.
