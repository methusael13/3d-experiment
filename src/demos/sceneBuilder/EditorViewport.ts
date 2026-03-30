/**
 * EditorViewport — Thin editor shell wrapping the Engine
 *
 * Owns editor-specific concerns: camera controllers, input management,
 * gizmo management, debug overlays, FPS/debug camera modes, and
 * canvas sizing. Delegates all engine logic to Engine.
 *
 * Public API is backward-compatible with the old Viewport class —
 * ViewportContainer.tsx can swap its import with minimal changes.
 *
 * @see docs/engine-extraction-plan.md — Phase 3.2
 */

import { mat4, quat } from 'gl-matrix';
import type { Vec2, Vec3 } from '../../core/types';
import { Engine, type EngineOptions } from '../../core/Engine';
import type { GPUCamera, RenderOptions } from '../../core/gpu/pipeline/GPUForwardPipeline';
import type { GPUContext } from '../../core/gpu/GPUContext';
import type { TerrainManager } from '../../core/terrain/TerrainManager';
import { TransformGizmoManager, GizmoMode } from './gizmos';
import type { GizmoOrientation } from './gizmos/BaseGizmo';
import { CameraController, type CameraState } from './CameraController';
import { InputManager } from './InputManager';
import { screenToRay, projectToScreen, rayIntersectsSphere } from '../../core/utils/raycastUtils';
import type { WindParams, IRenderer } from '../../core/sceneObjects/types';
import { DebugCameraController } from './DebugCameraController';
import { CameraObject } from '@/core/sceneObjects';
import { World } from '../../core/ecs/World';
import { CameraComponent } from '../../core/ecs/components/CameraComponent';
import { TransformComponent } from '../../core/ecs/components/TransformComponent';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { CameraTargetComponent } from '@/core/ecs/components';
import { TerrainLayerBounds } from '@/core/terrain';
import type { CloudConfig } from '@/core/gpu/clouds';
import type { CompositeEffectConfig, AtmosphericFogConfig, GodRayConfig } from '@/core/gpu/postprocess';
import type { WebGPUShadowSettings, SSAOSettings, SSRSettings } from '@/core/EngineConfig';
import { EditorOverlayManager } from './EditorOverlayManager';

// ==================== Type Definitions ====================

export interface ViewportCallbacks {
  onFps?: (fps: number) => void;
  onDrawCalls?: (count: number) => void;
  onUpdate?: (deltaTime: number) => void;
  onGizmoTransform?: (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat) => void;
  onGizmoDragEnd?: () => void;
  onUniformScaleChange?: (newScale: Vec3) => void;
  onUniformScaleCommit?: () => void;
  onUniformScaleCancel?: () => void;
  onObjectClicked?: (objectId: string, shiftKey: boolean) => void;
  onBackgroundClicked?: (shiftKey: boolean) => void;
}

export interface ViewportOptions extends ViewportCallbacks {
  width?: number;
  height?: number;
}

export interface SceneGraph {
  size: number;
  castRay(origin: number[], dir: number[]): { node: { id: string } } | null;
}

// ==================== EditorViewport Class ====================

export class EditorViewport {
  // ── Engine (delegated core) ──
  private _engine: Engine | null = null;

  // ── Canvas and dimensions ──
  private readonly canvas: HTMLCanvasElement;
  private logicalWidth: number;
  private logicalHeight: number;
  private readonly dpr: number;
  private _resolutionScale = 1.0;
  private _lastLogicalWidth = 0;
  private _lastLogicalHeight = 0;

  // ── Editor-specific ──
  private transformGizmo: TransformGizmoManager | null = null;
  private inputManager: InputManager;
  private cameraController: CameraController | null = null;
  private overlayManager: EditorOverlayManager | null = null;
  private overlayContainer: HTMLElement | null = null;
  private sceneGraph: SceneGraph | null = null;

  // ── Camera modes ──
  private fpsMode = false;
  private debugCameraMode = false;
  private debugCameraController: DebugCameraController | null = null;

  // ── View settings ──
  private viewportMode: 'solid' | 'wireframe' = 'solid';
  private showGrid = true;
  private showAxes = true;
  private lastMousePos: Vec2 = [0, 0];

