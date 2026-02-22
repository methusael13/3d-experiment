/**
 * VegetationBillboardRenderer
 * 
 * Renders vegetation instances as camera-facing billboard quads.
 * Uses the shared instance buffer from VegetationSpawner.
 * Only draws instances where renderFlag = 0 (billboard mode).
 * 
 * Uses dynamic uniform buffer offsets so each draw call (per plant type)
 * gets its own uniform data within the same render pass.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  RenderPipelineWrapper,
  CommonBlendStates,
  SamplerFactory,
} from '../gpu';
import type { WindParams } from './types';

// Import shader source
import billboardShader from '../gpu/shaders/vegetation/billboard.wgsl?raw';

// ==================== Constants ====================

/** Uniforms struct size: mat4x4f(64) + vec3f+f32(16) + f32+f32+vec2f(16) + vec3f+f32(16) + vec4f(16) = 128 bytes */
const UNIFORMS_SIZE = 128;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame (each uses one slot) — must accommodate CDLOD tiles × plant types */
const MAX_DRAW_SLOTS = 512;

/** WindParams struct size: vec2f(8) + f32(4) + f32(4) + f32(4) + f32(4) + vec2f(8) = 32 bytes */
const WIND_PARAMS_SIZE = 32;

/** Vertices per cross-billboard (2 quads at 90° = 4 triangles = 12 vertices) */
const VERTICES_PER_QUAD = 12;

// ==================== VegetationBillboardRenderer ====================

export class VegetationBillboardRenderer {
  private ctx: GPUContext;
  
  // Pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Dynamic uniform buffer (holds multiple slots for per-draw-call data)
  private uniformsBuffer: GPUBuffer | null = null;
  private windBuffer: UnifiedGPUBuffer | null = null;
  
  // Current slot index within the dynamic buffer (reset each frame)
  private currentSlot = 0;
  
  // Default white texture for plants without assigned texture
  private defaultTexture: UnifiedGPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  
  private initialized = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  // ==================== Initialization ====================
  
  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;
    
