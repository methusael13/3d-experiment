/**
 * PostProcessManager - Manages the post-processing pipeline and all its effects.
 *
 * Owns:
 *  - PostProcessPipeline instance
 *  - Effect initialization (SSAO, Fog, Composite, Cloud Composite, God Rays)
 *  - Per-frame effect feeding (fog sun data, god ray sun data, CSM/cloud shadow resources)
 *  - Public configuration API for each effect
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { ShadowRendererGPU } from '../renderers';
import {
  PostProcessPipeline,
  SSAOEffect,
  CompositeEffect,
  AtmosphericFogEffect,
  CloudCompositeEffect,
  GodRayEffect,
  FroxelGodRayEffect,
  type SSAOEffectConfig,
  type CompositeEffectConfig,
  type AtmosphericFogConfig,
  type GodRayConfig,
  type EffectUniforms,
} from '../postprocess';
import type { RenderContext } from './RenderContext';
import type { RenderOptions } from './GPUForwardPipeline';
import type { CloudManager } from './CloudManager';

export class PostProcessManager {
  private ctx: GPUContext;
  private pipeline: PostProcessPipeline;

  constructor(ctx: GPUContext, width: number, height: number) {
    this.ctx = ctx;

    // Create post-processing pipeline
    this.pipeline = new PostProcessPipeline(ctx, width, height);

    // Add SSAO effect (order 100 - runs first, starts DISABLED)
    const ssaoEffect = new SSAOEffect({
      radius: 1.0,
      intensity: 1.5,
      bias: 0.025,
      samples: 16,
      blur: true,
    });
    ssaoEffect.enabled = false;
    this.pipeline.addEffect(ssaoEffect, 100);

    // Add Atmospheric Fog effect (order 150, starts DISABLED)
    const fogEffect = new AtmosphericFogEffect({
      enabled: false,
      visibilityDistance: 3000,
      hazeIntensity: 0.8,
      hazeScaleHeight: 800,
      heightFogEnabled: false,
      fogVisibilityDistance: 1500,
      fogMode: 'exp' as const,
      fogHeight: 0,
      fogHeightFalloff: 0.05,
      fogColor: [0.85, 0.88, 0.92],
      fogSunScattering: 0.3,
    });
    fogEffect.enabled = false;
    this.pipeline.addEffect(fogEffect, 150);

    // Add Composite effect (order 200 - ALWAYS enabled, tonemapping + gamma)
    const compositeEffect = new CompositeEffect(ctx.format, {
      tonemapping: 3, // ACES
      gamma: 2.2,
      exposure: 1.0,
    });
    this.pipeline.addEffect(compositeEffect, 200);

    // Add Cloud Composite effect (order 125, starts DISABLED)
    const cloudCompositeEffect = new CloudCompositeEffect();
    cloudCompositeEffect.enabled = false;
    this.pipeline.addEffect(cloudCompositeEffect, 125);

    // Add God Ray effect (order 130, screen-space mode, starts DISABLED)
    const godRayEffect = new GodRayEffect();
    godRayEffect.enabled = false;
    this.pipeline.addEffect(godRayEffect, 130);

    // Add Froxel God Ray effect (order 131, volumetric mode, starts DISABLED)
    const froxelGodRayEffect = new FroxelGodRayEffect();
    froxelGodRayEffect.enabled = false;
    this.pipeline.addEffect(froxelGodRayEffect, 131);
  }

  // ========== Pipeline Access ==========

  getPipeline(): PostProcessPipeline {
    return this.pipeline;
  }

  // ========== Per-Frame Execution ==========

  /**
   * Feed sun/light/cloud data to all effects and execute the post-processing pipeline.
   * Returns early if HDR is not enabled.
   */
  execute(
    renderCtx: RenderContext,
    mergedOptions: Required<RenderOptions>,
    sceneColorTexture: UnifiedGPUTexture,
    depthTextureCopy: UnifiedGPUTexture,
    outputView: GPUTextureView,
    time: number,
    deltaTime: number,
    nearPlane: number,
    farPlane: number,
    shadowRenderer: ShadowRendererGPU,
    cloudManager: CloudManager,
  ): void {
    // Ensure depth is copied for post-processing effects
    renderCtx.copyDepthForReading();

    // Compute inverse matrices for SSAO
    const inverseProjectionMatrix = mat4.create();
    mat4.invert(inverseProjectionMatrix, renderCtx.projectionMatrix as unknown as mat4);

    const inverseViewMatrix = mat4.create();
    mat4.invert(inverseViewMatrix, renderCtx.viewMatrix as unknown as mat4);

    // Build effect uniforms
    const effectUniforms: EffectUniforms = {
      near: nearPlane,
      far: farPlane,
      width: renderCtx.width,
      height: renderCtx.height,
      time,
      deltaTime,
      projectionMatrix: renderCtx.projectionMatrix,
      inverseProjectionMatrix: new Float32Array(inverseProjectionMatrix),
      viewMatrix: renderCtx.viewMatrix,
      inverseViewMatrix: new Float32Array(inverseViewMatrix),
    };

    // Compute normalized sun direction (shared by fog + god rays)
    const lightDir = mergedOptions.lightDirection;
    const len = Math.sqrt(lightDir[0] * lightDir[0] + lightDir[1] * lightDir[1] + lightDir[2] * lightDir[2]);
    const sunDir: [number, number, number] = len > 0
      ? [lightDir[0] / len, lightDir[1] / len, lightDir[2] / len]
      : [0, 1, 0];

    // Feed sun data to atmospheric fog effect
    const fogEffect = this.pipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
    if (fogEffect) {
      fogEffect.setSunData(
        sunDir,
        mergedOptions.lightColor as [number, number, number],
        mergedOptions.sunIntensity,
      );
    }

    // Get sun visibility from ECS directional light
    const dirLightData = renderCtx.getDirectionalLight();

    // Feed sun data + cloud texture to screen-space god ray effect
    const godRayEffect = this.pipeline.getEffect<GodRayEffect>('godRays');
    if (godRayEffect) {
      godRayEffect.setSunData(
        sunDir,
        mergedOptions.lightColor as [number, number, number],
        mergedOptions.sunIntensity,
        dirLightData.sunIntensityFactor,
      );

      // Feed cloud texture for cloud occlusion in god rays
      const cloudView = cloudManager.getCloudOutputView();
      if (cloudManager.enabled && cloudView) {
        godRayEffect.setCloudTexture(
          cloudView,
          cloudManager.rayMarcher!.outputWidth,
          cloudManager.rayMarcher!.outputHeight,
        );
      } else {
        godRayEffect.setCloudTexture(null);
      }
    }

    // Feed sun data to froxel god ray effect (volumetric mode)
    const froxelGodRayEffect = this.pipeline.getEffect<FroxelGodRayEffect>('froxelGodRays');
    if (froxelGodRayEffect) {
      froxelGodRayEffect.setSunData(
        sunDir,
        mergedOptions.lightColor as [number, number, number],
        mergedOptions.sunIntensity,
        dirLightData.sunIntensityFactor,
      );

      // Feed CSM shadow resources for froxel shadow sampling
      if (shadowRenderer.isCSMEnabled()) {
        const csmArrayView = shadowRenderer.getShadowMapArrayView();
        if (csmArrayView) {
          froxelGodRayEffect.setCSMResources(csmArrayView, null);
        }
      } else {
        froxelGodRayEffect.setCSMResources(null, null);
      }

      // Feed cloud shadow resources
      if (cloudManager.enabled && cloudManager.shadowGenerator?.textureView) {
        const sr = mergedOptions.shadowRadius;
        froxelGodRayEffect.setCloudShadowResources(
          cloudManager.shadowGenerator.textureView,
          -sr, -sr, sr, sr,
        );
      } else {
        froxelGodRayEffect.setCloudShadowResources(null, 0, 0, 1, 1);
      }
    }

    // Execute post-processing pipeline
    this.pipeline.execute(
      renderCtx.encoder,
      sceneColorTexture,
      depthTextureCopy,
      outputView,
      effectUniforms
    );
  }

  // ========== SSAO ==========

  setSSAOEnabled(enabled: boolean): void {
    this.pipeline.setEnabled('ssao', enabled);
  }

  isSSAOEnabled(): boolean {
    return this.pipeline.isEnabled('ssao');
  }

  setSSAOConfig(config: Partial<SSAOEffectConfig>): void {
    const ssaoEffect = this.pipeline.getEffect<SSAOEffect>('ssao');
    ssaoEffect?.setConfig(config);
  }

  getSSAOConfig(): SSAOEffectConfig | null {
    const ssaoEffect = this.pipeline.getEffect<SSAOEffect>('ssao');
    return ssaoEffect?.getConfig() ?? null;
  }

  // ========== Composite ==========

  setCompositeConfig(config: Partial<CompositeEffectConfig>): void {
    const compositeEffect = this.pipeline.getEffect<CompositeEffect>('composite');
    compositeEffect?.setConfig(config);
  }

  getCompositeConfig(): CompositeEffectConfig | null {
    const compositeEffect = this.pipeline.getEffect<CompositeEffect>('composite');
    return compositeEffect?.getConfig() ?? null;
  }

  // ========== Atmospheric Fog ==========

  setAtmosphericFogEnabled(enabled: boolean): void {
    this.pipeline.setEnabled('atmosphericFog', enabled);
  }

  isAtmosphericFogEnabled(): boolean {
    return this.pipeline.isEnabled('atmosphericFog');
  }

  setAtmosphericFogConfig(config: Partial<AtmosphericFogConfig>): void {
    const fogEffect = this.pipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
    fogEffect?.setConfig(config);
  }

  getAtmosphericFogConfig(): AtmosphericFogConfig | null {
    const fogEffect = this.pipeline.getEffect<AtmosphericFogEffect>('atmosphericFog');
    return fogEffect?.getConfig() ?? null;
  }

  // ========== God Rays ==========

  setGodRaysEnabled(enabled: boolean): void {
    this.pipeline.setEnabled('godRays', enabled);
  }

  isGodRaysEnabled(): boolean {
    return this.pipeline.isEnabled('godRays');
  }

  setGodRayConfig(config: Partial<GodRayConfig> & { mode?: 'screen-space' | 'volumetric' }): void {
    const pp = this.pipeline;

    // Handle mode switching
    if (config.mode !== undefined) {
      const enabled = config.enabled ?? (this.isGodRaysEnabled() || pp.isEnabled('froxelGodRays'));
      if (config.mode === 'screen-space') {
        pp.setEnabled('godRays', enabled);
        pp.setEnabled('froxelGodRays', false);
      } else {
        pp.setEnabled('godRays', false);
        pp.setEnabled('froxelGodRays', enabled);
      }
    } else if (config.enabled !== undefined) {
      const isVolMode = pp.isEnabled('froxelGodRays');
      if (isVolMode) {
        pp.setEnabled('froxelGodRays', config.enabled);
      } else {
        pp.setEnabled('godRays', config.enabled);
      }
    }

    // Forward shared params to screen-space effect
    const godRayEffect = pp.getEffect<GodRayEffect>('godRays');
    godRayEffect?.setConfig(config);

    // Forward intensity to froxel effect
    const froxelEffect = pp.getEffect<FroxelGodRayEffect>('froxelGodRays');
    if (froxelEffect && config.intensity !== undefined) {
      froxelEffect.setIntensity(config.intensity);
    }
  }

  getGodRayConfig(): GodRayConfig | null {
    const godRayEffect = this.pipeline.getEffect<GodRayEffect>('godRays');
    return godRayEffect?.getConfig() ?? null;
  }

  // ========== Resize ==========

  resize(width: number, height: number): void {
    this.pipeline.resize(width, height);
  }

  // ========== Destroy ==========

  destroy(): void {
    this.pipeline.destroy();
  }
}
