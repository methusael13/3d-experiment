/**
 * VegetationMeshRenderer
 * 
 * Renders 3D vegetation mesh instances using instanced drawing.
 * All per-draw data (VP matrix, wind, lighting) is in a single dynamic uniform buffer.
 * No separate wind buffer — wind params are per-draw to support per-plant wind influence.
 * 
 * Shadow receiving via CSM (Group 1 bind group from SceneEnvironment).
 * Shadow casting via a separate depth-only pipeline.
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
import type { WindParams, VegetationLightParams } from './types';
import { DEFAULT_VEGETATION_LIGHT } from './types';
import { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';
import { ENV_BINDING_MASK } from '../gpu/renderers/shared/types';

// Import shader sources
import meshShader from '../gpu/shaders/vegetation/vegetation-mesh.wgsl?raw';
import depthShader from '../gpu/shaders/vegetation/vegetation-mesh-depth.wgsl?raw';

// ==================== Constants ====================

/** MeshUniforms: 176 bytes (44 floats) — see shader struct for layout */
const MESH_UNIFORMS_SIZE = 176;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame — increased to support many tiles × plant types × submeshes */
const MAX_DRAW_SLOTS = 1024;

/** Bitmask for vegetation CSM shadow bindings */
const VEG_CSM_MASK = ENV_BINDING_MASK.CSM_SHADOW;

/** DepthUniforms: mat4x4f(64) + vec3f+f32(16) = 80 bytes */
const DEPTH_UNIFORMS_SIZE = 80;

/** Maximum shadow passes per frame */
const MAX_SHADOW_SLOTS = 64;

// ==================== Types ====================

export interface VegetationMesh {
  id: string;
  name: string;
  subMeshes: VegetationSubMesh[];
}

export interface VegetationSubMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  baseColorTexture: UnifiedGPUTexture | null;
  windMultiplier: number;
}

// ==================== VegetationMeshRenderer ====================

export class VegetationMeshRenderer {
  private ctx: GPUContext;
  
  // Main render pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Shadow (depth-only) pipeline
  private shadowPipeline: RenderPipelineWrapper | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowUniformsBuffer: GPUBuffer | null = null;
  private shadowCurrentSlot = 0;
  
  // Dynamic uniform buffer (holds per-draw uniforms including wind + light)
  private uniformsBuffer: GPUBuffer | null = null;
  
  // Current slot index
  private currentSlot = 0;
  
  // Default white texture
  private defaultTexture: UnifiedGPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  
  // Scene environment for shadow receiving
  private sceneEnvironment: SceneEnvironment | null = null;
  
  private initialized = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  // ==================== Initialization ====================
  
  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;
    
    // Group 0: Per-draw data — uniforms (dynamic), instances (storage), texture, sampler
    // Bindings: 0=uniforms, 1=instances, 2=texture, 3=sampler (no separate wind buffer)
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-mesh-layout-g0',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MESH_UNIFORMS_SIZE },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });
    