  private windParams: WindParams = {
    enabled: false, time: 0, strength: 0.5,
    direction: [0.707, 0.707], turbulence: 0.5,
  };

  // ── Callbacks ──
  private readonly onFps: (fps: number) => void;
  private readonly onDrawCalls: (count: number) => void;
  private readonly onUpdate: (deltaTime: number) => void;
  private readonly onGizmoTransform: (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat) => void;
  private readonly onGizmoDragEnd: () => void;
  private readonly onUniformScaleChange: (newScale: Vec3) => void;
  private readonly onUniformScaleCommit: () => void;
  private readonly onUniformScaleCancel: () => void;
  private readonly onObjectClicked: (objectId: string, shiftKey: boolean) => void;
  private readonly onBackgroundClicked: (shiftKey: boolean) => void;

  constructor(canvas: HTMLCanvasElement, options: ViewportOptions = {}) {
    this.canvas = canvas;
    this.dpr = window.devicePixelRatio || 1;
    this.logicalWidth = options.width ?? 800;
    this.logicalHeight = options.height ?? 600;
    this._lastLogicalWidth = this.logicalWidth;
    this._lastLogicalHeight = this.logicalHeight;
    this.inputManager = new InputManager(this.canvas);

    // Callbacks
    this.onFps = options.onFps ?? (() => {});
    this.onDrawCalls = options.onDrawCalls ?? (() => {});
    this.onUpdate = options.onUpdate ?? (() => {});
    this.onGizmoTransform = options.onGizmoTransform ?? (() => {});
    this.onGizmoDragEnd = options.onGizmoDragEnd ?? (() => {});
    this.onUniformScaleChange = options.onUniformScaleChange ?? (() => {});
    this.onUniformScaleCommit = options.onUniformScaleCommit ?? (() => {});
    this.onUniformScaleCancel = options.onUniformScaleCancel ?? (() => {});
    this.onObjectClicked = options.onObjectClicked ?? (() => {});
    this.onBackgroundClicked = options.onBackgroundClicked ?? (() => {});
  }

  // ==================== Lifecycle ====================

  async init(): Promise<boolean> {
    const renderWidth = Math.floor(this.logicalWidth * this.dpr);
    const renderHeight = Math.floor(this.logicalHeight * this.dpr);

    this.canvas.width = renderWidth;
    this.canvas.height = renderHeight;
    this.canvas.style.width = this.logicalWidth + 'px';
    this.canvas.style.height = this.logicalHeight + 'px';

    try {
      // Create Engine (replaces old initWebGPU + system registration)
      this._engine = await Engine.create({
        canvas: this.canvas,
        width: renderWidth,
        height: renderHeight,
        onFps: this.onFps,
        systemOptions: { inputManager: this.inputManager },
      });

      // Create editor overlay manager
      this.overlayManager = new EditorOverlayManager(this._engine.gpuContext);

      // Init camera and gizmo
      this.initCamera();
      this.initGizmo();

      // Start render loop
      this._engine.start((dt) => this.render(dt));

      console.log('[EditorViewport] Initialized successfully');
      return true;
    } catch (error) {
      console.error('[EditorViewport] Failed to initialize:', error);
      return false;
    }
  }

  destroy(): void {
    this._engine?.stop();
    this.overlayManager?.destroy();
    this.overlayManager = null;
    this.transformGizmo?.destroy();
    this.transformGizmo = null;
    this._engine?.destroy();
    this._engine = null;
  }

  // ==================== Camera ====================

  private initCamera(): void {
    this.cameraController = new CameraController({
      width: this.logicalWidth,
      height: this.logicalHeight,
      inputManager: this.inputManager,
    });

    this.cameraController.setCallbacks({
      onGizmoCheck: () => this.transformGizmo?.isDragging || this.transformGizmo?.isUniformScaleActive || false,
      onGizmoMouseDown: (x, y) => {
        if (this.transformGizmo?.isUniformScaleActive) {
          this.commitUniformScale();
          return true;
        }
        return this.transformGizmo?.handleMouseDown(x, y, this.logicalWidth, this.logicalHeight) || false;
      },
      onGizmoMouseMove: (x, y) => {
        this.lastMousePos = [x, y];
        if (this.transformGizmo?.isUniformScaleActive) {
          this.handleUniformScaleMove(x, y);
          return;
        }
        this.transformGizmo?.handleMouseMove(x, y);
      },
      onGizmoMouseUp: () => {
        this.transformGizmo?.handleMouseUp();
        this.onGizmoDragEnd();
      },
      onClick: (x, y, shiftKey) => this.handleCanvasClick(x, y, shiftKey),
    });

    this.inputManager.on('global', 'mousemove', (e) => {
      this.lastMousePos = [e.x, e.y];
      if (this.transformGizmo?.isUniformScaleActive) {
        this.handleUniformScaleMove(e.x, e.y);
      }
    });
  }

