/**
 * Engine — Demo-agnostic core runtime entry point
 *
 * Owns: GPU initialization, ECS World + system registration, rendering pipeline,
 * animation loop, light buffer wiring, reflection probe wiring, and per-frame
 * system data feeding.
 *
 * Does NOT own: Camera controllers, input management, gizmos, debug overlays,
 * editor-specific UI concerns. Those belong in the application layer
 * (e.g., EditorViewport for the scene builder demo).
 *
 * Usage:
 *   const engine = await Engine.create({ canvas, width: 800, height: 600 });
 *   engine.start((dt) => {
 *     const camera = buildCameraAdapter();
 *     engine.update(dt, camera, renderOptions);
 *   });
 *
 * @see docs/engine-extraction-plan.md — Phase 2
 */

import { GPUContext } from './gpu/GPUContext';
import { GPUForwardPipeline, type GPUCamera, type RenderOptions } from './gpu/pipeline/GPUForwardPipeline';
import { createAnimationLoop, type AnimationLoop } from './animationLoop';
import { World } from './ecs/World';
import { registerDefaultSystems, type SystemRegistryOptions } from './SystemRegistry';
import { LightBufferManager } from './gpu/renderers/LightBufferManager';
import { ReflectionProbeCaptureRenderer } from './gpu/renderers/ReflectionProbeCaptureRenderer';
import { LightingSystem } from './ecs/systems/LightingSystem';
import { FrustumCullSystem } from './ecs/systems/FrustumCullSystem';
import { ShadowCasterSystem } from './ecs/systems/ShadowCasterSystem';
import { LODSystem } from './ecs/systems/LODSystem';
import { MeshRenderSystem } from './ecs/systems/MeshRenderSystem';
import { WindSystem } from './ecs/systems/WindSystem';
import { SSRSystem } from './ecs/systems/SSRSystem';
import { ReflectionProbeSystem } from './ecs/systems/ReflectionProbeSystem';
import { LightComponent } from './ecs/components/LightComponent';
import type { RGBColor } from './sceneObjects/lights';
import type { WebGPUShadowSettings, SSAOSettings, SSRSettings, VolumetricFogSettings } from './EngineConfig';
import type { CompositeEffectConfig, AtmosphericFogConfig, GodRayConfig } from './gpu/postprocess';
import type { CloudConfig } from './gpu/clouds/types';

// ==================== Types ====================

export interface EngineOptions {
  /** Canvas element to render into */
  canvas: HTMLCanvasElement;
  /** Initial width in physical pixels */
  width: number;
  /** Initial height in physical pixels */
  height: number;
  /** FPS callback (called once per second) */
  onFps?: (fps: number) => void;
  /** Custom system registration. If provided, replaces default system setup. */
  systemRegistrar?: (world: World, engine: Engine) => void;
  /** Options passed to default system registration (ignored if systemRegistrar is provided) */
  systemOptions?: SystemRegistryOptions;
}

// ==================== Engine Class ====================

export class Engine {
  // ── Public readonly ──
  readonly gpuContext: GPUContext;
  readonly world: World;
  readonly pipeline: GPUForwardPipeline;
  readonly lightBufferManager: LightBufferManager;
  readonly reflectionProbeCaptureRenderer: ReflectionProbeCaptureRenderer;

  // ── Internal state ──
  private animationLoop: AnimationLoop | null = null;
  private time = 0;
  private dynamicIBLEnabled = true;
  private onFps: ((fps: number) => void) | null;

  // ── Private constructor (use Engine.create()) ──
  private constructor(
    gpuContext: GPUContext,
    world: World,
    pipeline: GPUForwardPipeline,
    lightBufferManager: LightBufferManager,
    reflectionProbeCaptureRenderer: ReflectionProbeCaptureRenderer,
    onFps?: (fps: number) => void,
  ) {
    this.gpuContext = gpuContext;
    this.world = world;
    this.pipeline = pipeline;
    this.lightBufferManager = lightBufferManager;
    this.reflectionProbeCaptureRenderer = reflectionProbeCaptureRenderer;
    this.onFps = onFps ?? null;
  }

