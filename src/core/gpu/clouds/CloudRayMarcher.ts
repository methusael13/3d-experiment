/**
 * CloudRayMarcher — Compute pipeline for volumetric cloud ray marching
 *
 * Dispatches a compute shader that marches rays through the cloud layer,
 * sampling 3D noise and weather map textures. Outputs an rgba16float texture
 * with (scatteredLight.rgb, transmittance) that the CloudCompositeEffect
 * blends into the scene.
 *
 * Phase 3: Half-resolution rendering, checkerboard pattern, blue noise
 *          dithering, and frame counter for temporal reprojection.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { CloudNoiseGenerator } from './CloudNoiseGenerator';
import { WeatherMapGenerator } from './WeatherMapGenerator';
import { CLOUD_UNIFORM_SIZE, EARTH_RADIUS, type CloudConfig, DEFAULT_CLOUD_CONFIG } from './types';

import raymarchShader from '../shaders/clouds/cloud-raymarch.wgsl?raw';
import { Logger } from '@/core/utils/logger';

export class CloudRayMarcher {
  private ctx: GPUContext;
  private noiseGen: CloudNoiseGenerator;
  private weatherGen: WeatherMapGenerator;

  // Config
  private config: CloudConfig = { ...DEFAULT_CLOUD_CONFIG };

  // Output texture (half-resolution)
  private _outputTexture: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;
  private halfWidth = 0;
  private halfHeight = 0;

  // Full viewport dimensions (for uniform upload)
  private fullWidth = 0;
  private fullHeight = 0;

  // Pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer
  private uniformBuffer: GPUBuffer | null = null;

  // Wind-driven weather map offset
  private _weatherOffsetX = 0;
  private _weatherOffsetZ = 0;

  // Frame counter (shared with temporal filter for checkerboard sync)
  private _frameIndex = 0;

  // When true, force-disable checkerboard in the shader regardless of config.
  // Set this when the temporal filter is not running, because without temporal
  // fill the same pixels are permanently skipped causing radial streaking
  // during camera translation (FPS/player mode).
  private _forceDisableCheckerboard = false;

  // Blue noise texture view (set externally by pipeline from CloudTemporalFilter)
  private _blueNoiseView: GPUTextureView | null = null;

  // Fallback 1×1 blue noise texture (used when temporal filter not yet initialized)
  private fallbackBlueNoise: GPUTexture | null = null;
  private fallbackBlueNoiseView: GPUTextureView | null = null;

  private _logger = new Logger('CloudRayMarcher', 2000);

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

  /** Half-resolution output width */
  get outputWidth(): number { return this.halfWidth; }
  /** Half-resolution output height */
  get outputHeight(): number { return this.halfHeight; }

  getConfig(): CloudConfig { return { ...this.config }; }

  setConfig(config: Partial<CloudConfig>): void {
    Object.assign(this.config, config);
    // Regenerate weather map when coverage/type changes
    if (config.coverage !== undefined || config.cloudType !== undefined) {
      this.weatherGen.generate(this.config.coverage, this.config.cloudType);
    }
  }

  /** Set the blue noise texture view from CloudTemporalFilter */
  setBlueNoiseView(view: GPUTextureView | null): void {
    this._blueNoiseView = view;
  }

  /** Set the frame index (synced from CloudTemporalFilter) */
  setFrameIndex(index: number): void {
    this._frameIndex = index;
  }

  /**
   * Force-disable checkerboard rendering regardless of config.temporalReprojection.
   * Call with `true` when the temporal filter is not running — without temporal
   * fill the same pixels are permanently skipped, causing radial streaking
   * artifacts during camera translation (FPS/player mode).
   */
  setForceDisableCheckerboard(disable: boolean): void {
    this._forceDisableCheckerboard = disable;
  }

  // ========== Initialization ==========

  /**
   * Initialize the ray marcher with half-resolution output.
   * @param fullWidth  Full viewport width
   * @param fullHeight Full viewport height
   */
  init(fullWidth: number, fullHeight: number): void {
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
    this.halfWidth = Math.ceil(fullWidth / 2);
    this.halfHeight = Math.ceil(fullHeight / 2);

    const device = this.ctx.device;

    // Generate noise textures (one-time)
    this.noiseGen.generate();

    // Generate initial weather map
    this.weatherGen.generate(this.config.coverage, this.config.cloudType);

    // Create output texture (half-res)
    this.createOutputTexture();

    // Create fallback 1×1 blue noise texture
    this.createFallbackBlueNoise();

    // Bind group layout (Phase 3: added binding 6 for blue noise)
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cloud-raymarch-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
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
      size: { width: this.halfWidth, height: this.halfHeight },
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._outputView = this._outputTexture.createView({ label: 'cloud-raymarch-output-view' });
  }

  /** Create a 1×1 fallback blue noise texture for when temporal filter isn't ready */
  private createFallbackBlueNoise(): void {
    this.fallbackBlueNoise = this.ctx.device.createTexture({
      label: 'cloud-fallback-blue-noise',
      size: { width: 1, height: 1 },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Write a single value (0.5)
    this.ctx.device.queue.writeTexture(
      { texture: this.fallbackBlueNoise },
      new Uint8Array([128]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );
    this.fallbackBlueNoiseView = this.fallbackBlueNoise.createView({ label: 'cloud-fallback-blue-noise-view' });
  }

  // ========== Resize ==========

  resize(fullWidth: number, fullHeight: number): void {
    const newHalfW = Math.ceil(fullWidth / 2);
    const newHalfH = Math.ceil(fullHeight / 2);
    if (this.halfWidth === newHalfW && this.halfHeight === newHalfH) return;
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
    this.halfWidth = newHalfW;
    this.halfHeight = newHalfH;
    this.createOutputTexture();
  }

  // ========== Execute ==========

  /**
   * Dispatch the cloud ray march compute shader.
   * Call once per frame when clouds are enabled.
   */
  execute(
    encoder: GPUCommandEncoder,
    inverseViewProjectionMatrix: Float32Array,
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
      inverseViewProjectionMatrix, cameraPosition,
      sunDirection, sunColor, sunIntensity,
      time, near, far,
    );

    // Use the real blue noise texture if available, otherwise fallback
    const blueNoise = this._blueNoiseView ?? this.fallbackBlueNoiseView!;

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
        { binding: 6, resource: blueNoise },
      ],
    });

    // Dispatch compute (half-resolution)
    const pass = encoder.beginComputePass({ label: 'cloud-raymarch-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    // workgroup_size(8, 8, 1)
    const wgX = Math.ceil(this.halfWidth / 8);
    const wgY = Math.ceil(this.halfHeight / 8);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();
  }

  // ========== Uniform Upload ==========

  private uploadUniforms(
    inverseViewProjectionMatrix: Float32Array,
    cameraPosition: [number, number, number],
    sunDirection: [number, number, number],
    sunColor: [number, number, number],
    sunIntensity: number,
    time: number,
    near: number,
    far: number,
  ): void {
    const data = new Float32Array(CLOUD_UNIFORM_SIZE / 4);
    const uintView = new Uint32Array(data.buffer);

    data.set(new Float32Array(inverseViewProjectionMatrix), 0);

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

    // resolution (half-res) + earthRadius + frameIndex (offset 36)
    uintView[36] = this.halfWidth;
    uintView[37] = this.halfHeight;
    data[38] = EARTH_RADIUS;
    uintView[39] = this._frameIndex;

    // fullResolution + checkerboard + pad (offset 40)
    uintView[40] = this.fullWidth;
    uintView[41] = this.fullHeight;
    // Checkerboard is only useful when the temporal filter is running to fill
    // in the skipped pixels.  Without it, the same 50% of pixels are permanently
    // empty, causing radial streak artifacts during camera translation.
    const checkerboardActive = this.config.temporalReprojection && !this._forceDisableCheckerboard;
    uintView[42] = checkerboardActive ? 1 : 0;
    data[43] = 0; // _pad1

    this.ctx.device.queue.writeBuffer(this.uniformBuffer!, 0, data);
  }

  // ========== Cleanup ==========

  destroy(): void {
    this._outputTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.fallbackBlueNoise?.destroy();
    this.noiseGen.destroy();
    this.weatherGen.destroy();
    this._outputTexture = null;
    this._outputView = null;
    this.uniformBuffer = null;
    this.fallbackBlueNoise = null;
    this.fallbackBlueNoiseView = null;
  }
}
