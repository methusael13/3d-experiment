import { mat4, quat } from 'gl-matrix';
import type { Vec2, Vec3, RGB } from '../../core/types';
import { createAnimationLoop, AnimationLoop } from '../../core/animationLoop';
import { GPUContext } from '../../core/gpu/GPUContext';
import { GPUCamera, GPUForwardPipeline, type RenderOptions as GPURenderOptions } from '../../core/gpu/pipeline/GPUForwardPipeline';
import type { TerrainManager } from '../../core/terrain/TerrainManager';
import {
  createGridRenderer,
  createOriginMarkerRenderer,
  createSkyRenderer,
  createShadowRenderer,
  createDepthPrePassRenderer,
  GridRenderer,
  OriginMarkerRenderer,
  SkyRenderer,
  ShadowRenderer,
  DepthPrePassRenderer,
  ContactShadowRenderer,
  type ContactShadowSettings,
  ForwardPipeline,
  type RenderObject,
  type PipelineCamera,
} from '../../core/renderers';
import { TransformGizmoManager, GizmoMode } from './gizmos';
import type { GizmoOrientation } from './gizmos/BaseGizmo';
import { CameraController, type CameraState } from './CameraController';
import { InputManager } from './InputManager';
import { screenToRay, projectToScreen } from '../../core/utils/raycastUtils';
import type { SceneLightingParams } from '../../core/sceneObjects/lights';
import type {
  WindParams,
  ObjectWindSettings,
  TerrainBlendParams,
  IRenderer,
} from '../../core/sceneObjects/types';
import { isTerrainObject, type TerrainObject } from '../../core/sceneObjects';
import type { FPSCameraController } from './FPSCameraController';
import { WebGPUShadowSettings } from './componentPanels/RenderingPanel';
import type { SSAOSettings } from './components/panels/RenderingPanel';
import type { CompositeEffectConfig } from '../../core/gpu/postprocess';
import { WaterParams } from './components';
import type { Scene } from '../../core/Scene';

// ==================== Type Definitions ====================

/**
 * Viewport callback functions
 */
export interface ViewportCallbacks {
  onFps?: (fps: number) => void;
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

  // WebGL context
  private gl: WebGL2RenderingContext | null = null;

  // Renderers (GPU resources)
  private gridRenderer: GridRenderer | null = null;
  private originMarkerRenderer: OriginMarkerRenderer | null = null;
  private skyRenderer: SkyRenderer | null = null;
  private shadowRenderer: ShadowRenderer | null = null;
  private depthPrePassRenderer: DepthPrePassRenderer | null = null;
  private contactShadowRenderer: ContactShadowRenderer | null = null;
  
  // Render pipeline (manages all passes)
  private pipeline: ForwardPipeline | null = null;

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

  // Render data (reference from controller)
  private renderData: RenderData = {
    objects: [],
    objectWindSettings: new Map(),
    objectTerrainBlendSettings: new Map(),
    selectedIds: new Set(),
    getModelMatrix: () => null,
  };

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

  // GPU Resources (owned by viewport)
  private hdrTexture: WebGLTexture | null = null;
  private hdrMaxMipLevel = 6.0;
  private shadowResolution = 2048;

  private shadowEnabled = true;
  private contactShadowSettings: ContactShadowSettings = {
    enabled: true,
    maxDistance: 1.0,
    thickness: 0.1,
    steps: 16,
    intensity: 0.8,
  };

  // Pure view settings (not duplicated elsewhere)
  private viewportMode: 'solid' | 'wireframe' = 'solid';
  private showShadowThumbnail = false;
  private showGrid = true;
  private showAxes = true;

  // Mouse tracking
  private lastMousePos: Vec2 = [0, 0];
  
  // FPS Camera mode
  private fpsMode = false;
  private fpsController: FPSCameraController | null = null;
  
