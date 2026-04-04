/**
 * GPUForwardPipeline - WebGPU Forward Rendering Pipeline
 *
 * Facade that delegates to focused managers:
 *  - RenderTargetManager: render texture creation, resize, destruction
 *  - PostProcessManager: post-processing effects (SSAO, Fog, Tonemapping, God Rays)
 *  - CloudManager: volumetric clouds, weather, temporal reprojection, GPU profiling
 *
 * Uses a pass-based architecture for modularity:
 * 1. ShadowPass      2. SkyPass       3. OpaquePass
 * 4. TransparentPass  5. OverlayPass   6. DebugPass
 *
 * All scene passes render to an HDR intermediate buffer (rgba16float).
 * The CompositePass always runs to apply tonemapping and gamma correction.
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { GridRendererGPU } from '../renderers/GridRendererGPU';
import { SkyRendererGPU } from '../renderers/SkyRendererGPU';
import { ObjectRendererGPU } from '../renderers/ObjectRendererGPU';
import { ShadowRendererGPU, DebugTextureManager } from '../renderers';
import { SceneEnvironment, type IBLResources } from '../renderers/shared';
import { DynamicSkyIBL } from '../ibl';
import type { WebGPUShadowSettings } from '@/core/EngineConfig';
import {
  PostProcessPipeline,
  type SSAOEffectConfig,
  type CompositeEffectConfig,
  type AtmosphericFogConfig,
  type GodRayConfig,
  VolumetricFogConfig,
} from '../postprocess';
import { WeatherStateManager, type CloudConfig, type SerializedWeatherState } from '../clouds';
import { RenderContextImpl, type RenderContextOptions } from './RenderContext';
import type { World } from '../../ecs/World';
import type { RenderPass } from './RenderPass';
import { MeshRenderSystem } from '../../ecs/systems/MeshRenderSystem';
import { SSRSystem } from '../../ecs/systems/SSRSystem';
import { TerrainComponent } from '../../ecs/components/TerrainComponent';
import {
  SkyPass, ShadowPass, OpaquePass, TransparentPass, GroundPass,
  OverlayPass, DebugPass, SelectionMaskPass, SelectionOutlinePass,
  SSRPass, DebugViewPass,
} from './passes';
import { GlobalDistanceField } from '../sdf/GlobalDistanceField';
import type { SDFPrimitive, SDFTerrainStampParams } from '../sdf/types';
import { BoundsComponent } from '../../ecs/components/BoundsComponent';
import { OceanComponent } from '../../ecs/components/OceanComponent';
import type { DebugViewMode } from './passes';
import type { SSRConfig, SSRQualityLevel } from './SSRConfig';
import { SelectionOutlineRendererGPU } from '../renderers/SelectionOutlineRendererGPU';
import { RenderTargetManager } from './RenderTargetManager';
import { CloudManager } from './CloudManager';
import { VolumetricFogManager } from './VolumetricFogManager';
import { PostProcessManager } from './PostProcessManager';
import type { LightBufferManager } from '../renderers/LightBufferManager';
import { Vec3 } from '@/core/types';

// ========== Public Types ==========

export interface GPUCamera {
  getViewMatrix(): Float32Array | number[];
  getProjectionMatrix(): Float32Array | number[];
  getPosition(): Float32Array | number[];
  getVpMatrix(): Float32Array | number[];
  near?: number;
  far?: number;
}

export interface GPUForwardPipelineOptions {
  width: number;
  height: number;
  sampleCount?: number;
}

export interface RenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
  skyMode?: 'sun' | 'hdr' | 'none';
  sunIntensity?: number;
  hdrExposure?: number;
  wireframe?: boolean;
  ambientIntensity?: number;
  lightDirection?: [number, number, number];
  lightColor?: [number, number, number];
  shadowEnabled?: boolean;
  shadowSoftShadows?: boolean;
  shadowRadius?: number;
  showShadowThumbnail?: boolean;
  dynamicIBL?: boolean;
}

export const DEFAULT_RENDER_OPTIONS: Required<RenderOptions> = {
  showGrid: true,
  showAxes: true,
  skyMode: 'sun',
  sunIntensity: 20,
  hdrExposure: 1.0,
  wireframe: false,
  ambientIntensity: 0.3,
  lightDirection: [1, 0, 1],
  lightColor: [1, 1, 1],
  shadowEnabled: true,
  shadowSoftShadows: true,
  shadowRadius: 200,
  showShadowThumbnail: false,
  dynamicIBL: true,
};

// ========== Pipeline Class ==========

export class GPUForwardPipeline {
  private ctx: GPUContext;
  private width: number;
  private height: number;
  private sampleCount: number;

  // Delegated managers
  private renderTargets: RenderTargetManager;
  private cloudManager: CloudManager;
  private volumetricFogManager: VolumetricFogManager;
  private postProcessManager: PostProcessManager;

  // Renderers
  private gridRenderer: GridRendererGPU;
  private skyRenderer: SkyRendererGPU;
  private objectRenderer: ObjectRendererGPU;
  private shadowRenderer: ShadowRendererGPU;
  private selectionOutlineRenderer: SelectionOutlineRendererGPU;

  // IBL
  private dynamicSkyIBL: DynamicSkyIBL;
  private iblEnabled = true;

  // Shared environment (shadow + IBL) - Group 3
  private sceneEnvironment: SceneEnvironment;

  // Debug texture manager
  private debugTextureManager: DebugTextureManager;

  // Render passes (ordered by priority)
  private passes: RenderPass[] = [];
  private ssrPass: SSRPass | null = null;
  private debugViewPass: DebugViewPass | null = null;
  private lastSSRSystemHasConsumers = false;

  // Shadow settings
  private shadowEnabled = true;
  private shadowSoftShadows = true;
  private shadowRadius = 200;

  // Default camera parameters
  private defaultNearPlane = 0.1;
  private defaultFarPlane = 2000;

  // Animation time
  private time = 0;
  private lastFrameTime = performance.now();
  private lastDrawCallsCount = 0;

  // Light buffer manager — set by Engine after construction for volumetric fog point/spot lights
  private _lightBufferManager: LightBufferManager | null = null;

  // Global Distance Field (G2: pipeline-level ownership, multi-cascade, camera scrolling)
  private gdf: GlobalDistanceField | null = null;
  private _sdfEnabled = true;

  constructor(ctx: GPUContext, options: GPUForwardPipelineOptions) {
    this.ctx = ctx;
    this.width = options.width;
    this.height = options.height;
    this.sampleCount = options.sampleCount || 1;

    // Create render target manager (owns all textures)
    this.renderTargets = new RenderTargetManager(ctx, this.width, this.height, this.sampleCount);

    // Create renderers
    this.gridRenderer = new GridRendererGPU(ctx);
    this.skyRenderer = new SkyRendererGPU(ctx);
    this.objectRenderer = ctx.objectRenderer;
    this.shadowRenderer = new ShadowRendererGPU(ctx, { resolution: 2048, shadowRadius: this.shadowRadius });
    this.objectRenderer.setShadowRenderer(this.shadowRenderer);

    // IBL + SceneEnvironment
    this.dynamicSkyIBL = new DynamicSkyIBL(ctx);
    this.sceneEnvironment = new SceneEnvironment(ctx);
    this.selectionOutlineRenderer = new SelectionOutlineRendererGPU(ctx);

    // Debug texture manager + shadow debug registrations
    this.debugTextureManager = new DebugTextureManager(ctx);
    this.debugTextureManager.register('shadow-map', 'depth', () => this.shadowRenderer.getShadowMap()?.view ?? null);
    for (let i = 0; i < 4; i++) {
      const ci = i;
      this.debugTextureManager.register(`csm-cascade-${i}`, 'depth', () => this.shadowRenderer.getCascadeView(ci));
    }

    // Create render passes
    this.initializePasses();
    this.debugTextureManager.register('ssr', 'float', () => this.ssrPass?.getSSRTexture()?.view ?? null);

    // Post-processing manager (owns PostProcessPipeline + all effects)
    this.postProcessManager = new PostProcessManager(ctx, this.width, this.height);
    this.renderTargets.initializeHDRTargets();

    // Cloud manager (owns clouds, weather, temporal filter, GPU profiling)
    this.cloudManager = new CloudManager(ctx, this.width, this.height);

    // Volumetric fog manager (Phase 6 — froxel-based fog)
    this.volumetricFogManager = new VolumetricFogManager(ctx);

    // Cloud debug textures (providers may be null until clouds are enabled)
    this.debugTextureManager.register('cloud-result', 'float', () => this.cloudManager.rayMarcher?.outputView ?? null);
    this.debugTextureManager.register('weather-map', 'float', () => this.cloudManager.rayMarcher?.weatherMapGenerator.textureView ?? null);

    // Vegetation shadow map debug texture (available when grass blade shadows are active)
    this.debugTextureManager.register('vegetation-shadow', 'depth', () => {
      // The vegetation shadow map view is set on sceneEnvironment each frame;
      // read it back from the last-rendered terrain's VegetationShadowMap.
      return this.sceneEnvironment.getVegetationShadowView?.() ?? null;
    });
  }

  // ==================== Pass Initialization ====================

  private initializePasses(): void {
    const shadowPass = new ShadowPass({ shadowRenderer: this.shadowRenderer, objectRenderer: this.objectRenderer, meshPool: this.ctx.variantMeshPool });
    const skyPass = new SkyPass(this.skyRenderer);
    const opaquePass = new OpaquePass({ objectRenderer: this.objectRenderer, shadowRenderer: this.shadowRenderer, meshPool: this.ctx.variantMeshPool });
    const transparentPass = new TransparentPass();
    transparentPass.debugTextureManager = this.debugTextureManager;
    const groundPass = new GroundPass({ gridRenderer: this.gridRenderer, shadowRenderer: this.shadowRenderer });
    const overlayPass = new OverlayPass(this.gridRenderer);
    const debugPass = new DebugPass({ shadowRenderer: this.shadowRenderer, debugTextureManager: this.debugTextureManager });
    const selectionMaskPass = new SelectionMaskPass({ objectRenderer: this.objectRenderer });
    const selectionOutlinePass = new SelectionOutlinePass({ objectRenderer: this.objectRenderer, outlineRenderer: this.selectionOutlineRenderer });

    const ssrPass = new SSRPass(this.ctx, this.width, this.height, { enabled: false });
    this.ssrPass = ssrPass;
    ssrPass.setConsumerCheck(() => this.lastSSRSystemHasConsumers);

    const debugViewPass = new DebugViewPass(this.ctx);
    this.debugViewPass = debugViewPass;
    debugViewPass.setSSRTextureProvider(() => ssrPass.getSSRTexture());

    this.passes = [
      shadowPass, skyPass, groundPass, opaquePass, ssrPass, transparentPass,
      overlayPass, selectionMaskPass, selectionOutlinePass, debugPass, debugViewPass,
    ].sort((a, b) => a.priority - b.priority);
  }

  getMergedRenderOptions = (options: RenderOptions = {}) => ({
    ...DEFAULT_RENDER_OPTIONS,
    shadowEnabled: this.shadowEnabled,
    shadowSoftShadows: this.shadowSoftShadows,
    shadowRadius: this.shadowRadius,
    ...options,
  });

  preWorldUpdate(deltaTime: number, options: Required<RenderOptions>, world?: World, sceneCamera?: GPUCamera) {
    // ── Weather + cloud lighting adaptation ──
    this.cloudManager.updateWeather(deltaTime, options, world);

    // ── Pre-world vegetation prepare ──
    // Vegetation mesh entities must be synced BEFORE world.update() so that
    // MeshRenderSystem (which runs during world.update) sees them as active
    // and includes them in variant groups for rendering. Without this,
    // vegetation mesh entities have active=false when MeshRenderSystem runs,
    // causing them to be excluded from all draw calls.
    if (sceneCamera) {
      this._cachedSceneVpMatrix = new Float32Array(sceneCamera.getVpMatrix());
      const pos = sceneCamera.getPosition();
      this._cachedSceneCamPos = [pos[0], pos[1], pos[2]];
    }
    if (world && this._cachedSceneVpMatrix) {
      this.prepareVegetation(world, this._cachedSceneVpMatrix, this._cachedSceneCamPos);
    }
  }

  // Cached scene camera data for vegetation preparation (updated each frame in preWorldUpdate)
  private _cachedSceneVpMatrix: Float32Array | null = null;
  private _cachedSceneCamPos: [number, number, number] = [0, 0, 0];

  render(camera: GPUCamera, options: Required<RenderOptions>, sceneCamera?: GPUCamera, world?: World): void {
    const now = performance.now();
    const deltaTime = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    this.time += deltaTime;

    if (!this.ctx.context) {
      console.warn('[GPUForwardPipeline] Canvas not configured');
      return;
    }
    const outputTexture = this.ctx.context.getCurrentTexture();
    const outputView = outputTexture.createView();
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'forward-pipeline-encoder'
    });

    const rt = this.renderTargets;
    const useHDR = !!rt.sceneColorTexture;

    // ── Dynamic Sky IBL ──
    this.updateIBL(encoder, options, deltaTime);

    // ── Shadow environment ──
    this.updateShadowEnvironment(options);

    // ── Build RenderContext ──
    const nearPlane = camera.near ?? this.defaultNearPlane;
    const farPlane = camera.far ?? this.defaultFarPlane;

    const contextOptions: RenderContextOptions = {
      ctx: this.ctx, encoder, camera, sceneCamera, world,
      options,
      width: this.width, height: this.height,
      near: nearPlane, far: farPlane,
      time: this.time, deltaTime,
      sampleCount: this.sampleCount,
      depthTexture: rt.depthTexture,
      depthTextureCopy: rt.depthTextureCopy,
      outputTexture, outputView,
      useHDR,
      sceneColorTexture: rt.sceneColorTexture ?? undefined,
      sceneColorTextureCopy: rt.sceneColorTextureCopy ?? undefined,
      msaaHdrColorTexture: rt.msaaHdrColorTexture ?? undefined,
      msaaColorTexture: rt.msaaColorTexture ?? undefined,
      selectionMaskTexture: rt.selectionMaskTexture ?? undefined,
      normalsTexture: rt.normalsTexture ?? undefined,
      sceneEnvironment: this.sceneEnvironment,
      meshRenderSystem: world ? this.findMeshRenderSystem(world) : undefined,
    };
    const renderCtx = new RenderContextImpl(contextOptions);

    // ── SSR state ──
    this.sceneEnvironment.setSSR(this.ssrPass?.getSSRTexture()?.view ?? null);
    if (world) {
      this.lastSSRSystemHasConsumers = this.findSSRSystem(world)?.hasConsumers ?? false;
    } else {
      this.lastSSRSystemHasConsumers = false;
    }

    // NOTE: prepareVegetation() already ran in preWorldUpdate() — do NOT call it
    // again here, as it would re-run GPU culling and allocate new buffers,
    // invalidating the buffer references synced to ECS entities before world.update().

    // ── Grass blade shadow pass (after vegetation cull, before scene shadow pass) ──
    this.renderGrassShadows(world, encoder, renderCtx);

    // ── GDF compute pre-pass (G2: before any render passes that need SDF) ──
    this.updateGDF(encoder, renderCtx);

    // ── Scene passes (render to HDR buffer) ──
    for (const pass of this.passes) {
      if (pass.enabled && pass.category === 'scene') {
        pass.execute(renderCtx);
      }
    }

    // ── Volumetric fog compute passes (before post-processing) ──
    if (this.volumetricFogManager.enabled) {
      this.volumetricFogManager.execute(
        encoder, renderCtx, options,
        this.time, deltaTime, nearPlane, farPlane,
        this.shadowRenderer, this.cloudManager,
        this._lightBufferManager,
        this.postProcessManager.getPipeline(),
      );
    }

    // ── Cloud shadow + ray march ──
    this.cloudManager.executeCloudShadow(encoder, renderCtx, this.sceneEnvironment);
    const cloudResult = this.cloudManager.executeCloudRayMarch(
      encoder, renderCtx, options, this.time, deltaTime, nearPlane, farPlane,
    );
    this.cloudManager.feedCloudComposite(
      this.postProcessManager.getPipeline(), cloudResult, deltaTime, renderCtx
    );

    // ── Post-processing ──
    if (useHDR && rt.sceneColorTexture) {
      this.postProcessManager.execute(
        renderCtx, options, rt.sceneColorTexture, rt.depthTextureCopy,
        outputView, this.time, deltaTime, nearPlane, farPlane,
        this.shadowRenderer, this.cloudManager,
      );
    }

    // ── Viewport passes (grid, debug overlays — after post-processing) ──
    for (const pass of this.passes) {
      if (pass.enabled && pass.category === 'viewport') {
        pass.execute(renderCtx);
      }
    }

    this.ctx.queue.submit([encoder.finish()]);
    this.lastDrawCallsCount = renderCtx.getDrawCalls();
  }

  // ==================== Render Helpers (private) ====================

  private updateIBL(encoder: GPUCommandEncoder, mergedOptions: Required<RenderOptions>, deltaTime: number): void {
    if (mergedOptions.skyMode === 'sun' && mergedOptions.dynamicIBL && this.iblEnabled) {
      const ld = mergedOptions.lightDirection;
      const len = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]);
      const sunDir: [number, number, number] = len > 0 ? [ld[0] / len, ld[1] / len, ld[2] / len] : [0, 1, 0];

      if (this.cloudManager.needsIBLRecapture()) {
        this.cloudManager.markIBLCoverageUpdated();
        this.dynamicSkyIBL.forceUpdate(sunDir, mergedOptions.sunIntensity);
      }

      this.dynamicSkyIBL.update(encoder, sunDir, mergedOptions.sunIntensity, deltaTime);
      if (this.dynamicSkyIBL.isReady()) {
        const t = this.dynamicSkyIBL.getIBLTextures();
        this.sceneEnvironment.setIBL({ diffuseCubemap: t.diffuse, specularCubemap: t.specular, brdfLut: t.brdfLut } as IBLResources);
      }
    } else {
      this.sceneEnvironment.setIBL(null);
    }
  }

  private updateShadowEnvironment(mergedOptions: Required<RenderOptions>): void {
    if (mergedOptions.shadowEnabled) {
      const sm = this.shadowRenderer.getShadowMap();
      if (sm) this.sceneEnvironment.setShadowMap(sm.view);
      if (this.shadowRenderer.isCSMEnabled()) {
        const av = this.shadowRenderer.getShadowMapArrayView();
        const ub = this.shadowRenderer.getCSMUniformBuffer();
        if (av && ub) this.sceneEnvironment.setCSM({ shadowArrayView: av, uniformBuffer: ub });
      } else {
        this.sceneEnvironment.setCSM(null);
      }
    } else {
      this.sceneEnvironment.setShadowMap(null);
      this.sceneEnvironment.setCSM(null);
    }
  }

  /**
   * Prepare vegetation for the current frame
   * - Raw VP matrix + camera position (from preWorldUpdate(), before RenderContext exists)
   */
  private prepareVegetation(world: World | undefined, vpMatrix: Float32Array, cameraPosition: Vec3): void {
    if (!world) return;
    const terrainEntity = world.queryFirst('terrain');
    if (!terrainEntity) return;
    const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
    if (tc?.manager?.isReady) {
      tc.manager.setWorld(world);
      tc.manager.prepareVegetationForFrame(vpMatrix, cameraPosition);
    }
  }

  /**
   * Render grass blade shadows into the dedicated vegetation shadow map.
   * Called after prepareVegetation() (which runs GPU culling), before scene passes.
   * The shadow map is then available for sampling by grass-blade.wgsl and terrain shaders.
   */
  private renderGrassShadows(
    world: World | undefined,
    encoder: GPUCommandEncoder,
    renderCtx: RenderContextImpl,
  ): void {
    if (!world || !renderCtx.options.shadowEnabled) return;
    const terrainEntity = world.queryFirst('terrain');
    if (!terrainEntity) return;
    const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
    if (!tc?.manager?.isReady) return;

    // Get light direction from the ECS directional light component (via RenderContext).
    // LightComponent.direction points TOWARDS the light (sun direction).
    // VegetationShadowMap.updateLightMatrix also expects direction towards the light.
    const dirLight = renderCtx.getDirectionalLight();
    const d = dirLight.direction;
    const lightDir: Vec3 = [d[0], d[1], d[2]];

    // Render grass shadow depth pass into the vegetation shadow map
    // Uses the scene camera position from the render context
    tc.manager.renderGrassShadowPass(
      encoder,
      lightDir,
      renderCtx.sceneCameraPosition,
    );

    // Wire the vegetation shadow map into SceneEnvironment for terrain sampling
    const vegShadowMap = tc.manager.getVegetationShadowMap();
    if (vegShadowMap) {
      this.sceneEnvironment.setVegetationShadow(
        vegShadowMap.getShadowMapView(),
        vegShadowMap.getUniformBuffer(),
      );
    }
  }

  // ==================== Resize ====================

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.renderTargets.resize(width, height);
    this.ssrPass?.resize(width, height);
    this.cloudManager.resize(width, height);
    this.postProcessManager.resize(width, height);
  }

  // ==================== Shadow Settings ====================

  setShadowSettings(config: WebGPUShadowSettings): void {
    if (config.enabled !== undefined) this.shadowEnabled = config.enabled;
    if (config.softShadows !== undefined) this.shadowSoftShadows = config.softShadows;
    if (config.shadowRadius !== undefined) { this.shadowRadius = config.shadowRadius; this.shadowRenderer.setShadowRadius(config.shadowRadius); }
    if (config.resolution !== undefined) this.shadowRenderer.setResolution(config.resolution);
    if (config.csmEnabled !== undefined) this.shadowRenderer.setCSMEnabled(config.csmEnabled);
    if (config.cascadeCount !== undefined) this.shadowRenderer.setCascadeCount(config.cascadeCount);
    if (config.cascadeBlendFraction !== undefined) this.shadowRenderer.setCascadeBlendFraction(config.cascadeBlendFraction);
  }

  // ==================== Public Getters ====================

  getLastDrawCallsCount(): number { return this.lastDrawCallsCount; }
  setHDRTexture(texture: UnifiedGPUTexture): void { this.skyRenderer.setHDRTexture(texture); }
  getObjectRenderer(): ObjectRendererGPU { return this.objectRenderer; }
  getShadowRenderer(): ShadowRendererGPU { return this.shadowRenderer; }
  getSceneEnvironment(): SceneEnvironment { return this.sceneEnvironment; }
  getDebugTextureManager(): DebugTextureManager { return this.debugTextureManager; }
  getPostProcessPipeline(): PostProcessPipeline | null { return this.postProcessManager.getPipeline(); }

  /** Set the LightBufferManager for volumetric fog point/spot light injection */
  setLightBufferManager(manager: LightBufferManager): void { this._lightBufferManager = manager; }

  // ==================== Post-Processing (delegates to PostProcessManager) ====================

  setSSAOEnabled(enabled: boolean): void { this.postProcessManager.setSSAOEnabled(enabled); }
  isSSAOEnabled(): boolean { return this.postProcessManager.isSSAOEnabled(); }
  setSSAOConfig(config: Partial<SSAOEffectConfig>): void { this.postProcessManager.setSSAOConfig(config); }
  getSSAOConfig(): SSAOEffectConfig | null { return this.postProcessManager.getSSAOConfig(); }

  setCompositeConfig(config: Partial<CompositeEffectConfig>): void { this.postProcessManager.setCompositeConfig(config); }
  getCompositeConfig(): CompositeEffectConfig | null { return this.postProcessManager.getCompositeConfig(); }

  setAtmosphericFogEnabled(enabled: boolean): void { this.postProcessManager.setAtmosphericFogEnabled(enabled); }
  isAtmosphericFogEnabled(): boolean { return this.postProcessManager.isAtmosphericFogEnabled(); }
  setAtmosphericFogConfig(config: Partial<AtmosphericFogConfig>): void { this.postProcessManager.setAtmosphericFogConfig(config); }
  getAtmosphericFogConfig(): AtmosphericFogConfig | null { return this.postProcessManager.getAtmosphericFogConfig(); }

  setGodRaysEnabled(enabled: boolean): void { this.postProcessManager.setGodRaysEnabled(enabled); }
  isGodRaysEnabled(): boolean { return this.postProcessManager.isGodRaysEnabled(); }
  setGodRayConfig(config: Partial<GodRayConfig> & { mode?: 'screen-space' | 'volumetric' }): void { this.postProcessManager.setGodRayConfig(config); }
  getGodRayConfig(): GodRayConfig | null { return this.postProcessManager.getGodRayConfig(); }

  // ==================== Cloud (delegates to CloudManager) ====================

  setCloudEnabled(enabled: boolean): void {
    this.cloudManager.setEnabled(enabled, this.debugTextureManager, this.postProcessManager.getPipeline());
    if (!enabled) this.sceneEnvironment.setCloudShadow(null, null);
  }
  isCloudEnabled(): boolean { return this.cloudManager.enabled; }

  setCloudConfig(config: Partial<CloudConfig>): void {
    if (config.enabled !== undefined) this.setCloudEnabled(config.enabled);
    this.cloudManager.setConfig(config);
  }

  setVolumetricFogConfig(config: Partial<VolumetricFogConfig>): void {
    // Handle enable/disable
    if (config.enabled !== undefined) {
      this.volumetricFogManager.setEnabled(
        config.enabled,
        this.postProcessManager.getPipeline(),
        this.debugTextureManager,
      );
    }
    // Forward all config to the manager
    this.volumetricFogManager.setConfig(config);
  }
  
  getCloudConfig(): CloudConfig | null { return this.cloudManager.getConfig(); }

  // ==================== Weather (delegates to CloudManager) ====================

  getWeatherManager(): WeatherStateManager { return this.cloudManager.weatherState; }

  setWeatherPreset(name: string, duration?: number): void {
    if (!this.cloudManager.enabled) this.setCloudEnabled(true);
    this.cloudManager.setWeatherPreset(name, duration);
  }

  jumpToWeatherPreset(name: string): void {
    if (!this.cloudManager.enabled) this.setCloudEnabled(true);
    this.cloudManager.jumpToWeatherPreset(name);
  }

  clearWeatherPreset(): void {
    this.cloudManager.clearWeatherPreset();
  }

  getActiveWeatherPreset(): string | null { return this.cloudManager.activePreset; }
  isWeatherTransitioning(): boolean { return this.cloudManager.isTransitioning; }
  serializeWeatherState(): SerializedWeatherState { return this.cloudManager.serializeWeatherState(); }
  deserializeWeatherState(data: SerializedWeatherState): void { this.cloudManager.deserializeWeatherState(data); }

  getCloudTimings(): { raymarch: number; temporal: number; total: number } | null {
    return this.cloudManager.getCloudTimings();
  }

  // ==================== SSR ====================

  // ==================== SDF / Global Distance Field ====================

  setSDFEnabled(enabled: boolean): void {
    this._sdfEnabled = enabled;
    const tp = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (tp) { tp.sdfEnabled = enabled; }
  }
  isSDFEnabled(): boolean {
    return this._sdfEnabled;
  }

  /** Get the pipeline-owned GDF instance (for external consumers) */
  getGlobalDistanceField(): GlobalDistanceField | null {
    return this.gdf;
  }

  // ==================== SSR ====================

  setSSREnabled(enabled: boolean): void {
    this.ssrPass?.setEnabled(enabled);
    const tp = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (tp) {
      tp.ssrEnabled = enabled;
      const cfg = this.ssrPass?.getConfig();
      if (cfg) { const { enabled: _, quality: __, ...rest } = cfg; tp.ssrConfig = rest; }
    }
  }
  isSSREnabled(): boolean { return this.ssrPass?.getConfig().enabled ?? false; }
  setSSRQuality(quality: SSRQualityLevel): void {
    this.ssrPass?.setQuality(quality);
    const tp = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (tp) { const cfg = this.ssrPass?.getConfig(); if (cfg) { const { enabled: _, quality: __, ...rest } = cfg; tp.ssrConfig = rest; } }
  }
  setSSRConfig(config: Partial<SSRConfig>): void { this.ssrPass?.setConfig(config); }
  getSSRConfig(): SSRConfig | null { return this.ssrPass?.getConfig() ?? null; }
  getSSRPass(): SSRPass | null { return this.ssrPass; }

  // ==================== Debug View ====================

  setDebugViewMode(mode: DebugViewMode): void { this.debugViewPass?.setMode(mode); }
  getDebugViewMode(): DebugViewMode { return this.debugViewPass?.getMode() ?? 'off'; }
  getPass(name: string): RenderPass | undefined { return this.passes.find(p => p.name === name); }
  setPassEnabled(name: string, enabled: boolean): void { const p = this.getPass(name); if (p) p.enabled = enabled; }

  // ==================== IBL ====================

  setIBLEnabled(enabled: boolean): void { this.iblEnabled = enabled; }
  isIBLEnabled(): boolean { return this.iblEnabled; }
  getDynamicSkyIBL(): DynamicSkyIBL { return this.dynamicSkyIBL; }
  isIBLReady(): boolean { return this.dynamicSkyIBL.isReady(); }

  // ==================== Destroy ====================

  destroy(): void {
    this.renderTargets.destroy();
    this.gridRenderer.destroy();
    this.skyRenderer.destroy();
    this.shadowRenderer.destroy();
    this.dynamicSkyIBL.destroy();
    this.postProcessManager.destroy();
    this.selectionOutlineRenderer.destroy();
    this.debugTextureManager.destroy();
    this.cloudManager.destroy();
    this.volumetricFogManager.destroy();
    this.gdf?.destroy();
    this.gdf = null;
    for (const pass of this.passes) pass.destroy?.();
  }

  // ==================== Private Helpers ====================

  /**
   * Update the Global Distance Field (G2/G3: multi-cascade, camera scrolling, mesh primitives).
   * Runs as a compute pre-pass before any render passes that need SDF data.
   * Lazy-initializes GDF on first frame that has terrain with a heightmap.
   * Independent of ocean/water — any consumer (water, fog, AO) can use GDF.
   */
  private updateGDF(encoder: GPUCommandEncoder, renderCtx: RenderContextImpl): void {
    if (!this._sdfEnabled) return;

    const world = renderCtx.world;
    if (!world) return;

    // Get terrain manager for heightmap stamping (optional — GDF works without terrain too)
    let terrainManager = null;
    const terrainEntity = world.queryFirst('terrain');
    if (terrainEntity) {
      const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
      terrainManager = tc?.manager ?? null;
    }

    // G3: Collect mesh primitives from ECS (boxes from world-space AABBs)
    const meshPrimitives = this.collectSDFPrimitives(world, renderCtx.cameraPosition);

    // Need either terrain or mesh primitives to justify GDF initialization
    const hasTerrain = terrainManager?.isReady && terrainManager.getHeightmap();
    if (!hasTerrain && meshPrimitives.length === 0) return;

    // Lazy-initialize GDF on first use
    if (!this.gdf) {
      this.gdf = new GlobalDistanceField(this.ctx);
      this.gdf.initialize();
      console.log('[GPUForwardPipeline] GlobalDistanceField initialized (G2: pipeline-level, multi-cascade)');
    }

    // Build terrain stamp params (null if no terrain — GDF skips terrain stamping)
    let terrainStampParams: SDFTerrainStampParams | undefined;
    if (hasTerrain) {
      const terrainConfig = terrainManager!.getConfig();
      const heightmap = terrainManager!.getHeightmap()!;
      terrainStampParams = {
        heightmapView: heightmap.view,
        heightScale: terrainConfig?.heightScale ?? 50,
        terrainWorldSize: terrainConfig?.worldSize ?? 1000,
      };
    }

    // Update GDF (all cascades, hysteresis-based re-centering, terrain + mesh stamping)
    this.gdf.update(encoder, renderCtx.cameraPosition, terrainStampParams, meshPrimitives);

    // Pass GDF reference to TransparentPass (water reads it for contact foam)
    const tp = this.passes.find(p => p.name === 'transparent') as TransparentPass | undefined;
    if (tp) {
      tp.externalGDF = this.gdf;
    }

    // G4: Pass GDF reference to VolumetricFogManager for fog-SDF integration
    this.volumetricFogManager.setGDF(this.gdf);

    // Pass GDF to DebugViewPass for SDF visualization
    this.debugViewPass?.setGDF(this.gdf);
  }

  /**
   * G3: Collect SDF primitives from ECS world.
   * Queries entities with BoundsComponent that have computed worldBounds,
   * converts AABBs to SDFPrimitive boxes, and filters out non-mesh entities
   * (terrain, ocean, lights) and distant objects.
   */
  private collectSDFPrimitives(world: World, cameraPosition: Float32Array | number[]): SDFPrimitive[] {
    const primitives: SDFPrimitive[] = [];
    const camX = cameraPosition[0], camY = cameraPosition[1], camZ = cameraPosition[2];
    // Only stamp primitives within the coarsest cascade range (~512m) for efficiency
    const maxRange = 512;
    const maxRangeSq = maxRange * maxRange;

    // Query all entities with bounds component
    const entities = world.query('bounds');
    for (const entity of entities) {
      const bounds = entity.getComponent<BoundsComponent>('bounds');
      if (!bounds?.worldBounds) continue;

      // Skip terrain and ocean entities — they have their own SDF stamping
      if (entity.hasComponent('terrain') || entity.hasComponent('ocean')) continue;
      // Skip light entities
      if (entity.hasComponent('light')) continue;

      const wb = bounds.worldBounds;
      const minX = wb.min[0], minY = wb.min[1], minZ = wb.min[2];
      const maxX = wb.max[0], maxY = wb.max[1], maxZ = wb.max[2];

      // Compute AABB center and half-extents
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const hx = (maxX - minX) * 0.5;
      const hy = (maxY - minY) * 0.5;
      const hz = (maxZ - minZ) * 0.5;

      // Skip very small objects (< 0.1m half-extent in all dimensions)
      if (hx < 0.1 && hy < 0.1 && hz < 0.1) continue;

      // Distance check from camera to AABB center
      const dx = cx - camX, dy = cy - camY, dz = cz - camZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > maxRangeSq) continue;

      primitives.push({
        type: 'box',
        center: new Float32Array([cx, cy, cz]) as any,
        extents: new Float32Array([hx, hy, hz]) as any,
      });
    }

    return primitives;
  }

  private findMeshRenderSystem(world: World): MeshRenderSystem | undefined {
    for (const s of world.getSystems()) { if (s instanceof MeshRenderSystem) return s; }
    return undefined;
  }

  private findSSRSystem(world: World): SSRSystem | undefined {
    for (const s of world.getSystems()) { if (s instanceof SSRSystem) return s; }
    return undefined;
  }
}
