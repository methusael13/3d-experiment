/**
 * GridRendererGPU - WebGPU port of GridRenderer
 * 
 * Renders a grid floor and axis indicators for scene visualization.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';

// Import shader
import gridShader from '../shaders/grid.wgsl?raw';

export interface GridRenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
}

/**
 * Grid floor and axis renderer for scene visualization (WebGPU)
 */
export class GridRendererGPU {
  private ctx: GPUContext;
  private pipeline: RenderPipelineWrapper;
  private bindGroupLayout: GPUBindGroupLayout;
  private bindGroup: GPUBindGroup;
  
  // Buffers
  private uniformBuffer: UnifiedGPUBuffer;
  private gridVertexBuffer: UnifiedGPUBuffer;
  private axisVertexBuffer: UnifiedGPUBuffer;
  
  private gridVertexCount: number;
  private axisVertexCount: number;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Create uniform buffer for view-projection matrix (64 bytes = mat4x4f)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'grid-uniforms',
      size: 64,
    });
    
    // Create bind group layout
    this.bindGroupLayout = new BindGroupLayoutBuilder('grid-bind-layout')
      .uniformBuffer(0, 'vertex')
      .build(ctx);
    
    // Create bind group
    this.bindGroup = new BindGroupBuilder('grid-bind-group')
      .buffer(0, this.uniformBuffer)
      .build(ctx, this.bindGroupLayout);
    
    // Create vertex buffer layout
    const vertexLayout: VertexBufferLayoutDesc = {
      arrayStride: 24, // 3 floats position + 3 floats color = 24 bytes
      stepMode: 'vertex',
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },  // position
        { format: 'float32x3', offset: 12, shaderLocation: 1 }, // color
      ],
    };
    
    // Create render pipeline (swap chain format for viewport overlay)
    // Grid renders AFTER post-processing, directly to backbuffer
    this.pipeline = RenderPipelineWrapper.create(ctx, {
      label: 'grid-pipeline',
      vertexShader: gridShader,
      fragmentShader: gridShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [vertexLayout],
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'line-list',
      cullMode: 'none',
      depthFormat: 'depth24plus',
      depthWriteEnabled: false, // Grid renders in overlay, no depth write
      depthCompare: 'greater-equal',  // Reversed-Z: use greater-equal for overlay
      colorFormats: [ctx.format], // Swap chain format (viewport overlay, not HDR)
    });
    
    // Generate grid geometry
    const gridData = this.generateGridGeometry();
    this.gridVertexBuffer = UnifiedGPUBuffer.createVertex(ctx, {
      label: 'grid-vertex-buffer',
      data: gridData.vertices,
    });
    this.gridVertexCount = gridData.count;
    
    // Generate axis geometry
    const axisData = this.generateAxisGeometry();
    this.axisVertexBuffer = UnifiedGPUBuffer.createVertex(ctx, {
      label: 'axis-vertex-buffer',
      data: axisData.vertices,
    });
    this.axisVertexCount = axisData.count;
  }
  
  /**
   * Generate grid line geometry on XZ plane
   */
  private generateGridGeometry(): { vertices: Float32Array; count: number } {
    const gridSize = 10;
    const gridStep = 1;
    const gridColor = [0.3, 0.3, 0.35]; // Dark grey
    const vertices: number[] = [];
    
    for (let i = -gridSize; i <= gridSize; i += gridStep) {
      if (i === 0) continue; // Skip center lines (axis lines drawn there)
      
      // Lines parallel to Z axis
      vertices.push(i, 0, -gridSize, ...gridColor);
      vertices.push(i, 0, gridSize, ...gridColor);
      
      // Lines parallel to X axis
      vertices.push(-gridSize, 0, i, ...gridColor);
      vertices.push(gridSize, 0, i, ...gridColor);
    }
    
    return {
      vertices: new Float32Array(vertices),
      count: vertices.length / 6,
    };
  }
  
  /**
   * Generate axis line geometry
   */
  private generateAxisGeometry(): { vertices: Float32Array; count: number } {
    const axisLength = 5;
    const vertices = new Float32Array([
      // X axis (red) - negative to positive
      -axisLength, 0, 0, 0.8, 0.2, 0.2,
      axisLength, 0, 0, 1.0, 0.3, 0.3,
      // Y axis (green) - negative to positive
      0, -axisLength, 0, 0.2, 0.6, 0.2,
      0, axisLength, 0, 0.3, 0.9, 0.3,
      // Z axis (blue) - negative to positive
      0, 0, -axisLength, 0.2, 0.2, 0.8,
      0, 0, axisLength, 0.3, 0.3, 1.0,
    ]);
    
    return {
      vertices,
      count: vertices.length / 6,
    };
  }
  
  /**
   * Render grid and axes
   * 
   * @param passEncoder - The render pass encoder
   * @param vpMatrix - View-projection matrix
   * @param options - Render options (showGrid, showAxes)
   */
  render(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    options: GridRenderOptions = {}
  ): void {
    const { showGrid = true, showAxes = true } = options;
    
    // Update uniform buffer with view-projection matrix
    this.uniformBuffer.write(this.ctx, vpMatrix as Float32Array);
    
    // Set pipeline and bind group
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    
    // Draw grid
    if (showGrid) {
      passEncoder.setVertexBuffer(0, this.gridVertexBuffer.buffer);
      passEncoder.draw(this.gridVertexCount);
    }
    
    // Draw axes
    if (showAxes) {
      passEncoder.setVertexBuffer(0, this.axisVertexBuffer.buffer);
      passEncoder.draw(this.axisVertexCount);
    }
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.uniformBuffer.destroy();
    this.gridVertexBuffer.destroy();
    this.axisVertexBuffer.destroy();
  }
}