  // WebGPU Test Mode
  private webgpuTestMode = false;
  private gpuContext: GPUContext | null = null;
  private gpuPipeline: GPUForwardPipeline | null = null;
  private webgpuCanvas: HTMLCanvasElement | null = null;
  
  // Dynamic IBL (Image-Based Lighting) setting for WebGPU mode
  private dynamicIBLEnabled = true;  // Enabled by default

  // Callbacks (all optional)
  private readonly onFps: (fps: number) => void;
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
  init(): boolean {
    // Set physical canvas size (high resolution for HiDPI)
    this.canvas.width = this.renderWidth;
    this.canvas.height = this.renderHeight;

    // Set CSS display size (logical pixels)
    this.canvas.style.width = this.logicalWidth + 'px';
    this.canvas.style.height = this.logicalHeight + 'px';

    if (!this.initGL()) return false;
    this.initCamera();
    this.initGizmo();
    this.startRendering();
    return true;
  }

  /**
   * Clean up all GPU resources
   */
  destroy(): void {
    this.animationLoop?.stop();
    this.animationLoop = null;

    // Pipeline handles cleanup of its own passes
    this.pipeline?.destroy();
    this.pipeline = null;
    
    this.gridRenderer = null;
    this.originMarkerRenderer = null;
    this.skyRenderer = null;
    this.shadowRenderer = null;
    this.depthPrePassRenderer = null;
    this.contactShadowRenderer = null;

    this.transformGizmo?.destroy();
    this.transformGizmo = null;

    if (this.hdrTexture && this.gl) {
      this.gl.deleteTexture(this.hdrTexture);
      this.hdrTexture = null;
    }
  }

  // ==================== GL Initialization ====================

  private initGL(): boolean {
    this.gl = this.canvas.getContext('webgl2', { antialias: true });
    if (!this.gl) {
      console.error('WebGL 2 not supported');
      return false;
    }

    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.15, 0.17, 0.22, 1.0);

    this.gridRenderer = createGridRenderer(gl);
    this.originMarkerRenderer = createOriginMarkerRenderer(gl);
    this.skyRenderer = createSkyRenderer(gl);
    this.shadowRenderer = createShadowRenderer(gl, this.shadowResolution);
    this.depthPrePassRenderer = createDepthPrePassRenderer(gl, this.renderWidth, this.renderHeight);
    this.contactShadowRenderer = new ContactShadowRenderer(gl, this.contactShadowSettings);
    this.contactShadowRenderer.resize(this.renderWidth, this.renderHeight);
    
    // Initialize ForwardPipeline
    this.pipeline = new ForwardPipeline(gl, {
      width: this.renderWidth,
      height: this.renderHeight,
      shadowRenderer: this.shadowRenderer!,
      depthPrePassRenderer: this.depthPrePassRenderer!,
      skyRenderer: this.skyRenderer!,
      gridRenderer: this.gridRenderer!,
      originMarkerRenderer: this.originMarkerRenderer!,
    });

    return true;
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
    if (!this.gl || !this.cameraController) return;

    this.transformGizmo = new TransformGizmoManager(this.gl, this.cameraController.getCamera() as any);
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

  // ==================== Lighting Helpers ====================

  /**
   * Get complete light params for rendering.
   * No duplication - reads from stored lightParams reference.
   */
  private getCompleteLightParams(): SceneLightingParams & { cameraPos: Vec3 } {
    const cameraPos = this.cameraController!.getCamera().getPosition();

    if (!this.lightParams) {
      // Fallback if no light params set yet
      return {
        type: 'directional',
        direction: [0.5, 0.707, 0.5],
        effectiveColor: [1, 1, 1],
        ambient: 0.3,
        castsShadow: true,
        shadowEnabled: true,
        shadowDebug: 0,
        lightSpaceMatrix: this.shadowRenderer?.getLightSpaceMatrix() ?? undefined,
        shadowMap: this.shadowRenderer?.getTexture() ?? undefined,
        toneMapping: 3, // ACES
        pointLights: [],
        cameraPos,
      } as any;
    }

    // Merge lightParams with viewport's GPU resources
    return {
      ...this.lightParams,
      // Override shadow map/matrix from viewport's shadow renderer
      lightSpaceMatrix: this.shadowRenderer?.getLightSpaceMatrix() ?? this.lightParams.lightSpaceMatrix,
      shadowMap: this.shadowRenderer?.getTexture() ?? this.lightParams.shadowMap,
      // Override HDR texture from viewport if in HDR mode
      hdrTexture: this.lightParams.type === 'hdr' ? this.hdrTexture : undefined,
      // Add camera position
      cameraPos,
    } as any;
  }

