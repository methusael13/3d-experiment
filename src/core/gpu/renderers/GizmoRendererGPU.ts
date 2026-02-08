/**
 * GizmoRendererGPU - WebGPU renderer for transform gizmos
 *
 * Renders unlit colored geometry for translate, rotate, and scale gizmos.
 * Provides pre-built geometry buffers for gizmo primitives.
 * 
 * Note: Uses 3 separate uniform buffers (one per axis) to avoid the WebGPU
 * timing issue where queue.writeBuffer() executes immediately but draw commands
 * are batched. With a single buffer, all draws would see the last written color.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';

// Import shader
import gizmoShader from '../shaders/gizmo.wgsl?raw';

/** RGBA color with alpha */
export type GizmoColor = [number, number, number, number];

/** Gizmo draw command */
export interface GizmoDrawCommand {
  geometryType: 'translate-lines' | 'translate-arrows' | 'rotate-ring' | 'scale-lines' | 'scale-boxes';
  axisIndex: 0 | 1 | 2; // 0=X, 1=Y, 2=Z
  modelMatrix: mat4 | Float32Array;
  color: GizmoColor;
}

/**
 * Uniform buffer layout (must match gizmo.wgsl):
 * - viewProjection: mat4x4f (64 bytes)
 * - model: mat4x4f (64 bytes)
 * - color: vec4f (16 bytes)
 * Total: 144 bytes
 */
const UNIFORM_SIZE = 144;

/**
 * Gizmo renderer for WebGPU
 */
export class GizmoRendererGPU {
  private ctx: GPUContext;

  // Pipelines
  private linePipeline: RenderPipelineWrapper;
  private trianglePipeline: RenderPipelineWrapper;
  private bindGroupLayout: GPUBindGroupLayout;

  // Per-axis uniform buffers and bind groups (3 = one per axis)
  // This solves the WebGPU timing issue: each axis has its own buffer that
  // won't be overwritten before the GPU executes the draw command.
  private uniformBuffers: [UnifiedGPUBuffer, UnifiedGPUBuffer, UnifiedGPUBuffer];
  private bindGroups: [GPUBindGroup, GPUBindGroup, GPUBindGroup];

  // Pre-built geometry buffers

  // Translate gizmo: axis lines (3 lines, 6 vertices)
  private translateLinesBuffer: UnifiedGPUBuffer;
  private translateLinesCount = 6;

  // Translate gizmo: arrow heads (3 axes × 6 triangles = 18 triangles, 54 vertices)
  private translateArrowsBuffer: UnifiedGPUBuffer;
  private translateArrowsVertices = 18; // Per axis

  // Rotate gizmo: ring segments for each axis (stored separately for front/back culling)
  // Pre-computed ring with 64 segments
  private rotateRingBuffer: UnifiedGPUBuffer;
  private rotateRingSegments = 64;

  // Scale gizmo: axis lines (same as translate)
  private scaleLinesBuffer: UnifiedGPUBuffer;
  private scaleLinesCount = 6;

  // Scale gizmo: endpoint boxes (3 axes × 36 vertices = 108 vertices)
  private scaleBoxesBuffer: UnifiedGPUBuffer;
  private scaleBoxVertices = 36; // Per axis

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    // Create bind group layout
    this.bindGroupLayout = new BindGroupLayoutBuilder('gizmo-bind-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);

    // Create 3 uniform buffers and bind groups (one per axis)
    this.uniformBuffers = [
      UnifiedGPUBuffer.createUniform(ctx, { label: 'gizmo-uniforms-x', size: UNIFORM_SIZE }),
      UnifiedGPUBuffer.createUniform(ctx, { label: 'gizmo-uniforms-y', size: UNIFORM_SIZE }),
      UnifiedGPUBuffer.createUniform(ctx, { label: 'gizmo-uniforms-z', size: UNIFORM_SIZE }),
    ];

    this.bindGroups = [
      new BindGroupBuilder('gizmo-bind-group-x').buffer(0, this.uniformBuffers[0]).build(ctx, this.bindGroupLayout),
      new BindGroupBuilder('gizmo-bind-group-y').buffer(0, this.uniformBuffers[1]).build(ctx, this.bindGroupLayout),
      new BindGroupBuilder('gizmo-bind-group-z').buffer(0, this.uniformBuffers[2]).build(ctx, this.bindGroupLayout),
    ];

    // Vertex layout: position only (vec3f, 12 bytes)
    const vertexLayout: VertexBufferLayoutDesc = {
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
    };

    // Create line pipeline (for axis lines and rotation rings)
    // No depth stencil - gizmos render on top of everything (overlay)
    this.linePipeline = RenderPipelineWrapper.create(ctx, {
      label: 'gizmo-line-pipeline',
      vertexShader: gizmoShader,
      fragmentShader: gizmoShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [vertexLayout],
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'line-list',
      cullMode: 'none',
      colorFormats: [ctx.format], // Swap chain format (viewport overlay)
      // No depth testing - gizmos always visible on top
    });

    // Create triangle pipeline (for arrow heads and scale boxes)
    // No depth stencil - gizmos render on top of everything (overlay)
    this.trianglePipeline = RenderPipelineWrapper.create(ctx, {
      label: 'gizmo-triangle-pipeline',
      vertexShader: gizmoShader,
      fragmentShader: gizmoShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [vertexLayout],
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none', // No culling for gizmos (always visible)
      colorFormats: [ctx.format], // Swap chain format (viewport overlay)
      // No depth testing - gizmos always visible on top
    });

    // Generate geometry buffers
    this.translateLinesBuffer = this.createTranslateLinesBuffer();
    this.translateArrowsBuffer = this.createTranslateArrowsBuffer();
    this.rotateRingBuffer = this.createRotateRingBuffer();
    this.scaleLinesBuffer = this.createScaleLinesBuffer();
    this.scaleBoxesBuffer = this.createScaleBoxesBuffer();
  }

