/**
 * FroxelScatteringPass — Compute pipeline for per-froxel light injection (Pass 2)
 *
 * Accumulates in-scattered light from directional (sun), point, and spot lights.
 * Uses CSM shadow maps for directional god rays, cloud shadow for cloud gaps,
 * and spot shadow atlas for spot light volumetric beams.
 */

import { mat4 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import type { FroxelGrid } from './FroxelGrid';
import type { VolumetricFogConfig } from './types';
import { FROXEL_WIDTH, FROXEL_HEIGHT, FROXEL_DEPTH, FROXEL_COUNT } from './types';
import scatterShader from '../shaders/volumetric/froxel-scattering.wgsl?raw';

/** Must match ScatterUniforms in WGSL (192 bytes, 48 floats) */
const SCATTER_UNIFORM_SIZE = 192;

/** FroxelLightList struct size: 2 u32 + 16 u32 + 16 u32 = 34 u32 = 136 bytes */
const FROXEL_LIGHT_LIST_STRIDE = 136;

export interface ScatteringSunData {
  direction: [number, number, number];
  color: [number, number, number];
  intensity: number;
  visibility: number;
}

export interface ScatteringShadowResources {
  csmShadowArrayView: GPUTextureView | null;
  /** GPU buffer containing CSM uniforms — bound directly to compute shader (no CPU copy needed) */
  csmUniformBuffer: GPUBuffer | null;
  cloudShadowView: GPUTextureView | null;
  cloudShadowBounds: [number, number, number, number]; // minX, minZ, maxX, maxZ
  cloudsEnabled: boolean;
  csmEnabled: boolean;
}

export interface ScatteringLightResources {
  lightCountsBuffer: GPUBuffer;
  pointLightsBuffer: GPUBuffer;
  spotLightsBuffer: GPUBuffer;
  spotShadowAtlasView: GPUTextureView;
  hasMultiLights: boolean;
}

export class FroxelScatteringPass {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private csmUniformBuffer: GPUBuffer | null = null;
  private froxelLightListBuffer: GPUBuffer | null = null;

  // Placeholder resources
  private placeholderDepthArray: GPUTexture | null = null;
  private placeholderDepthArrayView: GPUTextureView | null = null;
  private placeholderCloudShadow: GPUTexture | null = null;
  private placeholderCloudShadowView: GPUTextureView | null = null;
  private comparisonSampler: GPUSampler | null = null;
  private linearSampler: GPUSampler | null = null;

  // Bind group layouts (explicit for multi-group compute)
  private pipelineLayout: GPUPipelineLayout | null = null;
  private group0Layout: GPUBindGroupLayout | null = null;
  private group1Layout: GPUBindGroupLayout | null = null;
  private group2Layout: GPUBindGroupLayout | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.createPlaceholders();
    this.createBuffers();
    this.createLayouts();
    this.createPipeline();
  }

  private createPlaceholders(): void {
    this.placeholderDepthArray = this.ctx.device.createTexture({
      label: 'froxel-scatter-placeholder-depth-array',
      size: { width: 1, height: 1, depthOrArrayLayers: 4 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.placeholderDepthArrayView = this.placeholderDepthArray.createView({ dimension: '2d-array' });

    this.placeholderCloudShadow = this.ctx.device.createTexture({
      label: 'froxel-scatter-placeholder-cloud-shadow',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.placeholderCloudShadowView = this.placeholderCloudShadow.createView();

    // Write 1.0 transmittance
    const data = new Uint16Array(4);
    data[0] = 0x3C00; // 1.0 in float16
    this.ctx.device.queue.writeTexture(
      { texture: this.placeholderCloudShadow },
      data.buffer, { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );

    this.comparisonSampler = this.ctx.device.createSampler({
      label: 'froxel-scatter-comparison-sampler',
      compare: 'less', magFilter: 'linear', minFilter: 'linear',
    });

    this.linearSampler = this.ctx.device.createSampler({
      label: 'froxel-scatter-linear-sampler',
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });
  }

  private createBuffers(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-scatter-uniforms',
      size: SCATTER_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.csmUniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-scatter-csm-uniforms',
      size: 304, // 4 mat4 + 3 vec4
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Allocate froxel light list buffer
    this.froxelLightListBuffer = this.ctx.device.createBuffer({
      label: 'froxel-light-lists',
      size: FROXEL_COUNT * FROXEL_LIGHT_LIST_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private createLayouts(): void {
    // Group 0: Uniforms + density (read) + scatter (write)
    this.group0Layout = this.ctx.device.createBindGroupLayout({
      label: 'froxel-scatter-group0',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
      ],
    });

    // Group 1: Shadow resources
    this.group1Layout = this.ctx.device.createBindGroupLayout({
      label: 'froxel-scatter-group1',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });

    // Group 2: Light buffers + clustered assignment + spot shadow
    this.group2Layout = this.ctx.device.createBindGroupLayout({
      label: 'froxel-scatter-group2',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
      ],
    });

    this.pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'froxel-scatter-pipeline-layout',
      bindGroupLayouts: [this.group0Layout, this.group1Layout, this.group2Layout],
    });
  }

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'froxel-scatter-module',
      code: scatterShader,
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-scatter-pipeline',
      layout: this.pipelineLayout!,
      compute: { module, entryPoint: 'main' },
    });
  }

  /** Get the froxel light list buffer for the light culler to write into */
  get lightListBuffer(): GPUBuffer { return this.froxelLightListBuffer!; }

  execute(
    encoder: GPUCommandEncoder,
    grid: FroxelGrid,
    config: VolumetricFogConfig,
    inverseViewProj: Float32Array,
    cameraPosition: [number, number, number],
    near: number,
    far: number,
    sun: ScatteringSunData,
    shadows: ScatteringShadowResources,
    lights: ScatteringLightResources | null,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.csmUniformBuffer) return;

    // Upload uniforms
    const data = new Float32Array(SCATTER_UNIFORM_SIZE / 4);
    data.set(new Float32Array(inverseViewProj.buffer, inverseViewProj.byteOffset, 16), 0);
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = near;
    data[20] = far;
    data[21] = sun.visibility;
    data[22] = config.scatteringScale;
    data[23] = config.mieG;
    data[24] = sun.direction[0];
    data[25] = sun.direction[1];
    data[26] = sun.direction[2];
    data[27] = sun.intensity;
    data[28] = sun.color[0];
    data[29] = sun.color[1];
    data[30] = sun.color[2];
    data[31] = config.ambientFogIntensity;
    data[32] = 0.6; data[33] = 0.65; data[34] = 0.7; // ambient color (gray-blue)
    data[35] = shadows.cloudsEnabled ? 1.0 : 0.0;
    data[36] = shadows.cloudShadowBounds[0];
    data[37] = shadows.cloudShadowBounds[1];
    data[38] = shadows.cloudShadowBounds[2];
    data[39] = shadows.cloudShadowBounds[3];
    data[40] = shadows.csmEnabled ? 1.0 : 0.0;
    data[41] = config.fogColor[0];
    data[42] = config.fogColor[1];
    data[43] = config.fogColor[2];
    data[44] = lights?.hasMultiLights ? 1.0 : 0.0;

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Group 0: Uniforms + density read + scatter write
    const group0 = this.ctx.device.createBindGroup({
      label: 'froxel-scatter-group0-bg',
      layout: this.group0Layout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: grid.densityReadView },
        { binding: 2, resource: grid.scatterStorageView },
      ],
    });

    // Group 1: Shadow resources
    const group1 = this.ctx.device.createBindGroup({
      label: 'froxel-scatter-group1-bg',
      layout: this.group1Layout!,
      entries: [
        { binding: 0, resource: shadows.csmShadowArrayView ?? this.placeholderDepthArrayView! },
        { binding: 1, resource: this.comparisonSampler! },
        { binding: 2, resource: { buffer: shadows.csmUniformBuffer ?? this.csmUniformBuffer } },
        { binding: 3, resource: shadows.cloudShadowView ?? this.placeholderCloudShadowView! },
        { binding: 4, resource: this.linearSampler! },
      ],
    });

    // Group 2: Light buffers
    const placeholderUniform = this.uniformBuffer; // Reuse as placeholder
    const group2 = this.ctx.device.createBindGroup({
      label: 'froxel-scatter-group2-bg',
      layout: this.group2Layout!,
      entries: [
        { binding: 0, resource: { buffer: lights?.lightCountsBuffer ?? this.createPlaceholderLightCounts() } },
        { binding: 1, resource: { buffer: lights?.pointLightsBuffer ?? this.createPlaceholderStorage() } },
        { binding: 2, resource: { buffer: lights?.spotLightsBuffer ?? this.createPlaceholderStorage() } },
        { binding: 3, resource: { buffer: this.froxelLightListBuffer! } },
        { binding: 4, resource: lights?.spotShadowAtlasView ?? this.placeholderDepthArrayView! },
        { binding: 5, resource: this.comparisonSampler! },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'froxel-scattering-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.setBindGroup(2, group2);
    pass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      FROXEL_DEPTH,
    );
    pass.end();
  }

  // Placeholder helpers
  private _placeholderLightCounts: GPUBuffer | null = null;
  private _placeholderStorage: GPUBuffer | null = null;

  private createPlaceholderLightCounts(): GPUBuffer {
    if (!this._placeholderLightCounts) {
      this._placeholderLightCounts = this.ctx.device.createBuffer({
        label: 'froxel-scatter-placeholder-light-counts',
        size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    return this._placeholderLightCounts;
  }

  private createPlaceholderStorage(): GPUBuffer {
    if (!this._placeholderStorage) {
      this._placeholderStorage = this.ctx.device.createBuffer({
        label: 'froxel-scatter-placeholder-storage',
        size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    return this._placeholderStorage;
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.csmUniformBuffer?.destroy();
    this.froxelLightListBuffer?.destroy();
    this.placeholderDepthArray?.destroy();
    this.placeholderCloudShadow?.destroy();
    this._placeholderLightCounts?.destroy();
    this._placeholderStorage?.destroy();
  }
}
