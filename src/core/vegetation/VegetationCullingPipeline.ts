/**
 * VegetationCullingPipeline
 * 
 * Two-pass GPU compute pipeline:
 * 1. Prepare pass: reads spawn counter → writes indirect dispatch args (1 thread)
 * 2. Cull pass: runs with dispatchWorkgroupsIndirect, exact workgroup count
 * 
 * This ensures the cull shader only processes actual spawned instances,
 * not the full buffer capacity (which could be 65K per tile).
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
} from '../gpu';

import cullShader from '../gpu/shaders/vegetation/cull.wgsl?raw';
import prepareDispatchShader from '../gpu/shaders/vegetation/prepare-cull-dispatch.wgsl?raw';

// ==================== Constants ====================

const CULL_PARAMS_SIZE = 128;
const INSTANCE_STRIDE = 32;
const DRAW_ARGS_SIZE = 48;
const BILLBOARD_VERTICES = 12;
const WORKGROUP_SIZE = 256;
/** Indirect dispatch args: 3 × u32 = 12 bytes */
const DISPATCH_ARGS_SIZE = 12;

// ==================== Types ====================

export interface CullResult {
  billboardBuffer: UnifiedGPUBuffer;
  meshBuffer: UnifiedGPUBuffer;
  drawArgsBuffer: UnifiedGPUBuffer;
  maxInstances: number;
}

// ==================== VegetationCullingPipeline ====================

export class VegetationCullingPipeline {
  private ctx: GPUContext;
  
  // Cull pipeline
  private cullPipeline: GPUComputePipeline | null = null;
  private cullBindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Prepare-dispatch pipeline (1 thread: counter → workgroup count)
  private preparePipeline: GPUComputePipeline | null = null;
  private prepareBindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Shared
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  
  // Pools
  private bufferPool: Map<number, CullResult[]> = new Map();
  private dispatchArgsPool: GPUBuffer[] = [];
  private activeAllocations: { tier: number; result: CullResult; dispatchArgs: GPUBuffer }[] = [];
  
