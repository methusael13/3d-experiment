/**
 * CloudManager - Manages volumetric clouds, weather system, and GPU profiling.
 *
 * Owns:
 *  - Cloud ray marcher (half-res checkerboard)
 *  - Cloud shadow generator
 *  - Cloud temporal filter (reprojection)
 *  - Weather state manager (preset transitions)
 *  - GPU timestamp query profiling
 *  - Cirrus wind offset accumulation
 *  - Previous VP matrix for temporal motion vectors
 */

import { GPUContext } from '../GPUContext';
import { DebugTextureManager } from '../renderers';
import { SceneEnvironment } from '../renderers/shared';
import {
  CloudRayMarcher,
  CloudShadowGenerator,
  CloudTemporalFilter,
  WeatherStateManager,
  type CloudConfig,
  type SerializedWeatherState,
} from '../clouds';
import {
  PostProcessPipeline,
  CloudCompositeEffect,
} from '../postprocess';
import type { RenderContext } from './RenderContext';
import type { RenderOptions } from './GPUForwardPipeline';
import type { World } from '../../ecs/World';
import { LightComponent } from '../../ecs/components/LightComponent';

/**
 * Per-frame cloud render result — output texture and dimensions
 * for the post-processing cloud composite effect.
 */
export interface CloudFrameResult {
  cloudOutputView: GPUTextureView | null;
  cloudOutputWidth: number;
  cloudOutputHeight: number;
}

export class CloudManager {
  private ctx: GPUContext;
  private width: number;
  private height: number;

  // Cloud subsystems
  private cloudRayMarcher: CloudRayMarcher | null = null;
  private cloudShadowGenerator: CloudShadowGenerator | null = null;
  private cloudTemporalFilter: CloudTemporalFilter | null = null;
  private _enabled = false;

  // Weather system (Phase 5)
  private weatherManager = new WeatherStateManager();
  // Track coverage for IBL re-capture (§6.4.4)
  private _lastIBLCoverage = 0;
  // Cirrus wind offset accumulator (scrolls UV over time at 2× wind speed per plan §2.2.1)
  private cirrusWindOffsetX = 0;
  private cirrusWindOffsetY = 0;

  // Previous frame's view-projection matrix for temporal reprojection motion vectors
  private prevViewProjectionMatrix: Float32Array = new Float32Array(16);
  private hasPrevViewProjectionMatrix = false;

  // GPU timestamp query profiling (Phase 3)
  private timestampQuerySet: GPUQuerySet | null = null;
  private timestampBuffer: GPUBuffer | null = null;
  private timestampReadBuffer: GPUBuffer | null = null;
  private timestampSupported = false;
  private _cloudTimings: { raymarch: number; temporal: number; total: number } = { raymarch: 0, temporal: 0, total: 0 };

