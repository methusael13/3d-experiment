/**
 * GridRendererGPU - UE5-style solid ground plane with procedural grid lines
 * 
 * Two rendering modes:
 * 1. Ground plane (scene pass): Solid dark grey ground with procedural grid lines,
 *    shadow receiving, directional lighting. Renders to HDR buffer with depth.
 * 2. Axis lines (viewport overlay): Colored X/Y/Z axis lines rendered after
 *    post-processing directly to backbuffer.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, CommonBlendStates, type VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import { SceneEnvironment } from './shared/SceneEnvironment';
import { ENV_BINDING_MASK } from './shared/types';
import { registerWGSLShader, unregisterWGSLShader, getWGSLShaderSource } from '../../../demos/sceneBuilder/shaderManager';

// Import shader
import gridShader from '../shaders/grid.wgsl?raw';

export interface GridRenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
}

/**
 * Parameters for ground plane rendering (scene pass)
 */
export interface GridGroundRenderParams {
  viewProjectionMatrix: mat4 | Float32Array;
  cameraPosition: [number, number, number];
  lightDirection: [number, number, number];
  lightColor: [number, number, number];
  ambientIntensity: number;
  lightSpaceMatrix?: mat4 | Float32Array;
  shadowEnabled: boolean;
  /** Shadow map resolution (needed for correct PCF texel size) */
  shadowResolution?: number;
}

/**
 * Uniform buffer layout for GridUniforms (must match grid.wgsl)
 * 
 * struct GridUniforms {
 *   viewProjection: mat4x4f,       // offset 0,   size 64
 *   lightSpaceMatrix: mat4x4f,     // offset 64,  size 64
 *   cameraPosition: vec3f,         // offset 128, size 12
 *   _pad0: f32,                    // offset 140, size 4
 *   lightDirection: vec3f,         // offset 144, size 12
 *   _pad1: f32,                    // offset 156, size 4
 *   lightColor: vec3f,             // offset 160, size 12
 *   ambientIntensity: f32,         // offset 172, size 4
 *   gridConfig: vec4f,             // offset 176, size 16
 * }
 * Total: 192 bytes
 */
const UNIFORM_SIZE = 192;

/** Vertex layout for axis lines: position (vec3f) + color (vec3f) */
const AXIS_VERTEX_LAYOUT: VertexBufferLayoutDesc = {
  arrayStride: 24,
  stepMode: 'vertex',
  attributes: [
    { format: 'float32x3', offset: 0, shaderLocation: 0 },
    { format: 'float32x3', offset: 12, shaderLocation: 1 },
  ],
};

/** Vertex layout for ground plane: position (vec3f) only */
const GROUND_VERTEX_LAYOUT: VertexBufferLayoutDesc = {
  arrayStride: 12,
  stepMode: 'vertex',
  attributes: [
    { format: 'float32x3', offset: 0, shaderLocation: 0 },
  ],
};

/**
 * Grid floor and axis renderer for scene visualization (WebGPU)
 */
export class GridRendererGPU {
  private ctx: GPUContext;
  
  // Current shader source (updated on live edit)
  private currentShaderSource: string = gridShader;
  
  // Ground plane pipeline (scene category - renders to HDR buffer)
  private groundPipeline: RenderPipelineWrapper | null = null;
  private groundBindGroupLayout: GPUBindGroupLayout | null = null;
  private groundBindGroup: GPUBindGroup | null = null;
  private groundVertexBuffer: UnifiedGPUBuffer;
  private groundVertexCount: number;
  private groundUniformBuffer: UnifiedGPUBuffer;
  
  // SceneEnvironment bind group layout for ground plane (Group 3)
  private envBindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Empty bind group layouts for Group 1 and Group 2 (unused by grid shader)
  private emptyBindGroupLayout: GPUBindGroupLayout | null = null;
  private emptyBindGroup: GPUBindGroup | null = null;
  
  // Axis lines pipeline (viewport category - renders to backbuffer)
  private axisPipeline: RenderPipelineWrapper;
  private axisBindGroupLayout: GPUBindGroupLayout;
  private axisBindGroup: GPUBindGroup;
  private axisVertexBuffer: UnifiedGPUBuffer;
  private axisVertexCount: number;
  private axisUniformBuffer: UnifiedGPUBuffer;
  
