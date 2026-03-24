import { mat4, quat } from 'gl-matrix';
import type { Vec2, Vec3, RGB } from '../../core/types';
import { createAnimationLoop, AnimationLoop } from '../../core/animationLoop';
import { GPUContext } from '../../core/gpu/GPUContext';
import { GPUCamera, GPUForwardPipeline, type RenderOptions as GPURenderOptions } from '../../core/gpu/pipeline/GPUForwardPipeline';
import type { TerrainManager } from '../../core/terrain/TerrainManager';
import { TransformGizmoManager, GizmoMode } from './gizmos';
import type { GizmoOrientation } from './gizmos/BaseGizmo';
import { CameraController, type CameraState } from './CameraController';
import { InputManager } from './InputManager';
import { screenToRay, projectToScreen, rayIntersectsSphere } from '../../core/utils/raycastUtils';
import type { RGBColor } from '../../core/sceneObjects/lights';
import type {
  WindParams,
  ObjectWindSettings,
  IRenderer,
} from '../../core/sceneObjects/types';
import { DebugCameraController } from './DebugCameraController';
import { CameraFrustumRendererGPU, type CSMDebugInfo } from '../../core/gpu/renderers/CameraFrustumRendererGPU';
import { WebGPUShadowSettings } from './components/panels/RenderingPanel';
import type { SSAOSettings, SSRSettings } from './components/panels/RenderingPanel';
import type { CompositeEffectConfig, AtmosphericFogConfig } from '../../core/gpu/postprocess';
import { CameraObject } from '@/core/sceneObjects';
import { World } from '../../core/ecs/World';
import {
  TransformSystem,
  BoundsSystem,
  WindSystem,
  ShadowCasterSystem,
  MeshRenderSystem,
  LODSystem,
  WetnessSystem,
  SSRSystem,
  ReflectionProbeSystem,
  PlayerSystem,
  CharacterMovementSystem,
  TerrainCollisionSystem,
  CameraSystem,
  FrustumCullSystem,
  LightingSystem,
  AnimationSystem,
  VegetationInstanceSystem,
} from '../../core/ecs/systems';
import { PlayerComponent } from '../../core/ecs/components/PlayerComponent';
import { CameraComponent } from '../../core/ecs/components/CameraComponent';
import { TransformComponent } from '../../core/ecs/components/TransformComponent';
import { FrustumCullComponent } from '../../core/ecs/components/FrustumCullComponent';
import { LightComponent } from '../../core/ecs/components/LightComponent';
import { createDirectionalLightEntity } from '../../core/ecs/factories';
import { ReflectionProbeCaptureRenderer } from '../../core/gpu/renderers/ReflectionProbeCaptureRenderer';
import { LightBufferManager } from '../../core/gpu/renderers/LightBufferManager';
import { LightVisualizerGPU } from '../../core/gpu/renderers/LightVisualizerGPU';
import { PlayerVisualizerGPU } from '../../core/gpu/renderers/PlayerVisualizerGPU';
import { TerrainLayerBounds } from '@/core/terrain';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { CloudConfig } from '@/core/gpu/clouds';
import type { GodRayConfig } from '@/core/gpu/postprocess';

// ==================== Type Definitions ====================

/**
 * Viewport callback functions
 */
export interface ViewportCallbacks {
  onFps?: (fps: number) => void;
  onDrawCalls?: (count: number) => void;
  onUpdate?: (deltaTime: number) => void;
  /** For rotation, value is quat; for position/scale, value is Vec3 */
  onGizmoTransform?: (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat) => void;
  onGizmoDragEnd?: () => void;
  onUniformScaleChange?: (newScale: Vec3) => void;
  onUniformScaleCommit?: () => void;
  onUniformScaleCancel?: () => void;
  onObjectClicked?: (objectId: string, shiftKey: boolean) => void;
  onBackgroundClicked?: (shiftKey: boolean) => void;
}

/**
 * Viewport initialization options
 */
export interface ViewportOptions extends ViewportCallbacks {
  width?: number;
  height?: number;
}

/**
 * Scene object with renderer for viewport rendering
 */
export interface RenderableSceneObject {
  id: string;
  renderer: IRenderer | null;
  showNormals?: boolean;
  /** Object type for special handling (e.g., terrain) */
  objectType?: string;
}

/**
 * Terrain blend settings per object
 */
export interface TerrainBlendSettings {
  enabled: boolean;
  blendDistance: number;
}

/**
 * Render data provided by controller each frame
 */
export interface RenderData {
  objects: RenderableSceneObject[];
  objectWindSettings: Map<string, ObjectWindSettings>;
  objectTerrainBlendSettings: Map<string, TerrainBlendSettings>;
  selectedIds: Set<string>;
  getModelMatrix: (obj: RenderableSceneObject) => mat4 | null;
}

/**
 * Camera interface expected by viewport
 */
export interface ViewportCamera {
  getPosition(): Vec3;
  getViewProjectionMatrix(): mat4;
  getFOV?(): number;
  near?: number;
  far?: number;
}

/**
 * Scene graph interface for raycasting
 */
export interface SceneGraph {
  size: number;
  castRay(origin: number[], dir: number[]): { node: { id: string } } | null;
}

// ==================== Viewport Class ====================

/**
 * Viewport - The View in MVC architecture
 * Handles all WebGL rendering, camera control, and 3D input
 * Communicates with Controller via pure callbacks
 */
export class Viewport {
  // Canvas and dimensions
  private readonly canvas: HTMLCanvasElement;
  private readonly logicalWidth: number;
  private readonly logicalHeight: number;
  private readonly renderWidth: number;
  private readonly renderHeight: number;
  private readonly dpr: number;

  // Resolution scale (1.0 = native DPR, lower = reduced render resolution)
  private _resolutionScale: number = 1.0;
  private _lastLogicalWidth: number = 0;
  private _lastLogicalHeight: number = 0;

  // Transform gizmo
  private transformGizmo: TransformGizmoManager | null = null;

  // Input management
  private inputManager: InputManager;

  // Camera
  private cameraController: CameraController | null = null;

  // Animation loop
  private animationLoop: AnimationLoop | null = null;

  // Overlay container for gizmo 2D elements
  private overlayContainer: HTMLElement | null = null;

  // Scene graph reference (for raycasting)
  private sceneGraph: SceneGraph | null = null;

  // ECS World (self-contained, owns its systems)
  private _world: World;

