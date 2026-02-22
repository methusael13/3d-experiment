/**
 * VegetationMeshRenderer
 * 
 * Renders 3D vegetation mesh instances using instanced drawing.
 * Uses the shared instance buffer from VegetationSpawner.
 * Only draws instances where renderFlag = 1 (mesh mode).
 * 
 * Supports multi-submesh models (trunk, leaves, branches) with
 * per-submesh wind multiplier.
 * 
 * Uses dynamic uniform buffer offsets so each draw call (per plant type
 * and per sub-mesh) gets its own uniform data within the same render pass.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  RenderPipelineWrapper,
  CommonBlendStates,
  CommonVertexLayouts,
  SamplerFactory,
} from '../gpu';
import type { WindParams } from './types';

// Import shader source
import meshShader from '../gpu/shaders/vegetation/vegetation-mesh.wgsl?raw';

// ==================== Constants ====================

/** MeshUniforms: mat4x4f(64) + vec3f+f32(16) + f32(4)+pad(12 to align vec3f to 16)+vec3f(12)+pad(4 struct align) = 112 bytes */
const MESH_UNIFORMS_SIZE = 112;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame (each uses one slot) — must accommodate CDLOD tiles × plant types × submeshes */
const MAX_DRAW_SLOTS = 512;

/** WindParams struct: 32 bytes */
const WIND_PARAMS_SIZE = 32;

// ==================== Types ====================

/**
 * A loaded vegetation mesh ready for instanced rendering.
 */
export interface VegetationMesh {
  id: string;
  name: string;
  subMeshes: VegetationSubMesh[];
}

/**
 * A sub-mesh within a vegetation model (e.g., trunk, leaves).
 */
export interface VegetationSubMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  /** Base color + opacity texture */
  baseColorTexture: UnifiedGPUTexture | null;
  /** Wind influence: 0 = rigid (trunk), 1 = full (leaves) */
  windMultiplier: number;
}

// ==================== VegetationMeshRenderer ====================

export class VegetationMeshRenderer {
  private ctx: GPUContext;
  
  // Pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Dynamic uniform buffer (holds multiple slots for per-draw-call data)
  private uniformsBuffer: GPUBuffer | null = null;
  private windBuffer: UnifiedGPUBuffer | null = null;
  
  // Current slot index within the dynamic buffer (reset each frame)
  private currentSlot = 0;
  
  // Default white texture
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
      label: 'vegetation-mesh-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MESH_UNIFORMS_SIZE },
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
    
