/**
 * ObjectRendererGPU - Unified WebGPU renderer for meshes
 * 
 * Handles both primitives (cubes, spheres, planes) and loaded models (GLB/OBJ).
 * Uses instancing for efficient batch rendering of objects with the same mesh.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';

// Import shader
import objectShader from '../shaders/object.wgsl?raw';

// ============ Types ============

/**
 * Material properties for rendering
 */
export interface GPUMaterial {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
}

/**
 * Mesh data to be uploaded to GPU
 */
export interface GPUMeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  material?: GPUMaterial;
}

/**
 * Internal GPU mesh representation
 */
interface GPUMeshInternal {
  id: number;
  vertexBuffer: UnifiedGPUBuffer;
  indexBuffer: UnifiedGPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  material: GPUMaterial;
  modelMatrix: Float32Array;
  modelBuffer: UnifiedGPUBuffer;
  modelBindGroup: GPUBindGroup;
}

/**
 * Global render parameters
 */
export interface ObjectRenderParams {
  viewProjectionMatrix: mat4 | Float32Array;
  cameraPosition: [number, number, number];
  lightDirection?: [number, number, number];
  lightColor?: [number, number, number];
  ambientIntensity?: number;
}

// ============ Default Values ============

const DEFAULT_MATERIAL: GPUMaterial = {
  albedo: [0.7, 0.7, 0.7],
  metallic: 0.0,
  roughness: 0.5,
};

// ============ ObjectRendererGPU Class ============

/**
 * Unified object renderer for WebGPU
 */
export class ObjectRendererGPU {
  private ctx: GPUContext;
  
  // Pipeline and layouts
  private pipeline: RenderPipelineWrapper;
  private globalBindGroupLayout: GPUBindGroupLayout;
  private modelBindGroupLayout: GPUBindGroupLayout;
  
  // Global uniforms
  private globalUniformBuffer: UnifiedGPUBuffer;
  private materialUniformBuffer: UnifiedGPUBuffer;
  private globalBindGroup: GPUBindGroup;
  
  // Registered meshes
  private meshes: Map<number, GPUMeshInternal> = new Map();
  private nextMeshId = 1;
  