  // Wind params (reference from WindManager via controller)
  private windParams: WindParams = {
    enabled: false,
    time: 0,
    strength: 0.5,
    direction: [0.707, 0.707],
    turbulence: 0.5,
  };

  // Pure view settings (not duplicated elsewhere)
  private viewportMode: 'solid' | 'wireframe' = 'solid';
  private showGrid = true;
  private showAxes = true;

  // Mouse tracking
  private lastMousePos: Vec2 = [0, 0];

  // Animation time (for ECS systems)
  private time = 0;

  // FPS Camera mode
  private fpsMode = false;

  // Debug Camera mode
  private debugCameraMode = false;
  private debugCameraController: DebugCameraController | null = null;
  private cameraFrustumRenderer: CameraFrustumRendererGPU | null = null;

  // Reflection Probe capture renderer
  private reflectionProbeCaptureRenderer: ReflectionProbeCaptureRenderer | null = null;

  // Light buffer manager for multi-light GPU buffers
  private lightBufferManager: LightBufferManager | null = null;

  // Light visualizer for wireframe helpers (arrows, spheres, cones)
  private lightVisualizer: LightVisualizerGPU | null = null;

  // Player visualizer for wireframe helpers (sphere + look-direction arrow)
  private playerVisualizer: PlayerVisualizerGPU | null = null;

  private gpuContext: GPUContext | null = null;
  private gpuPipeline: GPUForwardPipeline | null = null;

  // Dynamic IBL (Image-Based Lighting) setting for WebGPU mode
  private dynamicIBLEnabled = true;  // Enabled by default

  // Callbacks (all optional)
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

    // Dimensions
    this.logicalWidth = options.width ?? 800;
    this.logicalHeight = options.height ?? 600;
    this.renderWidth = Math.floor(this.logicalWidth * this.dpr);
    this.renderHeight = Math.floor(this.logicalHeight * this.dpr);

    // Seed last-known logical size so setResolutionScale works before the first ResizeObserver fires
    this._lastLogicalWidth = this.logicalWidth;
    this._lastLogicalHeight = this.logicalHeight;

    // Create InputManager for event routing
    this.inputManager = new InputManager(this.canvas);

    // Initialize ECS World with all systems
    // Execution order: PlayerSystem(5) → TransformSystem(7) → Bounds(10) → CharacterMovement(20) → TerrainCollision(25) → CameraSystem(30) → ...
    this._world = new World();

    // Player system — persistent, no-ops until enter() is called
    // Runs first to write position/rotation to TransformComponent before hierarchy propagation
    const playerSystem = new PlayerSystem(this.inputManager);
    playerSystem.initialize?.();
    this._world.addSystem(playerSystem);                  // priority 5 — runs early, writes position/rotation

    // Character movement system — converts input + physics into position changes
    // Only runs on entities with CharacterPhysicsComponent (new physics-based pipeline)
    this._world.addSystem(new CharacterMovementSystem()); // priority 20 — after input, before terrain collision

    // Terrain collision system — samples heightmap, snaps to ground, detects grounding
    // Only runs on entities with CharacterPhysicsComponent
    this._world.addSystem(new TerrainCollisionSystem());  // priority 25 — after movement, before camera/transform

    // Camera system — computes view/projection matrices from transform + player orientation
    // Priority 30: runs AFTER CharacterMovementSystem(20) and TerrainCollisionSystem(25)
    // so the view matrix uses the final post-collision position each frame.
    this._world.addSystem(new CameraSystem());            // priority 30 — after movement + collision

    // Transform system — propagates parent-child hierarchy AFTER player writes position
    // This ensures child entities (e.g. spot lights attached to player) get the current frame's rotation
    const transformSystem = new TransformSystem();
    transformSystem.world = this._world;
    transformSystem.priority = 7;                          // priority 7 — AFTER PlayerSystem(5)
    this._world.addSystem(transformSystem);

    const boundsSystem = new BoundsSystem();
    boundsSystem.world = this._world;
    this._world.addSystem(boundsSystem);                 // priority 10
    this._world.addSystem(new LODSystem());               // priority 10 — LOD from camera distance
    this._world.addSystem(new WindSystem());              // priority 50 — owns its own WindManager
    const wetnessSystem = new WetnessSystem();            // priority 55 — wetness from ocean
    wetnessSystem.setWorld(this._world);
    this._world.addSystem(wetnessSystem);

    // Frustum culling system (priority 85 — after bounds, before shadow caster / render)
    const frustumCullSystem = new FrustumCullSystem();
    this._world.addSystem(frustumCullSystem);             // priority 85
    // Create singleton entity for frustum cull data (internal = hidden from UI)
    const frustumCullEntity = this._world.createEntity('__FrustumCull');
    frustumCullEntity.internal = true;
    frustumCullEntity.addComponent(new FrustumCullComponent());

    this._world.addSystem(new LightingSystem());         // priority 80 — compute direction/color from azimuth/elevation
    this._world.addSystem(new ShadowCasterSystem());     // priority 90
    this._world.addSystem(new AnimationSystem());        // priority 95 — skeletal animation clip eval + bone matrices
    this._world.addSystem(new VegetationInstanceSystem()); // priority 95 — vegetation wind uniform upload
    const ssrSystem = new SSRSystem();                   // priority 95 — LOD-gated SSR
    this._world.addSystem(ssrSystem);
    this._world.addSystem(new ReflectionProbeSystem());  // priority 96 — probe bake lifecycle
    this._world.addSystem(new MeshRenderSystem());       // priority 100

    // Create default "Sun" directional light entity (internal — not shown in Objects Panel)
    const sunEntity = createDirectionalLightEntity(this._world, {
      name: '__Sun',
      azimuth: 45,
      elevation: 45,
      castsShadow: true,
    });
    sunEntity.internal = true;

