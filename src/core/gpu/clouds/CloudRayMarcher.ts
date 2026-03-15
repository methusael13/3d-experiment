/**
 * CloudRayMarcher — Compute pipeline for volumetric cloud ray marching
 *
 * Dispatches a compute shader that marches rays through the cloud layer,
 * sampling 3D noise and weather map textures. Outputs an rgba16float texture
 * with (scatteredLight.rgb, transmittance) that the CloudCompositeEffect
 * blends into the scene.
 *
 * Phase 1: Full resolution, no temporal reprojection.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { CloudNoiseGenerator } from './CloudNoiseGenerator';
import { WeatherMapGenerator } from './WeatherMapGenerator';
import { CLOUD_UNIFORM_SIZE, EARTH_RADIUS, type CloudConfig, DEFAULT_CLOUD_CONFIG } from './types';

import raymarchShader from '../shaders/clouds/cloud-raymarch.wgsl?raw';

export class CloudRayMarcher {
  private ctx: GPUContext;
  private noiseGen: CloudNoiseGenerator;
  private weatherGen: WeatherMapGenerator;

  // Config
  private config: CloudConfig = { ...DEFAULT_CLOUD_CONFIG };

  // Output texture
  private _outputTexture: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;
  private width = 0;
  private height = 0;

  // Pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer
  private uniformBuffer: GPUBuffer | null = null;

  // Wind-driven weather map offset
  private _weatherOffsetX = 0;
  private _weatherOffsetZ = 0;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.noiseGen = new CloudNoiseGenerator(ctx);
    this.weatherGen = new WeatherMapGenerator(ctx);
  }

  // ========== Accessors ==========

  get outputView(): GPUTextureView | null { return this._outputView; }
  get noiseGenerator(): CloudNoiseGenerator { return this.noiseGen; }
  get weatherMapGenerator(): WeatherMapGenerator { return this.weatherGen; }
  get isReady(): boolean { return this.noiseGen.isReady && this._outputView !== null; }
  get currentWeatherOffsetX(): number { return this._weatherOffsetX; }
  get currentWeatherOffsetZ(): number { return this._weatherOffsetZ; }

  getConfig(): CloudConfig { return { ...this.config }; }

  setConfig(config: Partial<CloudConfig>): void {
    Object.assign(this.config, config);
    // Regenerate weather map when coverage/type changes
    if (config.coverage !== undefined || config.cloudType !== undefined) {
      this.weatherGen.generate(this.config.coverage, this.config.cloudType);
    }
  }

  // ========== Initialization ==========

  /**
   * Initialize the ray marcher. Must be called before execute().
   */
  init(width: number, height: number): void {
    this.width = width;
    this.height = height;

    const device = this.ctx.device;

    // Generate noise textures (one-time)
    this.noiseGen.generate();

    // Generate initial weather map
    this.weatherGen.generate(this.config.coverage, this.config.cloudType);

    // Create output texture
    this.createOutputTexture();

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cloud-raymarch-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });

    // Pipeline
    const module = device.createShaderModule({
      label: 'cloud-raymarch-shader',
      code: raymarchShader,
    });
    this.pipeline = device.createComputePipeline({
      label: 'cloud-raymarch-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module, entryPoint: 'main' },
    });

    // Uniform buffer
    this.uniformBuffer = device.createBuffer({
      label: 'cloud-raymarch-uniform',
      size: CLOUD_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private createOutputTexture(): void {
    this._outputTexture?.destroy();

    this._outputTexture = this.ctx.device.createTexture({
      label: 'cloud-raymarch-output',
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._outputView = this._outputTexture.createView({ label: 'cloud-raymarch-output-view' });
  }

  // ========== Resize ==========

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.createOutputTexture();
  }

  // ========== Execute ==========

  /**
   * Dispatch the cloud ray march compute shader.
   * Call once per frame when clouds are enabled.
   */
  execute(
    encoder: GPUCommandEncoder,
    viewMatrix: Float32Array,
    projectionMatrix: Float32Array,
    cameraPosition: [number, number, number],
    sunDirection: [number, number, number],
    sunColor: [number, number, number],
    sunIntensity: number,
    time: number,
    deltaTime: number,
    near: number,
    far: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this._outputView) return;
    if (!this.noiseGen.shapeNoiseView || !this.noiseGen.detailNoiseView) return;
    if (!this.weatherGen.textureView) return;

    // Update wind offset
    const windRad = (this.config.windDirection * Math.PI) / 180;
    const windDx = Math.sin(windRad) * this.config.windSpeed * deltaTime * 0.0001;
    const windDz = Math.cos(windRad) * this.config.windSpeed * deltaTime * 0.0001;
    this._weatherOffsetX += windDx;
    this._weatherOffsetZ += windDz;

    // Upload uniforms
    this.uploadUniforms(
      viewMatrix, projectionMatrix, cameraPosition,
      sunDirection, sunColor, sunIntensity,
      time, near, far,
    );

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'cloud-raymarch-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._outputView },
        { binding: 2, resource: this.noiseGen.shapeNoiseView },
        { binding: 3, resource: this.noiseGen.detailNoiseView },
        { binding: 4, resource: this.weatherGen.textureView },
        { binding: 5, resource: this.noiseGen.sampler! },
      ],
    });

    // Dispatch compute
    const pass = encoder.beginComputePass({ label: 'cloud-raymarch-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    // workgroup_size(8, 8, 1)
    const wgX = Math.ceil(this.width / 8);
    const wgY = Math.ceil(this.height / 8);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();
  }

  // ========== Uniform Upload ==========

  private uploadUniforms(
    viewMatrix: Float32Array,
    projectionMatrix: Float32Array,
    cameraPosition: [number, number, number],
    sunDirection: [number, number, number],
    sunColor: [number, number, number],
    sunIntensity: number,
    time: number,
    near: number,
    far: number,
  ): void {
    const data = new Float32Array(CLOUD_UNIFORM_SIZE / 4);

    // Compute inverse VP matrix
    const vp = mat4.create();
    mat4.multiply(vp, projectionMatrix as unknown as mat4, viewMatrix as unknown as mat4);
    const invVP = mat4.create();
    mat4.invert(invVP, vp);
    data.set(new Float32Array(invVP as unknown as ArrayBuffer), 0);

    // cameraPosition (offset 16)
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = time;

    // sunDirection (offset 20)
    data[20] = sunDirection[0];
    data[21] = sunDirection[1];
    data[22] = sunDirection[2];
    data[23] = sunIntensity;

    // sunColor (offset 24) + coverage
    data[24] = sunColor[0];
    data[25] = sunColor[1];
    data[26] = sunColor[2];
    data[27] = this.config.coverage;

    // cloud params (offset 28)
    data[28] = this.config.cloudBase;
    data[29] = this.config.cloudThickness;
    data[30] = this.config.density;
    data[31] = this.config.cloudType;

    // weatherOffset + near/far (offset 32)
    data[32] = this._weatherOffsetX;
    data[33] = this._weatherOffsetZ;
    data[34] = near;
    data[35] = far;

    // resolution + earthRadius (offset 36)
    // resolution is vec2u, need uint view
    const uintView = new Uint32Array(data.buffer);
    uintView[36] = this.width;
    uintView[37] = this.height;
    data[38] = EARTH_RADIUS;
    data[39] = 0; // _pad0

    this.ctx.device.queue.writeBuffer(this.uniformBuffer!, 0, data);
  }

  // ========== Cleanup ==========

  destroy(): void {
    this._outputTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.noiseGen.destroy();
    this.weatherGen.destroy();
    this._outputTexture = null;
    this._outputView = null;
    this.uniformBuffer = null;
  }
}
