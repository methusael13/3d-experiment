/**
 * ProceduralTextureGenerator — GPU compute-based procedural texture generation
 *
 * Uses a compute shader to generate grayscale textures from various noise functions.
 * Outputs rgba8unorm textures compatible with the PBR material system.
 *
 * Usage:
 *   const gen = new ProceduralTextureGenerator(gpuContext);
 *   const texture = gen.generate(params);
 *   objectRenderer.setTextures(meshId, { metallicRoughness: texture });
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { UnifiedGPUTexture } from '../GPUTexture';
import proceduralTextureShader from '../shaders/procedural-texture.wgsl?raw';
import packMRShader from '../shaders/pack-metallic-roughness.wgsl?raw';

// ==================== Types ====================

/** Noise function types */
export type NoiseType =
  | 'perlin'
  | 'fbm'
  | 'voronoiF1'
  | 'voronoiF2'
  | 'voronoiEdge'
  | 'musgrave'
  | 'checker'
  | 'whiteNoise';

/** Noise type to shader index mapping */
const NOISE_TYPE_INDEX: Record<NoiseType, number> = {
  perlin: 0,
  fbm: 1,
  voronoiF1: 2,
  voronoiF2: 3,
  voronoiEdge: 4,
  musgrave: 5,
  checker: 6,
  whiteNoise: 7,
};

/** Texture resolution presets */
export type TextureResolution = 128 | 256 | 512;

/** Color ramp definition: 2 threshold stops with 4 output values */
export interface ColorRamp {
  /** First threshold position [0..1] */
  stopX: number;
  /** Second threshold position [0..1] */
  stopY: number;
  /** Output value at t=0 */
  val0: number;
  /** Output value at t=stopX */
  valX: number;
  /** Output value at t=stopY */
  valY: number;
  /** Output value at t=1 */
  val1: number;
}

/** Texture projection mode */
export type ProjectionMode = 'uv' | 'triplanar';

/** Full parameters for procedural texture generation */
export interface ProceduralTextureParams {
  noiseType: NoiseType;
  scale: number;
  octaves: number;
  lacunarity: number;
  persistence: number;
  seed: number;
  cellDensity: number;
  offsetX: number;
  offsetY: number;
  colorRamp: ColorRamp;
  resolution: TextureResolution;
  /** How the texture is projected onto geometry (default: 'uv') */
  projection: ProjectionMode;
  /** World-space tiling scale for triplanar mode (default: 1.0) */
  triplanarScale: number;
}

/** PBR texture target slots */
export type TextureTargetSlot = 'baseColor' | 'metallic' | 'roughness' | 'occlusion' | 'emissive';

/** Default parameters for a new procedural texture */
export const DEFAULT_PROCEDURAL_PARAMS: ProceduralTextureParams = {
  noiseType: 'fbm',
  scale: 4.0,
  octaves: 4,
  lacunarity: 2.0,
  persistence: 0.5,
  seed: 0,
  cellDensity: 8.0,
  offsetX: 0,
  offsetY: 0,
  colorRamp: {
    stopX: 0.33,
    stopY: 0.66,
    val0: 0.0,
    valX: 0.33,
    valY: 0.66,
    val1: 1.0,
  },
  resolution: 256,
  projection: 'uv',
  triplanarScale: 1.0,
};

// ==================== Generator ====================

/**
 * GPU compute pipeline for generating procedural textures.
 * Singleton-per-GPUContext pattern — create once, reuse for all textures.
 */
export class ProceduralTextureGenerator {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private paramBuffer: UnifiedGPUBuffer;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    // Create shader module
    const shaderModule = ctx.device.createShaderModule({
      label: 'procedural-texture-shader',
      code: proceduralTextureShader,
    });

