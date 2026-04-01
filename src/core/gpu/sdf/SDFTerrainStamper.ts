/**
 * SDFTerrainStamper - Stamps terrain heightmap into SDF 3D texture
 * 
 * For each XZ column of voxels, samples the terrain heightmap and
 * writes the signed distance (worldY - terrainHeight) into the SDF texture.
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer, UniformBuilder } from '../index';
import { ShaderModuleManager } from '../GPUShaderModule';
import type { SDFCascade, SDFTerrainStampParams } from './types';
import sdfTerrainSource from '../shaders/sdf/sdf-terrain.wgsl?raw';

export class SDFTerrainStamper {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private uniformBuilder: UniformBuilder;
  private sampler: GPUSampler | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    // TerrainSDFUniforms: center(3) + resolution(1) + extent(3) + voxelSize(1) + heightScale(1) + terrainWorldSize(1) + originX(1) + originZ(1) = 12 floats
    this.uniformBuilder = new UniformBuilder(12);
    this.initialize();
  }

  private initialize(): void {
    // Bind group layout: storage texture + uniforms + heightmap + sampler
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'sdf-terrain-stamp-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'non-filtering' } },
      ],
    });

    const shaderModule = ShaderModuleManager.getOrCreate(this.ctx, sdfTerrainSource, 'sdf-terrain-shader');

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'sdf-terrain-stamp-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'sdf-terrain-stamp-pipeline',
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'sdf-terrain-uniforms',
      size: 48, // 12 floats * 4 bytes
    });

    // Non-filtering sampler required for unfilterable-float (r32float) heightmap textures
    this.sampler = this.ctx.device.createSampler({
      label: 'sdf-terrain-heightmap-sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /**
   * Stamp terrain heightmap into an SDF cascade
   */
  stamp(
    encoder: GPUCommandEncoder,
    cascade: SDFCascade,
    params: SDFTerrainStampParams
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroupLayout || !this.sampler) return;

    const originX = params.terrainOrigin?.[0] ?? -(params.terrainWorldSize / 2);
    const originZ = params.terrainOrigin?.[1] ?? -(params.terrainWorldSize / 2);

    // Write uniforms matching TerrainSDFUniforms struct
    this.uniformBuilder.reset()
      .vec4(cascade.center[0], cascade.center[1], cascade.center[2], cascade.resolution)
      .vec4(cascade.extent[0], cascade.extent[1], cascade.extent[2], cascade.voxelSize)
      .vec4(params.heightScale, params.terrainWorldSize, originX, originZ);

    this.uniformBuffer.write(this.ctx, this.uniformBuilder.build());

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'sdf-terrain-stamp-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: cascade.storageView },
        { binding: 1, resource: { buffer: this.uniformBuffer.buffer } },
        { binding: 2, resource: params.heightmapView },
        { binding: 3, resource: this.sampler },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'sdf-terrain-stamp' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    // Dispatch one thread per XZ column: resolution × resolution
    const workgroups = Math.ceil(cascade.resolution / 8);
    pass.dispatchWorkgroups(workgroups, workgroups, 1);
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.sampler = null;
  }
}