  // Grid configuration
  private gridExtent = 100;     // Size of ground plane in each direction
  private majorSpacing = 1.0;   // Major grid line spacing
  private minorSpacing = 0.1;   // Minor grid line spacing (10 subdivisions)
  
  // Uniform data buffer (reusable)
  private uniformData = new Float32Array(UNIFORM_SIZE / 4);
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Register grid shader for live editing
    registerWGSLShader('Grid', {
      device: ctx.device,
      source: gridShader,
      label: 'grid-shader',
      onRecompile: (_module: GPUShaderModule) => {
        const newSource = getWGSLShaderSource('Grid');
        if (newSource) {
          this.currentShaderSource = newSource;
          this.rebuildPipelines();
        }
      },
    });
    
    // ========== GROUND PLANE SETUP ==========
    
    // Create uniform buffer for ground plane
    this.groundUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'grid-ground-uniforms',
      size: UNIFORM_SIZE,
    });
    
    // Generate ground plane quad geometry
    const groundData = this.generateGroundGeometry();
    this.groundVertexBuffer = UnifiedGPUBuffer.createVertex(ctx, {
      label: 'grid-ground-vertex-buffer',
      data: groundData.vertices,
    });
    this.groundVertexCount = groundData.count;
    
    // ========== AXIS LINES SETUP ==========
    
    // Create uniform buffer for axis lines
    this.axisUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'grid-axis-uniforms',
      size: UNIFORM_SIZE, // Reuse same struct size for simplicity
    });
    
    // Create axis bind group layout
    this.axisBindGroupLayout = new BindGroupLayoutBuilder('grid-axis-bind-layout')
      .uniformBuffer(0, 'vertex')
      .build(ctx);
    
    // Create axis bind group
    this.axisBindGroup = new BindGroupBuilder('grid-axis-bind-group')
      .buffer(0, this.axisUniformBuffer)
      .build(ctx, this.axisBindGroupLayout);
    
    // Create axis render pipeline
    this.axisPipeline = this.createAxisPipeline();
    
    // Generate axis geometry
    const axisData = this.generateAxisGeometry();
    this.axisVertexBuffer = UnifiedGPUBuffer.createVertex(ctx, {
      label: 'grid-axis-vertex-buffer',
      data: axisData.vertices,
    });
    this.axisVertexCount = axisData.count;
  }
  
  // ========== Pipeline Creation Helpers ==========
  
  /**
   * Create the axis lines pipeline (swap chain format for viewport overlay)
   */
  private createAxisPipeline(): RenderPipelineWrapper {
    return RenderPipelineWrapper.create(this.ctx, {
      label: 'grid-axis-pipeline',
      vertexShader: this.currentShaderSource,
      fragmentShader: this.currentShaderSource,
      vertexEntryPoint: 'vs_axis',
      fragmentEntryPoint: 'fs_axis',
      vertexBuffers: [AXIS_VERTEX_LAYOUT],
      bindGroupLayouts: [this.axisBindGroupLayout],
      topology: 'line-list',
      cullMode: 'none',
      depthFormat: 'depth24plus',
      depthWriteEnabled: false,
      depthCompare: 'greater-equal',  // Reversed-Z
      colorFormats: [this.ctx.format], // Swap chain format (viewport overlay)
    });
  }
  
  /**
   * Create the ground plane pipeline (HDR format for scene pass).
   * Requires bind group layouts to be initialized first.
   */
  private createGroundPipeline(): RenderPipelineWrapper {
    return RenderPipelineWrapper.create(this.ctx, {
      label: 'grid-ground-pipeline',
      vertexShader: this.currentShaderSource,
      fragmentShader: this.currentShaderSource,
      vertexEntryPoint: 'vs_ground',
      fragmentEntryPoint: 'fs_ground',
      vertexBuffers: [GROUND_VERTEX_LAYOUT],
      bindGroupLayouts: [
        this.groundBindGroupLayout!,      // Group 0: uniforms
        this.emptyBindGroupLayout!,       // Group 1: unused
        this.emptyBindGroupLayout!,       // Group 2: unused
        this.envBindGroupLayout!,         // Group 3: SceneEnvironment (shadow + IBL + CSM)
      ],
      topology: 'triangle-list',
      cullMode: 'none',
      depthFormat: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z
      colorFormats: ['rgba16float'], // HDR format for scene pass
      blendStates: [CommonBlendStates.alpha()], // Alpha blending for edge fade
    });
  }
  
  /**
   * Initialize the ground plane pipeline with SceneEnvironment for shadow support.
   * Must be called after SceneEnvironment is available (lazy init on first render).
   */
  initGroundPipeline(sceneEnvironment: SceneEnvironment): void {
    if (this.groundPipeline) return; // Already initialized
    
    // Get full SceneEnvironment bind group layout (all bindings: shadow + IBL + CSM)
    this.envBindGroupLayout = sceneEnvironment.getLayoutForMask(ENV_BINDING_MASK.ALL);
    
    // Create empty bind group layout for unused groups 1 and 2
    this.emptyBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'grid-empty-bind-layout',
      entries: [],
    });
    this.emptyBindGroup = this.ctx.device.createBindGroup({
      label: 'grid-empty-bind-group',
      layout: this.emptyBindGroupLayout,
      entries: [],
    });
    
    // Create ground plane bind group layout (Group 0 = uniforms)
    this.groundBindGroupLayout = new BindGroupLayoutBuilder('grid-ground-bind-layout')
      .uniformBuffer(0, 'all')
      .build(this.ctx);
    
    // Create ground plane bind group
    this.groundBindGroup = new BindGroupBuilder('grid-ground-bind-group')
      .buffer(0, this.groundUniformBuffer)
      .build(this.ctx, this.groundBindGroupLayout);
    
    // Create ground plane render pipeline (HDR format for scene pass)
    this.groundPipeline = this.createGroundPipeline();
  }
  
  /**
   * Rebuild both pipelines after shader live-edit.
   */
  private rebuildPipelines(): void {
    try {
      this.axisPipeline = this.createAxisPipeline();
    } catch (e) {
      console.warn('[GridRendererGPU] Failed to rebuild axis pipeline:', e);
    }
    
    // Rebuild ground pipeline only if it was previously initialized
    if (this.groundPipeline && this.groundBindGroupLayout && this.emptyBindGroupLayout && this.envBindGroupLayout) {
      try {
        this.groundPipeline = this.createGroundPipeline();
        console.log('[GridRendererGPU] Pipelines rebuilt with live-edited shader');
      } catch (e) {
        console.warn('[GridRendererGPU] Failed to rebuild ground pipeline:', e);
      }
    }
  }
  
  /**
   * Generate ground plane quad geometry (large XZ plane)
   */
  private generateGroundGeometry(): { vertices: Float32Array; count: number } {
    const e = this.gridExtent;
    
    // Two triangles forming a quad on XZ plane at Y=0
    const vertices = new Float32Array([
      // Triangle 1
      -e, 0, -e,
       e, 0, -e,
       e, 0,  e,
      // Triangle 2
      -e, 0, -e,
       e, 0,  e,
      -e, 0,  e,
    ]);
    
    return {
      vertices,
      count: 6, // 2 triangles × 3 vertices
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
   * Write uniform data for the ground plane
   */
  private writeGroundUniforms(params: GridGroundRenderParams): void {
    const d = this.uniformData;
    
    // viewProjection (offset 0, 16 floats)
    const vp = params.viewProjectionMatrix as Float32Array;
    for (let i = 0; i < 16; i++) d[i] = vp[i];
    
    // lightSpaceMatrix (offset 16, 16 floats)
    if (params.lightSpaceMatrix) {
      const lsm = params.lightSpaceMatrix as Float32Array;
      for (let i = 0; i < 16; i++) d[16 + i] = lsm[i];
    } else {
      // Identity matrix when no shadow
      d.fill(0, 16, 32);
      d[16] = 1; d[21] = 1; d[26] = 1; d[31] = 1;
    }
    
    // cameraPosition (offset 32, 3 floats + 1 pad)
    d[32] = params.cameraPosition[0];
    d[33] = params.cameraPosition[1];
    d[34] = params.cameraPosition[2];
    d[35] = 0; // pad
    
    // lightDirection (offset 36, 3 floats + 1 pad) - normalize
    const ld = params.lightDirection;
    const len = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]);
    d[36] = len > 0 ? ld[0] / len : 0;
    d[37] = len > 0 ? ld[1] / len : 1;
    d[38] = len > 0 ? ld[2] / len : 0;
    d[39] = 0; // pad
    
    // lightColor (offset 40, 3 floats) + ambientIntensity (offset 43, 1 float)
    d[40] = params.lightColor[0];
    d[41] = params.lightColor[1];
    d[42] = params.lightColor[2];
    d[43] = params.ambientIntensity;
    
    // gridConfig (offset 44, 4 floats): x=gridExtent, y=majorSpacing, z=minorSpacing, w=shadowResolution (0=disabled)
    d[44] = this.gridExtent;
    d[45] = this.majorSpacing;
    d[46] = this.minorSpacing;
    // Encode shadow resolution as gridConfig.w: 0 = shadows disabled, >0 = resolution (e.g. 2048, 4096)
    d[47] = params.shadowEnabled ? (params.shadowResolution ?? 2048) : 0.0;
    
    this.groundUniformBuffer.write(this.ctx, d);
  }
  
  /**
   * Render the ground plane (scene pass - HDR buffer with depth)
   * 
   * @param passEncoder - The render pass encoder (scene pass)
   * @param params - Ground rendering parameters
   * @param sceneEnvironment - SceneEnvironment for shadow bind group
   */
  renderGround(
    passEncoder: GPURenderPassEncoder,
    params: GridGroundRenderParams,
    sceneEnvironment: SceneEnvironment
  ): void {
    // Ensure ground pipeline is initialized
    if (!this.groundPipeline) {
      this.initGroundPipeline(sceneEnvironment);
    }
    
    if (!this.groundPipeline || !this.groundBindGroup) return;
    
    // Update uniforms
    this.writeGroundUniforms(params);
    
    // Get full SceneEnvironment bind group (all bindings: shadow + IBL + CSM)
    const envBindGroup = sceneEnvironment.getBindGroupForMask(ENV_BINDING_MASK.ALL);
    
    // Set pipeline and bind groups
    passEncoder.setPipeline(this.groundPipeline.pipeline);
    passEncoder.setBindGroup(0, this.groundBindGroup);
    passEncoder.setBindGroup(1, this.emptyBindGroup!);
    passEncoder.setBindGroup(2, this.emptyBindGroup!);
    passEncoder.setBindGroup(3, envBindGroup);
    
    // Draw ground quad
    passEncoder.setVertexBuffer(0, this.groundVertexBuffer.buffer);
    passEncoder.draw(this.groundVertexCount);
  }
  
  /**
   * Render axis lines (viewport overlay - after post-processing)
   * 
   * @param passEncoder - The render pass encoder (viewport pass)
   * @param vpMatrix - View-projection matrix
   */
  renderAxes(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
  ): void {
    // Update uniform buffer with view-projection matrix
    // We reuse the same uniform struct layout; only viewProjection matters for axes
    const d = this.uniformData;
    d.fill(0);
    const vp = vpMatrix as Float32Array;
    for (let i = 0; i < 16; i++) d[i] = vp[i];
    this.axisUniformBuffer.write(this.ctx, d);
    
    // Set pipeline and bind group
    passEncoder.setPipeline(this.axisPipeline.pipeline);
    passEncoder.setBindGroup(0, this.axisBindGroup);
    
    // Draw axes
    passEncoder.setVertexBuffer(0, this.axisVertexBuffer.buffer);
    passEncoder.draw(this.axisVertexCount);
  }
  
  /**
   * Render method for overlay pass compatibility.
   * Ground plane is now rendered separately via renderGround() in the scene pass.
   * This only renders axis lines.
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
    const { showAxes = true } = options;
    
    // Only render axes in overlay pass (ground is now in scene pass)
    if (showAxes) {
      this.renderAxes(passEncoder, vpMatrix);
    }
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    unregisterWGSLShader('Grid');
    this.groundUniformBuffer.destroy();
    this.groundVertexBuffer.destroy();
    this.axisUniformBuffer.destroy();
    this.axisVertexBuffer.destroy();
  }
}