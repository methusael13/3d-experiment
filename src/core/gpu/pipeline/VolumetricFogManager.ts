/**
 * VolumetricFogManager — Orchestrates the froxel volumetric fog pipeline.
 *
 * Manages the full compute pass chain:
 *   1. Fog Density Injection (height fog + noise + local volumes)
 *   2. Light-to-Froxel Culling (point + spot lights)
 *   3. Per-Froxel Scattering (sun + point + spot + ambient)
 *   4. Temporal Reprojection (optional smoothing)
 *   5. Front-to-Back Integration
 *
 * The final integrated 3D texture is fed to VolumetricFogEffect (post-process)
 * which applies it to the scene color buffer.
 *
 * When enabled, auto-disables AtmosphericFogEffect (lightweight fallback).
 */

import { mat4 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import type { PostProcessPipeline } from '../postprocess/PostProcessPipeline';
import type { ShadowRendererGPU } from '../renderers';
import type { LightBufferManager } from '../renderers/LightBufferManager';
import type { DebugTextureManager } from '../renderers/DebugTextureManager';
import type { RenderContext } from './RenderContext';
import type { CloudManager } from './CloudManager';
import type { RenderOptions } from './GPUForwardPipeline';
import {
  FroxelGrid,
  FogDensityInjector,
  FroxelScatteringPass,
  FroxelIntegrator,
  FroxelTemporalFilter,
  FroxelLightCuller,
  VolumetricFogEffect,
  DEFAULT_VOLUMETRIC_FOG_CONFIG,
  type VolumetricFogConfig,
  type ScatteringSunData,
  type ScatteringShadowResources,
  type ScatteringLightResources,
  type FogVolumeDescriptor,
} from '../volumetric';
import { WindComponent } from '@/core/ecs';
import type { GlobalDistanceField } from '../sdf/GlobalDistanceField';

export class VolumetricFogManager {
  private ctx: GPUContext;
  private _enabled = false;
  private _config: VolumetricFogConfig = { ...DEFAULT_VOLUMETRIC_FOG_CONFIG };

  // Subsystems — lazily initialized on first enable
  private grid: FroxelGrid | null = null;
  private densityInjector: FogDensityInjector | null = null;
  private scatteringPass: FroxelScatteringPass | null = null;
  private integrator: FroxelIntegrator | null = null;
  private temporalFilter: FroxelTemporalFilter | null = null;
  private lightCuller: FroxelLightCuller | null = null;

  // Previous frame VP matrix for temporal reprojection
  private prevViewProjMatrix = new Float32Array(16);
  private hasPrevVP = false;

  // G4: Global Distance Field reference (set by GPUForwardPipeline each frame)
  private _gdf: GlobalDistanceField | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ========== Getters ==========

  get enabled(): boolean { return this._enabled; }
  get config(): VolumetricFogConfig { return { ...this._config }; }

  // ========== Enable / Disable ==========

  setEnabled(
    enabled: boolean,
    postProcessPipeline: PostProcessPipeline | null,
    debugTextureManager: DebugTextureManager | null,
  ): void {
    this._enabled = enabled;

    // Lazily initialize subsystems
    if (enabled && !this.grid) {
      this.grid = new FroxelGrid(this.ctx);
      this.grid.init();

      this.densityInjector = new FogDensityInjector(this.ctx);
      this.densityInjector.init();

      this.scatteringPass = new FroxelScatteringPass(this.ctx);
      this.scatteringPass.init();

      this.integrator = new FroxelIntegrator(this.ctx);
      this.integrator.init();

      this.temporalFilter = new FroxelTemporalFilter(this.ctx);
      this.temporalFilter.init();

      this.lightCuller = new FroxelLightCuller(this.ctx);
      this.lightCuller.init();

      // Register debug textures
      if (debugTextureManager) {
        debugTextureManager.register(
          'froxel-scatter',
          'float',
          () => this.grid?.scatterReadView ?? null,
        );
        debugTextureManager.register(
          'froxel-integrated',
          'float',
          () => this.grid?.integratedReadView ?? null,
        );
      }
    }

    // Enable/disable the post-process effect
    if (postProcessPipeline) {
      postProcessPipeline.setEnabled('volumetricFog', enabled);
      // Auto-disable AtmosphericFogEffect when volumetric fog is active
      if (enabled) {
        postProcessPipeline.setEnabled('atmosphericFog', false);
      }
    }
  }

  // ========== Configuration ==========

  setConfig(config: Partial<VolumetricFogConfig>): void {
    Object.assign(this._config, config);
  }

  getConfig(): VolumetricFogConfig {
    return { ...this._config };
  }

  // ========== G4: SDF Integration ==========

  /**
   * Set the Global Distance Field reference for fog-SDF integration (G4).
   * Called by GPUForwardPipeline each frame after GDF update.
   * When set, the density injector can sample SDF to:
   * - Zero fog density inside solid geometry
   * - Enhance density near surfaces (ground fog hugging)
   */
  setGDF(gdf: GlobalDistanceField | null): void {
    this._gdf = gdf;
    // Pass SDF resources to density injector for surface-aware fog
    if (this.densityInjector && gdf?.isReady) {
      this.densityInjector.setSDFResources(
        gdf.getSampleView(2),        // Coarse cascade (1024m) for fog — broadest coverage
        gdf.sampler,
        gdf.consumerUniformBuffer?.buffer ?? null,
      );
    } else if (this.densityInjector) {
      this.densityInjector.setSDFResources(null, null, null);
    }
  }

  // ========== Per-Frame Execution ==========

  /**
   * Execute the full froxel fog compute pipeline.
   * Called by GPUForwardPipeline before post-processing.
   */
  execute(
    encoder: GPUCommandEncoder,
    renderCtx: RenderContext,
    mergedOptions: Required<RenderOptions>,
    time: number,
    deltaTime: number,
    near: number,
    far: number,
    shadowRenderer: ShadowRendererGPU,
    cloudManager: CloudManager,
    lightBufferManager: LightBufferManager | null,
    postProcessPipeline: PostProcessPipeline | null,
  ): void {
    if (!this._enabled || !this.grid || !this.densityInjector || !this.scatteringPass || !this.integrator) return;

    const config = this._config;
    const inverseVP = renderCtx.inverseViewProjectionMatrix;
    const cameraPos: [number, number, number] = [
      renderCtx.cameraPosition[0],
      renderCtx.cameraPosition[1],
      renderCtx.cameraPosition[2],
    ];

    // Compute VP matrix for temporal
    const vp = new Float32Array(16);
    mat4.multiply(
      vp as unknown as mat4,
      renderCtx.projectionMatrix as unknown as mat4,
      renderCtx.viewMatrix as unknown as mat4,
    );

    // ===== Pass 1: Density Injection =====
    // Use WindComponent.displacement as wind direction + magnitude for fog drift.
    // displacement is the steady wind push vector — when wind strength/turbulence is 0,
    // displacement is [0,0] and fog stops moving.
    const windEntity = renderCtx.world?.queryFirst('wind');
    const windComp = windEntity?.getComponent<WindComponent>('wind');
    const disp = windComp?.displacement ?? [0, 0];
    const dispMag = Math.sqrt(disp[0] * disp[0] + disp[1] * disp[1]);
    // Use displacement directly as direction; magnitude drives speed.
    // When global wind is 0, displacement is 0 → fog is static.
    const fogDirX = dispMag > 0.001 ? disp[0] / dispMag : 0;
    const fogDirZ = dispMag > 0.001 ? disp[1] / dispMag : 0;
    const fogWindSpeed = dispMag * 10.0; // scale displacement to world-unit drift rate
    this.densityInjector.updateWindOffset(fogDirX, fogDirZ, fogWindSpeed, deltaTime);

    // No fog volumes yet (Phase 6c ECS integration will provide them)
    const fogVolumes: FogVolumeDescriptor[] = [];

    this.densityInjector.execute(
      encoder, this.grid, config,
      inverseVP, cameraPos, near, far, time,
      fogVolumes,
    );

    // ===== Pass 1.5: Light Culling (if multi-lights present) =====
    const lightBuffers = lightBufferManager?.getBuffers();
    const hasMultiLights = lightBufferManager?.hasMultiLights ?? false;

    if (hasMultiLights && this.lightCuller && lightBuffers) {
      this.lightCuller.execute(
        encoder,
        this.scatteringPass.lightListBuffer,
        lightBuffers.lightCountsBuffer,
        lightBuffers.pointLightsBuffer,
        lightBuffers.spotLightsBuffer,
        inverseVP, cameraPos, near, far,
      );
    }

    // ===== Pass 2: Scattering =====
    const dirLight = renderCtx.getDirectionalLight();
    const sunData: ScatteringSunData = {
      direction: dirLight.direction as [number, number, number],
      color: mergedOptions.lightColor as [number, number, number],
      intensity: mergedOptions.sunIntensity,
      visibility: dirLight.sunIntensityFactor,
    };

    // CSM shadow data: bind the GPU buffer directly (no CPU copy needed).
    // ShadowRendererGPU.getCSMUniformBuffer() returns a UnifiedGPUBuffer whose
    // .buffer property is the raw GPUBuffer we can bind to the compute shader.
    const csmEnabled = shadowRenderer.isCSMEnabled();
    const csmArrayView = csmEnabled ? shadowRenderer.getShadowMapArrayView() : null;
    const csmUniformBuf = csmEnabled ? shadowRenderer.getCSMUniformBuffer()?.buffer ?? null : null;

    const shadowResources: ScatteringShadowResources = {
      csmShadowArrayView: csmArrayView,
      csmUniformBuffer: csmUniformBuf,
      cloudShadowView: cloudManager.enabled ? cloudManager.shadowGenerator?.textureView ?? null : null,
      cloudShadowBounds: [
        -(mergedOptions.shadowRadius ?? 200),
        -(mergedOptions.shadowRadius ?? 200),
        mergedOptions.shadowRadius ?? 200,
        mergedOptions.shadowRadius ?? 200,
      ],
      cloudsEnabled: cloudManager.enabled,
      csmEnabled,
    };

    let lightResources: ScatteringLightResources | null = null;
    if (hasMultiLights && lightBuffers) {
      lightResources = {
        lightCountsBuffer: lightBuffers.lightCountsBuffer,
        pointLightsBuffer: lightBuffers.pointLightsBuffer,
        spotLightsBuffer: lightBuffers.spotLightsBuffer,
        spotShadowAtlasView: shadowRenderer.getSpotShadowAtlasView()!,
        hasMultiLights: true,
      };
    }

    this.scatteringPass.execute(
      encoder, this.grid, config,
      inverseVP, cameraPos, near, far,
      sunData, shadowResources, lightResources,
    );

    // ===== Pass 2.5: Temporal Reprojection (optional) =====
    if (config.temporalEnabled && this.temporalFilter && this.hasPrevVP) {
      this.temporalFilter.execute(
        encoder, this.grid,
        inverseVP, cameraPos, near, far,
        config.temporalBlend,
      );
    }

    // Save VP for next frame's temporal
    if (config.temporalEnabled && this.temporalFilter) {
      this.temporalFilter.setCurrentViewProj(vp);
    }
    this.prevViewProjMatrix.set(vp);
    this.hasPrevVP = true;

    // ===== Pass 3: Integration =====
    this.integrator.execute(encoder, this.grid, near, far);

    // ===== Feed integrated texture to post-process effect =====
    const fogEffect = postProcessPipeline?.getEffect<VolumetricFogEffect>('volumetricFog');
    if (fogEffect && this.grid) {
      fogEffect.setIntegratedGrid(this.grid.integratedReadView);
    }
  }

  // ========== Destroy ==========

  destroy(): void {
    this.grid?.destroy();
    this.densityInjector?.destroy();
    this.scatteringPass?.destroy();
    this.integrator?.destroy();
    this.temporalFilter?.destroy();
    this.lightCuller?.destroy();
  }
}