  // ==================== Factory ====================

  /**
   * Create and initialize a new Engine instance.
   * This is async because WebGPU initialization requires adapter/device negotiation.
   */
  static async create(options: EngineOptions): Promise<Engine> {
    // 1. Initialize WebGPU context
    const gpuContext = await GPUContext.getInstance(options.canvas, {
      requiredLimits: {
        maxComputeInvocationsPerWorkgroup: 512,
        maxStorageTexturesPerShaderStage: 8
      }
    });

    // 2. Create rendering pipeline
    const pipeline = new GPUForwardPipeline(gpuContext, {
      width: options.width,
      height: options.height,
    });

    // 3. Create ECS World
    const world = new World();

    // 4. Create light buffer manager and wire to systems + environment
    const lightBufferManager = new LightBufferManager(gpuContext);
    const sceneEnv = pipeline.getSceneEnvironment();
    const shadowRenderer = pipeline.getShadowRenderer();
    sceneEnv.setLightBufferManager(lightBufferManager);
    sceneEnv.setShadowRenderer(shadowRenderer);
    pipeline.setLightBufferManager(lightBufferManager);

    // 5. Create reflection probe capture renderer
    const reflectionProbeCaptureRenderer = new ReflectionProbeCaptureRenderer(gpuContext);

    // 6. Create engine instance (before system registration so systemRegistrar can access it)
    const engine = new Engine(
      gpuContext, world, pipeline,
      lightBufferManager, reflectionProbeCaptureRenderer,
      options.onFps,
    );

    // 7. Register systems
    if (options.systemRegistrar) {
      options.systemRegistrar(world, engine);
    } else {
      registerDefaultSystems(world, options.systemOptions);
    }

    // 8. Wire systems that need engine resources
    const lightingSystem = world.getSystem<LightingSystem>('lighting');
    if (lightingSystem) {
      lightingSystem.lightBufferManager = lightBufferManager;
      lightingSystem.shadowRenderer = shadowRenderer;
    }

    // Wire reflection probe capture renderer
    const probeSystem = world.getSystem<ReflectionProbeSystem>('reflection-probe');
    if (probeSystem && !probeSystem.captureRenderer) {
      reflectionProbeCaptureRenderer.meshRenderSystem =
        world.getSystem<MeshRenderSystem>('mesh-render') ?? null;
      probeSystem.captureRenderer = reflectionProbeCaptureRenderer;
    }

    console.log('[Engine] Created successfully');
    return engine;
  }

  // ==================== Lifecycle ====================

  /**
   * Start the engine's animation loop.
   * @param onFrame - Called each frame with delta time in seconds.
   *                  The caller should call engine.update() within this callback.
   */
  start(onFrame: (dt: number) => void): void {
    this.animationLoop?.stop();
    this.animationLoop = createAnimationLoop({ onFps: this.onFps });
    this.animationLoop.start((deltaTimeMs: number) => {
      onFrame(deltaTimeMs / 1000);
    });
  }

  /**
   * Stop the animation loop (resources remain alive).
   */
  stop(): void {
    this.animationLoop?.stop();
    this.animationLoop = null;
  }

  /**
   * Get the underlying animation loop (for pause/resume).
   */
  getAnimationLoop(): AnimationLoop | null {
    return this.animationLoop;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.stop();
    this.lightBufferManager.destroy();
    this.pipeline.destroy();
    this.world.destroy();
  }

  // ==================== Frame Update ====================

