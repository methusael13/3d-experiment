/**
 * GPUCullingPipeline - GPU-driven frustum culling for CDLOD terrain
 * 
 * Moves frustum culling from CPU to GPU using compute shaders.
 * This reduces CPU-GPU data transfer and leverages GPU parallelism.
 * 
 * Workflow:
 * 1. CPU uploads all quadtree nodes (not just visible ones) once
 * 2. Each frame, GPU computes frustum planes and runs culling shader
 * 3. Visible nodes are written to output buffer with atomic counter
 * 4. drawIndexedIndirect() uses the output for instanced rendering
 */

import { mat4, vec3 } from 'gl-matrix';
import {
  GPUContext,
  UnifiedGPUBuffer,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  UniformBuilder,
} from '../gpu';
import { TerrainNode } from './TerrainQuadtree';

// Import the frustum cull shader
import frustumCullShader from '../gpu/shaders/terrain/frustum-cull.wgsl?raw';

/**
 * Input node data structure (matches WGSL InputNode)
 * 12 floats per node = 48 bytes
 */
interface GPUNodeData {
  // AABB min (xyz) + LOD level (w) - 4 floats
  minX: number; minY: number; minZ: number; lodLevel: number;
  // AABB max (xyz) + morph factor (w) - 4 floats
  maxX: number; maxY: number; maxZ: number; morph: number;
  // Center XZ + size + padding - 4 floats
  centerX: number; centerZ: number; size: number; _pad: number;
}

/**
 * Culling pipeline configuration
 */
export interface GPUCullingConfig {
  /** Maximum number of nodes to process */
  maxNodes: number;
  /** Grid size (vertices per side) */
  gridSize: number;
}

/**
 * Default configuration
 */
export function createDefaultCullingConfig(): GPUCullingConfig {
  return {
    maxNodes: 1024,
    gridSize: 65,
  };
}

/**
 * GPUCullingPipeline - Manages GPU-driven frustum culling
 */
export class GPUCullingPipeline {
  private ctx: GPUContext;
  private config: GPUCullingConfig;
  
  // Compute pipelines
  private cullPipeline: ComputePipelineWrapper | null = null;
  private resetPipeline: ComputePipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Buffers
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private inputNodesBuffer: UnifiedGPUBuffer | null = null;
  private visibleNodesBuffer: UnifiedGPUBuffer | null = null;
  private indirectBuffer: UnifiedGPUBuffer | null = null;
  
  // Bind groups
  private cullBindGroup: GPUBindGroup | null = null;
  
  // Uniform builder
  private uniformBuilder: UniformBuilder;
  
  // Stats
  private lastNodeCount = 0;
  private lastVisibleCount = 0;
  
  // Index count for indirect draw
  private gridIndexCount = 0;
  
  constructor(ctx: GPUContext, config?: Partial<GPUCullingConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultCullingConfig(), ...config };
    
    // Uniform buffer: 6 frustum planes (6*4=24) + camera pos (4) + counts (4) = 32 floats
    this.uniformBuilder = new UniformBuilder(32);
    
