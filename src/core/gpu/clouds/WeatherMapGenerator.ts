/**
 * WeatherMapGenerator — Generates 2D procedural weather map for cloud coverage
 *
 * Produces a 512×512 rgba8unorm texture:
 *   R: Cloud coverage (0 = clear, 1 = overcast)
 *   G: Cloud type (0 = stratus, 1 = cumulus)
 *   B: Precipitation (0 = none, 1 = heavy)
 *   A: Reserved
 *
 * Regenerated when coverage/type parameters change.
 * Wind-driven UV scrolling is applied per-frame in the ray march shader.
 */

import { GPUContext } from '../GPUContext';
import { WEATHER_MAP_SIZE } from './types';

import weatherMapShader from '../shaders/clouds/weather-map.wgsl?raw';

export class WeatherMapGenerator {
  private ctx: GPUContext;

  // Output texture
  private _texture: GPUTexture | null = null;
  private _textureView: GPUTextureView | null = null;

  // Pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer (16 bytes)
  private uniformBuffer: GPUBuffer | null = null;

  // Cached parameters (to avoid regeneration when unchanged)
  private lastCoverage = -1;
  private lastCloudType = -1;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.init();
  }

  // ========== Accessors ==========

  get textureView(): GPUTextureView | null { return this._textureView; }

  // ========== Initialization ==========

  private init(): void {
    const device = this.ctx.device;

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'weather-map-bgl',
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
            viewDimension: '2d',
          },
        },
      ],
    });

    // Pipeline
    const module = device.createShaderModule({
      label: 'weather-map-shader',
      code: weatherMapShader,
    });
    this.pipeline = device.createComputePipeline({
      label: 'weather-map-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module, entryPoint: 'main' },
    });

    // Uniform buffer: { size: u32, coverage: f32, cloudType: f32, seed: f32 }
    this.uniformBuffer = device.createBuffer({
      label: 'weather-map-uniform',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create output texture
    this._texture = device.createTexture({
      label: 'weather-map',
      size: { width: WEATHER_MAP_SIZE, height: WEATHER_MAP_SIZE },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._textureView = this._texture.createView({ label: 'weather-map-view' });
  }

  // ========== Generation ==========

  /**
   * Generate or regenerate the weather map.
   * Only dispatches compute if parameters have changed.
   */
  generate(coverage: number, cloudType: number, seed: number = 42): void {
    // Quantize to avoid regeneration from tiny slider movements
    const qCoverage = Math.round(coverage * 100) / 100;
    const qType = Math.round(cloudType * 100) / 100;

    if (qCoverage === this.lastCoverage && qType === this.lastCloudType) {
      return; // No change
    }
    this.lastCoverage = qCoverage;
    this.lastCloudType = qType;

    this.dispatchGeneration(qCoverage, qType, seed);
  }

  /**
   * Force regeneration regardless of cached state.
   */
  forceGenerate(coverage: number, cloudType: number, seed: number = 42): void {
    this.lastCoverage = -1;
    this.lastCloudType = -1;
    this.generate(coverage, cloudType, seed);
  }

  private dispatchGeneration(coverage: number, cloudType: number, seed: number): void {
    const device = this.ctx.device;

    // Upload uniforms
    const data = new ArrayBuffer(16);
    const uintView = new Uint32Array(data);
    const floatView = new Float32Array(data);
    uintView[0] = WEATHER_MAP_SIZE;
    floatView[1] = coverage;
    floatView[2] = cloudType;
    floatView[3] = seed;
    device.queue.writeBuffer(this.uniformBuffer!, 0, data);

    // Create bind group
    const bindGroup = device.createBindGroup({
      label: 'weather-map-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this._textureView! },
      ],
    });

    // Dispatch
    const encoder = device.createCommandEncoder({ label: 'weather-map-encoder' });
    const pass = encoder.beginComputePass({ label: 'weather-map-pass' });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    // workgroup_size(8, 8, 1)
    const wg = Math.ceil(WEATHER_MAP_SIZE / 8);
    pass.dispatchWorkgroups(wg, wg);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  // ========== Cleanup ==========

  destroy(): void {
    this._texture?.destroy();
    this.uniformBuffer?.destroy();
    this._texture = null;
    this._textureView = null;
    this.uniformBuffer = null;
  }
}
