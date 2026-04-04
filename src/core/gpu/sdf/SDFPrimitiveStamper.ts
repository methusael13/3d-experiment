/**
 * SDFPrimitiveStamper - Stamps mesh primitives (boxes, spheres, capsules) into SDF
 * 
 * Phase G3: Takes a list of SDFPrimitive objects (collected from scene entities)
 * and stamps them into the SDF 3D texture via a compute shader. The shader reads
 * the existing SDF value (from terrain) and takes the min with each primitive's
 * signed distance, so primitives "add" to the field without erasing terrain.
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer, UniformBuilder } from '../index';
import { ShaderModuleManager } from '../GPUShaderModule';
import type { SDFCascade, SDFPrimitive } from './types';
import sdfPrimitivesSource from '../shaders/sdf/sdf-primitives.wgsl?raw';

/** Maximum number of primitives per stamp dispatch */
const MAX_PRIMITIVES = 256;
/** Bytes per packed primitive (2 vec4f = 32 bytes) */
const BYTES_PER_PRIMITIVE = 32;

export class SDFPrimitiveStamper {
  private ctx: GPUContext;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private primitiveBuffer: GPUBuffer | null = null;
  private uniformBuilder: UniformBuilder;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    // Uniforms: centerRes(4) + extentVoxel(4) + counts(4) = 12 floats
    this.uniformBuilder = new UniformBuilder(12);
    this.initialize();
  }

  private initialize(): void {
    // Bind group layout: read_write storage texture + uniforms + primitive storage buffer
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'sdf-primitives-stamp-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'read-write', format: 'r32float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    const shaderModule = ShaderModuleManager.getOrCreate(this.ctx, sdfPrimitivesSource, 'sdf-primitives-shader');

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'sdf-primitives-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'sdf-primitives-pipeline',
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'sdf-primitives-uniforms',
      size: 48, // 12 floats * 4 bytes
    });

    // Pre-allocate storage buffer for MAX_PRIMITIVES
    this.primitiveBuffer = this.ctx.device.createBuffer({
      label: 'sdf-primitives-storage',
      size: MAX_PRIMITIVES * BYTES_PER_PRIMITIVE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Stamp primitives into an SDF cascade.
   * Must be called AFTER terrain stamping so primitives min() with existing terrain SDF.
   */
  stamp(
    encoder: GPUCommandEncoder,
    cascade: SDFCascade,
    primitives: SDFPrimitive[]
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroupLayout || !this.primitiveBuffer) return;
    if (primitives.length === 0) return;

    const count = Math.min(primitives.length, MAX_PRIMITIVES);

    // Pack primitives into float32 array: 8 floats per primitive (2 vec4f)
    const data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) {
      const p = primitives[i];
      const typeId = p.type === 'sphere' ? 0 : p.type === 'box' ? 1 : 2;
      const off = i * 8;
      // vec4[0]: center.xyz, type
      data[off + 0] = p.center[0];
      data[off + 1] = p.center[1];
      data[off + 2] = p.center[2];
      data[off + 3] = typeId;
      // vec4[1]: extents.xyz, pad
      data[off + 4] = p.extents[0];
      data[off + 5] = p.extents[1];
      data[off + 6] = p.extents[2];
      data[off + 7] = 0;
    }

    this.ctx.queue.writeBuffer(this.primitiveBuffer, 0, data);

    // Write uniforms
    this.uniformBuilder.reset()
      .vec4(cascade.center[0], cascade.center[1], cascade.center[2], cascade.resolution)
      .vec4(cascade.extent[0], cascade.extent[1], cascade.extent[2], cascade.voxelSize);
    
    // counts vec4u (as float reinterpretation for uniform builder compatibility)
    const uniformData = this.uniformBuilder.build();
    // Manually write the counts as uint32
    const fullData = new ArrayBuffer(48);
    const f32View = new Float32Array(fullData);
    f32View.set(uniformData);
    const u32View = new Uint32Array(fullData);
    u32View[8] = count;  // primitiveCount
    u32View[9] = 0;
    u32View[10] = 0;
    u32View[11] = 0;
    this.uniformBuffer.write(this.ctx, new Float32Array(fullData));

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'sdf-primitives-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: cascade.storageView },
        { binding: 1, resource: { buffer: this.uniformBuffer.buffer } },
        { binding: 2, resource: { buffer: this.primitiveBuffer, size: count * BYTES_PER_PRIMITIVE } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'sdf-primitives-stamp' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(cascade.resolution / 8);
    pass.dispatchWorkgroups(wg, wg, wg);
    pass.end();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.primitiveBuffer?.destroy();
    this.primitiveBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