  constructor(ctx: GPUContext, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  // ========== Getters ==========

  get enabled() { return this._enabled; }
  get weatherState() { return this.weatherManager; }
  get lastIBLCoverage() { return this._lastIBLCoverage; }
  set lastIBLCoverage(v: number) { this._lastIBLCoverage = v; }

  /** Expose ray marcher for debug texture registration */
  get rayMarcher() { return this.cloudRayMarcher; }
  get shadowGenerator() { return this.cloudShadowGenerator; }
  get temporalFilter() { return this.cloudTemporalFilter; }

  // ========== Enable / Disable ==========

  /**
   * Enable/disable volumetric clouds.
   * Lazily initializes the cloud ray marcher on first enable.
   */
  setEnabled(enabled: boolean, debugTextureManager: DebugTextureManager, postProcessPipeline: PostProcessPipeline | null): void {
    this._enabled = enabled;

    // Lazily create the cloud ray marcher when first enabled
    if (enabled && !this.cloudRayMarcher) {
      this.cloudRayMarcher = new CloudRayMarcher(this.ctx);
      this.cloudRayMarcher.init(this.width, this.height);

      // Create cloud shadow generator (Phase 2)
      this.cloudShadowGenerator = new CloudShadowGenerator(this.ctx);
      this.cloudShadowGenerator.init();

      // Create temporal filter (Phase 3)
      this.cloudTemporalFilter = new CloudTemporalFilter(this.ctx);
      const halfW = this.cloudRayMarcher.outputWidth;
      const halfH = this.cloudRayMarcher.outputHeight;
      this.cloudTemporalFilter.init(halfW, halfH, this.width, this.height);

      // Wire blue noise texture from temporal filter to ray marcher
      this.cloudRayMarcher.setBlueNoiseView(this.cloudTemporalFilter.blueNoiseView);
      this.cloudRayMarcher.setForceDisableCheckerboard(false);

      // Initialize timestamp query profiling (if supported)
      this.initTimestampQueries();

      // Register debug textures
      debugTextureManager.register(
        'cloud-shadow',
        'float',
        () => this.cloudShadowGenerator?.textureView ?? null
      );
      debugTextureManager.register(
        'cloud-history',
        'float',
        () => this.cloudTemporalFilter?.historyView ?? null
      );
      debugTextureManager.register(
        'cloud-temporal',
        'float',
        () => this.cloudTemporalFilter?.outputView ?? null
      );
    }

    // Enable/disable the cloud composite post-process effect
    postProcessPipeline?.setEnabled('cloudComposite', enabled);
  }

  // ========== Weather System ==========

  /**
   * Update weather system and apply weather-aware lighting.
   * Mutates mergedOptions in place for sun/ambient adaptation.
   */
  updateWeather(deltaTime: number, mergedOptions: Required<RenderOptions>, world?: World): void {
    if (!this._enabled) return;

    this.weatherManager.update(deltaTime);

    // §6.4.2: Sun intensity attenuation from cloud coverage
    const weatherSunScale = this.weatherManager.effectiveSunScale;
    mergedOptions.sunIntensity *= weatherSunScale;

    // §6.4.5: Ambient boost under overcast
    const weatherAmbientBoost = this.weatherManager.effectiveAmbientBoost;
    const ambientScale = Math.max(0, 1.0 + weatherAmbientBoost);
    mergedOptions.ambientIntensity = Math.min(1.0, mergedOptions.ambientIntensity * ambientScale);

    // Write weatherDimming input field on the directional light entity.
    // LightingSystem reads this field and applies it centrally to both
    // effectiveColor and ambient, ensuring uniform dimming for terrain
    // and objects alike (follows the same pattern as night-time dimming).
    if (world) {
      const sunEntity = world.queryFirst('light');
      if (sunEntity) {
        const lc = sunEntity.getComponent<LightComponent>('light');
        if (lc && lc.lightType === 'directional' && lc.enabled) {
          lc.weatherDimming = weatherSunScale;
        }
      }
    }

    // Sync weather cloud params to ray marcher config only when a preset is active.
    // In Custom mode (activePreset === null), the user controls cloud params directly
    // via setCloudConfig() from the UI sliders — don't override them here.
    if (this.weatherManager.activePreset !== null) {
      const weather = this.weatherManager.current;
      this.cloudRayMarcher?.setConfig({
        coverage: weather.cloudCoverage,
        cloudType: weather.cloudType,
        density: weather.cloudDensity,
        cloudBase: weather.cloudBaseAltitude,
        cloudThickness: weather.cloudThickness,
        windSpeed: weather.windSpeed,
        windDirection: weather.windDirection,
      });
    }
  }

  /**
   * Check if IBL needs re-capture due to coverage change >0.1
   */
  needsIBLRecapture(): boolean {
    if (!this._enabled) return false;
    const currentCoverage = this.weatherManager.current.cloudCoverage;
    return Math.abs(currentCoverage - this._lastIBLCoverage) > 0.1;
  }

  /**
   * Mark IBL coverage as up-to-date after re-capture.
   */
  markIBLCoverageUpdated(): void {
    this._lastIBLCoverage = this.weatherManager.current.cloudCoverage;
  }

  // ========== Per-Frame Cloud Rendering ==========

  /**
   * Execute cloud shadow map generation.
   * Called before scene passes so objects can sample cloud shadows.
   */
  executeCloudShadow(
    encoder: GPUCommandEncoder,
    renderCtx: RenderContext,
    sceneEnvironment: SceneEnvironment,
  ): void {
    if (!this._enabled || !this.cloudRayMarcher?.isReady || !this.cloudShadowGenerator) return;

    const dirLight = renderCtx.getDirectionalLight();
    const config = this.cloudRayMarcher.getConfig();

    if (config.cloudShadows) {
      this.cloudShadowGenerator.execute(
        encoder,
        this.cloudRayMarcher.noiseGenerator,
        this.cloudRayMarcher.weatherMapGenerator,
        config,
        dirLight.direction,
        renderCtx.cameraPosition,
        this.cloudRayMarcher.currentWeatherOffsetX,
        this.cloudRayMarcher.currentWeatherOffsetZ,
      );

      // Wire cloud shadow map + uniforms into SceneEnvironment (bindings 17-18)
      sceneEnvironment.setCloudShadow(
        this.cloudShadowGenerator.textureView,
        this.cloudShadowGenerator.sceneUniformBuffer,
      );
    } else {
      sceneEnvironment.setCloudShadow(null, null);
    }
  }

  /**
   * Execute cloud ray marching + temporal reprojection.
   * Called between scene passes and post-processing.
   * Returns the cloud output texture and dimensions for the composite effect.
   */
  executeCloudRayMarch(
    encoder: GPUCommandEncoder,
    renderCtx: RenderContext,
    mergedOptions: Required<RenderOptions>,
    time: number,
    deltaTime: number,
    nearPlane: number,
    farPlane: number,
  ): CloudFrameResult | null {
    if (!this._enabled || !this.cloudRayMarcher?.isReady) return null;

    const dirLight = renderCtx.getDirectionalLight();
    const config = this.cloudRayMarcher.getConfig();
    const cloudSunIntensity = mergedOptions.sunIntensity * dirLight.sunIntensityFactor;

    // Sync frame index from temporal filter → ray marcher (for checkerboard pattern)
    if (this.cloudTemporalFilter) {
      this.cloudRayMarcher.setFrameIndex(this.cloudTemporalFilter.frameIndex);
    }

    // Dispatch cloud ray march (half-resolution, checkerboard)
    this.cloudRayMarcher.execute(
      encoder,
      renderCtx.inverseViewProjectionMatrix,
      renderCtx.cameraPosition,
      dirLight.direction,
      dirLight.effectiveColor,
      cloudSunIntensity,
      time,
      deltaTime,
      nearPlane,
      farPlane,
    );

    // Dispatch temporal reprojection (Phase 3)
    let cloudOutputView = this.cloudRayMarcher.outputView;
    let cloudOutputWidth = this.cloudRayMarcher.outputWidth;
    let cloudOutputHeight = this.cloudRayMarcher.outputHeight;

    if (this.cloudTemporalFilter && config.temporalReprojection) {
      this.cloudTemporalFilter.setMatrices(
        this.prevViewProjectionMatrix,
        renderCtx.inverseViewProjectionMatrix,
      );

      if (this.hasPrevViewProjectionMatrix) {
        this.cloudTemporalFilter.execute(encoder, this.cloudRayMarcher.outputView!);
        cloudOutputView = this.cloudTemporalFilter.outputView;
      }
    }

    // Save current VP matrix for next frame's motion vector generation
    this.prevViewProjectionMatrix.set(renderCtx.viewProjectionMatrix);
    this.hasPrevViewProjectionMatrix = true;

    return { cloudOutputView, cloudOutputWidth, cloudOutputHeight };
  }

  /**
   * Feed cloud texture and cirrus params to the cloud composite post-process effect.
   */
  feedCloudComposite(
    postProcessPipeline: PostProcessPipeline | null,
    cloudResult: CloudFrameResult | null,
    deltaTime: number,
    renderCtx: RenderContext,
  ): void {
    const cloudComposite = postProcessPipeline?.getEffect<CloudCompositeEffect>('cloudComposite');
    if (!cloudComposite) return;

    if (this._enabled && cloudResult?.cloudOutputView) {
      cloudComposite.setCloudTexture(
        cloudResult.cloudOutputView,
        cloudResult.cloudOutputWidth,
        cloudResult.cloudOutputHeight,
      );

      // Feed cirrus params (Phase 5)
      const weather = this.weatherManager.current;
      const windRad = (weather.windDirection * Math.PI) / 180;
      const cirrusSpeedMultiplier = 2.0;
      this.cirrusWindOffsetX += Math.sin(windRad) * weather.windSpeed * cirrusSpeedMultiplier * deltaTime * 0.00005;
      this.cirrusWindOffsetY += Math.cos(windRad) * weather.windSpeed * cirrusSpeedMultiplier * deltaTime * 0.00005;
      cloudComposite.setCirrusParams(weather.cirrusOpacity, this.cirrusWindOffsetX, this.cirrusWindOffsetY);
      cloudComposite.setInverseViewProj(renderCtx.inverseViewProjectionMatrix);
    } else {
      cloudComposite.setCloudTexture(null);
    }
  }

  /**
   * Get the current cloud output view (temporal filtered or raw)
   * for feeding to god ray effects.
   */
  getCloudOutputView(): GPUTextureView | null {
    if (!this._enabled || !this.cloudRayMarcher?.isReady) return null;
    return this.cloudTemporalFilter?.outputView ?? this.cloudRayMarcher.outputView;
  }

  // ========== Configuration ==========

  setConfig(config: Partial<CloudConfig>): void {
    if (config.enabled !== undefined) {
      // Note: caller must call setEnabled() separately with debug/postprocess refs
    }
    this.cloudRayMarcher?.setConfig(config);
  }

  getConfig(): CloudConfig | null {
    return this.cloudRayMarcher?.getConfig() ?? null;
  }

  // ========== Weather Preset Methods ==========

  setWeatherPreset(name: string, duration?: number): void {
    this.weatherManager.setPreset(name, duration);
  }

  jumpToWeatherPreset(name: string): void {
    this.weatherManager.jumpToPreset(name);
  }

  clearWeatherPreset(): void {
    this.weatherManager.clearPreset();
  }

  get activePreset(): string | null {
    return this.weatherManager.activePreset;
  }

  get isTransitioning(): boolean {
    return this.weatherManager.isTransitioning;
  }

  serializeWeatherState(): SerializedWeatherState {
    return this.weatherManager.serialize();
  }

  deserializeWeatherState(data: SerializedWeatherState): void {
    this.weatherManager.deserialize(data);
    // Sync the restored state to the cloud ray marcher
    if (this.cloudRayMarcher) {
      const weather = this.weatherManager.current;
      this.cloudRayMarcher.setConfig({
        coverage: weather.cloudCoverage,
        cloudType: weather.cloudType,
        density: weather.cloudDensity,
        cloudBase: weather.cloudBaseAltitude,
        cloudThickness: weather.cloudThickness,
        windSpeed: weather.windSpeed,
        windDirection: weather.windDirection,
      });
    }
  }

  // ========== Resize ==========

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    if (this.cloudRayMarcher) {
      this.cloudRayMarcher.resize(width, height);
      if (this.cloudTemporalFilter) {
        const halfW = this.cloudRayMarcher.outputWidth;
        const halfH = this.cloudRayMarcher.outputHeight;
        this.cloudTemporalFilter.resize(halfW, halfH, width, height);
      }
    }
  }

  // ========== GPU Timestamp Profiling ==========

  private initTimestampQueries(): void {
    if (!this.ctx.device.features.has('timestamp-query')) {
      this.timestampSupported = false;
      return;
    }

    try {
      this.timestampQuerySet = this.ctx.device.createQuerySet({
        type: 'timestamp',
        count: 4,
      });

      this.timestampBuffer = this.ctx.device.createBuffer({
        label: 'cloud-timestamp-buffer',
        size: 4 * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });

      this.timestampReadBuffer = this.ctx.device.createBuffer({
        label: 'cloud-timestamp-read-buffer',
        size: 4 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      this.timestampSupported = true;
    } catch {
      this.timestampSupported = false;
    }
  }

  getCloudTimings(): { raymarch: number; temporal: number; total: number } | null {
    if (!this.timestampSupported) return null;
    return { ...this._cloudTimings };
  }

  // ========== Destroy ==========

  destroy(): void {
    this.cloudRayMarcher?.destroy();
    this.cloudShadowGenerator?.destroy();
    this.cloudTemporalFilter?.destroy();
    this.timestampQuerySet?.destroy();
    this.timestampBuffer?.destroy();
    this.timestampReadBuffer?.destroy();
  }
}
