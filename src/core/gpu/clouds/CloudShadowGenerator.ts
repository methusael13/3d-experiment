/**
 * CloudShadowGenerator — Generates a 2D cloud shadow map
 *
 * Projects cloud density along the sun direction onto a 1024×1024 texture.
 * Scene shaders sample this to apply soft cloud shadows on terrain, objects, and water.
 *
 * The shadow map is centered on the camera position and covers a configurable radius
 * (matching the CSM shadow radius for consistent coverage).
 */

import { GPUContext } from '../GPUContext';
import { CloudNoiseGenerator } from './CloudNoiseGenerator';
import { WeatherMapGenerator } from './WeatherMapGenerator';
import { EARTH_RADIUS, CLOUD_SHADOW_MAP_SIZE, CLOUD_SHADOW_UNIFORM_SIZE, type CloudConfig } from './types';

import shadowShader from '../shaders/clouds/cloud-shadow.wgsl?raw';

export class CloudShadowGenerator {
  private ctx: GPUContext;

  // Output texture
  private _texture: GPUTexture | null = null;
  private _textureView: GPUTextureView | null = null;

  // Pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer
  private uniformBuffer: GPUBuffer | null = null;

  // Cloud shadow uniforms buffer for scene shaders (binding 18)
  // Contains: shadowCenter.xy, shadowRadius, resolution — enough for UV mapping
  private _sceneUniformBuffer: GPUBuffer | null = null;

  // Shadow map sampler (linear filtering for soft shadows)
  private _sampler: GPUSampler | null = null;

  // Config
  private shadowRadius = 500; // world units half-extent

  // Average coverage (computed each frame for lighting adaptation)
  private _averageCoverage = 0;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ========== Accessors ==========

  get textureView(): GPUTextureView | null { return this._textureView; }
  get sampler(): GPUSampler | null { return this._sampler; }
  get sceneUniformBuffer(): GPUBuffer | null { return this._sceneUniformBuffer; }
  get averageCoverage(): number { return this._averageCoverage; }

  // ========== Initialization ==========

  init(): void {
    const device = this.ctx.device;

    // Create output texture (rgba16float to be compatible with storage texture)
    this._texture = device.createTexture({
      label: 'cloud-shadow-map',
      size: { width: CLOUD_SHADOW_MAP_SIZE, height: CLOUD_SHADOW_MAP_SIZE },
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._textureView = this._texture.createView({ label: 'cloud-shadow-map-view' });

    // Sampler for scene shaders
    this._sampler = device.createSampler({
      label: 'cloud-shadow-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cloud-shadow-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });

    // Pipeline
    const module = device.createShaderModule({
      label: 'cloud-shadow-shader',
      code: shadowShader,
    });
    this.pipeline = device.createComputePipeline({
      label: 'cloud-shadow-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module, entryPoint: 'main' },
    });

    // Uniform buffer (64 bytes — matches CloudShadowUniforms struct)
    this.uniformBuffer = device.createBuffer({
      label: 'cloud-shadow-uniform',
      size: CLOUD_SHADOW_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Scene uniform buffer (for scene shaders to convert world pos → shadow UV)
    // Layout: vec2f shadowCenter, f32 shadowRadius, f32 averageCoverage = 16 bytes
    this._sceneUniformBuffer = device.createBuffer({
      label: 'cloud-shadow-scene-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Set the shadow map coverage radius (should match CSM shadow radius)
   */
  setShadowRadius(radius: number): void {
    this.shadowRadius = radius;
  }

  // ========== Execute ==========

  /**
   * Generate cloud shadow map for the current frame.
   */
  execute(
    encoder: GPUCommandEncoder,
    noiseGen: CloudNoiseGenerator,
    weatherGen: WeatherMapGenerator,
    config: CloudConfig,
    sunDirection: [number, number, number],
    cameraPosition: [number, number, number],
    weatherOffsetX: number,
    weatherOffsetZ: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this._textureView) return;
    if (!noiseGen.shapeNoiseView || !noiseGen.sampler || !weatherGen.textureView) return;

    // Upload uniforms
    const data = new Float32Array(CLOUD_SHADOW_UNIFORM_SIZE / 4);
    data[0] = sunDirection[0];
    data[1] = sunDirection[1];
    data[2] = sunDirection[2];
    data[3] = config.density; // extinctionCoeff
    data[4] = config.cloudBase;
    data[5] = config.cloudThickness;
    data[6] = config.coverage;
    data[7] = config.cloudType;
    data[8] = weatherOffsetX;
    data[9] = weatherOffsetZ;
    data[10] = cameraPosition[0]; // shadowCenter X
    data[11] = cameraPosition[2]; // shadowCenter Z
    data[12] = this.shadowRadius;
    const uintView = new Uint32Array(data.buffer);
    uintView[13] = CLOUD_SHADOW_MAP_SIZE;
    data[14] = EARTH_RADIUS;
    data[15] = 0; // _pad0

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Update scene uniform buffer for scene shaders
    const sceneData = new Float32Array(4);
    sceneData[0] = cameraPosition[0]; // shadowCenter.x
    sceneData[1] = cameraPosition[2]; // shadowCenter.y (Z in world)
    sceneData[2] = this.shadowRadius;
    sceneData[3] = this._averageCoverage; // pass average coverage to scene shaders
    this.ctx.device.queue.writeBuffer(this._sceneUniformBuffer!, 0, sceneData);

    // Compute average coverage (simple 4×4 grid sample of weather map on CPU)
    // This is approximate — uses the coverage config value directly
    // A more accurate approach would readback the weather map, but this is sufficient
    this._averageCoverage = config.coverage;

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'cloud-shadow-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this._textureView },
        { binding: 2, resource: noiseGen.shapeNoiseView },
        { binding: 3, resource: weatherGen.textureView },
        { binding: 4, resource: noiseGen.sampler! },
      ],
    });

    // Dispatch compute
    const pass = encoder.beginComputePass({ label: 'cloud-shadow-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(CLOUD_SHADOW_MAP_SIZE / 8);
    pass.dispatchWorkgroups(wg, wg);
    pass.end();
  }

  // ========== Cleanup ==========

  destroy(): void {
    this._texture?.destroy();
    this.uniformBuffer?.destroy();
    this._sceneUniformBuffer?.destroy();
    this._texture = null;
    this._textureView = null;
    this.uniformBuffer = null;
    this._sceneUniformBuffer = null;
  }
}