  /**
   * Check if shadows are enabled (from local state + lightParams)
   */
  private isShadowEnabled(): boolean {
    return this.shadowEnabled && (this.lightParams?.shadowEnabled ?? true);
  }

  /**
   * Get HDR exposure from lightParams
   */
  private getHDRExposure(): number {
    if (this.lightParams && this.lightParams.type === 'hdr' && 'hdrExposure' in this.lightParams) {
      return (this.lightParams as any).hdrExposure;
    }
    return 1.0;
  }

  // ==================== Render Objects Helper ====================
  
  /**
   * Build RenderObject array from current RenderData
   */
  private buildRenderObjects(): RenderObject[] {
    return this.renderData.objects
      .map(obj => {
        const modelMatrix = this.renderData.getModelMatrix(obj);
        if (!modelMatrix) return null;
        
        // Check if this is a terrain object
        if (obj.objectType === 'terrain' || isTerrainObject(obj as any)) {
          return {
            id: obj.id,
            modelMatrix,
            renderer: null,
            gpuMeshes: [],
            isSelected: this.renderData.selectedIds.has(obj.id),
            windSettings: null,
            terrainBlendSettings: null,
            showNormals: false,
            terrain: obj as unknown as TerrainObject,
          } as RenderObject;
        }
        
        // Regular objects need a renderer
        if (!obj.renderer) return null;
        
        return {
          id: obj.id,
          modelMatrix,
          renderer: obj.renderer,
          gpuMeshes: obj.renderer.gpuMeshes || [],
          isSelected: this.renderData.selectedIds.has(obj.id),
          windSettings: this.renderData.objectWindSettings.get(obj.id) || null,
          terrainBlendSettings: this.renderData.objectTerrainBlendSettings.get(obj.id) || null,
          showNormals: obj.showNormals || false,
        } as RenderObject;
      })
      .filter((o): o is RenderObject => o !== null);
  }
  
  /**
   * Create a PipelineCamera adapter from CameraController or FPSController
   */
  private getPipelineCamera(): PipelineCamera {
    // Use FPS camera when in FPS mode
    if (this.fpsMode && this.fpsController) {
      return {
        getViewProjectionMatrix: () => this.fpsController!.getViewProjectionMatrix(),
        getViewMatrix: () => this.fpsController!.getViewMatrix(),
        getProjectionMatrix: () => this.fpsController!.getProjectionMatrix(),
        getPosition: () => this.fpsController!.getPosition(),
        near: this.fpsController!.near,
        far: this.fpsController!.far,
      };
    }
    
    // Default to orbit camera
    const camera = this.cameraController!.getCamera();
    return {
      getViewProjectionMatrix: () => camera.getViewProjectionMatrix(),
      getViewMatrix: () => camera.getViewMatrix(),
      getProjectionMatrix: () => camera.getProjectionMatrix(),
      getPosition: () => camera.getPosition(),
      near: camera.near,
      far: camera.far,
    };
  }

  // ==================== WebGPU Test Mode ====================
  
