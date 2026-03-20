/**
 * VegetationDensityMapGenerator
 * 
 * Generates a terrain-space density texture from spawned vegetation instances.
 * The CDLOD terrain shader samples this texture to darken the ground beneath
 * vegetation, creating a natural transition between grass blades and terrain.
 * 
 * Pipeline:
 *   1. Clear accumulation buffer (u32 per texel)
 *   2. For each spawn result, dispatch stampInstances compute → atomicAdd into accum buffer
 *   3. Dispatch normalizeToTexture compute → write normalized [0,1] to r8unorm density texture
 * 
 * The density texture is updated after spawn completes (not per-frame).
 * It reflects the actual LOD-dependent spawn pattern, not just the biome mask.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
} from '../gpu';
import type { SpawnResult } from './VegetationSpawner';

import densityStampShader from '../gpu/shaders/vegetation/density-stamp.wgsl?raw';

// ==================== Constants ====================

/** Default density map resolution (texels per side) */
const DEFAULT_RESOLUTION = 512;

/** Stamp params uniform: terrainSize(f32) + resolution(f32) + instanceCount(u32) + splatRadius(u32) = 16 bytes */
const STAMP_PARAMS_SIZE = 16;

/** Normalize params uniform: resolution(f32) + maxCount(f32) + pad(f32) + pad(f32) = 16 bytes */
const NORMALIZE_PARAMS_SIZE = 16;

/** Default splat radius in texels (0 = single point, 1 = 3x3 kernel) */
const DEFAULT_SPLAT_RADIUS = 1;

/** Default max count for normalization (tuned empirically — dense grass ~20-30 instances/texel) */
const DEFAULT_MAX_COUNT = 24.0;

// ==================== VegetationDensityMapGenerator ====================

export class VegetationDensityMapGenerator {
  private ctx: GPUContext;
  
  // GPU resources
  private stampPipeline: GPUComputePipeline | null = null;
  private normalizePipeline: GPUComputePipeline | null = null;
  private stampBindGroupLayout: GPUBindGroupLayout | null = null;
  private normalizeBindGroupLayout: GPUBindGroupLayout | null = null;
  private stampParamsBuffer: GPUBuffer | null = null;
  private normalizeParamsBuffer: GPUBuffer | null = null;
  private accumBuffer: GPUBuffer | null = null;
  private densityTexture: UnifiedGPUTexture | null = null;
  
  // Configuration
  private resolution: number;
  private terrainSize: number = 100;
  private splatRadius: number = DEFAULT_SPLAT_RADIUS;
  private maxCount: number = DEFAULT_MAX_COUNT;
  
  // State
  private initialized = false;
  private dirty = false;
  /** Pending stamp dispatches to batch before normalizing */
  private pendingStamps: Array<{ instanceBuffer: GPUBuffer; counterBuffer: GPUBuffer; maxInstances: number }> = [];
  
  constructor(ctx: GPUContext, resolution: number = DEFAULT_RESOLUTION) {
    this.ctx = ctx;
    this.resolution = resolution;
  }
  
  // ==================== Initialization ====================
  
  initialize(): void {
    if (this.initialized) return;
    
    this.createPipelines();
    this.createBuffers();
    this.createDensityTexture();
    
    this.initialized = true;
    console.log(`[VegetationDensityMap] Initialized (${this.resolution}x${this.resolution})`);
  }
  