  /**
   * Run one frame: feed system data, update ECS, render pipeline, flush deletions.
   *
   * @param dt - Delta time in seconds
   * @param camera - View camera (what appears on screen)
   * @param renderOptions - Per-frame render configuration
   * @param sceneCamera - Optional separate scene camera (e.g., for debug camera mode).
   *                      If not provided, the view camera is used as the scene camera.
   */
  update(
    dt: number,
    camera: GPUCamera,
    renderOptions: RenderOptions,
    sceneCamera?: GPUCamera,
  ): void {
    if (!this.gpuContext) return;

    // The "scene camera" drives shadows, culling, and LOD.
    // If no separate scene camera is given, use the view camera.
    const effectiveSceneCamera = sceneCamera ?? camera;

    // ── Read lighting from ECS LightComponent ──
    const sunEntity = this.world.queryFirst('light');
    const sunLight = sunEntity?.getComponent<LightComponent>('light') ?? null;
    const sunIntensityFactor = sunLight?.sunIntensityFactor ?? 1.0;
    const ambientIntensity = sunLight?.ambient ?? 0.3;
    const lightColor: RGBColor = (sunLight?.effectiveColor as RGBColor) ?? [1, 1, 0.95];
    const lightDirection = sunLight?.direction;

    // ── Merge render options with lighting data ──
    const mergedOptions: RenderOptions = {
      ...renderOptions,
      sunIntensity: 20 * sunIntensityFactor,
      ambientIntensity,
      lightColor,
      lightDirection,
      dynamicIBL: this.dynamicIBLEnabled,
    };

    // ── Feed per-frame data to systems ──
    this.feedSystemData(effectiveSceneCamera, mergedOptions);

    // ── Update reflection probe capture renderer with scene light params ──
    if (this.reflectionProbeCaptureRenderer) {
      this.reflectionProbeCaptureRenderer.sceneLightParams = {
        lightDirection: (lightDirection ?? [0.3, 0.8, 0.5]) as [number, number, number],
        lightColor: (lightColor ?? [1.0, 1.0, 0.95]) as [number, number, number],
        ambientIntensity,
      };
    }

    // ── Merge with pipeline defaults ──
    const pipelineOptions = this.pipeline.getMergedRenderOptions(mergedOptions);

    // ── Pre-world update (vegetation sync, weather) ──
    this.pipeline.preWorldUpdate(dt, pipelineOptions, this.world, effectiveSceneCamera);

    // ── Run all ECS systems ──
    this.time += dt;
    this.world.update(dt, {
      ctx: this.gpuContext,
      world: this.world,
      time: this.time,
      deltaTime: dt,
      sceneEnvironment: this.pipeline.getSceneEnvironment(),
    });

    // ── Render ──
    const separateSceneCamera = sceneCamera ? effectiveSceneCamera : undefined;
    this.pipeline.render(camera, pipelineOptions, separateSceneCamera, this.world);

    // ── Flush deferred entity deletions ──
    this.world.flushPendingDeletions();
  }

  // ==================== Per-Frame System Data Feeding ====================

  /**
   * Feed camera-derived data to systems that need it each frame.
   * This is the logic that was previously embedded in Viewport.renderWebGPU().
   */
  private feedSystemData(sceneCamera: GPUCamera, options: RenderOptions): void {
    const camPos = sceneCamera.getPosition();

    // ── Compute scene VP matrix ──
    const sceneVP = this.computeVPMatrix(sceneCamera);

    // ── Frustum culling ──
    const frustumCullSys = this.world.getSystem<FrustumCullSystem>('frustum-cull');
    frustumCullSys?.setViewProjectionMatrix(sceneVP);

    // ── Lighting (frustum culling for point/spot lights) ──
    const lightingSys = this.world.getSystem<LightingSystem>('lighting');
    lightingSys?.setViewProjectionMatrix(sceneVP);

    // ── Shadow caster (camera position for shadow map centering) ──
    const shadowSys = this.world.getSystem<ShadowCasterSystem>('shadow-caster');
    if (shadowSys) {
      shadowSys.cameraPosition = [camPos[0], camPos[1], camPos[2]] as [number, number, number];
    }

    // ── LOD (camera position for distance computation) ──
    const lodSys = this.world.getSystem<LODSystem>('lod');
    lodSys?.setCameraPosition(camPos[0], camPos[1], camPos[2]);

    // ── Mesh render system feature flags ──
    const meshRenderSys = this.world.getSystem<MeshRenderSystem>('mesh-render');
    if (meshRenderSys) {
      meshRenderSys.iblActive = this.dynamicIBLEnabled;
      meshRenderSys.shadowsActive = options.shadowEnabled ?? true;
      if (!meshRenderSys.windSystem) {
        meshRenderSys.windSystem = this.world.getSystem<WindSystem>('wind') ?? null;
      }
    }
  }

