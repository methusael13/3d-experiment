/**
 * FroxelTemporalFilter — Temporal reprojection for froxel grid (Pass 2.5)
 *
 * Smooths the froxel scattering result over time by blending with the
 * previous frame's reprojected result. Runs between scattering and integration.
 */

import type { GPUContext } from '../GPUContext';
import type { FroxelGrid } from './FroxelGrid';
import { FROXEL_WIDTH, FROXEL_HEIGHT, FROXEL_DEPTH } from './types';
import temporalShader from '../shaders/volumetric/froxel-temporal.wgsl?raw';

/** Must match TemporalUniforms in WGSL */
const TEMPORAL_UNIFORM_SIZE = 160; // 2 mat4 + vec3 + 4 floats = 40 floats × 4

export class FroxelTemporalFilter {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Previous frame's VP matrix (set externally each frame)
  private prevViewProjMatrix = new Float32Array(16);
  private hasPrevMatrix = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.createPipeline();
    this.createBuffers();
  }

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'froxel-temporal-module',
      code: temporalShader,
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-temporal-pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private createBuffers(): void {
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-temporal-uniforms',
      size: TEMPORAL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /** Set current VP matrix — call before execute each frame */
  setCurrentViewProj(vpMatrix: Float32Array): void {
    // Save for next frame's prevViewProj
    this.prevViewProjMatrix.set(vpMatrix);
    this.hasPrevMatrix = true;
  }

  get ready(): boolean {
    return this.hasPrevMatrix;
  }

  execute(
    encoder: GPUCommandEncoder,
    grid: FroxelGrid,
    inverseViewProj: Float32Array,
    cameraPosition: [number, number, number],
    near: number,
    far: number,
    temporalBlend: number,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.hasPrevMatrix) return;

    // Upload uniforms
    const data = new Float32Array(TEMPORAL_UNIFORM_SIZE / 4);
    // prevViewProj (mat4, offset 0)
    data.set(this.prevViewProjMatrix, 0);
    // inverseViewProj (mat4, offset 16)
    data.set(new Float32Array(inverseViewProj.buffer, inverseViewProj.byteOffset, 16), 16);
    // cameraPosition (vec3, offset 32)
    data[32] = cameraPosition[0];
    data[33] = cameraPosition[1];
    data[34] = cameraPosition[2];
    // near, far, temporalBlend (offset 35, 36, 37)
    data[35] = near;
    data[36] = far;
    data[37] = temporalBlend;

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // The temporal filter reads from current scatter + history, writes to a temp output.
    // We use the density grid's storage view as temp output (density pass is already done).
    // After temporal, we copy result back to scatter grid for integration.
    // Actually, let's use the scatter grid as output (the shader writes to outputScatter).
    // We read from scatter (current) + history, write to density (as temp).
    // Then swap: density becomes the new scatter for integration.

    // Simpler approach: use a dedicated output. The grid manages swapHistory().
    // Read current scatter → grid.scatterReadView
    // Read history → grid.historyReadView
    // Write output → grid.densityStorageView (reuse as temp — density is done)

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-temporal-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: grid.scatterReadView },
        { binding: 2, resource: grid.historyReadView },
        { binding: 3, resource: grid.densityStorageView }, // Reuse density as temp output
        { binding: 4, resource: grid.linearSampler },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'froxel-temporal-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      FROXEL_DEPTH,
    );
    pass.end();

    // After temporal: density texture now contains the temporally blended scatter result.
    // The integrator needs to read from "scatter" — so we need to swap.
    // Before next frame: save current scatter as history.
    grid.swapHistory();
    // Now: historyGrid = old scatterGrid (saved for next frame)
    //       scatterGrid = old historyGrid (available for reuse)
    // But the blended result is in densityGrid... we need integrator to read densityGrid.
    // This is a bit awkward. Let's just document that when temporal is enabled,
    // the integrator should read from densityReadView instead of scatterReadView.
  }

  /** Whether temporal output is in densityGrid (true) or scatterGrid (false) */
  get outputInDensityGrid(): boolean {
    return true; // Always writes to density grid as temp
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