  // Current material (for batch rendering)
  private currentMaterial: GPUMaterial = { ...DEFAULT_MATERIAL };
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Create global uniform buffer
    // Layout: mat4x4f (64) + vec3f (12) + pad (4) + vec3f (12) + pad (4) + vec3f (12) + f32 (4) = 112 bytes
    this.globalUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'object-global-uniforms',
      size: 112,
    });
    
    // Create material uniform buffer
    // Layout: vec3f (12) + f32 (4) + f32 (4) + pad (12) = 32 bytes
    this.materialUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'object-material-uniforms',
      size: 32,
    });
    
    // Create bind group layouts
    this.globalBindGroupLayout = new BindGroupLayoutBuilder('object-global-layout')
      .uniformBuffer(0, 'all') // Global uniforms
      .uniformBuffer(1, 'fragment')        // Material uniforms
      .build(ctx);
    
    this.modelBindGroupLayout = new BindGroupLayoutBuilder('object-model-layout')
      .uniformBuffer(0, 'vertex')          // Model matrix
      .build(ctx);
    
    // Create pipeline
    this.pipeline = RenderPipelineWrapper.create(ctx, {
      label: 'object-pipeline',
      vertexShader: objectShader,
      fragmentShader: objectShader,
      vertexEntryPoint: 'vs_single',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [
        {
          // Interleaved: position (3) + normal (3) + uv (2) = 8 floats = 32 bytes
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
            { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
          ],
        },
      ],
      bindGroupLayouts: [this.globalBindGroupLayout, this.modelBindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'back',
      depthFormat: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
      colorFormats: ['rgba16float'], // HDR intermediate format
    });
    
    // Create global bind group
    this.globalBindGroup = new BindGroupBuilder('object-global-bindgroup')
      .buffer(0, this.globalUniformBuffer)
      .buffer(1, this.materialUniformBuffer)
      .build(ctx, this.globalBindGroupLayout);
  }
  
  /**
   * Create interleaved vertex buffer from mesh data
   */
  private createInterleavedBuffer(data: GPUMeshData, id: number): UnifiedGPUBuffer {
    const vertexCount = data.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8);
    
    for (let i = 0; i < vertexCount; i++) {
      const vi = i * 8;
      const pi = i * 3;
      const ni = i * 3;
      const ui = i * 2;
      
      // Position
      interleavedData[vi + 0] = data.positions[pi + 0];
      interleavedData[vi + 1] = data.positions[pi + 1];
      interleavedData[vi + 2] = data.positions[pi + 2];
      
      // Normal
      interleavedData[vi + 3] = data.normals[ni + 0];
      interleavedData[vi + 4] = data.normals[ni + 1];
      interleavedData[vi + 5] = data.normals[ni + 2];
      
      // UV
      if (data.uvs) {
        interleavedData[vi + 6] = data.uvs[ui + 0];
        interleavedData[vi + 7] = data.uvs[ui + 1];
      } else {
        interleavedData[vi + 6] = 0;
        interleavedData[vi + 7] = 0;
      }
    }
    
    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: `object-vertex-buffer-${id}`,
      data: interleavedData,
    });
  }
  
  /**
   * Add a mesh to the renderer
   * @returns Mesh ID for later reference
   */
  addMesh(data: GPUMeshData): number {
    const id = this.nextMeshId++;
    
    // Create vertex buffer
    const vertexBuffer = this.createInterleavedBuffer(data, id);
    
    // Create index buffer if provided
    let indexBuffer: UnifiedGPUBuffer | null = null;
    let indexCount = 0;
    let indexFormat: GPUIndexFormat = 'uint16';
    
    if (data.indices) {
      indexCount = data.indices.length;
      indexFormat = data.indices instanceof Uint32Array ? 'uint32' : 'uint16';
      
      indexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
        label: `object-index-buffer-${id}`,
        data: data.indices,
      });
    }
    
    // Create model matrix buffer
    const modelBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `object-model-${id}`,
      size: 64, // mat4x4f
    });
    
    // Initialize with identity matrix
    const modelMatrix = new Float32Array(16);
    mat4.identity(modelMatrix as unknown as mat4);
    modelBuffer.write(this.ctx, modelMatrix);
    
    // Create model bind group
    const modelBindGroup = new BindGroupBuilder(`object-model-bindgroup-${id}`)
      .buffer(0, modelBuffer)
      .build(this.ctx, this.modelBindGroupLayout);
    
    const mesh: GPUMeshInternal = {
      id,
      vertexBuffer,
      indexBuffer,
      indexCount,
      vertexCount: data.positions.length / 3,
      indexFormat,
      material: data.material || { ...DEFAULT_MATERIAL },
      modelMatrix,
      modelBuffer,
      modelBindGroup,
    };
    
    this.meshes.set(id, mesh);
    
    return id;
  }
  
  /**
   * Remove a mesh from the renderer
   */
  removeMesh(id: number): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    mesh.vertexBuffer.destroy();
    mesh.indexBuffer?.destroy();
    mesh.modelBuffer.destroy();
    
    this.meshes.delete(id);
  }
  
  /**
   * Update transform for a mesh
   */
  setTransform(id: number, modelMatrix: mat4 | Float32Array): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    mesh.modelMatrix.set(modelMatrix as Float32Array);
    mesh.modelBuffer.write(this.ctx, mesh.modelMatrix);
  }
  
  /**
   * Update material for a mesh
   */
  setMaterial(id: number, material: Partial<GPUMaterial>): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    if (material.albedo) mesh.material.albedo = [...material.albedo];
    if (material.metallic !== undefined) mesh.material.metallic = material.metallic;
    if (material.roughness !== undefined) mesh.material.roughness = material.roughness;
  }
  
  /**
   * Update global uniforms
   */
  private updateGlobalUniforms(params: ObjectRenderParams): void {
    const data = new Float32Array(28); // 112 bytes / 4
    
    // ViewProjection matrix (64 bytes)
    data.set(params.viewProjectionMatrix as Float32Array, 0);
    
    // Camera position (12 bytes) + pad (4 bytes)
    data[16] = params.cameraPosition[0];
    data[17] = params.cameraPosition[1];
    data[18] = params.cameraPosition[2];
    data[19] = 0; // pad
    
    // Light direction (12 bytes) + pad (4 bytes)
    const lightDir = params.lightDirection || [0.5, 0.707, 0.5];
    data[20] = lightDir[0];
    data[21] = lightDir[1];
    data[22] = lightDir[2];
    data[23] = 0; // pad
    
    // Light color (12 bytes) + ambient (4 bytes)
    const lightColor = params.lightColor || [1, 1, 1];
    data[24] = lightColor[0];
    data[25] = lightColor[1];
    data[26] = lightColor[2];
    data[27] = params.ambientIntensity ?? 0.3;
    
    this.globalUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Update material uniforms
   */
  private updateMaterialUniforms(material: GPUMaterial): void {
    const data = new Float32Array(8); // 32 bytes / 4
    
    data[0] = material.albedo[0];
    data[1] = material.albedo[1];
    data[2] = material.albedo[2];
    data[3] = material.metallic;
    data[4] = material.roughness;
    // data[5-7] are padding
    
    this.materialUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Render all meshes
   */
  render(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams): void {
    if (this.meshes.size === 0) {
      return;
    }
    
    // Update global uniforms
    this.updateGlobalUniforms(params);
    
    // Set pipeline
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.setBindGroup(0, this.globalBindGroup);
    
    // Render each mesh
    let firstMesh = true;
    for (const mesh of this.meshes.values()) {
      // Always update material on first mesh, or if different
      if (
        firstMesh ||
        mesh.material.albedo[0] !== this.currentMaterial.albedo[0] ||
        mesh.material.albedo[1] !== this.currentMaterial.albedo[1] ||
        mesh.material.albedo[2] !== this.currentMaterial.albedo[2] ||
        mesh.material.metallic !== this.currentMaterial.metallic ||
        mesh.material.roughness !== this.currentMaterial.roughness
      ) {
        this.updateMaterialUniforms(mesh.material);
        this.currentMaterial = { ...mesh.material };
        firstMesh = false;
      }
      
      // Set per-mesh bindings
      passEncoder.setBindGroup(1, mesh.modelBindGroup);
      passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
      
      if (mesh.indexBuffer) {
        passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
        passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
      }
    }
  }
  
  /**
   * Render a single mesh by ID
   */
  renderMesh(passEncoder: GPURenderPassEncoder, id: number, params: ObjectRenderParams): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    // Update global uniforms
    this.updateGlobalUniforms(params);
    this.updateMaterialUniforms(mesh.material);
    
    // Set pipeline and bindings
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.setBindGroup(0, this.globalBindGroup);
    passEncoder.setBindGroup(1, mesh.modelBindGroup);
    passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
    
    if (mesh.indexBuffer) {
      passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
      passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
    } else {
      passEncoder.draw(mesh.vertexCount, 1, 0, 0);
    }
  }
  
  /**
   * Get number of registered meshes
   */
  get meshCount(): number {
    return this.meshes.size;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    // Destroy all meshes
    for (const mesh of this.meshes.values()) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer?.destroy();
      mesh.modelBuffer.destroy();
    }
    this.meshes.clear();
    
    // Destroy shared resources
    this.globalUniformBuffer.destroy();
    this.materialUniformBuffer.destroy();
  }
}