  private initialized = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  initialize(): void {
    if (this.initialized) return;
    
    // === Prepare-dispatch pipeline ===
    this.prepareBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'veg-prepare-dispatch-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // spawnCounters
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },           // dispatchArgs
      ],
    });
    
    const prepareModule = this.ctx.device.createShaderModule({
      label: 'veg-prepare-dispatch-shader',
      code: prepareDispatchShader,
    });
    
    this.preparePipeline = this.ctx.device.createComputePipeline({
      label: 'veg-prepare-dispatch-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        label: 'veg-prepare-dispatch-layout',
        bindGroupLayouts: [this.prepareBindGroupLayout],
      }),
      compute: { module: prepareModule, entryPoint: 'main' },
    });
    
    // === Cull pipeline (now with binding 5 for spawn counters) ===
    this.cullBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-cull-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // spawnCounters
      ],
    });
    
    const cullModule = this.ctx.device.createShaderModule({
      label: 'vegetation-cull-shader',
      code: cullShader,
    });
    
    this.cullPipeline = this.ctx.device.createComputePipeline({
      label: 'vegetation-cull-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        label: 'vegetation-cull-pipeline-layout',
        bindGroupLayouts: [this.cullBindGroupLayout],
      }),
      compute: { module: cullModule, entryPoint: 'main' },
    });
    
    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-cull-params',
      size: CULL_PARAMS_SIZE,
    });
    
    this.initialized = true;
  }
  
  resetFrame(): void {
    for (const alloc of this.activeAllocations) {
      const pool = this.bufferPool.get(alloc.tier);
      if (pool) pool.push(alloc.result);
      this.dispatchArgsPool.push(alloc.dispatchArgs);
    }
    this.activeAllocations = [];
  }
  
  /**
   * Two-pass cull: prepare-dispatch → dispatchWorkgroupsIndirect
   * 
   * Pass 1: 1-thread compute reads spawnCounters[0] → writes dispatch args
   * Pass 2: Cull shader dispatched with exact workgroup count via indirect
   */
  cull(
    encoder: GPUCommandEncoder,
    inputBuffer: UnifiedGPUBuffer,
    maxInstances: number,
    frustumPlanes: Float32Array,
    cameraPosition: [number, number, number],
    maxDistance: number,
    meshIndexCount: number = 0,
    renderMode: number = 0,
    billboardDistance: number = 50,
    spawnCounterBuffer?: GPUBuffer,
  ): CullResult {
    if (!this.initialized) this.initialize();
    
    const result = this.acquireBuffers(maxInstances);
    const dispatchArgs = this.acquireDispatchArgs();
    
    this.writeParams(frustumPlanes, cameraPosition, maxDistance, maxInstances, renderMode, billboardDistance);
    
    // Pre-fill draw args
    const drawArgsData = new Uint32Array(12);
    drawArgsData[0] = BILLBOARD_VERTICES;
    drawArgsData[4] = meshIndexCount;
    this.ctx.queue.writeBuffer(result.drawArgsBuffer.buffer, 0, drawArgsData);
    
    if (spawnCounterBuffer) {
      // === Pass 1: Prepare dispatch args from spawn counter ===
      const prepareBG = this.ctx.device.createBindGroup({
        label: 'veg-prepare-dispatch-bg',
        layout: this.prepareBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: spawnCounterBuffer } },
          { binding: 1, resource: { buffer: dispatchArgs } },
        ],
      });
      
      const preparePass = encoder.beginComputePass({ label: 'veg-prepare-dispatch' });
      preparePass.setPipeline(this.preparePipeline!);
      preparePass.setBindGroup(0, prepareBG);
      preparePass.dispatchWorkgroups(1); // Single thread
      preparePass.end();
      
      // === Pass 2: Cull with indirect dispatch ===
      const cullBG = this.ctx.device.createBindGroup({
        label: 'vegetation-cull-bind-group',
        layout: this.cullBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer!.buffer } },
          { binding: 1, resource: { buffer: inputBuffer.buffer } },
          { binding: 2, resource: { buffer: result.billboardBuffer.buffer } },
          { binding: 3, resource: { buffer: result.meshBuffer.buffer } },
          { binding: 4, resource: { buffer: result.drawArgsBuffer.buffer } },
          { binding: 5, resource: { buffer: spawnCounterBuffer } },
        ],
      });
      
      const cullPass = encoder.beginComputePass({ label: 'vegetation-cull-pass' });
      cullPass.setPipeline(this.cullPipeline!);
      cullPass.setBindGroup(0, cullBG);
      cullPass.dispatchWorkgroupsIndirect(dispatchArgs, 0);
      cullPass.end();
    } else {
      // Fallback: direct dispatch with maxInstances (no counter buffer)
      const cullBG = this.ctx.device.createBindGroup({
        label: 'vegetation-cull-bind-group-fallback',
        layout: this.cullBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer!.buffer } },
          { binding: 1, resource: { buffer: inputBuffer.buffer } },
          { binding: 2, resource: { buffer: result.billboardBuffer.buffer } },
          { binding: 3, resource: { buffer: result.meshBuffer.buffer } },
          { binding: 4, resource: { buffer: result.drawArgsBuffer.buffer } },
          { binding: 5, resource: { buffer: inputBuffer.buffer } }, // dummy — won't be read
        ],
      });
      
      const workgroupCount = Math.ceil(maxInstances / WORKGROUP_SIZE);
      const cullPass = encoder.beginComputePass({ label: 'vegetation-cull-pass-fallback' });
      cullPass.setPipeline(this.cullPipeline!);
      cullPass.setBindGroup(0, cullBG);
      cullPass.dispatchWorkgroups(workgroupCount);
      cullPass.end();
    }
    
    this.activeAllocations.push({ tier: Math.max(256, nextPowerOf2(maxInstances)), result, dispatchArgs });
    return result;
  }
  
  // ==================== Internal ====================
  
  private writeParams(
    frustumPlanes: Float32Array,
    cameraPosition: [number, number, number],
    maxDistance: number,
    totalInstances: number,
    renderMode: number,
    billboardDistance: number,
  ): void {
    const data = new Float32Array(CULL_PARAMS_SIZE / 4);
    data.set(frustumPlanes.subarray(0, 24), 0);
    data[24] = cameraPosition[0];
    data[25] = cameraPosition[1];
    data[26] = cameraPosition[2];
    data[27] = maxDistance * maxDistance;
    const u32View = new Uint32Array(data.buffer);
    u32View[28] = totalInstances;
    u32View[29] = renderMode;
    data[30] = billboardDistance * billboardDistance;
    data[31] = 0;
    this.paramsBuffer!.write(this.ctx, data);
  }
  
  private acquireDispatchArgs(): GPUBuffer {
    if (this.dispatchArgsPool.length > 0) return this.dispatchArgsPool.pop()!;
    return this.ctx.device.createBuffer({
      label: 'veg-cull-dispatch-args',
      size: DISPATCH_ARGS_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
  }
  
  private acquireBuffers(maxInstances: number): CullResult {
    const tier = Math.max(256, nextPowerOf2(maxInstances));
    const pool = this.bufferPool.get(tier);
    if (pool && pool.length > 0) return pool.pop()!;
    
    const instanceBufferSize = tier * INSTANCE_STRIDE;
    const billboardBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
      label: `veg-cull-bb-${tier}`, size: instanceBufferSize,
    });
    const meshBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
      label: `veg-cull-mesh-${tier}`, size: instanceBufferSize,
    });
    const drawArgsBuffer = this.ctx.device.createBuffer({
      label: `veg-cull-drawargs-${tier}`,
      size: DRAW_ARGS_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    
    const result: CullResult = {
      billboardBuffer, meshBuffer,
      drawArgsBuffer: { buffer: drawArgsBuffer, destroy: () => drawArgsBuffer.destroy() } as UnifiedGPUBuffer,
      maxInstances: tier,
    };
    
    if (!this.bufferPool.has(tier)) this.bufferPool.set(tier, []);
    return result;
  }
  
  destroy(): void {
    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;
    
    for (const pool of this.bufferPool.values()) {
      for (const r of pool) { r.billboardBuffer.destroy(); r.meshBuffer.destroy(); r.drawArgsBuffer.destroy(); }
    }
    this.bufferPool.clear();
    
    for (const alloc of this.activeAllocations) {
      alloc.result.billboardBuffer.destroy(); alloc.result.meshBuffer.destroy(); alloc.result.drawArgsBuffer.destroy();
      alloc.dispatchArgs.destroy();
    }
    this.activeAllocations = [];
    
    for (const buf of this.dispatchArgsPool) buf.destroy();
    this.dispatchArgsPool = [];
    
    this.cullPipeline = null;
    this.cullBindGroupLayout = null;
    this.preparePipeline = null;
    this.prepareBindGroupLayout = null;
    this.initialized = false;
  }
}

function nextPowerOf2(v: number): number {
  v--; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16; return v + 1;
}