    this.initialize();
  }
  
  /**
   * Initialize GPU resources
   */
  private initialize(): void {
    this.createBuffers();
    this.createPipelines();
  }
  
  /**
   * Create GPU buffers
   */
  private createBuffers(): void {
    // Uniform buffer (128 bytes → 256 aligned)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'gpu-cull-uniforms',
      size: 128,
    });
    
    // Input nodes buffer (storage, read-only in shader)
    // 48 bytes per node (12 floats)
    this.inputNodesBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
      label: 'gpu-cull-input-nodes',
      size: this.config.maxNodes * 48,
    });
    
    // Visible nodes buffer (storage, read-write in shader)
    // 32 bytes per node (8 floats) for output
    this.visibleNodesBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
      label: 'gpu-cull-visible-nodes',
      size: this.config.maxNodes * 32,
    });
    
    // Indirect draw buffer (20 bytes = 5 u32)
    // Structure: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
    // Create directly since we need custom usage flags
    const indirectGPUBuffer = this.ctx.device.createBuffer({
      label: 'gpu-cull-indirect',
      size: 20,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });
    // Wrap in a simple object for consistency
    this.indirectBuffer = {
      buffer: indirectGPUBuffer,
      destroy: () => indirectGPUBuffer.destroy(),
    } as any;
  }
  
  /**
   * Create compute pipelines
   */
  private createPipelines(): void {
    // Create bind group layout
    this.bindGroupLayout = new BindGroupLayoutBuilder('gpu-cull-layout')
      .uniformBuffer(0, 'compute')           // Uniforms
      .storageBuffer(1, 'compute')           // Input nodes (read-only)
      .storageBufferRW(2, 'compute')         // Visible nodes (read-write)
      .storageBufferRW(3, 'compute')         // Indirect args (read-write)
      .build(this.ctx);
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'frustum-cull-shader',
      code: frustumCullShader,
    });
    
    // Create cull pipeline
    this.cullPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'gpu-cull-pipeline',
      shader: frustumCullShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    // Create reset pipeline
    this.resetPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'gpu-reset-pipeline',
      shader: frustumCullShader,
      entryPoint: 'reset_draw_args',
      bindGroupLayouts: [this.bindGroupLayout],
    });
  }
  
  /**
   * Update bind group with current buffers
   */
  private updateBindGroup(): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.inputNodesBuffer ||
        !this.visibleNodesBuffer || !this.indirectBuffer) {
      return;
    }
    
    this.cullBindGroup = new BindGroupBuilder('gpu-cull-bindgroup')
      .buffer(0, this.uniformBuffer)
      .buffer(1, this.inputNodesBuffer)
      .buffer(2, this.visibleNodesBuffer)
      .buffer(3, this.indirectBuffer)
      .build(this.ctx, this.bindGroupLayout);
  }
  
  /**
   * Upload quadtree nodes to GPU
   * Call this when nodes change (e.g., quadtree rebuild)
   */
  uploadNodes(nodes: TerrainNode[]): void {
    if (!this.inputNodesBuffer) return;
    
    const nodeCount = Math.min(nodes.length, this.config.maxNodes);
    this.lastNodeCount = nodeCount;
    
    // Pack nodes into buffer
    const data = new Float32Array(nodeCount * 12);
    
    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i];
      const offset = i * 12;
      
      // AABB min (xyz) + LOD level (w)
      data[offset + 0] = node.bounds.min[0];
      data[offset + 1] = node.bounds.min[1];
      data[offset + 2] = node.bounds.min[2];
      data[offset + 3] = node.lodLevel;
      
      // AABB max (xyz) + morph factor (w)
      data[offset + 4] = node.bounds.max[0];
      data[offset + 5] = node.bounds.max[1];
      data[offset + 6] = node.bounds.max[2];
      data[offset + 7] = node.morphFactor;
      
      // Center XZ + size + padding
      data[offset + 8] = node.center[0];
      data[offset + 9] = node.center[2];
      data[offset + 10] = node.size;
      data[offset + 11] = 0;
    }
    
    this.inputNodesBuffer.write(this.ctx, data);
    this.updateBindGroup();
  }
  
  /**
   * Set the grid index count (needed for indirect draw)
   */
  setGridIndexCount(count: number): void {
    this.gridIndexCount = count;
  }
  
  /**
   * Extract frustum planes from view-projection matrix
   */
  private extractFrustumPlanes(vpMatrix: mat4): Float32Array {
    const planes = new Float32Array(24); // 6 planes * 4 floats
    
    // Left plane
    planes[0] = vpMatrix[3] + vpMatrix[0];
    planes[1] = vpMatrix[7] + vpMatrix[4];
    planes[2] = vpMatrix[11] + vpMatrix[8];
    planes[3] = vpMatrix[15] + vpMatrix[12];
    this.normalizePlane(planes, 0);
    
    // Right plane
    planes[4] = vpMatrix[3] - vpMatrix[0];
    planes[5] = vpMatrix[7] - vpMatrix[4];
    planes[6] = vpMatrix[11] - vpMatrix[8];
    planes[7] = vpMatrix[15] - vpMatrix[12];
    this.normalizePlane(planes, 4);
    
    // Bottom plane
    planes[8] = vpMatrix[3] + vpMatrix[1];
    planes[9] = vpMatrix[7] + vpMatrix[5];
    planes[10] = vpMatrix[11] + vpMatrix[9];
    planes[11] = vpMatrix[15] + vpMatrix[13];
    this.normalizePlane(planes, 8);
    
    // Top plane
    planes[12] = vpMatrix[3] - vpMatrix[1];
    planes[13] = vpMatrix[7] - vpMatrix[5];
    planes[14] = vpMatrix[11] - vpMatrix[9];
    planes[15] = vpMatrix[15] - vpMatrix[13];
    this.normalizePlane(planes, 12);
    
    // Near plane
    planes[16] = vpMatrix[3] + vpMatrix[2];
    planes[17] = vpMatrix[7] + vpMatrix[6];
    planes[18] = vpMatrix[11] + vpMatrix[10];
    planes[19] = vpMatrix[15] + vpMatrix[14];
    this.normalizePlane(planes, 16);
    
    // Far plane
    planes[20] = vpMatrix[3] - vpMatrix[2];
    planes[21] = vpMatrix[7] - vpMatrix[6];
    planes[22] = vpMatrix[11] - vpMatrix[10];
    planes[23] = vpMatrix[15] - vpMatrix[14];
    this.normalizePlane(planes, 20);
    
    return planes;
  }
  
  /**
   * Normalize a frustum plane
   */
  private normalizePlane(planes: Float32Array, offset: number): void {
    const len = Math.sqrt(
      planes[offset] * planes[offset] +
      planes[offset + 1] * planes[offset + 1] +
      planes[offset + 2] * planes[offset + 2]
    );
    if (len > 0) {
      planes[offset] /= len;
      planes[offset + 1] /= len;
      planes[offset + 2] /= len;
      planes[offset + 3] /= len;
    }
  }
  
  /**
   * Run GPU culling compute pass
   */
  runCulling(
    commandEncoder: GPUCommandEncoder,
    vpMatrix: mat4,
    cameraPosition: vec3,
    terrainSize: number,
    heightScale: number
  ): void {
    if (!this.cullPipeline || !this.resetPipeline || !this.cullBindGroup ||
        !this.uniformBuffer || !this.indirectBuffer) {
      return;
    }
    
    // Update uniforms
    const frustumPlanes = this.extractFrustumPlanes(vpMatrix);
    
    this.uniformBuilder.reset();
    
    // Frustum planes (6 * vec4 = 24 floats)
    for (let i = 0; i < 24; i++) {
      this.uniformBuilder.float(frustumPlanes[i]);
    }
    
    // Camera position (vec3 + pad)
    this.uniformBuilder.vec3(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
    
    // Node count + terrain params (pack u32 as float - shader will reinterpret)
    // Use DataView to properly convert u32 to float bits
    const nodeCountFloat = new Float32Array(new Uint32Array([this.lastNodeCount]).buffer)[0];
    this.uniformBuilder.float(nodeCountFloat);
    this.uniformBuilder.float(terrainSize);
    this.uniformBuilder.float(heightScale);
    this.uniformBuilder.float(0); // padding
    
    this.uniformBuffer.write(this.ctx, this.uniformBuilder.build());
    
    // Initialize indirect buffer with index count
    const indirectInit = new Uint32Array([
      this.gridIndexCount, // indexCount
      0,                   // instanceCount (will be set by shader)
      0,                   // firstIndex
      0,                   // baseVertex
      0,                   // firstInstance
    ]);
    this.ctx.device.queue.writeBuffer(this.indirectBuffer.buffer, 0, indirectInit);
    
    // Run reset pass (clear instance count)
    const resetPass = commandEncoder.beginComputePass({
      label: 'gpu-cull-reset-pass',
    });
    resetPass.setPipeline(this.resetPipeline.pipeline);
    resetPass.setBindGroup(0, this.cullBindGroup);
    resetPass.dispatchWorkgroups(1);
    resetPass.end();
    
    // Run cull pass
    const cullPass = commandEncoder.beginComputePass({
      label: 'gpu-cull-pass',
    });
    cullPass.setPipeline(this.cullPipeline.pipeline);
    cullPass.setBindGroup(0, this.cullBindGroup);
    
    // Dispatch enough workgroups to cover all nodes
    const workgroupSize = 64;
    const workgroupCount = Math.ceil(this.lastNodeCount / workgroupSize);
    cullPass.dispatchWorkgroups(workgroupCount);
    cullPass.end();
  }
  
  /**
   * Get the indirect buffer for drawIndexedIndirect
   */
  getIndirectBuffer(): GPUBuffer | null {
    return this.indirectBuffer?.buffer ?? null;
  }
  
  /**
   * Get the visible nodes buffer for vertex shader
   * This contains the instance data for visible nodes
   */
  getVisibleNodesBuffer(): UnifiedGPUBuffer | null {
    return this.visibleNodesBuffer;
  }
  
  /**
   * Get last node count
   */
  getNodeCount(): number {
    return this.lastNodeCount;
  }
  
  /**
   * Check if pipeline is ready
   */
  isReady(): boolean {
    return this.cullPipeline !== null && this.cullBindGroup !== null;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.uniformBuffer?.destroy();
    this.inputNodesBuffer?.destroy();
    this.visibleNodesBuffer?.destroy();
    this.indirectBuffer?.destroy();
    
    this.uniformBuffer = null;
    this.inputNodesBuffer = null;
    this.visibleNodesBuffer = null;
    this.indirectBuffer = null;
    this.cullPipeline = null;
    this.resetPipeline = null;
    this.cullBindGroup = null;
    this.bindGroupLayout = null;
  }
}