  /**
   * Create a WebGPU canvas overlaid on the WebGL2 canvas
   */
  private createWebGPUCanvas(): HTMLCanvasElement {
    // Create a new canvas for WebGPU
    const canvas = document.createElement('canvas');
    canvas.id = 'webgpu-canvas';
    canvas.width = this.renderWidth;
    canvas.height = this.renderHeight;
    canvas.style.width = this.logicalWidth + 'px';
    canvas.style.height = this.logicalHeight + 'px';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'auto'; // Enable mouse events for camera control
    canvas.style.display = 'none'; // Hidden initially
    
    // Insert after the WebGL canvas
    this.canvas.parentElement?.appendChild(canvas);
    
    return canvas;
  }
  
  /**
   * Enable WebGPU test mode - renders a simple triangle using WebGPU
   * This is for testing the WebGPU pipeline before full migration
   */
  async enableWebGPUTest(): Promise<boolean> {
    try {
      console.log('[Viewport] Enabling WebGPU test mode...');
      
      // Create separate WebGPU canvas if not already created
      if (!this.webgpuCanvas) {
        this.webgpuCanvas = this.createWebGPUCanvas();
        console.log('[Viewport] Created WebGPU canvas');
      }
      
      // Initialize WebGPU context on the separate canvas
      this.gpuContext = await GPUContext.getInstance(this.webgpuCanvas);
      console.log('[Viewport] WebGPU context initialized');
      
      // Create full WebGPU forward pipeline with grid and sky
      this.gpuPipeline = new GPUForwardPipeline(this.gpuContext, {
        width: this.renderWidth,
        height: this.renderHeight,
      });
      console.log('[Viewport] WebGPU Forward Pipeline created');
      
      // Initialize WebGPU gizmo renderer on TransformGizmoManager
      if (this.transformGizmo && this.gpuContext) {
        this.transformGizmo.initGPURenderer(this.gpuContext);
        console.log('[Viewport] WebGPU gizmo renderer initialized');
      }
      
      // Show WebGPU canvas, hide WebGL canvas
      this.webgpuCanvas.style.display = 'block';
      this.canvas.style.visibility = 'hidden';
      
      // Attach InputManager to WebGPU canvas for camera control
      if (this.inputManager) {
        this.inputManager.attachToCanvas(this.webgpuCanvas);
      }
      
      this.webgpuTestMode = true;
      console.log('[Viewport] ✅ WebGPU test mode enabled');
      return true;
    } catch (error) {
      console.error('[Viewport] ❌ Failed to enable WebGPU test mode:', error);
      this.webgpuTestMode = false;
      
      // Restore WebGL canvas on failure
      if (this.webgpuCanvas) {
        this.webgpuCanvas.style.display = 'none';
      }
      this.canvas.style.visibility = 'visible';
      
      return false;
    }
  }
  