  // ==================== Geometry Generation ====================

  private createTranslateLinesBuffer(): UnifiedGPUBuffer {
    const L = 1.0; // Axis length (scaled by model matrix)
    const vertices = new Float32Array([
      // X axis
      0, 0, 0, L, 0, 0,
      // Y axis
      0, 0, 0, 0, L, 0,
      // Z axis
      0, 0, 0, 0, 0, L,
    ]);

    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'gizmo-translate-lines',
      data: vertices,
    });
  }

  private createTranslateArrowsBuffer(): UnifiedGPUBuffer {
    const L = 1.0;
    const S = 0.08; // Arrow size

    // Arrow cone approximation (2 triangles per axis)
    const vertices = new Float32Array([
      // X arrow
      L + S * 2, 0, 0, L, S, 0, L, -S, 0,
      L + S * 2, 0, 0, L, 0, S, L, 0, -S,
      // Y arrow
      0, L + S * 2, 0, S, L, 0, -S, L, 0,
      0, L + S * 2, 0, 0, L, S, 0, L, -S,
      // Z arrow
      0, 0, L + S * 2, S, 0, L, -S, 0, L,
      0, 0, L + S * 2, 0, S, L, 0, -S, L,
    ]);

    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'gizmo-translate-arrows',
      data: vertices,
    });
  }

  private createRotateRingBuffer(): UnifiedGPUBuffer {
    // Create ring geometry for all 3 axes as triangle strips (for thickness)
    // WebGPU doesn't support line width, so we render ribbons instead
    const segments = this.rotateRingSegments;
    const R = 0.8; // Ring radius
    const T = 0.025; // Ribbon thickness (half-width)

    // 3 axes × segments × 6 vertices per segment (2 triangles = quad)
    const vertices: number[] = [];

    // X axis ring (YZ plane) - ribbon perpendicular to X axis
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      
      // Inner and outer radii for ribbon
      const Ri = R - T;
      const Ro = R + T;
      
      // Two triangles forming a quad segment
      // Triangle 1: inner1, outer1, outer2
      vertices.push(0, Math.cos(a1) * Ri, Math.sin(a1) * Ri);
      vertices.push(0, Math.cos(a1) * Ro, Math.sin(a1) * Ro);
      vertices.push(0, Math.cos(a2) * Ro, Math.sin(a2) * Ro);
      // Triangle 2: inner1, outer2, inner2
      vertices.push(0, Math.cos(a1) * Ri, Math.sin(a1) * Ri);
      vertices.push(0, Math.cos(a2) * Ro, Math.sin(a2) * Ro);
      vertices.push(0, Math.cos(a2) * Ri, Math.sin(a2) * Ri);
    }

    // Y axis ring (XZ plane) - ribbon perpendicular to Y axis
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      
      const Ri = R - T;
      const Ro = R + T;
      
      vertices.push(Math.cos(a1) * Ri, 0, Math.sin(a1) * Ri);
      vertices.push(Math.cos(a1) * Ro, 0, Math.sin(a1) * Ro);
      vertices.push(Math.cos(a2) * Ro, 0, Math.sin(a2) * Ro);
      vertices.push(Math.cos(a1) * Ri, 0, Math.sin(a1) * Ri);
      vertices.push(Math.cos(a2) * Ro, 0, Math.sin(a2) * Ro);
      vertices.push(Math.cos(a2) * Ri, 0, Math.sin(a2) * Ri);
    }

    // Z axis ring (XY plane) - ribbon perpendicular to Z axis
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      
      const Ri = R - T;
      const Ro = R + T;
      
      vertices.push(Math.cos(a1) * Ri, Math.sin(a1) * Ri, 0);
      vertices.push(Math.cos(a1) * Ro, Math.sin(a1) * Ro, 0);
      vertices.push(Math.cos(a2) * Ro, Math.sin(a2) * Ro, 0);
      vertices.push(Math.cos(a1) * Ri, Math.sin(a1) * Ri, 0);
      vertices.push(Math.cos(a2) * Ro, Math.sin(a2) * Ro, 0);
      vertices.push(Math.cos(a2) * Ri, Math.sin(a2) * Ri, 0);
    }

    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'gizmo-rotate-ring',
      data: new Float32Array(vertices),
    });
  }

  private createScaleLinesBuffer(): UnifiedGPUBuffer {
    // Same as translate lines
    return this.createTranslateLinesBuffer();
  }

  private createScaleBoxesBuffer(): UnifiedGPUBuffer {
    const L = 1.0;
    const s = 0.06; // Box half-size

    const vertices: number[] = [];

    const addBox = (cx: number, cy: number, cz: number) => {
      // Front face
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy - s, cz + s, cx + s, cy + s, cz + s);
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy + s, cz + s, cx - s, cy + s, cz + s);
      // Back face
      vertices.push(cx + s, cy - s, cz - s, cx - s, cy - s, cz - s, cx - s, cy + s, cz - s);
      vertices.push(cx + s, cy - s, cz - s, cx - s, cy + s, cz - s, cx + s, cy + s, cz - s);
      // Top face
      vertices.push(cx - s, cy + s, cz - s, cx - s, cy + s, cz + s, cx + s, cy + s, cz + s);
      vertices.push(cx - s, cy + s, cz - s, cx + s, cy + s, cz + s, cx + s, cy + s, cz - s);
      // Bottom face
      vertices.push(cx - s, cy - s, cz + s, cx - s, cy - s, cz - s, cx + s, cy - s, cz - s);
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy - s, cz - s, cx + s, cy - s, cz + s);
      // Right face
      vertices.push(cx + s, cy - s, cz + s, cx + s, cy - s, cz - s, cx + s, cy + s, cz - s);
      vertices.push(cx + s, cy - s, cz + s, cx + s, cy + s, cz - s, cx + s, cy + s, cz + s);
      // Left face
      vertices.push(cx - s, cy - s, cz - s, cx - s, cy - s, cz + s, cx - s, cy + s, cz + s);
      vertices.push(cx - s, cy - s, cz - s, cx - s, cy + s, cz + s, cx - s, cy + s, cz - s);
    };

    // X axis box at (L, 0, 0)
    addBox(L, 0, 0);
    // Y axis box at (0, L, 0)
    addBox(0, L, 0);
    // Z axis box at (0, 0, L)
    addBox(0, 0, L);

    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'gizmo-scale-boxes',
      data: new Float32Array(vertices),
    });
  }

  // ==================== Rendering ====================

  /**
   * Update uniform buffer for a specific axis with view-projection matrix, model matrix, and color
   */
  private updateAxisUniforms(
    axisIndex: 0 | 1 | 2,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    color: GizmoColor
  ): void {
    const data = new Float32Array(UNIFORM_SIZE / 4);

    // Copy view-projection matrix (offset 0, 16 floats)
    data.set(vpMatrix as Float32Array, 0);

    // Copy model matrix (offset 16, 16 floats)
    data.set(modelMatrix as Float32Array, 16);

    // Copy color (offset 32, 4 floats)
    data.set(color, 32);

    this.uniformBuffers[axisIndex].write(this.ctx, data);
  }

  /**
   * Render translate gizmo lines (X, Y, Z axis lines)
   */
  renderTranslateLines(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisColors: [GizmoColor, GizmoColor, GizmoColor]
  ): void {
    passEncoder.setPipeline(this.linePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.translateLinesBuffer.buffer);

    // Update all 3 uniform buffers FIRST, then issue draws
    // This ensures each buffer has its correct value before GPU executes
    for (let i = 0; i < 3; i++) {
      this.updateAxisUniforms(i as 0 | 1 | 2, vpMatrix, modelMatrix, axisColors[i]);
    }

    // Now issue draw commands - each uses its own bind group/buffer
    for (let i = 0; i < 3; i++) {
      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.draw(2, 1, i * 2, 0);
    }
  }

  /**
   * Render translate gizmo arrow heads
   */
  renderTranslateArrows(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisColors: [GizmoColor, GizmoColor, GizmoColor]
  ): void {
    passEncoder.setPipeline(this.trianglePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.translateArrowsBuffer.buffer);

    // Update all 3 uniform buffers FIRST
    for (let i = 0; i < 3; i++) {
      this.updateAxisUniforms(i as 0 | 1 | 2, vpMatrix, modelMatrix, axisColors[i]);
    }

    // Draw each axis arrow (6 vertices per axis = 2 triangles)
    for (let i = 0; i < 3; i++) {
      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.draw(6, 1, i * 6, 0);
    }
  }

  /**
   * Render rotation ring for a single axis (as triangle ribbon for thickness)
   */
  renderRotateRing(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisIndex: 0 | 1 | 2,
    color: GizmoColor
  ): void {
    // Use triangle pipeline for ribbon geometry
    passEncoder.setPipeline(this.trianglePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.rotateRingBuffer.buffer);

    this.updateAxisUniforms(axisIndex, vpMatrix, modelMatrix, color);
    passEncoder.setBindGroup(0, this.bindGroups[axisIndex]);

    // Each axis ring has SEGMENTS * 6 vertices (2 triangles per segment)
    const verticesPerRing = this.rotateRingSegments * 6;
    passEncoder.draw(verticesPerRing, 1, axisIndex * verticesPerRing, 0);
  }

  /**
   * Render all rotation rings (as triangle ribbons for thickness)
   */
  renderRotateRings(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisColors: [GizmoColor, GizmoColor, GizmoColor]
  ): void {
    // Use triangle pipeline for ribbon geometry
    passEncoder.setPipeline(this.trianglePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.rotateRingBuffer.buffer);

    // Update all 3 uniform buffers FIRST
    for (let i = 0; i < 3; i++) {
      this.updateAxisUniforms(i as 0 | 1 | 2, vpMatrix, modelMatrix, axisColors[i]);
    }

    // Draw all 3 rings (6 vertices per segment = 2 triangles)
    const verticesPerRing = this.rotateRingSegments * 6;
    for (let i = 0; i < 3; i++) {
      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.draw(verticesPerRing, 1, i * verticesPerRing, 0);
    }
  }

  /**
   * Render scale gizmo lines
   */
  renderScaleLines(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisColors: [GizmoColor, GizmoColor, GizmoColor]
  ): void {
    passEncoder.setPipeline(this.linePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.scaleLinesBuffer.buffer);

    // Update all 3 uniform buffers FIRST
    for (let i = 0; i < 3; i++) {
      this.updateAxisUniforms(i as 0 | 1 | 2, vpMatrix, modelMatrix, axisColors[i]);
    }

    // Draw all 3 axis lines
    for (let i = 0; i < 3; i++) {
      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.draw(2, 1, i * 2, 0);
    }
  }

  /**
   * Render scale gizmo endpoint boxes
   */
  renderScaleBoxes(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    modelMatrix: mat4 | Float32Array,
    axisColors: [GizmoColor, GizmoColor, GizmoColor]
  ): void {
    passEncoder.setPipeline(this.trianglePipeline.pipeline);
    passEncoder.setVertexBuffer(0, this.scaleBoxesBuffer.buffer);

    // Update all 3 uniform buffers FIRST
    for (let i = 0; i < 3; i++) {
      this.updateAxisUniforms(i as 0 | 1 | 2, vpMatrix, modelMatrix, axisColors[i]);
    }

    // Draw each axis box (36 vertices per axis = 12 triangles)
    for (let i = 0; i < 3; i++) {
      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.draw(this.scaleBoxVertices, 1, i * this.scaleBoxVertices, 0);
    }
  }

  /**
   * Clean up GPU resources
   */
  destroy(): void {
    for (const buffer of this.uniformBuffers) {
      buffer.destroy();
    }
    this.translateLinesBuffer.destroy();
    this.translateArrowsBuffer.destroy();
    this.rotateRingBuffer.destroy();
    this.scaleLinesBuffer.destroy();
    this.scaleBoxesBuffer.destroy();
  }
}