    // Bind group layout — binding 0 has hasDynamicOffset: true
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-billboard-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORMS_SIZE },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });
    
    // Render pipeline
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-billboard-pipeline',
      vertexShader: billboardShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout],
      vertexBuffers: [], // No vertex buffers — all data from storage buffer
      colorFormats: [colorFormat],
      blendStates: [CommonBlendStates.alpha()],
      depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z depth buffer
      topology: 'triangle-list',
      cullMode: 'none', // Billboards visible from both sides
    });
    
    // Dynamic uniform buffer — one 256-byte aligned slot per draw call
    this.uniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-billboard-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.windBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-billboard-wind',
      size: WIND_PARAMS_SIZE,
    });
    
    // Default 1x1 white texture
    this.defaultTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-default-texture',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      sampled: true,
    });
    // Write white pixel
    this.ctx.queue.writeTexture(
      { texture: this.defaultTexture.texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    
    // Sampler with linear filtering
    this.sampler = SamplerFactory.linear(this.ctx, 'vegetation-billboard-sampler');
    
    this.initialized = true;
  }
  
  // ==================== Frame Management ====================
  
  /**
   * Reset the dynamic buffer slot counter. Call once at the start of each frame.
   */
  resetFrame(): void {
    this.currentSlot = 0;
  }
  
  // ==================== Rendering ====================
  
  /**
   * Render billboard vegetation instances.
   * Each call writes to a unique slot in the dynamic uniform buffer,
   * ensuring per-draw-call uniform data within the same render pass.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    instanceBuffer: UnifiedGPUBuffer,
    instanceCount: number,
    texture: UnifiedGPUTexture | null,
    fallbackColor: [number, number, number],
    atlasRegion: [number, number, number, number],  // [uOffset, vOffset, uSize, vSize] normalized (0-1). [0,0,0,0] = no atlas
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (instanceCount === 0) return;
    if (this.currentSlot >= MAX_DRAW_SLOTS) {
      console.warn('[VegetationBillboardRenderer] Max draw slots exceeded, skipping draw');
      return;
    }
    
    // Write uniforms to the current slot
    const hasRealTexture = texture !== null;
    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, hasRealTexture, atlasRegion, slotOffset);
    this.writeWindParams(wind);
    
    // Create bind group (instance buffer + texture vary per call, so we recreate)
    const plantTexture = texture ?? this.defaultTexture!;
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-billboard-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: instanceBuffer.buffer } },
        { binding: 3, resource: plantTexture.view },
        { binding: 4, resource: this.sampler! },
      ],
    });
    
    // Draw with dynamic offset pointing to this slot's uniform data
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.draw(VERTICES_PER_QUAD, instanceCount);
    
    this.currentSlot++;
  }
  
  /**
   * Render billboard vegetation using GPU indirect draw.
   * Uses pre-culled instance buffer and indirect draw args from VegetationCullingPipeline.
   * 
   * drawArgsBuffer layout at offset 0:
   *   [0] vertexCount (12), [1] instanceCount, [2] firstVertex (0), [3] firstInstance (0)
   */
  renderIndirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    texture: UnifiedGPUTexture | null,
    fallbackColor: [number, number, number],
    atlasRegion: [number, number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    lodLevel: number = 0,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (this.currentSlot >= MAX_DRAW_SLOTS) {
      console.warn('[VegetationBillboardRenderer] Max draw slots exceeded, skipping indirect draw');
      return;
    }
    
    const hasRealTexture = texture !== null;
    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, hasRealTexture, atlasRegion, slotOffset, lodLevel);
    this.writeWindParams(wind);
    
    const plantTexture = texture ?? this.defaultTexture!;
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-billboard-indirect-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: culledInstanceBuffer } },
        { binding: 3, resource: plantTexture.view },
        { binding: 4, resource: this.sampler! },
      ],
    });
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.drawIndirect(drawArgsBuffer, 0); // Billboard draw args at offset 0
    
    this.currentSlot++;
  }
  
  // ==================== Uniform Writing ====================
  
  private writeUniformsAtOffset(
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    time: number,
    maxDistance: number,
    fallbackColor: [number, number, number],
    useTexture: boolean,
    atlasRegion: [number, number, number, number],
    bufferOffset: number,
    lodLevel: number = 0,
  ): void {
    const data = new Float32Array(UNIFORMS_SIZE / 4);
    
    // viewProjection mat4x4f (offset 0-15)
    data.set(viewProjection, 0);
    
    // cameraPosition vec3f + time f32 (offset 16-19)
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = time;
    
    // maxFadeDistance, fadeStartRatio, lodLevel, maxLodLevels (offset 20-23)
    data[20] = maxDistance;
    data[21] = 0.75; // Start fading at 75% of max distance
    data[22] = lodLevel; // CDLOD LOD level (0=root/coarsest, N=leaf/finest)
    data[23] = 10; // maxLodLevels
    
    // fallbackColor vec3f + useTexture f32 (offset 24-27)
    data[24] = fallbackColor[0];
    data[25] = fallbackColor[1];
    data[26] = fallbackColor[2];
    data[27] = useTexture ? 1.0 : 0.0;
    
    // atlasRegion vec4f (offset 28-31): xy = UV offset, zw = UV size
    data[28] = atlasRegion[0];
    data[29] = atlasRegion[1];
    data[30] = atlasRegion[2];
    data[31] = atlasRegion[3];
    
    this.ctx.queue.writeBuffer(this.uniformsBuffer!, bufferOffset, data);
  }
  
  private writeWindParams(wind: WindParams): void {
    const data = new Float32Array(WIND_PARAMS_SIZE / 4);
    
    data[0] = wind.direction[0];
    data[1] = wind.direction[1];
    data[2] = wind.strength;
    data[3] = wind.frequency;
    data[4] = wind.gustStrength;
    data[5] = wind.gustFrequency;
    data[6] = 0; // pad
    data[7] = 0; // pad
    
    this.windBuffer!.write(this.ctx, data);
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.uniformsBuffer?.destroy();
    this.windBuffer?.destroy();
    this.defaultTexture?.destroy();
    
    this.uniformsBuffer = null;
    this.windBuffer = null;
    this.defaultTexture = null;
    this.sampler = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}