    // Render pipeline with position + normal + uv vertex layout
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-mesh-pipeline',
      vertexShader: meshShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout],
      vertexBuffers: [CommonVertexLayouts.positionNormalUV()],
      colorFormats: [colorFormat],
      blendStates: [CommonBlendStates.alpha()],
      depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z depth buffer
      topology: 'triangle-list',
      cullMode: 'none', // Vegetation is often double-sided (leaves)
    });
    
    // Dynamic uniform buffer — one 256-byte aligned slot per draw call
    this.uniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-mesh-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.windBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-mesh-wind',
      size: WIND_PARAMS_SIZE,
    });
    
    // Default 1x1 white texture
    this.defaultTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-mesh-default-texture',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      sampled: true,
    });
    this.ctx.queue.writeTexture(
      { texture: this.defaultTexture.texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    
    this.sampler = SamplerFactory.linear(this.ctx, 'vegetation-mesh-sampler');
    
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
   * Render a vegetation mesh with instanced drawing.
   * Iterates over all sub-meshes, each getting its own dynamic uniform slot.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    mesh: VegetationMesh,
    instanceBuffer: UnifiedGPUBuffer,
    instanceCount: number,
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (instanceCount === 0 || mesh.subMeshes.length === 0) return;
    
    // Write wind params (shared across sub-meshes)
    this.writeWindParams(wind);
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    
    // Draw each sub-mesh with the same instances, each at a unique uniform slot
    for (const subMesh of mesh.subMeshes) {
      if (this.currentSlot >= MAX_DRAW_SLOTS) {
        console.warn('[VegetationMeshRenderer] Max draw slots exceeded, skipping draw');
        return;
      }
      
      // Write uniforms to the current slot
      const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
      this.writeUniformsAtOffset(viewProjection, cameraPosition, time, subMesh.windMultiplier, maxDistance, slotOffset);
      
      // Create bind group for this sub-mesh
      const texture = subMesh.baseColorTexture ?? this.defaultTexture!;
      const bindGroup = this.ctx.device.createBindGroup({
        label: `vegetation-mesh-bg-${mesh.id}`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformsBuffer, size: MESH_UNIFORMS_SIZE } },
          { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
          { binding: 2, resource: { buffer: instanceBuffer.buffer } },
          { binding: 3, resource: texture.view },
          { binding: 4, resource: this.sampler! },
        ],
      });
      
      // Draw with dynamic offset pointing to this slot's uniform data
      passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
      passEncoder.setVertexBuffer(0, subMesh.vertexBuffer);
      passEncoder.setIndexBuffer(subMesh.indexBuffer, subMesh.indexFormat);
      passEncoder.drawIndexed(subMesh.indexCount, instanceCount);
      
      this.currentSlot++;
    }
  }
  
  /**
   * Render vegetation mesh using GPU indirect draw.
   * Uses pre-culled instance buffer and indirect draw args from VegetationCullingPipeline.
   * 
   * drawArgsBuffer layout at offset 16 (bytes):
   *   [4] indexCount, [5] instanceCount, [6] firstIndex (0), [7] baseVertex (0), [8] firstInstance (0)
   */
  renderIndirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    mesh: VegetationMesh,
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (mesh.subMeshes.length === 0) return;
    
    this.writeWindParams(wind);
    passEncoder.setPipeline(this.pipeline.pipeline);
    
    for (const subMesh of mesh.subMeshes) {
      if (this.currentSlot >= MAX_DRAW_SLOTS) {
        console.warn('[VegetationMeshRenderer] Max draw slots exceeded, skipping indirect draw');
        return;
      }
      
      const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
      this.writeUniformsAtOffset(viewProjection, cameraPosition, time, subMesh.windMultiplier, maxDistance, slotOffset);
      
      const texture = subMesh.baseColorTexture ?? this.defaultTexture!;
      const bindGroup = this.ctx.device.createBindGroup({
        label: `vegetation-mesh-indirect-bg-${mesh.id}`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformsBuffer, size: MESH_UNIFORMS_SIZE } },
          { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
          { binding: 2, resource: { buffer: culledInstanceBuffer } },
          { binding: 3, resource: texture.view },
          { binding: 4, resource: this.sampler! },
        ],
      });
      
      passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
      passEncoder.setVertexBuffer(0, subMesh.vertexBuffer);
      passEncoder.setIndexBuffer(subMesh.indexBuffer, subMesh.indexFormat);
      // Mesh draw args at offset 16 bytes (after billboard's 4 × u32 = 16 bytes)
      passEncoder.drawIndexedIndirect(drawArgsBuffer, 16);
      
      this.currentSlot++;
    }
  }
  
  // ==================== Uniform Writing ====================
  
  private writeUniformsAtOffset(
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    time: number,
    windMultiplier: number,
    maxDistance: number,
    bufferOffset: number,
  ): void {
    const data = new Float32Array(MESH_UNIFORMS_SIZE / 4);
    
    // viewProjection mat4x4f (offset 0-15)
    data.set(viewProjection, 0);
    
    // cameraPosition vec3f + time f32 (offset 16-19)
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = time;
    
    // windMultiplier + maxDistance + pad (offset 20-23)
    data[20] = windMultiplier;
    data[21] = maxDistance;
    data[22] = 0;
    data[23] = 0;
    
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
    data[6] = 0;
    data[7] = 0;
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