  /**
   * Disable WebGPU test mode and return to WebGL2 rendering
   */
  disableWebGPUTest(): void {
    this.webgpuTestMode = false;
    this.gpuPipeline?.destroy();
    this.gpuPipeline = null;
    
    // Hide WebGPU canvas, show WebGL canvas
    if (this.webgpuCanvas) {
      this.webgpuCanvas.style.display = 'none';
    }
    this.canvas.style.visibility = 'visible';
    
    // Re-attach InputManager to WebGL canvas
    if (this.inputManager) {
      this.inputManager.attachToCanvas(this.canvas);
    }
    
    console.log('[Viewport] WebGPU test mode disabled');
  }

  
  /**
   * Check if WebGPU test mode is active
   */
  isWebGPUTestMode(): boolean {
    return this.webgpuTestMode;
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
  
  /**
   * Render using WebGPU (full pipeline with grid/sky)
   */
  private renderWebGPUTest(): void {
    if (!this.gpuContext || !this.gpuPipeline || !this.cameraController) return;
    
    // Create camera adapter for WebGPU pipeline (use FPS camera if active)
    let cameraAdapter: GPUCamera;
    
    if (this.fpsMode && this.fpsController) {
      // Use FPS camera matrices
      cameraAdapter = {
        getViewMatrix: () => this.fpsController!.getViewMatrix() as Float32Array,
        getProjectionMatrix: () => this.fpsController!.getProjectionMatrix() as Float32Array,
        getPosition: () => this.fpsController!.getPosition() as number[],
        near: this.fpsController!.near,
        far: this.fpsController!.far,
      };
    } else {
      // Use orbit camera
      const camera = this.cameraController.getCamera();
      cameraAdapter = {
        getViewMatrix: () => camera.getViewMatrix() as Float32Array,
        getProjectionMatrix: () => camera.getProjectionMatrix() as Float32Array,
        getPosition: () => camera.getPosition() as number[],
        near: camera.near,
        far: camera.far,
      };
    }
    
    // Get lighting settings
    // Note: lightParams.direction is pre-computed from DirectionalLight
    // sunElevation/sunAzimuth are still needed for sky rendering
    const isHDR = this.lightParams?.type === 'hdr';
    const sunIntensity = (this.lightParams as any)?.sunIntensity ?? 20;
    const hdrExposure = (this.lightParams as any)?.hdrExposure ?? 1.0;
    const ambientIntensity = (this.lightParams as any)?.ambient ?? 0.3;
    
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
      dynamicIBL: this.dynamicIBLEnabled,  // Pass Dynamic IBL state
    };
    
    // Use render with scene and camera adapter
    this.gpuPipeline.render(this.scene, cameraAdapter as any, options);
    
    // Render gizmo via TransformGizmoManager (skip in FPS mode)
    // This uses the same screen-space scale as hit testing for consistency
    if (!this.fpsMode && this.transformGizmo?.hasGPURenderer()) {
      const vpMatrix = this.cameraController!.getCamera().getViewProjectionMatrix();
      this.renderGizmoOverlay(vpMatrix as Float32Array);
    }
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
  
  /**
   * Pipeline-based render method
   */
  private renderWithPipeline(dt: number): void {
    if (!this.pipeline || !this.cameraController) return;
    
    // Build render objects from RenderData
    const objects = this.buildRenderObjects();
    
    // Get pipeline camera adapter
    const camera = this.getPipelineCamera();
    
    // Get complete light params
    const lightParams = this.getCompleteLightParams();
    
    // Update pipeline context
    this.pipeline.updateContext(camera, lightParams, this.windParams, dt);
    this.pipeline.setOriginPosition(this.cameraController.getOriginPosition() as Vec3);
    
    // Update pipeline settings
    this.pipeline.updateSettings({
      shadowEnabled: this.isShadowEnabled(),
      contactShadowEnabled: this.contactShadowSettings.enabled,
      contactShadowSettings: this.contactShadowSettings,
      wireframeMode: this.viewportMode === 'wireframe',
      showGrid: this.showGrid,
      showAxes: this.showAxes,
      fpsMode: this.fpsMode
    });
    
    // Set HDR texture if in HDR mode
    if (this.lightParams?.type === 'hdr' && this.hdrTexture) {
      this.pipeline.setTexture('hdr', this.hdrTexture);
    }
    
    // Render through pipeline
    this.pipeline.render(objects);
    
    // Gizmo (skip in FPS mode)
    if (!this.fpsMode) {
      this.transformGizmo?.render(this.cameraController.getViewProjectionMatrix());
    }
    
    // Shadow debug thumbnail (rendered after pipeline)
    const shadowEnabled = this.isShadowEnabled();
    const isDirectionalMode = !this.lightParams || this.lightParams.type === 'directional';
    if (this.showShadowThumbnail && shadowEnabled && isDirectionalMode && this.shadowRenderer) {
      this.shadowRenderer.renderDebugThumbnail(
        10 * this.dpr,
        10 * this.dpr,
        150 * this.dpr,
        this.renderWidth,
        this.renderHeight
      );
    }
  }

  private render(deltaTime: number): void {
    const dt = deltaTime / 1000;
    
    // Update FPS camera if active (needed for both WebGL and WebGPU paths)
    if (this.fpsMode && this.fpsController) {
      this.fpsController.update(dt);
    }
    
    // WebGPU test mode - bypass WebGL2 entirely
    if (this.webgpuTestMode) {
      this.renderWebGPUTest();
      return;
    }
    
    if (!this.gl || !this.cameraController) return;
    
    // Let controller update wind physics
    this.onUpdate(dt);

    // Update wind time
    this.windParams.time += dt;
    this.renderWithPipeline(dt);
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

  setRenderData(data: Partial<RenderData>): void {
    this.renderData = {
      objects: data.objects || [],
      objectWindSettings: data.objectWindSettings || new Map(),
      objectTerrainBlendSettings: data.objectTerrainBlendSettings || new Map(),
      selectedIds: data.selectedIds || new Set(),
      getModelMatrix: data.getModelMatrix || (() => null),
    };
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
    this.fpsMode = enabled;
    this.fpsController = controller;
    
    // Switch InputManager channel
    if (this.inputManager) {
      this.inputManager.setActiveChannel(enabled ? 'fps' : 'editor');
    }
    
    console.log(`[Viewport] FPS mode ${enabled ? 'enabled' : 'disabled'}`);
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

  setShowShadowThumbnail(show: boolean): void {
    this.showShadowThumbnail = show;
    // Also update WebGPU pipeline if active
    if (this.gpuPipeline) {
      this.gpuPipeline.setShowShadowThumbnail(show);
    }
  }

  setShowGrid(show: boolean): void {
    this.showGrid = show;
  }

  setShowAxes(show: boolean): void {
    this.showAxes = show;
  }

  setShadowResolution(res: number): void {
    this.shadowResolution = res;
    this.shadowRenderer?.setResolution(res);
  }

  setShadowEnabled(enabled: boolean): void {
    this.shadowEnabled = enabled;
  }

  setContactShadowSettings(settings: ContactShadowSettings): void {
    this.contactShadowSettings = { ...settings };
    this.contactShadowRenderer?.setSettings(settings);
  }

  getContactShadowSettings(): ContactShadowSettings {
    return { ...this.contactShadowSettings };
  }

  setHDRTexture(texture: WebGLTexture | null, maxMipLevel = 6): void {
    if (this.hdrTexture && this.gl) {
      this.gl.deleteTexture(this.hdrTexture);
    }
    this.hdrTexture = texture;
    this.hdrMaxMipLevel = maxMipLevel;
  }

  /**
   * @deprecated Use setLightParams instead
   */
  setLightingState(state: { shadowResolution?: number }): void {
    if (state.shadowResolution) {
      this.setShadowResolution(state.shadowResolution);
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

  getGL(): WebGL2RenderingContext | null {
    return this.gl;
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
    
    // Update WebGL viewport
    if (this.gl) {
      this.gl.viewport(0, 0, renderWidth, renderHeight);
    }
    
    // Update camera projection by rebuilding it with new aspect ratio
    if (this.cameraController) {
      const camera = this.cameraController.getCamera();
      // Update projection matrix with new dimensions
      camera.setAspectRatio(width, height);
    }
    
    // Update renderers that need dimensions
    this.depthPrePassRenderer?.resize(renderWidth, renderHeight);
    this.contactShadowRenderer?.resize(renderWidth, renderHeight);
    this.pipeline?.resize(renderWidth, renderHeight);
    
    // Update gizmo canvas size
    if (this.transformGizmo) {
      this.transformGizmo.setCanvasSize(width, height);
    }
    
    // Update WebGPU canvas if active
    if (this.webgpuCanvas) {
      this.webgpuCanvas.width = renderWidth;
      this.webgpuCanvas.height = renderHeight;
      this.webgpuCanvas.style.width = width + 'px';
      this.webgpuCanvas.style.height = height + 'px';
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