  private createPipelines(): void {
    const device = this.ctx.device;
    
    // Shader module
    const shaderModule = device.createShaderModule({
      label: 'density-stamp-shader',
      code: densityStampShader,
    });
    
    // ---- Stamp pipeline ----
    this.stampBindGroupLayout = device.createBindGroupLayout({
      label: 'density-stamp-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    
    this.stampPipeline = device.createComputePipeline({
      label: 'density-stamp-pipeline',
      layout: device.createPipelineLayout({
        label: 'density-stamp-pipeline-layout',
        bindGroupLayouts: [this.stampBindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'stampInstances',
      },
    });
    
    // ---- Normalize pipeline ----
    this.normalizeBindGroupLayout = device.createBindGroupLayout({
      label: 'density-normalize-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r8unorm' } },
      ],
    });
    
    this.normalizePipeline = device.createComputePipeline({
      label: 'density-normalize-pipeline',
      layout: device.createPipelineLayout({
        label: 'density-normalize-pipeline-layout',
        bindGroupLayouts: [this.normalizeBindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'normalizeToTexture',
      },
    });
  }
  
  private createBuffers(): void {
    const device = this.ctx.device;
    const texelCount = this.resolution * this.resolution;
    
    // Accumulation buffer: u32 per texel
    this.accumBuffer = device.createBuffer({
      label: 'density-accum-buffer',
      size: texelCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    // Stamp params uniform
    this.stampParamsBuffer = device.createBuffer({
      label: 'density-stamp-params',
      size: STAMP_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Normalize params uniform
    this.normalizeParamsBuffer = device.createBuffer({
      label: 'density-normalize-params',
      size: NORMALIZE_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  
  private createDensityTexture(): void {
    this.densityTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-density-map',
      width: this.resolution,
      height: this.resolution,
      format: 'r8unorm',
      sampled: true,
      storage: true
    });
  }
  
  // ==================== Configuration ====================
  
  setTerrainSize(size: number): void {
    this.terrainSize = size;
  }
  
  setSplatRadius(radius: number): void {
    this.splatRadius = Math.max(0, Math.min(radius, 4));
  }
  
  setMaxCount(maxCount: number): void {
    this.maxCount = Math.max(1, maxCount);
  }
  
  /**
   * Get the density texture for binding in the CDLOD terrain shader.
   */
  getDensityTexture(): UnifiedGPUTexture | null {
    return this.densityTexture;
  }
  
  /**
   * Get the density texture view for binding in the CDLOD terrain shader.
   */
  getDensityTextureView(): GPUTextureView | null {
    return this.densityTexture?.view ?? null;
  }
  
  // ==================== Stamping ====================
  
  /**
   * Queue a spawn result for density stamping.
   * Call this after each spawnForPlant() returns.
   * The actual GPU work happens in flush().
   */
  queueSpawnResult(result: SpawnResult): void {
    if (!this.initialized) return;
    
    this.pendingStamps.push({
      instanceBuffer: result.instanceBuffer.buffer,
      counterBuffer: result.counterBuffer,
      maxInstances: result.maxInstances,
    });
    this.dirty = true;
  }
  
  /**
   * Clear the density map and process all queued stamps.
   * Call this once per frame (or after all spawns complete for a tile batch).
   * 
   * The two-phase approach:
   *   1. Clear accum buffer
   *   2. Dispatch stamp compute for each queued spawn result
   *   3. Dispatch normalize compute to write final density texture
   */
  flush(): void {
    if (!this.initialized || !this.dirty) return;
    if (this.pendingStamps.length === 0) {
      this.dirty = false;
      return;
    }
    
    const device = this.ctx.device;
    const queue = this.ctx.queue;
    
    // Phase 1: Clear accumulation buffer
    const clearEncoder = device.createCommandEncoder({ label: 'density-clear' });
    clearEncoder.clearBuffer(this.accumBuffer!);
    queue.submit([clearEncoder.finish()]);
    
    // Phase 2: Stamp all pending spawn results
    const stampEncoder = device.createCommandEncoder({ label: 'density-stamp' });
    
    for (const stamp of this.pendingStamps) {
      this.dispatchStamp(stampEncoder, stamp.instanceBuffer, stamp.counterBuffer, stamp.maxInstances);
    }
    
    queue.submit([stampEncoder.finish()]);
    
    // Phase 3: Normalize accumulated counts to density texture
    this.dispatchNormalize();
    
    // Reset state
    this.pendingStamps = [];
    this.dirty = false;
  }
  
  /**
   * Full rebuild: clear + stamp all active spawn results + normalize.
   * Use this when spawn data changes (new tiles, plant config change, etc.)
   */
  rebuild(spawnResults: SpawnResult[]): void {
    if (!this.initialized) return;
    
    this.pendingStamps = [];
    for (const result of spawnResults) {
      this.queueSpawnResult(result);
    }
    this.flush();
  }
  
  // ==================== GPU Dispatches ====================
  
  private dispatchStamp(
    encoder: GPUCommandEncoder,
    instanceBuffer: GPUBuffer,
    counterBuffer: GPUBuffer,
    maxInstances: number,
  ): void {
    if (!this.stampPipeline || !this.stampBindGroupLayout || !this.stampParamsBuffer || !this.accumBuffer) return;
    
    // Write stamp params
    const paramsData = new ArrayBuffer(STAMP_PARAMS_SIZE);
    const f32 = new Float32Array(paramsData);
    const u32 = new Uint32Array(paramsData);
    f32[0] = this.terrainSize;
    f32[1] = this.resolution;
    u32[2] = maxInstances;
    u32[3] = this.splatRadius;
    this.ctx.queue.writeBuffer(this.stampParamsBuffer, 0, new Float32Array(paramsData));
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'density-stamp-bg',
      layout: this.stampBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.stampParamsBuffer } },
        { binding: 1, resource: { buffer: instanceBuffer } },
        { binding: 2, resource: { buffer: counterBuffer } },
        { binding: 3, resource: { buffer: this.accumBuffer } },
      ],
    });
    
    // Dispatch: one thread per instance
    const workgroupSize = 256;
    const workgroups = Math.ceil(maxInstances / workgroupSize);
    
    const pass = encoder.beginComputePass({ label: 'density-stamp-pass' });
    pass.setPipeline(this.stampPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }
  
  private dispatchNormalize(): void {
    if (!this.normalizePipeline || !this.normalizeBindGroupLayout || 
        !this.normalizeParamsBuffer || !this.accumBuffer || !this.densityTexture) return;
    
    // Write normalize params
    const paramsData = new Float32Array(4);
    paramsData[0] = this.resolution;
    paramsData[1] = this.maxCount;
    paramsData[2] = 0; // pad
    paramsData[3] = 0; // pad
    this.ctx.queue.writeBuffer(this.normalizeParamsBuffer, 0, paramsData);
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'density-normalize-bg',
      layout: this.normalizeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.normalizeParamsBuffer } },
        { binding: 1, resource: { buffer: this.accumBuffer } },
        { binding: 2, resource: this.densityTexture.view },
      ],
    });
    
    // Dispatch: one thread per texel (8×8 workgroups)
    const workgroupsXY = Math.ceil(this.resolution / 8);
    
    const encoder = this.ctx.device.createCommandEncoder({ label: 'density-normalize' });
    const pass = encoder.beginComputePass({ label: 'density-normalize-pass' });
    pass.setPipeline(this.normalizePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroupsXY, workgroupsXY);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.accumBuffer?.destroy();
    this.stampParamsBuffer?.destroy();
    this.normalizeParamsBuffer?.destroy();
    this.densityTexture?.destroy();
    
    this.accumBuffer = null;
    this.stampParamsBuffer = null;
    this.normalizeParamsBuffer = null;
    this.densityTexture = null;
    this.stampPipeline = null;
    this.normalizePipeline = null;
    this.stampBindGroupLayout = null;
    this.normalizeBindGroupLayout = null;
    this.pendingStamps = [];
    this.initialized = false;
  }
}
