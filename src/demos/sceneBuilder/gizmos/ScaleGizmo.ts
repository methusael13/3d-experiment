/**
 * ScaleGizmo - Box-based axis scale gizmo
 * Extends BaseGizmo with cube handles at axis endpoints
 */

import { mat4, vec3 } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis } from './BaseGizmo';
import type { GizmoRendererGPU } from '@/core/gpu/renderers/GizmoRendererGPU';

export class ScaleGizmo extends BaseGizmo {
  private static readonly AXIS_LENGTH = 1.0;
  private static readonly BOX_SIZE = 0.06;
  
  private dragStartPos: [number, number] = [0, 0];
  private dragStartScale: [number, number, number] = [1, 1, 1];

  constructor(camera: GizmoCamera) {
    super(camera);
  }

  /**
   * Override setupModelMatrix to apply rotation in local mode
   */
  protected setupModelMatrix(): void {
    mat4.identity(this.modelMatrix);
    mat4.translate(this.modelMatrix, this.modelMatrix, this.targetPosition as unknown as vec3);
    
    // In local mode, apply object rotation so gizmo axes align with object
    if (this.orientation === 'local') {
      const rotMat = this.getRotationMatrix();
      mat4.multiply(this.modelMatrix, this.modelMatrix, rotMat);
    }
    
    const scale = this.getScreenSpaceScale();
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
  }
  
  /**
   * Override getAxisEndpoint to return rotated endpoints in local mode
   */
  protected getAxisEndpoint(axis: 'x' | 'y' | 'z', length = 1.0): [number, number, number] {
    const scale = this.getScreenSpaceScale();
    const scaledLength = length * scale;
    
    // Get axis direction (rotated in local mode)
    const axisDir = this.getAxisDirection(axis);
    
    return [
      this.targetPosition[0] + axisDir[0] * scaledLength,
      this.targetPosition[1] + axisDir[1] * scaledLength,
      this.targetPosition[2] + axisDir[2] * scaledLength,
    ];
  }
  
  private hitTestAxis(screenX: number, screenY: number): GizmoAxis {
    const L = ScaleGizmo.AXIS_LENGTH;
    const hitRadius = 30;
    
    for (const axis of ['x', 'y', 'z'] as const) {
      const screenPos = this.projectToScreen(this.getAxisEndpoint(axis, L));
      const distance = Math.sqrt((screenX - screenPos[0]) ** 2 + (screenY - screenPos[1]) ** 2);
      if (distance < hitRadius) return axis;
    }
    return null;
  }
  
  handleMouseDown(screenX: number, screenY: number): boolean {
    if (!this.enabled) return false;
    const axis = this.hitTestAxis(screenX, screenY);
    if (axis) {
      this.isDraggingFlag = true;
      this.activeAxis = axis;
      this.dragStartPos = [screenX, screenY];
      this.dragStartScale = [...this.targetScale];
      return true;
    }
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    const axisIndex = { x: 0, y: 1, z: 2 }[this.activeAxis];
    const dx = screenX - this.dragStartPos[0];
    const dy = screenY - this.dragStartPos[1];
    const delta = (dx - dy) * 0.01;
    
    // Scale is always applied along local axes (this is standard behavior)
    this.targetScale[axisIndex] = Math.max(0.01, this.dragStartScale[axisIndex] + delta);
    
    if (this.onTransformChange) this.onTransformChange('scale', [...this.targetScale]);
    return true;
  }
  
  handleMouseUp(): void {
    this.isDraggingFlag = false;
    this.activeAxis = null;
  }
  
  // ==================== WebGPU Rendering ====================
  
  renderGPU(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU
  ): void {
    if (!this.enabled) return;
    
    const modelMatrix = this.buildGPUModelMatrix();
    const axisColors = this.getGPUAxisColors();
    
    renderer.renderScaleLines(passEncoder, vpMatrix, modelMatrix, axisColors);
    renderer.renderScaleBoxes(passEncoder, vpMatrix, modelMatrix, axisColors);
  }
  
  destroy(): void {
    super.destroy();
  }
}