  /**
   * Compute a view-projection matrix from a GPUCamera.
   */
  private computeVPMatrix(camera: GPUCamera): Float32Array {
    const sceneView = camera.getViewMatrix();
    const sceneProj = camera.getProjectionMatrix();
    const vp = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += sceneProj[i + k * 4] * sceneView[k + j * 4];
        }
        vp[i + j * 4] = sum;
      }
    }
    return vp;
  }

  // ==================== Pipeline Configuration ====================

  setShadowSettings(settings: WebGPUShadowSettings): void {
    this.pipeline.setShadowSettings(settings);
  }

  setSSAOSettings(settings: SSAOSettings): void {
    this.pipeline.setSSAOEnabled(settings.enabled);
    if (settings.enabled) {
      this.pipeline.setSSAOConfig({ ...settings });
    }
  }

  setSDFEnabled(enabled: boolean): void {
    this.pipeline.setSDFEnabled(enabled);
  }

  setSSRSettings(settings: SSRSettings): void {
    this.pipeline.setSSREnabled(settings.enabled);
    if (settings.quality) {
      this.pipeline.setSSRQuality(settings.quality);
    }
    // Propagate global SSR enabled state to SSRSystem
    const ssrSystem = this.world.getSystem<SSRSystem>('ssr');
    if (ssrSystem) {
      ssrSystem.ssrGloballyEnabled = settings.enabled;
    }
  }

  setCompositeSettings(config: Partial<CompositeEffectConfig>): void {
    this.pipeline.setCompositeConfig(config);
  }

  setAtmosphericFogSettings(settings: Partial<AtmosphericFogConfig> & { enabled?: boolean }): void {
    if (settings.enabled !== undefined) {
      this.pipeline.setAtmosphericFogEnabled(settings.enabled);
    }
    this.pipeline.setAtmosphericFogConfig(settings);
  }

  setGodRaySettings(settings: Partial<GodRayConfig>): void {
    this.pipeline.setGodRayConfig(settings);
  }

  setVolumetricFogSettings(settings: Partial<VolumetricFogSettings>): void {
    this.pipeline.setVolumetricFogConfig(settings);
  }

  setCloudSettings(settings: Partial<CloudConfig>): void {
    this.pipeline.setCloudConfig(settings);
  }

  setWeatherPreset(name: string, duration?: number): void {
    this.pipeline.setWeatherPreset(name, duration);
  }

  clearWeatherPreset(): void {
    this.pipeline.clearWeatherPreset();
  }

  setDebugViewMode(mode: string): void {
    this.pipeline.setDebugViewMode(mode as any);
  }

  setDynamicIBL(enabled: boolean): void {
    this.dynamicIBLEnabled = enabled;
  }

  // ==================== Accessors ====================

  getSceneEnvironment() {
    return this.pipeline.getSceneEnvironment();
  }

  getShadowRenderer() {
    return this.pipeline.getShadowRenderer();
  }

  getDebugTextureManager() {
    return this.pipeline.getDebugTextureManager();
  }

  getLastDrawCallsCount(): number {
    return this.pipeline.getLastDrawCallsCount();
  }

  // ==================== Resize ====================

  resize(renderWidth: number, renderHeight: number): void {
    this.pipeline.resize(renderWidth, renderHeight);
  }
}
