/**
 * CloudNoiseGenerator — Generates 3D noise textures for volumetric clouds
 *
 * Creates two 3D textures via compute shaders:
 * 1. Base shape noise (128³ rgba8unorm) — Perlin-Worley + 3 Worley octaves
 * 2. Detail erosion noise (32³ rgba8unorm) — 3 Worley frequencies + FBM combo
 *
 * Both are generated once at initialization and reused every frame.
 */

import { GPUContext } from '../GPUContext';
import { SHAPE_NOISE_SIZE, DETAIL_NOISE_SIZE } from './types';

import shapeNoiseShader from '../shaders/clouds/cloud-noise-gen.wgsl?raw';
import detailNoiseShader from '../shaders/clouds/cloud-detail-noise.wgsl?raw';

export class CloudNoiseGenerator {
  private ctx: GPUContext;

  // Output textures
  private _shapeNoiseTexture: GPUTexture | null = null;
  private _shapeNoiseView: GPUTextureView | null = null;
  private _detailNoiseTexture: GPUTexture | null = null;
  private _detailNoiseView: GPUTextureView | null = null;

  // Pipelines
  private shapePipeline: GPUComputePipeline | null = null;
  private detailPipeline: GPUComputePipeline | null = null;

  // Bind group layouts
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer
  private uniformBuffer: GPUBuffer | null = null;

  // Sampler (repeat + trilinear for 3D noise)
  private _sampler: GPUSampler | null = null;

  private generated = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.init();
  }

  // ========== Accessors ==========

  get shapeNoiseView(): GPUTextureView | null { return this._shapeNoiseView; }
  get detailNoiseView(): GPUTextureView | null { return this._detailNoiseView; }
  get sampler(): GPUSampler | null { return this._sampler; }
  get isReady(): boolean { return this.generated; }

  // ========== Initialization ==========

  private init(): void {
    const device = this.ctx.device;

    // Bind group layout: uniform + storage texture 3D
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cloud-noise-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '3d',
          },
        },
      ],
    });

    // Shape noise pipeline
    const shapeModule = device.createShaderModule({
      label: 'cloud-shape-noise-shader',
      code: shapeNoiseShader,
    });
    this.shapePipeline = device.createComputePipeline({
      label: 'cloud-shape-noise-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module: shapeModule, entryPoint: 'main' },
    });

    // Detail noise pipeline
    const detailModule = device.createShaderModule({
      label: 'cloud-detail-noise-shader',
      code: detailNoiseShader,
    });
    this.detailPipeline = device.createComputePipeline({
      label: 'cloud-detail-noise-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module: detailModule, entryPoint: 'main' },
    });

    // Uniform buffer (16 bytes: size u32, seed f32, 2x pad)
    this.uniformBuffer = device.createBuffer({
      label: 'cloud-noise-uniform',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create sampler (repeat + trilinear for 3D noise)
    this._sampler = device.createSampler({
      label: 'cloud-noise-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
  }

  // ========== Generation ==========

  /**
   * Generate both noise textures. Call once after construction.
   */
  generate(seed: number = 42.0): void {
    if (this.generated) return;

    this.generateShapeNoise(seed);
    this.generateDetailNoise(seed + 100);
    this.generated = true;
  }

  /**
   * Regenerate noise textures with a new seed.
   * Destroys existing textures and recreates them.
   */
  regenerate(seed: number): void {
    this.generated = false;
    this._shapeNoiseTexture?.destroy();
    this._detailNoiseTexture?.destroy();
    this._shapeNoiseTexture = null;
    this._shapeNoiseView = null;
    this._detailNoiseTexture = null;
    this._detailNoiseView = null;
    this.generate(seed);
  }

  private generateShapeNoise(seed: number): void {
    const device = this.ctx.device;
    const size = SHAPE_NOISE_SIZE;

    // Create 3D texture
    this._shapeNoiseTexture = device.createTexture({
      label: 'cloud-shape-noise-3d',
      size: { width: size, height: size, depthOrArrayLayers: size },
      format: 'rgba8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._shapeNoiseView = this._shapeNoiseTexture.createView({
      label: 'cloud-shape-noise-view',
      dimension: '3d',
    });

    // Upload uniforms
    const data = new ArrayBuffer(16);
    new Uint32Array(data, 0, 1)[0] = size;
    new Float32Array(data, 4, 1)[0] = seed;
    device.queue.writeBuffer(this.uniformBuffer!, 0, data);

    // Create bind group
    const bindGroup = device.createBindGroup({
      label: 'cloud-shape-noise-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this._shapeNoiseView },
      ],
    });

    // Dispatch
    const encoder = device.createCommandEncoder({ label: 'cloud-shape-noise-encoder' });
    const pass = encoder.beginComputePass({ label: 'cloud-shape-noise-pass' });
    pass.setPipeline(this.shapePipeline!);
    pass.setBindGroup(0, bindGroup);
    // workgroup_size(4,4,4) → dispatch size/4 in each dimension
    const wg = Math.ceil(size / 4);
    pass.dispatchWorkgroups(wg, wg, wg);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private generateDetailNoise(seed: number): void {
    const device = this.ctx.device;
    const size = DETAIL_NOISE_SIZE;

    // Create 3D texture
    this._detailNoiseTexture = device.createTexture({
      label: 'cloud-detail-noise-3d',
      size: { width: size, height: size, depthOrArrayLayers: size },
      format: 'rgba8unorm',
      dimension: '3d',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._detailNoiseView = this._detailNoiseTexture.createView({
      label: 'cloud-detail-noise-view',
      dimension: '3d',
    });

    // Upload uniforms
    const data = new ArrayBuffer(16);
    new Uint32Array(data, 0, 1)[0] = size;
    new Float32Array(data, 4, 1)[0] = seed;
    device.queue.writeBuffer(this.uniformBuffer!, 0, data);

    // Create bind group
    const bindGroup = device.createBindGroup({
      label: 'cloud-detail-noise-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this._detailNoiseView },
      ],
    });

    // Dispatch
    const encoder = device.createCommandEncoder({ label: 'cloud-detail-noise-encoder' });
    const pass = encoder.beginComputePass({ label: 'cloud-detail-noise-pass' });
    pass.setPipeline(this.detailPipeline!);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(size / 4);
    pass.dispatchWorkgroups(wg, wg, wg);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // ========== Cleanup ==========

  destroy(): void {
    this._shapeNoiseTexture?.destroy();
    this._detailNoiseTexture?.destroy();
    this.uniformBuffer?.destroy();
    this._shapeNoiseTexture = null;
    this._detailNoiseTexture = null;
    this._shapeNoiseView = null;
    this._detailNoiseView = null;
    this.uniformBuffer = null;
    this.generated = false;
  }
}
