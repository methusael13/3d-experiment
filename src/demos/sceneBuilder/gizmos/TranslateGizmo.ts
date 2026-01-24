/**
 * TranslateGizmo - Arrow-based translation gizmo
 * Extends BaseGizmo with arrow geometry for X/Y/Z axis translation
 */

import { mat4 } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis } from './BaseGizmo';

/**
 * Translate gizmo with arrow endpoints for each axis
 */
export class TranslateGizmo extends BaseGizmo {
  // Geometry buffers
  private linesBuffer: WebGLBuffer;
  private arrowHeadsBuffer: WebGLBuffer;
  
  // Geometry constants (in unit space, scaled at render time)
  private static readonly AXIS_LENGTH = 1.0;
  private static readonly ARROW_SIZE = 0.08;
  
  // Drag state
  private dragStartPos: [number, number] = [0, 0];
  private dragStartValue = 0;

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    super(gl, camera);
    
    // Create geometry buffers
    this.linesBuffer = this.createLinesBuffer();
    this.arrowHeadsBuffer = this.createArrowHeadsBuffer();
  }
  
  /**
   * Create axis lines buffer
   */
  private createLinesBuffer(): WebGLBuffer {
    const gl = this.gl;
    const L = TranslateGizmo.AXIS_LENGTH;
    
    const vertices = new Float32Array([
      // X axis line
      0, 0, 0, L, 0, 0,
      // Y axis line
      0, 0, 0, 0, L, 0,
      // Z axis line
      0, 0, 0, 0, 0, L,
    ]);
    
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    
    return buffer;
  }
  
  /**
   * Create arrow head triangles buffer
   */
  private createArrowHeadsBuffer(): WebGLBuffer {
    const gl = this.gl;
    const L = TranslateGizmo.AXIS_LENGTH;
    const S = TranslateGizmo.ARROW_SIZE;
    
    const vertices = new Float32Array([
      // X arrow (2 triangles for cone approximation)
      L + S * 2, 0, 0,
      L, S, 0,
      L, -S, 0,
      
      L + S * 2, 0, 0,
      L, 0, S,
      L, 0, -S,
      
      // Y arrow
      0, L + S * 2, 0,
      S, L, 0,
      -S, L, 0,
      
      0, L + S * 2, 0,
      0, L, S,
      0, L, -S,
      
      // Z arrow
      0, 0, L + S * 2,
      S, 0, L,
      -S, 0, L,
      
      0, 0, L + S * 2,
      0, S, L,
      0, -S, L,
    ]);
    
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    
    return buffer;
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

  // ==================== BaseGizmo Implementation ====================

  render(vpMatrix: mat4): void {
    if (!this.enabled) return;
    
    const gl = this.gl;
    const loc = BaseGizmo.shaderLocations!;
    
    this.beginRender(vpMatrix);
    
    // Draw axis lines
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linesBuffer);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    this.setColor(this.getAxisColor('x'));
    gl.drawArrays(gl.LINES, 0, 2);
    
    this.setColor(this.getAxisColor('y'));
    gl.drawArrays(gl.LINES, 2, 2);
    
    this.setColor(this.getAxisColor('z'));
    gl.drawArrays(gl.LINES, 4, 2);
    
    // Draw arrow heads
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowHeadsBuffer);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    this.setColor(this.getAxisColor('x'));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    
    this.setColor(this.getAxisColor('y'));
    gl.drawArrays(gl.TRIANGLES, 6, 6);
    
    this.setColor(this.getAxisColor('z'));
    gl.drawArrays(gl.TRIANGLES, 12, 6);
    
    gl.disableVertexAttribArray(loc.aPosition);
    
    this.endRender();
  }
  
  handleMouseDown(screenX: number, screenY: number): boolean {
    if (!this.enabled) return false;
    
    const axis = this.hitTestAxis(screenX, screenY);
    if (axis) {
      this.isDraggingFlag = true;
      this.activeAxis = axis;
      this.dragStartPos = [screenX, screenY];
      
      const axisIndex = { x: 0, y: 1, z: 2 }[axis];
      this.dragStartValue = this.targetPosition[axisIndex];
      
      return true;
    }
    
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    
    const axisIndex = { x: 0, y: 1, z: 2 }[this.activeAxis];
    
    // Calculate delta based on screen movement
    const dx = screenX - this.dragStartPos[0];
    const dy = screenY - this.dragStartPos[1];
    const delta = (dx - dy) * 0.01;
    
    this.targetPosition[axisIndex] = this.dragStartValue + delta;
    
    if (this.onTransformChange) {
      this.onTransformChange('position', [...this.targetPosition]);
    }
    
    return true;
  }
  
  handleMouseUp(): void {
    this.isDraggingFlag = false;
    this.activeAxis = null;
  }
  
  destroy(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.linesBuffer);
    gl.deleteBuffer(this.arrowHeadsBuffer);
    super.destroy();
  }
}
