/**
 * VegetationSpawner - GPU compute-based vegetation instance generation
 * 
 * Fire-and-forget design: dispatches GPU compute and returns immediately.
 * No mapAsync, no CPU readback, no blocking.
 * The spawn counter buffer is passed to the cull shader which reads
 * totalInstances directly from GPU memory.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  calculateWorkgroupCount2D,
} from '../gpu';
import type { PlantType, RenderMode } from './types';

import spawnShader from '../gpu/shaders/vegetation/spawn.wgsl?raw';

// ==================== Types ====================

export interface SpawnRequest {
  tileId: string;
  tileOrigin: [number, number];
  tileSize: number;
  cameraPosition: [number, number, number];
}

/**
 * Result of a spawn operation.
 * No CPU-side counts — the GPU counter buffer is read by the cull shader.
 */
export interface SpawnResult {
  /** GPU buffer containing PlantInstance structs (32 bytes each) */
  instanceBuffer: UnifiedGPUBuffer;
  /** GPU counter buffer: [totalCount, meshCount, billboardCount] as u32 */
  counterBuffer: GPUBuffer;
  /** Maximum possible instances (buffer capacity) */
  maxInstances: number;
}

const SPAWN_PARAMS_SIZE = 96;
const DEFAULT_MAX_INSTANCES_PER_TILE = 65536;
const INSTANCE_STRIDE = 32;
const COUNTER_BUFFER_SIZE = 16; // 3 x u32 + padding

// ==================== VegetationSpawner ====================

export class VegetationSpawner {
  private ctx: GPUContext;
  
  private pipeline: ComputePipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  
  private instanceBufferPool: UnifiedGPUBuffer[] = [];
  private counterBufferPool: GPUBuffer[] = [];
  private maxInstances: number;
  
  constructor(ctx: GPUContext, maxInstancesPerTile: number = DEFAULT_MAX_INSTANCES_PER_TILE) {
    this.ctx = ctx;
    this.maxInstances = maxInstancesPerTile;
    this.initialize();
  }
  
