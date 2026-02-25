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
import { screenToRay, projectToScreen } from '../../core/utils/raycastUtils';
import type { DirectionalLightParams, RGBColor, SceneLightingParams } from '../../core/sceneObjects/lights';
import type {
  WindParams,
  ObjectWindSettings,
  IRenderer,
} from '../../core/sceneObjects/types';
import type { FPSCameraController } from './FPSCameraController';
import { DebugCameraController } from './DebugCameraController';
import { CameraFrustumRendererGPU, type CSMDebugInfo } from '../../core/gpu/renderers/CameraFrustumRendererGPU';
import { WebGPUShadowSettings } from './components/panels/RenderingPanel';
import type { SSAOSettings } from './components/panels/RenderingPanel';
import type { CompositeEffectConfig } from '../../core/gpu/postprocess';
import type { Scene } from '../../core/Scene';
import { CameraObject } from '@/core/sceneObjects';

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

  // Transform gizmo
  private transformGizmo: TransformGizmoManager | null = null;

  // Input management
  private inputManager: InputManager | null = null;
  
  // Camera
  private cameraController: CameraController | null = null;

  // Animation loop
  private animationLoop: AnimationLoop | null = null;

  // Overlay container for gizmo 2D elements
  private overlayContainer: HTMLElement | null = null;

  // Scene graph reference (for raycasting)
  private sceneGraph: SceneGraph | null = null;
  
  // Scene reference (for WebGPU pipeline rendering)
  private scene: Scene | null = null;

  // Light params (reference from LightingManager via controller)
  private lightParams: SceneLightingParams | null = null;

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
  
  // FPS Camera mode
  private fpsMode = false;
  private fpsController: FPSCameraController | null = null;
  
  // Debug Camera mode
  private debugCameraMode = false;
  private debugCameraController: DebugCameraController | null = null;
  private cameraFrustumRenderer: CameraFrustumRendererGPU | null = null;

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

    // Pipeline handles cleanup of its own passes
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;

    this.transformGizmo?.destroy();
    this.transformGizmo = null;
  }

  // ==================== Camera ====================

  private initCamera(): void {
    // Create InputManager for event routing
    this.inputManager = new InputManager(this.canvas);
    
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

  private handleCanvasClick(screenX: number, screenY: number, shiftKey = false): void {
    if (!this.sceneGraph || this.sceneGraph.size === 0) {
      this.onBackgroundClicked(shiftKey);
      return;
    }

    const camera = this.cameraController!.getCamera();
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera as any, this.logicalWidth, this.logicalHeight);
    const hit = this.sceneGraph.castRay(rayOrigin, rayDir);

    if (hit) {
      this.onObjectClicked(hit.node.id, shiftKey);
    } else {
      this.onBackgroundClicked(shiftKey);
    }
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
   * Set WebGPU composite/tonemapping settings (for RenderingPanel integration)
   */
  setCompositeSettings(config: Partial<CompositeEffectConfig>): void {
    if (this.gpuPipeline) {
      this.gpuPipeline.setCompositeConfig(config);
    }
  }

  adaptCamera(camera: CameraObject): GPUCamera {
    return {
      getViewMatrix: () => camera.getViewMatrix() as Float32Array,
      getProjectionMatrix: () => camera.getProjectionMatrix() as Float32Array,
      getPosition: () => camera.getPosition() as number[],
      near: camera.near,
      far: camera.far,
    };
  }
  
  /**
   * Render using WebGPU (full pipeline with grid/sky)
   */
  private renderWebGPU(): void {
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
    } else if (this.fpsMode && this.fpsController) {
      // FPS camera mode
      viewCameraAdapter = {
        getViewMatrix: () => this.fpsController!.getViewMatrix() as Float32Array,
        getProjectionMatrix: () => this.fpsController!.getProjectionMatrix() as Float32Array,
        getPosition: () => this.fpsController!.getPosition() as number[],
        near: this.fpsController!.near,
        far: this.fpsController!.far,
      };
      sceneCameraAdapter = viewCameraAdapter;
    } else {
      // Normal mode: scene camera is also the view camera
      viewCameraAdapter = sceneCameraAdapter;
    }
    
    // Alias for backward compatibility
    const cameraAdapter = viewCameraAdapter;
    
    // Get lighting settings
    // Note: lightParams.direction is pre-computed from DirectionalLight
    // sunElevation/sunAzimuth are still needed for sky rendering
    const isHDR = this.lightParams?.type === 'hdr';
    // Scale sunIntensity by sunIntensityFactor (0 at night, 1 during day)
    // This ensures water, terrain, and objects all receive zero direct light at night
    const baseSunIntensity = (this.lightParams as any)?.sunIntensity ?? 20;
    const sunIntensityFactor = (this.lightParams as any)?.sunIntensityFactor ?? 1.0;
    const sunIntensity = baseSunIntensity * sunIntensityFactor;
    const hdrExposure = (this.lightParams as any)?.hdrExposure ?? 1.0;
    const ambientIntensity = (this.lightParams as any)?.ambient ?? 0.3;
    const lightColor = isHDR
      ? [1.0, 1.0, 1.0] as RGBColor
      : (this.lightParams as DirectionalLightParams).effectiveColor;

    // Get pre-computed light direction from DirectionalLight (avoids redundant calculation)
    // Only available on directional light type, not HDR
    const lightDirection = (this.lightParams as any)?.direction as [number, number, number] | undefined;
    
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
    this.gpuPipeline.render(this.scene, cameraAdapter as any, options, separateSceneCamera as any);
    
    // Render debug camera frustum visualization when in debug camera mode
    if (this.debugCameraMode && this.debugCameraController && this.cameraFrustumRenderer) {
      this.renderDebugCameraOverlay();
    }
    
    // Render gizmo via TransformGizmoManager (skip in FPS mode and debug camera mode)
    // This uses the same screen-space scale as hit testing for consistency
    if (!this.fpsMode && !this.debugCameraMode && this.transformGizmo?.hasGPURenderer()) {
      const vpMatrix = this.cameraController!.getCamera().getViewProjectionMatrix();
      this.renderGizmoOverlay(vpMatrix as Float32Array);
    }
  }
  
  /**
   * Render debug camera overlay: scene camera frustum + body visualization
   */
  private renderDebugCameraOverlay(): void {
    if (!this.gpuContext || !this.cameraFrustumRenderer || !this.cameraController || !this.debugCameraController) return;
    
    const sceneCamera = this.cameraController.getCamera();
    
    // Update frustum geometry from scene camera parameters
    const pos = sceneCamera.getPosition() as [number, number, number];
    const target = sceneCamera.getTarget() as [number, number, number];
    
    // Build CSM debug info if shadow renderer has CSM enabled
    let csmInfo: CSMDebugInfo | undefined;
    if (this.gpuPipeline) {
      const shadowRenderer = this.gpuPipeline.getShadowRenderer();
      const shadowConfig = shadowRenderer.getConfig();
      if (shadowConfig.csmEnabled) {
        // Get light direction from current light params
        const lightDir = (this.lightParams as any)?.direction as [number, number, number] | undefined;
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

  private startRendering(): void {
    this.animationLoop?.stop();

    this.animationLoop = createAnimationLoop({ onFps: this.onFps });
    this.animationLoop.start((deltaTime: number) => {
      this.render(deltaTime);
    });
  }

  private render(deltaTime: number): void {
    const dt = deltaTime / 1000;
    
    // Update FPS camera if active (needed for both WebGL and WebGPU paths)
    if (this.fpsMode && this.fpsController) {
      this.fpsController.update(dt);
    }
    
    this.renderWebGPU();
    
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
  
  setScene(scene: Scene): void {
    this.scene = scene;
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

  // ==================== Viewport Settings ====================

  setFPSMode(enabled: boolean, controller: FPSCameraController | null): void {
    // Exit debug camera mode if entering FPS mode
    if (enabled && this.debugCameraMode) {
      this.setDebugCameraMode(false);
    }
    
    this.fpsMode = enabled;
    this.fpsController = controller;
    
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
      this.fpsController = null;
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

  /**
   * Set light params from LightingManager.
   * This is the primary way to update lighting state.
   */
  setLightParams(params: SceneLightingParams): void {
    this.lightParams = params;
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
    const farPlane = Math.max(maxDist + sceneRadius, 100);
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
    // Update internal dimensions
    const dpr = this.dpr;
    const renderWidth = Math.floor(width * dpr);
    const renderHeight = Math.floor(height * dpr);
    
    // Update canvas
    this.canvas.width = renderWidth;
    this.canvas.height = renderHeight;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';

    // Update camera projection by rebuilding it with new aspect ratio
    if (this.cameraController) {
      const camera = this.cameraController.getCamera();
      // Update projection matrix with new dimensions
      camera.setAspectRatio(width, height);
    }
    
    // Update gizmo canvas size
    if (this.transformGizmo) {
      this.transformGizmo.setCanvasSize(width, height);
    }

    // Update WebGPU pipeline
    if (this.gpuPipeline) {
      this.gpuPipeline.resize(renderWidth, renderHeight);
    }
    
    console.log(`[Viewport] Resized to ${width}x${height} (render: ${renderWidth}x${renderHeight})`);
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