    // Callbacks
    this.onFps = options.onFps ?? (() => { });
    this.onDrawCalls = options.onDrawCalls ?? (() => { });
    this.onUpdate = options.onUpdate ?? (() => { });
    this.onGizmoTransform = options.onGizmoTransform ?? (() => { });
    this.onGizmoDragEnd = options.onGizmoDragEnd ?? (() => { });
    this.onUniformScaleChange = options.onUniformScaleChange ?? (() => { });
    this.onUniformScaleCommit = options.onUniformScaleCommit ?? (() => { });
    this.onUniformScaleCancel = options.onUniformScaleCancel ?? (() => { });
    this.onObjectClicked = options.onObjectClicked ?? (() => { });
    this.onBackgroundClicked = options.onBackgroundClicked ?? (() => { });
  }

  // ==================== Lifecycle ====================

  /**
   * Initialize WebGL, renderers, camera, and start render loop
   */
  async init(): Promise<boolean> {
    // Set physical canvas size (high resolution for HiDPI)
    this.canvas.width = this.renderWidth;
    this.canvas.height = this.renderHeight;

    // Set CSS display size (logical pixels)
    this.canvas.style.width = this.logicalWidth + 'px';
    this.canvas.style.height = this.logicalHeight + 'px';

    await this.initWebGPU();
    this.initCamera();
    this.initGizmo();
    this.startRendering();
    return true;
  }


  /**
   * Enable WebGPU test mode - renders a simple triangle using WebGPU
   * This is for testing the WebGPU pipeline before full migration
   */
  async initWebGPU(): Promise<boolean> {
    try {
      console.log('[Viewport] Enabling WebGPU');

      // Initialize WebGPU context on the separate canvas
      this.gpuContext = await GPUContext.getInstance(this.canvas);
      console.log('[Viewport] WebGPU context initialized');

      // Create full WebGPU forward pipeline with grid and sky
      this.gpuPipeline = new GPUForwardPipeline(this.gpuContext, {
        width: this.renderWidth,
        height: this.renderHeight,
      });
      console.log('[Viewport] WebGPU Forward Pipeline created');

      // Create LightBufferManager and wire to LightingSystem + SceneEnvironment
      this.lightBufferManager = new LightBufferManager(this.gpuContext);
      const lightingSystem = this._world.getSystem<LightingSystem>('lighting');
      if (lightingSystem) {
        lightingSystem.lightBufferManager = this.lightBufferManager;
      }
      // Wire LightBufferManager and ShadowRenderer into SceneEnvironment + LightingSystem
      const sceneEnv = this.gpuPipeline.getSceneEnvironment();
      const shadowRenderer = this.gpuPipeline.getShadowRenderer();
      sceneEnv.setLightBufferManager(this.lightBufferManager);
      sceneEnv.setShadowRenderer(shadowRenderer);
      if (lightingSystem) {
        lightingSystem.shadowRenderer = shadowRenderer;
      }
      // Create light visualizer for wireframe light helpers
      this.lightVisualizer = new LightVisualizerGPU(this.gpuContext);
      // Create player visualizer for wireframe player helpers
      this.playerVisualizer = new PlayerVisualizerGPU(this.gpuContext);
      console.log('[Viewport] LightBufferManager + ShadowRenderer + LightVisualizer + PlayerVisualizer wired');

      // Wire up ReflectionProbeSystem with its capture renderer
      const probeSystem = this._world.getSystem<ReflectionProbeSystem>('reflection-probe');
      if (probeSystem && !probeSystem.captureRenderer) {
        if (!this.reflectionProbeCaptureRenderer) {
          this.reflectionProbeCaptureRenderer = new ReflectionProbeCaptureRenderer(this.gpuContext);
        }
        // Wire up MeshRenderSystem so the capture renderer can use VariantRenderer.renderColor()
        this.reflectionProbeCaptureRenderer.meshRenderSystem =
          this._world.getSystem<MeshRenderSystem>('mesh-render') ?? null;
        probeSystem.captureRenderer = this.reflectionProbeCaptureRenderer;
      }

      return true;
    } catch (error) {
      console.error('[Viewport] ❌ Failed to enable WebGPU test mode:', error);
      return false;
    }
  }

  /**
   * Clean up all GPU resources
   */
  destroy(): void {
    this.animationLoop?.stop();
    this.animationLoop = null;

    // Destroy light visualizer, player visualizer, and buffer manager
    this.lightVisualizer?.destroy();
    this.lightVisualizer = null;
    this.playerVisualizer?.destroy();
    this.playerVisualizer = null;
    this.lightBufferManager?.destroy();
    this.lightBufferManager = null;

    // Pipeline handles cleanup of its own passes
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;

    this.transformGizmo?.destroy();
    this.transformGizmo = null;
  }

  // ==================== Camera ====================

  private initCamera(): void {
    // Create CameraController with InputManager
    this.cameraController = new CameraController({
      width: this.logicalWidth,
      height: this.logicalHeight,
      inputManager: this.inputManager,
    });

    // Set up gizmo and click callbacks
    this.cameraController.setCallbacks({
      onGizmoCheck: () => this.transformGizmo?.isDragging || this.transformGizmo?.isUniformScaleActive || false,
      onGizmoMouseDown: (x: number, y: number) => {
        if (this.transformGizmo?.isUniformScaleActive) {
          this.commitUniformScale();
          return true;
        }
        return this.transformGizmo?.handleMouseDown(x, y, this.logicalWidth, this.logicalHeight) || false;
      },
      onGizmoMouseMove: (x: number, y: number) => {
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
      onClick: (x: number, y: number, shiftKey: boolean) => this.handleCanvasClick(x, y, shiftKey),
    });

    // Subscribe to InputManager for mouse position tracking (global channel)
    this.inputManager.on('global', 'mousemove', (e) => {
      this.lastMousePos = [e.x, e.y];
      if (this.transformGizmo?.isUniformScaleActive) {
        this.handleUniformScaleMove(e.x, e.y);
      }
    });
  }

  // ==================== Gizmo ====================

  private initGizmo(): void {
    if (!this.gpuContext || !this.cameraController) return;

    this.transformGizmo = new TransformGizmoManager(this.cameraController.getCamera() as any);
    this.transformGizmo.initGPURenderer(this.gpuContext);
    this.transformGizmo.setOnChange((type, value) => {
      this.onGizmoTransform(type, value);
    });

    if (this.overlayContainer) {
      this.transformGizmo.setOverlayContainer(this.overlayContainer);
    }

    this.transformGizmo.setCanvasSize(this.logicalWidth, this.logicalHeight);
  }

  // ==================== Input Handling ====================

  /** Fixed click radius for light handle selection (world units) */
  private static readonly LIGHT_HANDLE_RADIUS = 0.5;

  private handleCanvasClick(screenX: number, screenY: number, shiftKey = false): void {
    const camera = this.cameraController!.getCamera();
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera as any, this.logicalWidth, this.logicalHeight);

    // 1. Test scene graph (mesh entities) first
    let hitId: string | null = null;
    if (this.sceneGraph && this.sceneGraph.size > 0) {
      const hit = this.sceneGraph.castRay(rayOrigin, rayDir);
      if (hit) {
        hitId = hit.node.id;
      }
    }

    // 2. If no mesh hit, test light entity handles (sphere-ray intersection)
    if (!hitId) {
      hitId = this.raycastLightHandles(rayOrigin, rayDir);
    }

    if (hitId) {
      this.onObjectClicked(hitId, shiftKey);
    } else {
      this.onBackgroundClicked(shiftKey);
    }
  }

  /**
   * Test ray against light entity positions using sphere-ray intersection.
   * Returns the closest light entity ID hit, or null.
   */
  private raycastLightHandles(rayOrigin: number[], rayDir: number[]): string | null {
    const lightEntities = this._world.queryAny('light');
    if (lightEntities.length === 0) return null;

    let closestDist = Infinity;
    let closestId: string | null = null;
    const radius = Viewport.LIGHT_HANDLE_RADIUS;

    for (const entity of lightEntities) {
      const transform = entity.getComponent<import('../../core/ecs/components/TransformComponent').TransformComponent>('transform');
      if (!transform) continue;

      const wp = transform.worldPosition;
      const dist = rayIntersectsSphere(
        rayOrigin as [number, number, number],
        rayDir as [number, number, number],
        wp,
        radius,
      );
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
    if (newScale) {
      this.onUniformScaleChange(newScale);
    }
  }

  private commitUniformScale(): void {
    this.transformGizmo?.commitUniformScale();
    this.onUniformScaleCommit();
  }

  // ==================== WebGPU Mode ====================

  /**
   * Check if WebGPU test mode is active
   */
  isWebGPUTestMode(): boolean {
    return true;
  }

  /**
   * Get the WebGPU terrain manager (for panel integration)
   * @deprecated - Terrain is now maintained within the terrain scene object
   */
  getWebGPUTerrainManager(): TerrainManager | null {
    return null;
  }

  getWebGPUContext(): GPUContext | null {
    return this.gpuContext;
  }

  /**
   * Get the WebGPU debug texture manager (for registering debug textures)
   */
  getDebugTextureManager() {
    return this.gpuPipeline?.getDebugTextureManager() ?? null;
  }

  getShadowRenderer() {
    return this.gpuPipeline?.getShadowRenderer() ?? null;
  }

  /**
   * Set WebGPU shadow settings (for RenderingPanel integration)
   */
  setWebGPUShadowSettings(settings: WebGPUShadowSettings): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setShadowSettings(settings);
    }
  }

  /**
   * Set Dynamic IBL (Image-Based Lighting) enabled state
   * Controls whether the DynamicSkyIBL system is active for realistic ambient lighting
   */
  setDynamicIBL(enabled: boolean): void {
    this.dynamicIBLEnabled = enabled;
  }

  /**
   * Set WebGPU SSAO settings (for RenderingPanel integration)
   * Uses SSAOSettings which extends SSAOConfig from postprocess module
   */
  setSSAOSettings(settings: SSAOSettings): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setSSAOEnabled(settings.enabled);
      if (settings.enabled) {
        this.gpuPipeline.setSSAOConfig({ ...settings });
      }
    }
  }

  /**
   * Set debug view mode (off, depth, normals, ssr) for RenderingPanel integration
   */
  setDebugViewMode(mode: string): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setDebugViewMode(mode as any);
    }
  }

  /**
   * Set SSR (Screen Space Reflections) settings (for RenderingPanel integration)
   */
  setSSRSettings(settings: SSRSettings): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setSSREnabled(settings.enabled);
      if (settings.quality) {
        this.gpuPipeline.setSSRQuality(settings.quality);
      }
    }
    // Propagate global SSR enabled state to SSRSystem (gates per-entity SSR by LOD)
    const ssrSystem = this._world.getSystem<SSRSystem>('ssr');
    if (ssrSystem) {
      ssrSystem.ssrGloballyEnabled = settings.enabled;
    }
  }

  /**
   * Set WebGPU composite/tonemapping settings (for RenderingPanel integration)
   */
  setCompositeSettings(config: Partial<CompositeEffectConfig>): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setCompositeConfig(config);
    }
  }

  /**
   * Set atmospheric fog settings (for RenderingPanel integration)
   * Enables/disables the effect and updates all fog parameters
   */
  setAtmosphericFogSettings(settings: Partial<AtmosphericFogConfig> & { enabled?: boolean }): void {
    if (this.gpuPipeline) {
      // Handle master enable/disable
      if (settings.enabled !== undefined) {
        this.gpuPipeline.setAtmosphericFogEnabled(settings.enabled);
      }
      // Pass all config to the effect
      this.gpuPipeline.setAtmosphericFogConfig(settings);
    }
  }

  /**
   * Set god ray settings (for RenderingPanel integration)
   * Enables/disables god rays and updates all god ray parameters
   */
  setGodRaySettings(settings: Partial<GodRayConfig>): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setGodRayConfig(settings);
    }
  }

  /**
   * Set volumetric cloud settings (for RenderingPanel integration)
   * Enables/disables clouds and updates all cloud parameters
   */
  /**
   * Set a weather preset with smooth transition (Phase 5).
   */
  setWeatherPreset(name: string, duration?: number): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setWeatherPreset(name, duration);
    }
  }

  clearWeatherPreset(): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.clearWeatherPreset();
    }
  }

  setCloudSettings(settings: Partial<CloudConfig>): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setCloudConfig(settings);
    }
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

  /**
   * Render using WebGPU (full pipeline with grid/sky)
   */
  private renderWebGPU(dt: number): void {
    if (!this.gpuContext || !this.gpuPipeline || !this.cameraController) return;

    // Scene camera adapter (always the orbit camera — drives shadows, culling, shader uniforms)
    let sceneCameraAdapter = this.adaptCamera(this.cameraController.getCamera());

    // View camera adapter (what appears on screen — may be debug camera)
    let viewCameraAdapter: GPUCamera;
    let separateSceneCamera: GPUCamera | undefined;

    if (this.debugCameraMode && this.debugCameraController) {
      // Debug camera mode: view from debug camera, scene camera separate
      viewCameraAdapter = this.adaptCamera(this.debugCameraController.getCamera());
      separateSceneCamera = sceneCameraAdapter;
    } else if (this.fpsMode) {
      // FPS camera mode — read matrices from ECS CameraComponent
      const camEntity = this._world.queryFirst('camera');
      const cam = camEntity?.getComponent<CameraComponent>('camera');
      const camTransform = camEntity?.getComponent<TransformComponent>('transform');
      if (cam && camTransform) {
        // Sync clip planes, FOV, and aspect ratio from the orbit camera so the
        // FPS projection matches what the rest of the pipeline expects.
        // CameraComponent defaults to FOV=60°, aspect=16:9, near=0.1, far=1000
        // which all differ from the actual orbit camera; this mismatch causes
        // the inverseViewProj in the cloud ray marcher to reconstruct
        // world-space ray directions incorrectly, producing radial cloud
        // stretching during camera translation.
        //
        // near/far/fov are set BEFORE setAspectRatio because setAspectRatio
        // recomputes the projection matrix using the current near/far/fov.
        const orbitCam = this.cameraController!.getCamera();
        cam.near = orbitCam.near;
        cam.far = orbitCam.far;
        cam.fov = orbitCam.fov * Math.PI / 180; // CameraObject stores degrees, CameraComponent stores radians
        cam.setAspectRatio(this.logicalWidth, this.logicalHeight);

        viewCameraAdapter = {
          getViewMatrix: () => cam.viewMatrix as Float32Array,
          getProjectionMatrix: () => cam.projMatrix as Float32Array,
          getPosition: () => [camTransform.position[0], camTransform.position[1], camTransform.position[2]] as number[],
          getVpMatrix: () => cam.vpMatrix as Float32Array,
          near: cam.near,
          far: cam.far,
        };
        sceneCameraAdapter = viewCameraAdapter;
      } else {
        // Camera entity not found — fall through to normal mode
        viewCameraAdapter = sceneCameraAdapter;
      }
    } else {
      // Normal mode: scene camera is also the view camera
      viewCameraAdapter = sceneCameraAdapter;
    }

    // Alias for backward compatibility
    const cameraAdapter = viewCameraAdapter;

    // ── Read lighting from ECS LightComponent (single source of truth) ──
    // Query the first directional light entity. LightingSystem has already
    // computed direction / effectiveColor / sunIntensityFactor / ambient.
    const sunEntity = this._world.queryFirst('light');
    const sunLight = sunEntity?.getComponent<LightComponent>('light') ?? null;

    const isHDR = false; // HDR mode will be driven by ECS in the future
    const sunIntensityFactor = sunLight?.sunIntensityFactor ?? 1.0;
    const sunIntensity = 20 * sunIntensityFactor;
    const hdrExposure = 1.0;
    const ambientIntensity = sunLight?.ambient ?? 0.3;
    const lightColor: RGBColor = (sunLight?.effectiveColor as RGBColor) ?? [1, 1, 0.95];

    // Light direction from ECS (computed by LightingSystem)
    const lightDirection: [number, number, number] | undefined = sunLight?.direction;

    // Note: Gizmos are rendered by TransformGizmoManager after the pipeline finishes

    // Render options
    const options: GPURenderOptions = {
      showGrid: this.showGrid,
      showAxes: this.showAxes,
      skyMode: isHDR ? 'hdr' : 'sun',
      sunIntensity,
      hdrExposure,
      wireframe: this.viewportMode == 'wireframe',
      ambientIntensity,
      lightDirection,  // Pass pre-computed direction
      lightColor,
      dynamicIBL: this.dynamicIBLEnabled,  // Pass Dynamic IBL state
    };

    // Use render with scene and camera adapter (pass separate scene camera if in debug mode)
    // Run ECS systems before rendering
    if (this.gpuContext) {
      this.updateFrustumCullSystem(sceneCameraAdapter);

      // Feed scene camera VP matrix to LightingSystem for point/spot light frustum culling
      const lightingSystem = this._world.getSystem<LightingSystem>('lighting');
      if (lightingSystem) {
        const sceneVP = new Float32Array(16);
        const sceneView = sceneCameraAdapter.getViewMatrix();
        const sceneProj = sceneCameraAdapter.getProjectionMatrix();
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
              sum += sceneProj[i + k * 4] * sceneView[k + j * 4];
            }
            sceneVP[i + j * 4] = sum;
          }
        }
        lightingSystem.setViewProjectionMatrix(sceneVP);
      }

      // Feed per-frame data to systems
      const shadowCasterSystem = this._world.getSystem<ShadowCasterSystem>('shadow-caster');
      if (shadowCasterSystem) {
        const camPos = sceneCameraAdapter.getPosition();
        shadowCasterSystem.cameraPosition = [camPos[0], camPos[1], camPos[2]] as [number, number, number];
      }

      // LODSystem: provide camera position for distance-based LOD computation
      const lodSystem = this._world.getSystem<LODSystem>('lod');
      if (lodSystem) {
        const camPos = sceneCameraAdapter.getPosition();
        lodSystem.setCameraPosition(camPos[0], camPos[1], camPos[2]);
      }

      const meshRenderSystem = this._world.getSystem<MeshRenderSystem>('mesh-render');
      if (meshRenderSystem) {
        meshRenderSystem.iblActive = this.dynamicIBLEnabled;
        meshRenderSystem.shadowsActive = options.shadowEnabled ?? true;

        // Set WindSystem reference for wind uniform upload
        if (!meshRenderSystem.windSystem) {
          meshRenderSystem.windSystem = this._world.getSystem<WindSystem>('wind') ?? null;
        }
      }

      // Update reflection probe capture renderer with current scene light params
      // so probe bakes use real lighting (not hardcoded defaults)
      if (this.reflectionProbeCaptureRenderer) {
        this.reflectionProbeCaptureRenderer.sceneLightParams = {
          lightDirection: (lightDirection ?? [0.3, 0.8, 0.5]) as [number, number, number],
          lightColor: (lightColor ?? [1.0, 1.0, 0.95]) as [number, number, number],
          ambientIntensity,
        };
      }

      const mergedOptions = this.gpuPipeline.getMergedRenderOptions(options);
      // Run pipeline pre-world update (pass scene camera so vegetation mesh entities
      // are synced BEFORE world.update() — MeshRenderSystem needs them active)
      this.gpuPipeline.preWorldUpdate(dt, mergedOptions, this._world, sceneCameraAdapter);

      // Run all ECS systems
      this.time += dt;
      this._world.update(dt, {
        ctx: this.gpuContext,
        world: this._world,
        time: this.time,
        deltaTime: dt,
        sceneEnvironment: this.gpuPipeline!.getSceneEnvironment(),
      });

      this.gpuPipeline.render(cameraAdapter, mergedOptions, separateSceneCamera, this._world);
    }

    // Flush deferred entity deletions after all GPU commands are submitted.
    // Entities marked for deletion during the frame are kept alive until here
    // so their GPU resources (textures, buffers) can still be referenced by
    // in-flight render commands.
    this._world.flushPendingDeletions();

    // Render debug camera frustum visualization when in debug camera mode
    if (this.debugCameraMode && this.debugCameraController && this.cameraFrustumRenderer) {
      this.renderDebugCameraOverlay();
    }

    // Render light helper wireframes (skip in FPS mode)
    if (!this.fpsMode && this.lightVisualizer?.enabled) {
      this.lightVisualizer.update(this._world);
      const vpMatrix = this.cameraController!.getCamera().getViewProjectionMatrix();
      this.renderLightHelperOverlay(vpMatrix as Float32Array);
    }

    // Render player helper wireframes (skip in FPS mode — you ARE the player)
    if (!this.fpsMode && this.playerVisualizer?.enabled) {
      this.playerVisualizer.update(this._world);
      if (this.playerVisualizer.drawCount > 0) {
        const vpMatrix = this.cameraController!.getCamera().getViewProjectionMatrix();
        this.renderPlayerHelperOverlay(vpMatrix as Float32Array);
      }
    }

    // Render gizmo via TransformGizmoManager (skip in FPS mode and debug camera mode)
    // This uses the same screen-space scale as hit testing for consistency
    if (!this.fpsMode && !this.debugCameraMode && this.transformGizmo?.hasGPURenderer()) {
      const vpMatrix = this.cameraController!.getCamera().getViewProjectionMatrix();
      this.renderGizmoOverlay(vpMatrix as Float32Array);
    }
  }

  private updateFrustumCullSystem(sceneCamera: GPUCamera) {
    // Feed scene camera VP matrix to frustum cull system (always scene camera, not debug camera)
    const frustumCullSys = this._world.getSystem<FrustumCullSystem>('frustum-cull');
    if (frustumCullSys) {
      const sceneVP = new Float32Array(16);
      const sceneView = sceneCamera.getViewMatrix();
      const sceneProj = sceneCamera.getProjectionMatrix();
      // Compute VP = proj * view
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += sceneProj[i + k * 4] * sceneView[k + j * 4];
          }
          sceneVP[i + j * 4] = sum;
        }
      }
      frustumCullSys.setViewProjectionMatrix(sceneVP);
    }
  }

  /**
   * Render debug camera overlay: scene camera frustum + body visualization
   */
  private renderDebugCameraOverlay(): void {
    if (!this.gpuContext || !this.cameraFrustumRenderer || !this.cameraController || !this.debugCameraController) return;

    const sceneCamera = this.cameraController.getCamera();

    // Update frustum geometry from scene camera parameters
    const pos = sceneCamera.getPosition();
    const target = sceneCamera.getTarget();

    // Build CSM debug info if shadow renderer has CSM enabled
    let csmInfo: CSMDebugInfo | undefined;
    if (this.gpuPipeline) {
      const shadowRenderer = this.gpuPipeline.getShadowRenderer();
      const shadowConfig = shadowRenderer.getConfig();
      if (shadowConfig.csmEnabled) {
        // Get light direction from ECS
        const sunEntity = this._world.queryFirst('light');
        const sunLc = sunEntity?.getComponent<LightComponent>('light');
        const lightDir = sunLc?.direction;
        if (lightDir) {
          csmInfo = {
            lightDirection: lightDir,
            cascadeCount: shadowConfig.cascadeCount,
            cascadeSplitLambda: shadowConfig.cascadeSplitLambda,
            shadowRadius: shadowConfig.shadowRadius,
          };
        }
      }
    }

    this.cameraFrustumRenderer.updateFrustum(
      pos,
      target,
      sceneCamera.fov,
      this.logicalWidth / this.logicalHeight,
      sceneCamera.near,
      sceneCamera.far,
      csmInfo
    );

    // Get current backbuffer
    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();

    // Create command encoder for frustum pass
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'camera-frustum-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'camera-frustum-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    // Get debug camera VP matrix for rendering
    const debugVP = this.debugCameraController.getCamera().getViewProjectionMatrix();
    this.cameraFrustumRenderer.render(passEncoder, debugVP as Float32Array);

    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  /**
   * Render light helper wireframes overlay
   */
  private renderLightHelperOverlay(vpMatrix: Float32Array): void {
    if (!this.gpuContext || !this.lightVisualizer || this.lightVisualizer.drawCount === 0) return;

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'light-helper-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'light-helper-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    const cam = this.cameraController!.getCamera();
    const camPos = cam.getPosition();
    this.lightVisualizer.render(
      passEncoder,
      vpMatrix,
      [camPos[0], camPos[1], camPos[2]] as [number, number, number],
      this.logicalHeight,
    );
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  /**
   * Render player helper wireframes overlay (sphere + look-direction arrow)
   */
  private renderPlayerHelperOverlay(vpMatrix: Float32Array): void {
    if (!this.gpuContext || !this.playerVisualizer || this.playerVisualizer.drawCount === 0) return;

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'player-helper-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'player-helper-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    const cam = this.cameraController!.getCamera();
    const camPos = cam.getPosition();
    this.playerVisualizer.render(
      passEncoder,
      vpMatrix,
      [camPos[0], camPos[1], camPos[2]] as [number, number, number],
      this.logicalHeight,
    );
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  /**
   * Render gizmo overlay using WebGPU
   * Creates a separate render pass after the main pipeline to render gizmos
   */
  private renderGizmoOverlay(vpMatrix: Float32Array): void {
    if (!this.gpuContext || !this.transformGizmo) return;

    // Get current backbuffer
    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();

    // Create command encoder for gizmo pass
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'gizmo-overlay-encoder',
    });

    // Create render pass that renders on top of existing content
    // Load existing color, use existing depth for depth testing
    const passEncoder = encoder.beginRenderPass({
      label: 'gizmo-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load',    // Keep existing color
        storeOp: 'store',
      }],
      // No depth attachment - gizmos render without depth test in this overlay
      // (The GizmoRendererGPU disables depth test internally via pipeline state)
    });

    // Render gizmo
    this.transformGizmo.renderGPU(passEncoder, vpMatrix);

    passEncoder.end();

    // Submit gizmo commands
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  // ==================== Render Loop ====================

  get engineAnimationLoop() {
    return this.animationLoop;
  }

  private startRendering(): void {
    this.animationLoop?.stop();

    this.animationLoop = createAnimationLoop({ onFps: this.onFps });
    this.animationLoop.start((deltaTime: number) => {
      this.render(deltaTime);
    });
  }

  private render(deltaTime: number): void {
    const dt = deltaTime / 1000;

    // FPS camera update is now handled by FPSCameraSystem in the ECS update loop

    this.renderWebGPU(dt);

    // Emit draw call count from last pipeline render
    if (this.gpuPipeline) {
      this.onDrawCalls(this.gpuPipeline.getLastDrawCallsCount());
    }
  }

  // ==================== Public API ====================

  setOverlayContainer(container: HTMLElement): void {
    this.overlayContainer = container;
    this.transformGizmo?.setOverlayContainer(container);
  }

  setSceneGraph(sg: SceneGraph): void {
    this.sceneGraph = sg;
  }

  /**
   * Get the ECS World.
   */
  get world(): World {
    return this._world;
  }

  // ==================== Gizmo Control ====================

  setGizmoTarget(position: Vec3 | null | undefined, rotation?: Vec3, scale?: Vec3): void {
    if (!position) {
      this.transformGizmo?.setEnabled(false);
      return;
    }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTarget(position, rotation || [0, 0, 0], scale || [1, 1, 1]);
  }

  /**
   * Set gizmo target with quaternion rotation directly.
   * Avoids Euler→Quat→Euler conversion for better precision on selection changes.
   */
  setGizmoTargetWithQuat(position: Vec3 | null | undefined, rotationQuat: quat, scale?: Vec3): void {
    if (!position) {
      this.transformGizmo?.setEnabled(false);
      return;
    }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTargetWithQuat(position, rotationQuat, scale || [1, 1, 1]);
  }

  setGizmoTargetPositionAndScale(position: Vec3 | null | undefined, scale?: Vec3): void {
    if (!position) {
      this.transformGizmo?.setEnabled(false);
      return;
    }
    this.transformGizmo?.setEnabled(true);
    this.transformGizmo?.setTargetPositionAndScale(position, scale || [1, 1, 1]);
  }

  setGizmoEnabled(enabled: boolean): void {
    this.transformGizmo?.setEnabled(enabled);
  }

  setGizmoMode(mode: GizmoMode): void {
    this.transformGizmo?.setMode(mode);
  }

  setGizmoOrientation(orientation: GizmoOrientation): void {
    this.transformGizmo?.setOrientation(orientation);
  }

  /**
   * Set layer bounds for the LayerBoundsGizmo and CDLOD shader overlay.
   * Pass null to hide the bounds gizmo and clear the shader overlay.
   */
  setLayerBounds(bounds: TerrainLayerBounds | null): void {
    this.transformGizmo?.setLayerBounds(bounds);
    
    // Also push bounds to the terrain CDLOD shader overlay for terrain-conforming visualization
    // Find the terrain entity and pass bounds to its TerrainManager
    const terrainEntity = this._world.queryFirst('terrain');
    if (terrainEntity) {
      const terrainComp = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrainComp?.manager) {
        if (bounds) {
          terrainComp.manager.setBoundsOverlay({
            centerX: bounds.centerX,
            centerZ: bounds.centerZ,
            halfExtentX: bounds.halfExtentX,
            halfExtentZ: bounds.halfExtentZ,
            rotation: bounds.rotation,
            featherWidth: bounds.featherWidth,
          });
        } else {
          terrainComp.manager.setBoundsOverlay(null);
        }
      }
    }
  }

  /**
   * Set callback for when layer bounds change during gizmo drag.
   */
  setOnLayerBoundsChange(callback: ((bounds: TerrainLayerBounds) => void) | null): void {
    this.transformGizmo?.setOnLayerBoundsChange(callback);
  }

  setGizmoParentWorldRotation(parentRot: import('gl-matrix').quat): void {
    this.transformGizmo?.setParentWorldRotation(parentRot);
  }

  // ==================== Viewport Settings ====================

  setFPSMode(enabled: boolean): void {
    // Exit debug camera mode if entering FPS mode
    if (enabled && this.debugCameraMode) {
      this.setDebugCameraMode(false);
    }

    this.fpsMode = enabled;

    // Switch InputManager channel
    if (this.inputManager) {
      this.inputManager.setActiveChannel(enabled ? 'fps' : 'editor');
    }

    console.log(`[Viewport] FPS mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Enable/disable debug (global) camera mode.
   * When enabled, the scene is viewed from an independent debug camera
   * while the scene camera continues to drive shadows, culling, etc.
   */
  setDebugCameraMode(enabled: boolean): void {
    if (enabled === this.debugCameraMode) return;

    // Exit FPS mode if entering debug camera mode
    if (enabled && this.fpsMode) {
      // Don't call setFPSMode to avoid recursion - just clear state
      this.fpsMode = false;
    }

    this.debugCameraMode = enabled;

    if (enabled) {
      if (!this.inputManager || !this.cameraController) return;

      // Create debug camera controller if needed
      if (!this.debugCameraController) {
        this.debugCameraController = new DebugCameraController({
          width: this.logicalWidth,
          height: this.logicalHeight,
          inputManager: this.inputManager,
        });
      }

      // Create frustum renderer if needed
      if (!this.cameraFrustumRenderer && this.gpuContext) {
        this.cameraFrustumRenderer = new CameraFrustumRendererGPU(this.gpuContext);
      }

      // Initialize debug camera from current scene camera
      this.debugCameraController.initFromSceneCamera(this.cameraController.getCamera());

      // Activate input handling
      this.debugCameraController.activate();
      this.inputManager.setActiveChannel('debug-camera');

      console.log('[Viewport] Debug camera mode enabled');
    } else {
      // Deactivate debug camera input
      this.debugCameraController?.deactivate();

      // Switch back to editor channel
      if (this.inputManager) {
        this.inputManager.setActiveChannel('editor');
      }

      console.log('[Viewport] Debug camera mode disabled');
    }
  }

  /**
   * Check if debug camera mode is active
   */
  isDebugCameraMode(): boolean {
    return this.debugCameraMode;
  }

  setViewportMode(mode: 'solid' | 'wireframe'): void {
    this.viewportMode = mode;
  }

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

  setShowGrid(show: boolean): void {
    this.showGrid = show;
  }

  setShowAxes(show: boolean): void {
    this.showAxes = show;
  }

  /**
   * Show/hide light helper wireframes (arrows, spheres, cones) in the viewport
   */
  setShowLightHelpers(show: boolean): void {
    if (this.lightVisualizer) {
      this.lightVisualizer.enabled = show;
    }
  }

  // ==================== Uniform Scale ====================

  startUniformScale(startScale: Vec3, objectScreenPos: Vec2, mousePos: Vec2): void {
    this.transformGizmo?.startUniformScale(startScale, objectScreenPos, mousePos);
  }

  cancelUniformScale(): Vec3 {
    const originalScale = this.transformGizmo?.cancelUniformScale() || [1, 1, 1];
    this.onUniformScaleCancel();
    return originalScale;
  }

  // ==================== Camera ====================

  /**
   * Update camera zoom limits and far plane based on scene bounds.
   * Call this when terrain size changes or scene content changes significantly.
   * @param sceneRadius - Approximate radius of the scene bounding sphere
   */
  updateCameraForSceneBounds(sceneRadius: number): void {
    if (!this.cameraController) return;

    const camera = this.cameraController.getCamera();

    // Set zoom limits: min is small for close-up, max is enough to see whole scene
    const minDist = 0.5;
    const maxDist = sceneRadius * 3; // 3x radius allows viewing from outside
    camera.setZoomLimits(minDist, maxDist);

    // Update far plane to accommodate the scene
    // Far plane should be at least maxDist + sceneRadius (camera at max dist looking at scene edge)
    // Minimum 2000 to prevent far-plane clipping on large terrains
    const farPlane = Math.max(maxDist + sceneRadius, 2000);
    camera.setClipPlanes(camera.near, farPlane);

    console.log(`[Viewport] Updated camera for scene bounds: radius=${sceneRadius}, maxDist=${maxDist.toFixed(1)}, far=${farPlane.toFixed(1)}`);
  }

  getCameraState(): CameraState | null {
    return this.cameraController?.serialize() ?? null;
  }

  setCameraState(state: CameraState | Partial<CameraState> | null): void {
    if (state) {
      this.cameraController?.deserialize(state);
    }
  }

  resetCameraOrigin(): void {
    this.cameraController?.resetOrigin();
  }

  setCameraView(view: string): void {
    this.cameraController?.setView(view);
  }

  // ==================== Utilities ====================

  projectObjectToScreen(position: Vec3): Vec2 {
    return projectToScreen(position, this.cameraController!.getCamera() as any, this.logicalWidth, this.logicalHeight);
  }

  getLastMousePos(): Vec2 {
    return [...this.lastMousePos];
  }

  getInputManager(): InputManager | null {
    return this.inputManager;
  }

  // ==================== State Queries ====================

  isUniformScaleActive(): boolean {
    return this.transformGizmo?.isUniformScaleActive || false;
  }

  isGizmoDragging(): boolean {
    return this.transformGizmo?.isDragging || false;
  }

  /**
   * Resize the viewport to new dimensions
   * Updates canvas size, WebGL viewport, and all renderers
   */
  resize(width: number, height: number): void {
    // Store logical dimensions for resolution scale changes
    this._lastLogicalWidth = width;
    this._lastLogicalHeight = height;

    // Compute effective DPR from resolution scale
    const effectiveDpr = this.dpr * this._resolutionScale;
    const renderWidth = Math.floor(width * effectiveDpr);
    const renderHeight = Math.floor(height * effectiveDpr);

    // Update canvas backing store to render resolution
    this.canvas.width = renderWidth;
    this.canvas.height = renderHeight;
    // CSS size stays at logical pixels (the browser scales the canvas to fit)
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';

    // Update camera projection by rebuilding it with new aspect ratio
    // (aspect ratio is the same regardless of resolution scale)
    if (this.cameraController) {
      const camera = this.cameraController.getCamera();
      camera.setAspectRatio(width, height);
    }

    // Update gizmo canvas size (always logical pixels for input)
    if (this.transformGizmo) {
      this.transformGizmo.setCanvasSize(width, height);
    }

    // Update WebGPU pipeline render targets
    if (this.gpuPipeline) {
      this.gpuPipeline.resize(renderWidth, renderHeight);
    }

    console.log(`[Viewport] Resized to ${width}x${height} (render: ${renderWidth}x${renderHeight}, scale: ${this._resolutionScale.toFixed(2)}, effectiveDPR: ${effectiveDpr.toFixed(2)})`);
  }

  /**
   * Set the resolution scale factor.
   * 1.0 = native DPR (full Retina on Mac), lower values reduce render resolution.
   * The canvas CSS size (and thus input coordinates) remain unchanged.
   * @param scale - Scale factor from 0 to 1 (e.g., 0.5 = half native DPR)
   */
  setResolutionScale(scale: number): void {
    const clamped = Math.max(0.25, Math.min(1.0, scale));
    if (clamped === this._resolutionScale) return;

    this._resolutionScale = clamped;

    // Re-trigger resize with last known logical dimensions
    if (this._lastLogicalWidth > 0 && this._lastLogicalHeight > 0) {
      this.resize(this._lastLogicalWidth, this._lastLogicalHeight);
    }
  }

  /**
   * Get the current resolution scale factor.
   */
  getResolutionScale(): number {
    return this._resolutionScale;
  }

  /**
   * Get the native device pixel ratio.
   */
  getDevicePixelRatio(): number {
    return this.dpr;
  }

  /**
   * Get the current render resolution [width, height].
   */
  getRenderResolution(): [number, number] {
    const effectiveDpr = this.dpr * this._resolutionScale;
    return [
      Math.floor(this._lastLogicalWidth * effectiveDpr),
      Math.floor(this._lastLogicalHeight * effectiveDpr),
    ];
  }
}

// ==================== Factory Function (Backward Compatibility) ====================

/**
 * Create a new Viewport instance
 * @deprecated Use `new Viewport()` directly
 */
export function createViewport(canvas: HTMLCanvasElement, options?: ViewportOptions): Viewport {
  return new Viewport(canvas, options);
}