    // Group 1: Environment shadow (CSM)
    const envLayout = SceneEnvironment.getBindGroupLayoutEntriesForMask(VEG_CSM_MASK);
    const envBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-mesh-env-layout-g1',
      entries: envLayout,
    });
    
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-mesh-pipeline',
      vertexShader: meshShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout, envBindGroupLayout],
      vertexBuffers: [CommonVertexLayouts.positionNormalUV()],
      colorFormats: [colorFormat],
      blendStates: [CommonBlendStates.alpha()],
      depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'greater',
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    this.uniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-mesh-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.defaultTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-mesh-default-texture',
      width: 1, height: 1, format: 'rgba8unorm', sampled: true,
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
  
  // ==================== Scene Environment ====================
  
  setSceneEnvironment(env: SceneEnvironment | null): void {
    this.sceneEnvironment = env;
  }
  
  // ==================== Frame Management ====================
  
  resetFrame(): void {
    this.currentSlot = 0;
  }
  
  // ==================== Rendering ====================
  
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
    light?: VegetationLightParams,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (instanceCount === 0 || mesh.subMeshes.length === 0) return;
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    this._setEnvBindGroup(passEncoder);
    
    for (const subMesh of mesh.subMeshes) {
      if (this.currentSlot >= MAX_DRAW_SLOTS) {
        console.warn('[VegetationMeshRenderer] Max draw slots exceeded');
        return;
      }
      
      const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
      this._writeUniforms(viewProjection, cameraPosition, time, subMesh.windMultiplier, maxDistance, wind, light, slotOffset);
      
      const texture = subMesh.baseColorTexture ?? this.defaultTexture!;
      const bindGroup = this.ctx.device.createBindGroup({
        label: `veg-mesh-bg-${mesh.id}`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformsBuffer, size: MESH_UNIFORMS_SIZE } },
          { binding: 1, resource: { buffer: instanceBuffer.buffer } },
          { binding: 2, resource: texture.view },
          { binding: 3, resource: this.sampler! },
        ],
      });
      
      passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
      passEncoder.setVertexBuffer(0, subMesh.vertexBuffer);
      passEncoder.setIndexBuffer(subMesh.indexBuffer, subMesh.indexFormat);
      passEncoder.drawIndexed(subMesh.indexCount, instanceCount);
      
      this.currentSlot++;
    }
  }
  
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
    light?: VegetationLightParams,
  ): number {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return 0;
    if (mesh.subMeshes.length === 0) return 0;
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    this._setEnvBindGroup(passEncoder);
    
    let drawCalls = 0;
    for (let subMeshIdx = 0; subMeshIdx < mesh.subMeshes.length; subMeshIdx++) {
      const subMesh = mesh.subMeshes[subMeshIdx];
      if (this.currentSlot >= MAX_DRAW_SLOTS) {
        console.warn('[VegetationMeshRenderer] Max draw slots exceeded');
        return drawCalls;
      }
      
      const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
      this._writeUniforms(viewProjection, cameraPosition, time, subMesh.windMultiplier, maxDistance, wind, light, slotOffset);
      
      const texture = subMesh.baseColorTexture ?? this.defaultTexture!;
      const bindGroup = this.ctx.device.createBindGroup({
        label: `veg-mesh-ind-bg-${mesh.id}-s${subMeshIdx}`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformsBuffer, size: MESH_UNIFORMS_SIZE } },
          { binding: 1, resource: { buffer: culledInstanceBuffer } },
          { binding: 2, resource: texture.view },
          { binding: 3, resource: this.sampler! },
        ],
      });
      
      passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
      passEncoder.setVertexBuffer(0, subMesh.vertexBuffer);
      passEncoder.setIndexBuffer(subMesh.indexBuffer, subMesh.indexFormat);
      const meshArgsOffset = 16 + subMeshIdx * 20;
      passEncoder.drawIndexedIndirect(drawArgsBuffer, meshArgsOffset);
      
      this.currentSlot++;
      drawCalls++;
    }
    return drawCalls;
  }
  
  // ==================== Environment Bind Group ====================
  
  private _setEnvBindGroup(passEncoder: GPURenderPassEncoder): void {
    if (this.sceneEnvironment) {
      passEncoder.setBindGroup(1, this.sceneEnvironment.getBindGroupForMask(VEG_CSM_MASK));
    }
  }
  
  // ==================== Uniform Writing ====================
  
  private _writeUniforms(
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    time: number,
    windMultiplier: number,
    maxDistance: number,
    wind: WindParams,
    light: VegetationLightParams | undefined,
    bufferOffset: number,
  ): void {
    const l = light ?? DEFAULT_VEGETATION_LIGHT;
    const data = new Float32Array(MESH_UNIFORMS_SIZE / 4); // 44 floats
    
    // viewProjection mat4x4f (0-15)
    data.set(viewProjection, 0);
    
    // cameraPosition + time (16-19)
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = time;
    
    // windMultiplier + maxDistance + windStrength + windFrequency (20-23)
    data[20] = windMultiplier;
    data[21] = maxDistance;
    data[22] = wind.strength;
    data[23] = wind.frequency;
    
    // windDirection (vec2f) + gustStrength + gustFrequency (24-27)
    data[24] = wind.direction[0];
    data[25] = wind.direction[1];
    data[26] = wind.gustStrength;
    data[27] = wind.gustFrequency;
    
    // sunDirection + sunIntensityFactor (28-31)
    data[28] = l.sunDirection[0];
    data[29] = l.sunDirection[1];
    data[30] = l.sunDirection[2];
    data[31] = l.sunIntensityFactor;
    
    // sunColor + pad (32-35)
    data[32] = l.sunColor[0];
    data[33] = l.sunColor[1];
    data[34] = l.sunColor[2];
    data[35] = 0;
    
    // skyColor + pad (36-39)
    data[36] = l.skyColor[0];
    data[37] = l.skyColor[1];
    data[38] = l.skyColor[2];
    data[39] = 0;
    
    // groundColor + pad (40-43)
    data[40] = l.groundColor[0];
    data[41] = l.groundColor[1];
    data[42] = l.groundColor[2];
    data[43] = 0;
    
    this.ctx.queue.writeBuffer(this.uniformsBuffer!, bufferOffset, data);
  }
  
  // ==================== Shadow Casting (Depth-Only) ====================
  
  private _initShadowPipeline(): void {
    if (this.shadowPipeline) return;
    
    this.shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-mesh-shadow-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DEPTH_UNIFORMS_SIZE } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    
    this.shadowPipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-mesh-shadow-pipeline',
      vertexShader: depthShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.shadowBindGroupLayout],
      vertexBuffers: [CommonVertexLayouts.positionNormalUV()],
      colorFormats: [],
      blendStates: [],
      depthFormat: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'less',
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    this.shadowUniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-mesh-shadow-uniforms',
      size: UNIFORM_ALIGNMENT * MAX_SHADOW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    console.log('[VegetationMeshRenderer] Shadow pipeline initialized');
  }
  
  prepareShadowPasses(
    matrices: { lightSpaceMatrix: Float32Array | ArrayLike<number>; lightPosition: [number, number, number] }[],
    cameraPosition?: [number, number, number],
    shadowCastDistance?: number,
  ): void {
    this._initShadowPipeline();
    this.shadowCurrentSlot = 0;
    
    const camPos = cameraPosition ?? [0, 0, 0];
    const castDist = shadowCastDistance ?? 200.0;
    
    for (let i = 0; i < matrices.length; i++) {
      const { lightSpaceMatrix } = matrices[i];
      const data = new Float32Array(DEPTH_UNIFORMS_SIZE / 4);
      for (let j = 0; j < 16; j++) data[j] = lightSpaceMatrix[j];
      // Write camera position (for distance culling from camera, not light)
      data[16] = camPos[0];
      data[17] = camPos[1];
      data[18] = camPos[2];
      data[19] = castDist;
      this.ctx.queue.writeBuffer(this.shadowUniformsBuffer!, i * UNIFORM_ALIGNMENT, data);
    }
  }
  
  renderDepthOnly(
    passEncoder: GPURenderPassEncoder,
    mesh: VegetationMesh,
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    slotIndex: number,
  ): number {
    if (!this.shadowPipeline || !this.shadowBindGroupLayout || !this.shadowUniformsBuffer) return 0;
    if (mesh.subMeshes.length === 0) return 0;
    
    passEncoder.setPipeline(this.shadowPipeline.pipeline);
    
    let drawCalls = 0;
    const baseOffset = slotIndex * UNIFORM_ALIGNMENT;
    
    for (let subMeshIdx = 0; subMeshIdx < mesh.subMeshes.length; subMeshIdx++) {
      const subMesh = mesh.subMeshes[subMeshIdx];
      const texture = subMesh.baseColorTexture ?? this.defaultTexture!;
      
      const bindGroup = this.ctx.device.createBindGroup({
        label: `veg-mesh-shadow-bg-s${subMeshIdx}`,
        layout: this.shadowBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.shadowUniformsBuffer, size: DEPTH_UNIFORMS_SIZE } },
          { binding: 1, resource: { buffer: culledInstanceBuffer } },
          { binding: 2, resource: texture.view },
          { binding: 3, resource: this.sampler! },
        ],
      });
      
      passEncoder.setBindGroup(0, bindGroup, [baseOffset]);
      passEncoder.setVertexBuffer(0, subMesh.vertexBuffer);
      passEncoder.setIndexBuffer(subMesh.indexBuffer, subMesh.indexFormat);
      passEncoder.drawIndexedIndirect(drawArgsBuffer, 16 + subMeshIdx * 20);
      drawCalls++;
    }
    
    return drawCalls;
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.uniformsBuffer?.destroy();
    this.defaultTexture?.destroy();
    this.shadowUniformsBuffer?.destroy();
    
    this.uniformsBuffer = null;
    this.defaultTexture = null;
    this.sampler = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.shadowPipeline = null;
    this.shadowBindGroupLayout = null;
    this.shadowUniformsBuffer = null;
    this.sceneEnvironment = null;
    this.initialized = false;
  }
}