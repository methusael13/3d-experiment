/**
 * ScaleGizmo - Box-based axis scale gizmo
 * Extends BaseGizmo with cube handles at axis endpoints
 */

import { mat4 } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis } from './BaseGizmo';

export class ScaleGizmo extends BaseGizmo {
  private linesBuffer: WebGLBuffer;
  private boxesBuffer: WebGLBuffer;
  
  private static readonly AXIS_LENGTH = 1.0;
  private static readonly BOX_SIZE = 0.06;
  
  private dragStartPos: [number, number] = [0, 0];
  private dragStartValue = 0;

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    super(gl, camera);
    this.linesBuffer = this.createLinesBuffer();
    this.boxesBuffer = this.createBoxesBuffer();
  }
  
  private createLinesBuffer(): WebGLBuffer {
    const L = ScaleGizmo.AXIS_LENGTH;
    const vertices = new Float32Array([
      0, 0, 0, L, 0, 0,
      0, 0, 0, 0, L, 0,
      0, 0, 0, 0, 0, L,
    ]);
    const buffer = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
    return buffer;
  }
  
  private createBoxesBuffer(): WebGLBuffer {
    const s = ScaleGizmo.BOX_SIZE;
    const L = ScaleGizmo.AXIS_LENGTH;
    const vertices: number[] = [];
    
    const addBox = (cx: number, cy: number, cz: number) => {
      // Front
      vertices.push(cx-s,cy-s,cz+s, cx+s,cy-s,cz+s, cx+s,cy+s,cz+s, cx-s,cy-s,cz+s, cx+s,cy+s,cz+s, cx-s,cy+s,cz+s);
      // Back
      vertices.push(cx+s,cy-s,cz-s, cx-s,cy-s,cz-s, cx-s,cy+s,cz-s, cx+s,cy-s,cz-s, cx-s,cy+s,cz-s, cx+s,cy+s,cz-s);
      // Top
      vertices.push(cx-s,cy+s,cz-s, cx-s,cy+s,cz+s, cx+s,cy+s,cz+s, cx-s,cy+s,cz-s, cx+s,cy+s,cz+s, cx+s,cy+s,cz-s);
      // Bottom
      vertices.push(cx-s,cy-s,cz+s, cx-s,cy-s,cz-s, cx+s,cy-s,cz-s, cx-s,cy-s,cz+s, cx+s,cy-s,cz-s, cx+s,cy-s,cz+s);
      // Right
      vertices.push(cx+s,cy-s,cz+s, cx+s,cy-s,cz-s, cx+s,cy+s,cz-s, cx+s,cy-s,cz+s, cx+s,cy+s,cz-s, cx+s,cy+s,cz+s);
      // Left
      vertices.push(cx-s,cy-s,cz-s, cx-s,cy-s,cz+s, cx-s,cy+s,cz+s, cx-s,cy-s,cz-s, cx-s,cy+s,cz+s, cx-s,cy+s,cz-s);
    };
    
    addBox(L, 0, 0);
    addBox(0, L, 0);
    addBox(0, 0, L);
    
    const buffer = this.gl.createBuffer()!;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(vertices), this.gl.STATIC_DRAW);
    return buffer;
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

  render(vpMatrix: mat4): void {
    if (!this.enabled) return;
    
    const gl = this.gl;
    const loc = BaseGizmo.shaderLocations!;
    
    this.beginRender(vpMatrix);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linesBuffer);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    this.setColor(this.getAxisColor('x')); gl.drawArrays(gl.LINES, 0, 2);
    this.setColor(this.getAxisColor('y')); gl.drawArrays(gl.LINES, 2, 2);
    this.setColor(this.getAxisColor('z')); gl.drawArrays(gl.LINES, 4, 2);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxesBuffer);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    this.setColor(this.getAxisColor('x')); gl.drawArrays(gl.TRIANGLES, 0, 36);
    this.setColor(this.getAxisColor('y')); gl.drawArrays(gl.TRIANGLES, 36, 36);
    this.setColor(this.getAxisColor('z')); gl.drawArrays(gl.TRIANGLES, 72, 36);
    
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
      this.dragStartValue = this.targetScale[{ x: 0, y: 1, z: 2 }[axis]];
      return true;
    }
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    const axisIndex = { x: 0, y: 1, z: 2 }[this.activeAxis];
    const dx = screenX - this.dragStartPos[0];
    const dy = screenY - this.dragStartPos[1];
    this.targetScale[axisIndex] = Math.max(0.01, this.dragStartValue + (dx - dy) * 0.01);
    if (this.onTransformChange) this.onTransformChange('scale', [...this.targetScale]);
    return true;
  }
  
  handleMouseUp(): void {
    this.isDraggingFlag = false;
    this.activeAxis = null;
  }
  
  destroy(): void {
    this.gl.deleteBuffer(this.linesBuffer);
    this.gl.deleteBuffer(this.boxesBuffer);
    super.destroy();
  }
}
