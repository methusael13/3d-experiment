/**
 * TranslateGizmo - Arrow-based translation gizmo
 * Extends BaseGizmo with arrow geometry for X/Y/Z axis translation
 */

import { mat4, vec3, quat } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis } from './BaseGizmo';
import type { GizmoRendererGPU } from '../../../core/gpu/renderers/GizmoRendererGPU';

/**
 * Translate gizmo with arrow endpoints for each axis
 */
export class TranslateGizmo extends BaseGizmo {
  // Geometry constants (in unit space, scaled at render time)
  private static readonly AXIS_LENGTH = 1.0;
  private static readonly ARROW_SIZE = 0.08;
  
  // Drag state
  private dragStartPos: [number, number] = [0, 0];
  private dragStartPosition: [number, number, number] = [0, 0, 0];

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
  
  /**
   * Hit test to find which axis was clicked
   */
  private hitTestAxis(screenX: number, screenY: number): GizmoAxis {
    const L = TranslateGizmo.AXIS_LENGTH;
    const hitRadius = 30; // pixels
    
    const axes: Array<{ name: 'x' | 'y' | 'z'; endpoint: [number, number, number] }> = [
      { name: 'x', endpoint: this.getAxisEndpoint('x', L) },
      { name: 'y', endpoint: this.getAxisEndpoint('y', L) },
      { name: 'z', endpoint: this.getAxisEndpoint('z', L) },
    ];
    
    for (const axis of axes) {
      const screenPos = this.projectToScreen(axis.endpoint);
      const distance = Math.sqrt((screenX - screenPos[0]) ** 2 + (screenY - screenPos[1]) ** 2);
      
      if (distance < hitRadius) {
        return axis.name;
      }
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
      this.dragStartPosition = [...this.targetPosition];
      
      return true;
    }
    
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    
    // Calculate delta based on screen movement
    const dx = screenX - this.dragStartPos[0];
    const dy = screenY - this.dragStartPos[1];
    const delta = (dx - dy) * 0.01;
    
    // Get axis direction (world or local based on orientation)
    const axisDir = this.getAxisDirection(this.activeAxis);
    
    // Apply delta along the axis direction
    this.targetPosition[0] = this.dragStartPosition[0] + axisDir[0] * delta;
    this.targetPosition[1] = this.dragStartPosition[1] + axisDir[1] * delta;
    this.targetPosition[2] = this.dragStartPosition[2] + axisDir[2] * delta;
    
    if (this.onTransformChange) {
      this.onTransformChange('position', [...this.targetPosition]);
    }
    
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
    
    renderer.renderTranslateLines(passEncoder, vpMatrix, modelMatrix, axisColors);
    renderer.renderTranslateArrows(passEncoder, vpMatrix, modelMatrix, axisColors);
  }
  
  destroy(): void {
    super.destroy();
  }
}
