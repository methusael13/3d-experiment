/**
 * FroxelLightCuller — Light-to-froxel assignment compute pipeline (Phase 6b)
 *
 * For each froxel, determines which point and spot lights affect it.
 * Writes a FroxelLightList per froxel for the scattering pass to iterate.
 *
 * Uses a brute-force approach suitable for <32 lights per type.
 */

import type { GPUContext } from '../GPUContext';
import { FROXEL_WIDTH, FROXEL_HEIGHT, FROXEL_DEPTH, FROXEL_COUNT } from './types';
import cullShader from '../shaders/volumetric/froxel-light-cull.wgsl?raw';

const CULL_UNIFORM_SIZE = 96; // mat4(64) + vec3(12) + near(4) + far(4) + 3 pads(12) = 96

export class FroxelLightCuller {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.createPipeline();
    this.createBuffers();
  }

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'froxel-light-cull-module',
      code: cullShader,
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-light-cull-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private createBuffers(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-light-cull-uniforms',
      size: CULL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  execute(
    encoder: GPUCommandEncoder,
    froxelLightListBuffer: GPUBuffer,
    lightCountsBuffer: GPUBuffer,
    pointLightsBuffer: GPUBuffer,
    spotLightsBuffer: GPUBuffer,
    inverseViewProj: Float32Array,
    cameraPosition: [number, number, number],
    near: number,
    far: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer) return;

    // Upload uniforms
    const data = new Float32Array(CULL_UNIFORM_SIZE / 4);
    data.set(new Float32Array(inverseViewProj.buffer, inverseViewProj.byteOffset, 16), 0);
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = near;
    data[20] = far;

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-light-cull-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: lightCountsBuffer } },
        { binding: 2, resource: { buffer: pointLightsBuffer } },
        { binding: 3, resource: { buffer: spotLightsBuffer } },
        { binding: 4, resource: { buffer: froxelLightListBuffer } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'froxel-light-cull-pass' });
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
  }
}
