/**
 * FogDensityInjector — Compute pipeline for froxel fog density injection (Pass 1)
 *
 * Writes fog extinction into each froxel from:
 *  - Global height fog
 *  - 3D noise modulation
 *  - Local fog volume emitters
 */

import type { GPUContext } from '../GPUContext';
import type { FroxelGrid } from './FroxelGrid';
import type { VolumetricFogConfig, FogVolumeDescriptor } from './types';
import { FROXEL_WIDTH, FROXEL_HEIGHT, FROXEL_DEPTH, MAX_FOG_VOLUMES, FOG_VOLUME_GPU_STRIDE } from './types';
import densityShader from '../shaders/volumetric/fog-density-inject.wgsl?raw';

/** Uniform buffer size: must match DensityUniforms in WGSL (128 bytes, 32 floats) */
const DENSITY_UNIFORM_SIZE = 128;

export class FogDensityInjector {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private fogVolumeBuffer: GPUBuffer | null = null;

  // Placeholder 3D noise texture (1×1×1 white noise — replaced when noise enabled)
  private placeholderNoise: GPUTexture | null = null;
  private placeholderNoiseView: GPUTextureView | null = null;
  private noiseSampler: GPUSampler | null = null;

  // External 3D noise texture (set when noise is enabled, e.g. reuse cloud detail noise)
  private _noiseView: GPUTextureView | null = null;

  // Wind offset accumulators
  private windOffsetX = 0;
  private windOffsetY = 0;
  private windOffsetZ = 0;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.createPipeline();
    this.createBuffers();
    this.createPlaceholderNoise();
  }

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'fog-density-inject-module',
      code: densityShader,
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'fog-density-inject-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private createBuffers(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'fog-density-uniforms',
      size: DENSITY_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.fogVolumeBuffer = this.ctx.device.createBuffer({
      label: 'fog-volumes-storage',
      size: Math.max(FOG_VOLUME_GPU_STRIDE * MAX_FOG_VOLUMES, 64),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private createPlaceholderNoise(): void {
    this.placeholderNoise = this.ctx.device.createTexture({
      label: 'fog-placeholder-noise-3d',
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      format: 'r8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.placeholderNoiseView = this.placeholderNoise.createView({ dimension: '3d' });

    // Fill with 0.5 (neutral density modulation)
    const data = new Uint8Array(8).fill(128);
    this.ctx.device.queue.writeTexture(
      { texture: this.placeholderNoise },
      data,
      { bytesPerRow: 2, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 2 },
    );

    this.noiseSampler = this.ctx.device.createSampler({
      label: 'fog-noise-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
  }

  /** Set external 3D noise texture (e.g. cloud detail noise) */
  setNoiseTexture(view: GPUTextureView | null): void {
    this._noiseView = view;
  }

  /** Update wind offset for noise animation */
  updateWindOffset(windDirX: number, windDirZ: number, windSpeed: number, deltaTime: number): void {
    const scale = 0.5;
    this.windOffsetX += windDirX * windSpeed * deltaTime * scale;
    this.windOffsetY += 0;
    this.windOffsetZ += windDirZ * windSpeed * deltaTime * scale;
  }

  execute(
    encoder: GPUCommandEncoder,
    grid: FroxelGrid,
    config: VolumetricFogConfig,
    inverseViewProj: Float32Array,
    cameraPosition: [number, number, number],
    near: number,
    far: number,
    time: number,
    fogVolumes: FogVolumeDescriptor[],
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.fogVolumeBuffer) return;

    // Upload uniforms
    const data = new Float32Array(DENSITY_UNIFORM_SIZE / 4);
    data.set(new Float32Array(inverseViewProj.buffer, inverseViewProj.byteOffset, 16), 0);
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = near;
    data[20] = far;
    data[21] = config.fogHeight;
    data[22] = config.fogHeightFalloff;
    data[23] = config.fogBaseDensity;
    data[24] = config.noiseEnabled ? 1.0 : 0.0;
    data[25] = config.noiseScale;
    data[26] = config.noiseStrength;
    data[27] = time;
    data[28] = this.windOffsetX;
    data[29] = this.windOffsetY;
    data[30] = this.windOffsetZ;
    data[31] = Math.min(fogVolumes.length, MAX_FOG_VOLUMES);

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Upload fog volumes
    if (fogVolumes.length > 0) {
      const volData = new Float32Array(MAX_FOG_VOLUMES * (FOG_VOLUME_GPU_STRIDE / 4));
      const count = Math.min(fogVolumes.length, MAX_FOG_VOLUMES);
      for (let i = 0; i < count; i++) {
        const v = fogVolumes[i];
        const off = i * 16; // 16 floats per volume (64 bytes)
        // Position + shape
        volData[off + 0] = 0; // position set by caller (world transform)
        volData[off + 1] = 0;
        volData[off + 2] = 0;
        volData[off + 3] = v.shape === 'sphere' ? 0 : v.shape === 'box' ? 1 : 2;
        // Extents + density
        volData[off + 4] = 10; // default extents
        volData[off + 5] = 10;
        volData[off + 6] = 10;
        volData[off + 7] = v.density;
        // Color + falloff
        volData[off + 8] = v.color?.[0] ?? 1;
        volData[off + 9] = v.color?.[1] ?? 1;
        volData[off + 10] = v.color?.[2] ?? 1;
        volData[off + 11] = v.falloff;
      }
      this.ctx.device.queue.writeBuffer(this.fogVolumeBuffer, 0, volData.buffer, 0, count * FOG_VOLUME_GPU_STRIDE);
    }

    // Create bind group (bindings match shader: 0=uniforms, 1=density grid, 2=fog volumes)
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'fog-density-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: grid.densityStorageView },
        { binding: 2, resource: { buffer: this.fogVolumeBuffer } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'fog-density-inject-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      FROXEL_DEPTH,
    );
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.fogVolumeBuffer?.destroy();
    this.placeholderNoise?.destroy();
  }
}