  // ==================== Gizmo ====================

  private initGizmo(): void {
    if (!this._engine || !this.cameraController) return;
    this.transformGizmo = new TransformGizmoManager(this.cameraController.getCamera() as any);
    this.transformGizmo.initGPURenderer(this._engine.gpuContext);
    this.transformGizmo.setOnChange((type, value) => this.onGizmoTransform(type, value));
    if (this.overlayContainer) this.transformGizmo.setOverlayContainer(this.overlayContainer);
    this.transformGizmo.setCanvasSize(this.logicalWidth, this.logicalHeight);
  }

  // ==================== Input Handling ====================

  private static readonly LIGHT_HANDLE_RADIUS = 0.5;

  private handleCanvasClick(screenX: number, screenY: number, shiftKey = false): void {
    const camera = this.cameraController!.getCamera();
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera as any, this.logicalWidth, this.logicalHeight);

    let hitId: string | null = null;
    if (this.sceneGraph && this.sceneGraph.size > 0) {
      const hit = this.sceneGraph.castRay(rayOrigin, rayDir);
      if (hit) hitId = hit.node.id;
    }

    if (!hitId) hitId = this.raycastLightHandles(rayOrigin, rayDir);

    if (hitId) {
      this.onObjectClicked(hitId, shiftKey);
    } else {
      this.onBackgroundClicked(shiftKey);
    }
  }

  private raycastLightHandles(rayOrigin: number[], rayDir: number[]): string | null {
    const lightEntities = this.world.queryAny('light');
    if (lightEntities.length === 0) return null;
    let closestDist = Infinity;
    let closestId: string | null = null;
    for (const entity of lightEntities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!transform) continue;
      const wp = transform.worldPosition;
      const dist = rayIntersectsSphere(rayOrigin as any, rayDir as any, wp, EditorViewport.LIGHT_HANDLE_RADIUS);
      if (dist !== null && dist < closestDist) {
        closestDist = dist;
        closestId = entity.id;
      }
    }
    return closestId;
  }

  // ==================== Uniform Scale ====================

  private handleUniformScaleMove(mouseX: number, mouseY: number): void {
    if (!this.transformGizmo?.isUniformScaleActive) return;
    const newScale = this.transformGizmo.updateUniformScale(mouseX, mouseY);
    if (newScale) this.onUniformScaleChange(newScale);
  }

  private commitUniformScale(): void {
    this.transformGizmo?.commitUniformScale();
    this.onUniformScaleCommit();
  }

  // ==================== Render Loop ====================

  private render(dt: number): void {
    if (!this._engine || !this.cameraController) return;

    // Build camera adapters
    const { viewCamera, sceneCamera } = this.buildCameraAdapters(dt);

    // Build render options
    const renderOptions = this.buildRenderOptions();

    // Engine update (ECS + render pipeline)
    this._engine.update(dt, viewCamera, renderOptions, sceneCamera);

    // Draw call count
    this.onDrawCalls(this._engine.getLastDrawCallsCount());

    // Editor overlays
    this.renderOverlays(viewCamera);
  }

  private buildCameraAdapters(_dt: number): { viewCamera: GPUCamera; sceneCamera?: GPUCamera } {
    const sceneCameraAdapter = this.adaptCamera(this.cameraController!.getCamera());

    if (this.debugCameraMode && this.debugCameraController) {
      return {
        viewCamera: this.adaptCamera(this.debugCameraController.getCamera()),
        sceneCamera: sceneCameraAdapter,
      };
    }

    if (this.fpsMode) {
      const camEntity = this.world.queryFirst('camera');
      const cam = camEntity?.getComponent<CameraComponent>('camera');
      const camTransform = camEntity?.getComponent<TransformComponent>('transform');
      if (cam && camTransform) {
        const orbitCam = this.cameraController!.getCamera();
        cam.near = orbitCam.near;
        cam.far = orbitCam.far;
        cam.fov = orbitCam.fov * Math.PI / 180;
        cam.setAspectRatio(this.logicalWidth, this.logicalHeight);
        mat4.multiply(cam.vpMatrix, cam.projMatrix, cam.viewMatrix);

        const cameraTarget = camEntity!.getComponent<CameraTargetComponent>('camera-target');
        const camPos = cameraTarget?._currentPosition ?? camTransform.position;

        const fpsCameraAdapter: GPUCamera = {
          getViewMatrix: () => cam.viewMatrix as Float32Array,
          getProjectionMatrix: () => cam.projMatrix as Float32Array,
          getPosition: () => [camPos[0], camPos[1], camPos[2]],
          getVpMatrix: () => cam.vpMatrix as Float32Array,
          near: cam.near,
          far: cam.far,
        };
        return { viewCamera: fpsCameraAdapter };
      }
    }

    return { viewCamera: sceneCameraAdapter };
  }

  private buildRenderOptions(): RenderOptions {
    return {
      showGrid: this.showGrid,
      showAxes: this.showAxes,
      wireframe: this.viewportMode === 'wireframe',
    };
  }

  private renderOverlays(viewCamera: GPUCamera): void {
    if (!this.overlayManager || !this.cameraController) return;

    const cam = this.cameraController.getCamera();
    const camPos = cam.getPosition();
    const vpMatrix = cam.getViewProjectionMatrix() as Float32Array;

    this.overlayManager.renderAllOverlays({
      world: this.world,
      vpMatrix,
      cameraPosition: [camPos[0], camPos[1], camPos[2]],
      logicalHeight: this.logicalHeight,
      fpsMode: this.fpsMode,
      debugCameraMode: this.debugCameraMode,
      sceneCamera: this.debugCameraMode ? this.cameraController.getCamera() : undefined,
      debugCamera: this.debugCameraMode ? this.debugCameraController?.getCamera() : undefined,
      pipeline: this._engine?.pipeline,
      gizmo: this.transformGizmo ?? undefined,
    });
  }

  adaptCamera(camera: CameraObject): GPUCamera {
    return {
      getViewMatrix: () => camera.getViewMatrix() as Float32Array,
      getProjectionMatrix: () => camera.getProjectionMatrix() as Float32Array,
      getPosition: () => camera.getPosition() as number[],
      getVpMatrix: () => camera.getViewProjectionMatrix() as number[],
      near: camera.near,
      far: camera.far,
    };
  }

  // ==================== Public API (backward-compatible with old Viewport) ====================

  get world(): World { return this._engine!.world; }
  get engine(): Engine { return this._engine!; }
  get engineAnimationLoop() { return this._engine?.getAnimationLoop() ?? null; }

  isWebGPUTestMode(): boolean { return true; }
  getWebGPUTerrainManager(): TerrainManager | null { return null; }
  getWebGPUContext(): GPUContext | null { return this._engine?.gpuContext ?? null; }
  getDebugTextureManager() { return this._engine?.getDebugTextureManager() ?? null; }
  getShadowRenderer() { return this._engine?.getShadowRenderer() ?? null; }

  // ── Pipeline config (delegated to engine) ──
  setWebGPUShadowSettings(s: WebGPUShadowSettings): void { this._engine?.setShadowSettings(s); }
  setSSAOSettings(s: SSAOSettings): void { this._engine?.setSSAOSettings(s); }
  setSSRSettings(s: SSRSettings): void { this._engine?.setSSRSettings(s); }
  setCompositeSettings(c: Partial<CompositeEffectConfig>): void { this._engine?.setCompositeSettings(c); }
  setAtmosphericFogSettings(s: Partial<AtmosphericFogConfig> & { enabled?: boolean }): void { this._engine?.setAtmosphericFogSettings(s); }
  setGodRaySettings(s: Partial<GodRayConfig>): void { this._engine?.setGodRaySettings(s); }
  setCloudSettings(s: Partial<CloudConfig>): void { this._engine?.setCloudSettings(s); }
  setWeatherPreset(name: string, duration?: number): void { this._engine?.setWeatherPreset(name, duration); }
  clearWeatherPreset(): void { this._engine?.clearWeatherPreset(); }
  setDynamicIBL(enabled: boolean): void { this._engine?.setDynamicIBL(enabled); }
  setDebugViewMode(mode: string): void { this._engine?.setDebugViewMode(mode); }

  // ── Gizmo control ──
  setGizmoTarget(position: Vec3 | null | undefined, rotation?: Vec3, scale?: Vec3): void {
    if (!position) { this.transformGizmo?.setEnabled(false); return; }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTarget(position, rotation || [0, 0, 0], scale || [1, 1, 1]);
  }

  setGizmoTargetWithQuat(position: Vec3 | null | undefined, rotationQuat: quat, scale?: Vec3): void {
    if (!position) { this.transformGizmo?.setEnabled(false); return; }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTargetWithQuat(position, rotationQuat, scale || [1, 1, 1]);
  }

  setGizmoTargetPositionAndScale(position: Vec3 | null | undefined, scale?: Vec3): void {
    if (!position) { this.transformGizmo?.setEnabled(false); return; }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTargetPositionAndScale(position, scale || [1, 1, 1]);
  }

  setGizmoEnabled(enabled: boolean): void { this.transformGizmo?.setEnabled(enabled); }
  setGizmoMode(mode: GizmoMode): void { this.transformGizmo?.setMode(mode); }
  setGizmoOrientation(orientation: GizmoOrientation): void { this.transformGizmo?.setOrientation(orientation); }
  setGizmoParentWorldRotation(parentRot: quat): void { this.transformGizmo?.setParentWorldRotation(parentRot); }

  setLayerBounds(bounds: TerrainLayerBounds | null): void {
    this.transformGizmo?.setLayerBounds(bounds);
    const terrainEntity = this.world.queryFirst('terrain');
    if (terrainEntity) {
      const terrainComp = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrainComp?.manager) {
        if (bounds) {
          terrainComp.manager.setBoundsOverlay({
            centerX: bounds.centerX, centerZ: bounds.centerZ,
            halfExtentX: bounds.halfExtentX, halfExtentZ: bounds.halfExtentZ,
            rotation: bounds.rotation, featherWidth: bounds.featherWidth,
          });
        } else {
          terrainComp.manager.setBoundsOverlay(null);
        }
      }
    }
  }

  setOnLayerBoundsChange(callback: ((bounds: TerrainLayerBounds) => void) | null): void {
    this.transformGizmo?.setOnLayerBoundsChange(callback);
  }

  // ── Viewport settings ──
  setFPSMode(enabled: boolean): void {
    if (enabled && this.debugCameraMode) this.setDebugCameraMode(false);
    this.fpsMode = enabled;
    this.inputManager?.setActiveChannel(enabled ? 'fps' : 'editor');
  }

  setDebugCameraMode(enabled: boolean): void {
    if (enabled === this.debugCameraMode) return;
    if (enabled && this.fpsMode) this.fpsMode = false;
    this.debugCameraMode = enabled;
    if (enabled) {
      if (!this.inputManager || !this.cameraController) return;
      if (!this.debugCameraController) {
        this.debugCameraController = new DebugCameraController({
          width: this.logicalWidth, height: this.logicalHeight, inputManager: this.inputManager,
        });
      }
      this.debugCameraController.initFromSceneCamera(this.cameraController.getCamera());
      this.debugCameraController.activate();
      this.inputManager.setActiveChannel('debug-camera');
    } else {
      this.debugCameraController?.deactivate();
      this.inputManager?.setActiveChannel('editor');
    }
  }

  isDebugCameraMode(): boolean { return this.debugCameraMode; }
  setViewportMode(mode: 'solid' | 'wireframe'): void { this.viewportMode = mode; }

  setWindParams(params: Partial<WindParams>): void {
    const currentTime = this.windParams.time;
    if (params.enabled !== undefined) this.windParams.enabled = params.enabled;
    if (params.strength !== undefined) this.windParams.strength = params.strength;
    if (params.turbulence !== undefined) this.windParams.turbulence = params.turbulence;
    if (Array.isArray(params.direction)) this.windParams.direction = params.direction;
    if (params.debug !== undefined) (this.windParams as any).debug = params.debug;
    if ((params as any).gustStrength !== undefined) (this.windParams as any).gustStrength = (params as any).gustStrength;
    this.windParams.time = currentTime;
  }

  setShowGrid(show: boolean): void { this.showGrid = show; }
  setShowAxes(show: boolean): void { this.showAxes = show; }
  setShowLightHelpers(show: boolean): void { this.overlayManager?.setShowLightHelpers(show); }
  setOverlayContainer(container: HTMLElement): void {
    this.overlayContainer = container;
    this.transformGizmo?.setOverlayContainer(container);
  }
  setSceneGraph(sg: SceneGraph): void { this.sceneGraph = sg; }

  // ── Camera ──
  getCameraState(): CameraState | null { return this.cameraController?.serialize() ?? null; }
  setCameraState(state: CameraState | Partial<CameraState> | null): void {
    if (state) this.cameraController?.deserialize(state);
  }
  resetCameraOrigin(): void { this.cameraController?.resetOrigin(); }
  setCameraView(view: string): void { this.cameraController?.setView(view); }

  updateCameraForSceneBounds(sceneRadius: number): void {
    if (!this.cameraController) return;
    const camera = this.cameraController.getCamera();
    const minDist = 0.5;
    const maxDist = sceneRadius * 3;
    camera.setZoomLimits(minDist, maxDist);
    const farPlane = Math.max(maxDist + sceneRadius, 2000);
    camera.setClipPlanes(camera.near, farPlane);
  }

  // ── Uniform scale ──
  startUniformScale(startScale: Vec3, objectScreenPos: Vec2, mousePos: Vec2): void {
    this.transformGizmo?.startUniformScale(startScale, objectScreenPos, mousePos);
  }

  cancelUniformScale(): Vec3 {
    const originalScale = this.transformGizmo?.cancelUniformScale() || [1, 1, 1];
    this.onUniformScaleCancel();
    return originalScale;
  }

  // ── Utilities ──
  projectObjectToScreen(position: Vec3): Vec2 {
    return projectToScreen(position, this.cameraController!.getCamera() as any, this.logicalWidth, this.logicalHeight);
  }

  getLastMousePos(): Vec2 { return [...this.lastMousePos]; }
  getInputManager(): InputManager | null { return this.inputManager; }
  isUniformScaleActive(): boolean { return this.transformGizmo?.isUniformScaleActive || false; }
  isGizmoDragging(): boolean { return this.transformGizmo?.isDragging || false; }

  // ── Resize ──
  resize(width: number, height: number): void {
    this._lastLogicalWidth = width;
    this._lastLogicalHeight = height;
    this.logicalWidth = width;
    this.logicalHeight = height;

    const effectiveDpr = this.dpr * this._resolutionScale;
    const renderWidth = Math.floor(width * effectiveDpr);
    const renderHeight = Math.floor(height * effectiveDpr);

    this.canvas.width = renderWidth;
    this.canvas.height = renderHeight;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';

    if (this.cameraController) {
      this.cameraController.getCamera().setAspectRatio(width, height);
    }
    this.transformGizmo?.setCanvasSize(width, height);
    this._engine?.resize(renderWidth, renderHeight);
  }

  setResolutionScale(scale: number): void {
    const clamped = Math.max(0.25, Math.min(1.0, scale));
    if (clamped === this._resolutionScale) return;
    this._resolutionScale = clamped;
    if (this._lastLogicalWidth > 0 && this._lastLogicalHeight > 0) {
      this.resize(this._lastLogicalWidth, this._lastLogicalHeight);
    }
  }

  getResolutionScale(): number { return this._resolutionScale; }
  getDevicePixelRatio(): number { return this.dpr; }
  getRenderResolution(): [number, number] {
    const effectiveDpr = this.dpr * this._resolutionScale;
    return [
      Math.floor(this._lastLogicalWidth * effectiveDpr),
      Math.floor(this._lastLogicalHeight * effectiveDpr),
    ];
  }
}

// ==================== Backward-Compatible Alias ====================

/** @deprecated Use EditorViewport directly */
export { EditorViewport as Viewport };