    // Bind group layout:
    //   binding 0: storage texture (write-only rgba8unorm)
    //   binding 1: uniform buffer (Params struct)
    this.bindGroupLayout = ctx.device.createBindGroupLayout({
      label: 'procedural-texture-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Pipeline layout
    const pipelineLayout = ctx.device.createPipelineLayout({
      label: 'procedural-texture-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Compute pipeline
    this.pipeline = ctx.device.createComputePipeline({
      label: 'procedural-texture-pipeline',
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    // Params uniform buffer (matches Params struct: 5 × vec4 = 80 bytes)
    this.paramBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'procedural-texture-params',
      size: 80,
    });
  }

  /**
   * Generate a procedural texture from parameters.
   *
   * Returns a UnifiedGPUTexture (rgba8unorm) with mipmaps generated.
   * The texture is ready to be assigned to ObjectRendererGPU.setTextures().
   */
  generate(params: ProceduralTextureParams): UnifiedGPUTexture {
    const res = params.resolution;

    // Create output texture with mipmap support
    const texture = UnifiedGPUTexture.create2D(this.ctx, {
      label: `procedural-${params.noiseType}-${res}`,
      width: res,
      height: res,
      format: 'rgba8unorm',
      mipLevelCount: Math.floor(Math.log2(res)) + 1,
      storage: true,
      sampled: true,
      renderTarget: true, // needed for mipmap generation
      copyDst: false,
      copySrc: false,
    });

    // Write params to uniform buffer
    this.writeParams(params);

    // Storage textures require a single-mip view (mip level 0 only)
    const storageMip0View = texture.texture.createView({
      label: `procedural-${params.noiseType}-storage-mip0`,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    // Create bind group with the single-mip view for storage write
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'procedural-texture-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: storageMip0View },
        { binding: 1, resource: { buffer: this.paramBuffer.buffer } },
      ],
    });

    // Dispatch compute shader
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'procedural-texture-encoder',
    });

    const pass = encoder.beginComputePass({
      label: 'procedural-texture-pass',
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);

    const workgroups = Math.ceil(res / 8);
    pass.dispatchWorkgroups(workgroups, workgroups, 1);
    pass.end();

    this.ctx.queue.submit([encoder.finish()]);

    // Generate mipmaps
    texture.generateMipmaps(this.ctx);

    return texture;
  }

  /**
   * Write ProceduralTextureParams to the GPU uniform buffer.
   * Layout matches the Params struct in procedural-texture.wgsl (80 bytes = 20 floats).
   */
  private writeParams(params: ProceduralTextureParams): void {
    const data = new Float32Array(20);
    const u32View = new Uint32Array(data.buffer);

    // vec4: resolution, noiseType, octaves, _pad0
    u32View[0] = params.resolution;
    u32View[1] = NOISE_TYPE_INDEX[params.noiseType];
    u32View[2] = params.octaves;
    u32View[3] = 0; // pad

    // vec4: scale, lacunarity, persistence, seed
    data[4] = params.scale;
    data[5] = params.lacunarity;
    data[6] = params.persistence;
    data[7] = params.seed;

    // vec4: cellDensity, offsetX, offsetY, _pad1
    data[8] = params.cellDensity;
    data[9] = params.offsetX;
    data[10] = params.offsetY;
    data[11] = 0; // pad

    // vec4: stopX, stopY, val0, valX
    data[12] = params.colorRamp.stopX;
    data[13] = params.colorRamp.stopY;
    data[14] = params.colorRamp.val0;
    data[15] = params.colorRamp.valX;

    // vec4: valY, val1, _pad2, _pad3
    data[16] = params.colorRamp.valY;
    data[17] = params.colorRamp.val1;
    data[18] = 0; // pad
    data[19] = 0; // pad

    this.paramBuffer.write(this.ctx, data);
  }

  // ==================== Metallic-Roughness Packing ====================

  private packPipeline: GPUComputePipeline | null = null;
  private packBindGroupLayout: GPUBindGroupLayout | null = null;

  /**
   * Ensure the packing pipeline is created (lazy init).
   */
  private ensurePackPipeline(): void {
    if (this.packPipeline) return;

    const shaderModule = this.ctx.device.createShaderModule({
      label: 'pack-mr-shader',
      code: packMRShader,
    });

    this.packBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'pack-mr-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
      ],
    });

    const layout = this.ctx.device.createPipelineLayout({
      label: 'pack-mr-pipeline-layout',
      bindGroupLayouts: [this.packBindGroupLayout],
    });

    this.packPipeline = this.ctx.device.createComputePipeline({
      label: 'pack-mr-pipeline',
      layout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });
  }

  /**
   * Pack separate metallic and roughness grayscale textures into a single
   * metallicRoughness texture (R=0, G=roughness, B=metallic, A=1).
   *
   * If only one slot is set, the other uses a 1x1 white placeholder (value=1.0),
   * so the material uniform multiplier controls that channel directly.
   *
   * @returns A new UnifiedGPUTexture with proper channel packing + mipmaps.
   */
  packMetallicRoughness(
    metallicTex: UnifiedGPUTexture | null,
    roughnessTex: UnifiedGPUTexture | null,
    resolution: number,
  ): UnifiedGPUTexture {
    this.ensurePackPipeline();

    // Create 1x1 white placeholder for missing channel
    const whitePlaceholder = this.getWhitePlaceholder();

    const metalView = (metallicTex ?? whitePlaceholder).view;
    const roughView = (roughnessTex ?? whitePlaceholder).view;

    // Create output texture
    const output = UnifiedGPUTexture.create2D(this.ctx, {
      label: `packed-mr-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'rgba8unorm',
      mipLevelCount: Math.floor(Math.log2(resolution)) + 1,
      storage: true,
      sampled: true,
      renderTarget: true,
      copyDst: false,
      copySrc: false,
    });

    const outputMip0View = output.texture.createView({
      label: 'packed-mr-storage-mip0',
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'pack-mr-bind-group',
      layout: this.packBindGroupLayout!,
      entries: [
        { binding: 0, resource: metalView },
        { binding: 1, resource: roughView },
        { binding: 2, resource: outputMip0View },
      ],
    });

    const encoder = this.ctx.device.createCommandEncoder({ label: 'pack-mr-encoder' });
    const pass = encoder.beginComputePass({ label: 'pack-mr-pass' });
    pass.setPipeline(this.packPipeline!);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(resolution / 8);
    pass.dispatchWorkgroups(wg, wg, 1);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);

    output.generateMipmaps(this.ctx);
    return output;
  }

  private whitePlaceholder: UnifiedGPUTexture | null = null;

  private getWhitePlaceholder(): UnifiedGPUTexture {
    if (this.whitePlaceholder) return this.whitePlaceholder;

    const tex = this.ctx.device.createTexture({
      label: 'white-1x1',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.ctx.queue.writeTexture(
      { texture: tex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );

    this.whitePlaceholder = {
      texture: tex,
      view: tex.createView(),
      format: 'rgba8unorm',
      width: 1,
      height: 1,
      destroy: () => tex.destroy(),
    } as UnifiedGPUTexture;

    return this.whitePlaceholder;
  }

  /**
   * Destroy GPU resources
   */
  destroy(): void {
    this.paramBuffer.destroy();
    this.whitePlaceholder?.destroy();
  }
}