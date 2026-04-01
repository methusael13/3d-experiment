/**
 * FroxelIntegrator — Compute pipeline for front-to-back ray integration (Pass 3)
 *
 * Walks each column of the froxel grid front-to-back, accumulating
 * in-scattered light and transmittance. The output integrated 3D texture
 * is sampled by the post-process apply pass.
 */

import type { GPUContext } from '../GPUContext';
import type { FroxelGrid } from './FroxelGrid';
import { FROXEL_WIDTH, FROXEL_HEIGHT } from './types';
import integrateShader from '../shaders/volumetric/froxel-integrate.wgsl?raw';

const INTEGRATE_UNIFORM_SIZE = 16; // 4 floats

export class FroxelIntegrator {
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
      label: 'froxel-integrate-module',
      code: integrateShader,
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-integrate-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private createBuffers(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-integrate-uniforms',
      size: INTEGRATE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  execute(
    encoder: GPUCommandEncoder,
    grid: FroxelGrid,
    near: number,
    far: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer) return;

    // Upload uniforms
    const data = new Float32Array(4);
    data[0] = near;
    data[1] = far;
    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-integrate-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: grid.scatterReadView },
        { binding: 2, resource: grid.integratedStorageView },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'froxel-integrate-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    // Each thread walks a full column (64 slices) — dispatch 160×90 threads
    pass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      1,
    );
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