  private initialize(): void {
    this.bindGroupLayout = new BindGroupLayoutBuilder('vegetation-spawn-layout')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')
      .texture(2, 'compute', 'unfilterable-float')
      .storageBufferRW(3, 'compute')
      .storageBufferRW(4, 'compute')
      .build(this.ctx);
    
    this.pipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'vegetation-spawn-pipeline',
      shader: spawnShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-spawn-params',
      size: SPAWN_PARAMS_SIZE,
    });
  }
  
  // ==================== Spawn (synchronous, fire-and-forget) ====================
  
  /**
   * Spawn vegetation instances synchronously. No await, no blocking.
   * Returns immediately after recording GPU commands.
   * 
   * The returned SpawnResult contains:
   * - instanceBuffer: GPU buffer with spawned instances
   * - counterBuffer: GPU buffer with [total, mesh, billboard] counts
   * - maxInstances: buffer capacity (used for cull shader dispatch sizing)
   * 
   * The cull shader reads counterBuffer[0] as totalInstances.
   */
  spawnForPlant(
    request: SpawnRequest,
    plant: PlantType,
    biomeMask: UnifiedGPUTexture,
    heightmap: UnifiedGPUTexture,
    terrainSize: number,
    heightScale: number,
    densityMultiplier: number = 1.0,
    spawnSeed: number = 42,
  ): SpawnResult {
    if (!this.pipeline || !this.bindGroupLayout || !this.paramsBuffer) {
      throw new Error('[VegetationSpawner] Not initialized');
    }
    
    const instanceBuffer = this.acquireInstanceBuffer();
    const counterBuffer = this.acquireCounterBuffer();
    
    // Clear counter buffer
    const clearEncoder = this.ctx.device.createCommandEncoder({ label: 'spawn-clear' });
    clearEncoder.clearBuffer(counterBuffer);
    this.ctx.queue.submit([clearEncoder.finish()]);
    
    // Write params
    this.writeSpawnParams(request, plant, terrainSize, heightScale, densityMultiplier, spawnSeed);
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: `spawn-bg-${request.tileId}`,
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer.buffer } },
        { binding: 1, resource: biomeMask.view },
        { binding: 2, resource: heightmap.view },
        { binding: 3, resource: { buffer: instanceBuffer.buffer } },
        { binding: 4, resource: { buffer: counterBuffer } },
      ],
    });
    
    // Dispatch compute
    const gridSize = Math.ceil(request.tileSize * Math.sqrt(plant.spawnProbability * 4 * densityMultiplier * (plant.densityMultiplier ?? 1.0)));
    const workgroups = calculateWorkgroupCount2D(gridSize, gridSize, 8, 8);
    
    const encoder = this.ctx.device.createCommandEncoder({ label: `spawn-${request.tileId}` });
    const pass = encoder.beginComputePass({ label: `spawn-pass-${request.tileId}` });
    pass.setPipeline(this.pipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups.x, workgroups.y);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
    
    // Return immediately — no await!
    return {
      instanceBuffer,
      counterBuffer,
      maxInstances: this.maxInstances,
    };
  }
  
  // ==================== Internal ====================
  
  private writeSpawnParams(
    request: SpawnRequest,
    plant: PlantType,
    terrainSize: number,
    heightScale: number,
    densityMultiplier: number = 1.0,
    spawnSeed: number = 42,
  ): void {
    const renderModeMap: Record<RenderMode, number> = { 'billboard': 0, 'mesh': 1, 'hybrid': 2, 'grass-blade': 3 };
    const biomeChannelMap: Record<string, number> = { 'r': 0, 'g': 1, 'b': 2, 'a': 3 };
    
    const buffer = new ArrayBuffer(SPAWN_PARAMS_SIZE);
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);
    
    f32[0] = request.tileOrigin[0];
    f32[1] = request.tileOrigin[1];
    f32[2] = request.tileSize;
    f32[3] = plant.spawnProbability * 4 * densityMultiplier * (plant.densityMultiplier ?? 1.0);
    
    u32[4] = biomeChannelMap[plant.biomeChannel] ?? 0;
    f32[5] = plant.biomeThreshold;
    u32[6] = renderModeMap[plant.renderMode];
    u32[7] = Math.max(1, plant.modelRef?.variantCount ?? 1);
    
    f32[8]  = request.cameraPosition[0];
    f32[9]  = request.cameraPosition[1];
    f32[10] = request.cameraPosition[2];
    f32[11] = plant.maxDistance;
    
    f32[12] = plant.billboardDistance;
    f32[13] = spawnSeed;
    
    f32[14] = terrainSize;
    f32[15] = heightScale;
    
    f32[16] = (plant.minSize[0] + plant.minSize[1]) * 0.5;
    f32[17] = (plant.maxSize[0] + plant.maxSize[1]) * 0.5;
    
    u32[18] = this.maxInstances;
    f32[19] = plant.clusterStrength ?? 0;
    f32[20] = plant.minSpacing ?? 0;
    u32[21] = 0; // _padding
    
    this.paramsBuffer!.write(this.ctx, new Float32Array(buffer));
  }
  
  private acquireInstanceBuffer(): UnifiedGPUBuffer {
    if (this.instanceBufferPool.length > 0) return this.instanceBufferPool.pop()!;
    return UnifiedGPUBuffer.createStorage(this.ctx, {
      label: `vegetation-instance-buffer-${Date.now()}`,
      size: this.maxInstances * INSTANCE_STRIDE,
    });
  }
  
  private acquireCounterBuffer(): GPUBuffer {
    if (this.counterBufferPool.length > 0) return this.counterBufferPool.pop()!;
    return this.ctx.device.createBuffer({
      label: `vegetation-counter-${Date.now()}`,
      size: COUNTER_BUFFER_SIZE,
      // STORAGE for spawn shader write + cull shader read, COPY_DST for clearing
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
  
  releaseInstanceBuffer(buffer: UnifiedGPUBuffer): void {
    this.instanceBufferPool.push(buffer);
  }
  
  releaseCounterBuffer(buffer: GPUBuffer): void {
    this.counterBufferPool.push(buffer);
  }
  
  getMaxInstances(): number {
    return this.maxInstances;
  }
  
  getStats(): { poolSize: number; maxInstances: number; instanceStride: number } {
    return {
      poolSize: this.instanceBufferPool.length,
      maxInstances: this.maxInstances,
      instanceStride: INSTANCE_STRIDE,
    };
  }
  
  destroy(): void {
    this.paramsBuffer?.destroy();
    for (const buf of this.instanceBufferPool) buf.destroy();
    for (const buf of this.counterBufferPool) buf.destroy();
    
    this.paramsBuffer = null;
    this.instanceBufferPool = [];
    this.counterBufferPool = [];
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}