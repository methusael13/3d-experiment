/**
 * RotateGizmo - Circle-based rotation gizmo
 * Extends BaseGizmo with arc rotation for X/Y/Z axes
 */

import { mat4 } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis, AXIS_COLORS } from './BaseGizmo';
import { screenToRay, rayPlaneIntersect } from '../../../core/utils/raycastUtils';

/**
 * Rotate gizmo with circular rings for each axis
 */
export class RotateGizmo extends BaseGizmo {
  // Geometry constants
  private static readonly RADIUS = 0.8;
  private static readonly SEGMENTS = 32;
  
  // Drag state
  private rotationLastAngle = 0;

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    super(gl, camera);
  }
  
  /**
   * Get rotation plane info for an axis
   */
  private getRotationPlaneInfo(axis: 'x' | 'y' | 'z') {
    switch (axis) {
      case 'x':
        return {
          normal: [1, 0, 0] as [number, number, number],
          u: [0, 1, 0] as [number, number, number],
          v: [0, 0, 1] as [number, number, number],
        };
      case 'y':
        return {
          normal: [0, 1, 0] as [number, number, number],
          u: [0, 0, 1] as [number, number, number],
          v: [1, 0, 0] as [number, number, number],
        };
      case 'z':
        return {
          normal: [0, 0, 1] as [number, number, number],
          u: [1, 0, 0] as [number, number, number],
          v: [0, 1, 0] as [number, number, number],
        };
    }
  }
  
  /**
   * Get angle of a point in the rotation plane
   */
  private getAngleInPlane(point: [number, number, number], axis: 'x' | 'y' | 'z'): number {
    const planeInfo = this.getRotationPlaneInfo(axis);
    const v = [
      point[0] - this.targetPosition[0],
      point[1] - this.targetPosition[1],
      point[2] - this.targetPosition[2],
    ];
    
    const uCoord = v[0] * planeInfo.u[0] + v[1] * planeInfo.u[1] + v[2] * planeInfo.u[2];
    const vCoord = v[0] * planeInfo.v[0] + v[1] * planeInfo.v[1] + v[2] * planeInfo.v[2];
    
    return Math.atan2(vCoord, uCoord) * 180 / Math.PI;
  }
  
  /**
   * Get mouse angle on rotation circle
   */
  private getMouseAngleOnCircle(screenX: number, screenY: number, axis: 'x' | 'y' | 'z'): number | null {
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, this.camera as any, this.canvasWidth, this.canvasHeight);
    const planeInfo = this.getRotationPlaneInfo(axis);
    
    const intersection = rayPlaneIntersect(
      rayOrigin,
      rayDir,
      this.targetPosition,
      planeInfo.normal
    );
    
    if (!intersection) return null;
    
    return this.getAngleInPlane(intersection as [number, number, number], axis);
  }
  
  /**
   * Hit test rotation circles
   */
  private hitTestAxis(screenX: number, screenY: number): GizmoAxis {
    const R = RotateGizmo.RADIUS;
    const segments = 16;
    const hitRadius = 20; // pixels
    const camPos = this.camera.getPosition();
    const scale = this.getScreenSpaceScale();
    
    const circleAxes: Array<{
      name: 'x' | 'y' | 'z';
      getPoint: (a: number) => [number, number, number];
      getNormal: (a: number) => [number, number, number];
    }> = [
      {
        name: 'x',
        getPoint: (a) => [
          this.targetPosition[0],
          this.targetPosition[1] + Math.cos(a) * R * scale,
          this.targetPosition[2] + Math.sin(a) * R * scale,
        ],
        getNormal: (a) => [0, Math.cos(a), Math.sin(a)],
      },
      {
        name: 'y',
        getPoint: (a) => [
          this.targetPosition[0] + Math.cos(a) * R * scale,
          this.targetPosition[1],
          this.targetPosition[2] + Math.sin(a) * R * scale,
        ],
        getNormal: (a) => [Math.cos(a), 0, Math.sin(a)],
      },
      {
        name: 'z',
        getPoint: (a) => [
          this.targetPosition[0] + Math.cos(a) * R * scale,
          this.targetPosition[1] + Math.sin(a) * R * scale,
          this.targetPosition[2],
        ],
        getNormal: (a) => [Math.cos(a), Math.sin(a), 0],
      },
    ];
    
    for (const axis of circleAxes) {
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const worldPos = axis.getPoint(angle);
        const normal = axis.getNormal(angle);
        
        // Check if front-facing
        const toCamera = [
          camPos[0] - worldPos[0],
          camPos[1] - worldPos[1],
          camPos[2] - worldPos[2],
        ];
        const dot = normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2];
        
        if (dot > 0) {
          const screenPos = this.projectToScreen(worldPos);
          const distance = Math.sqrt((screenX - screenPos[0]) ** 2 + (screenY - screenPos[1]) ** 2);
          
          if (distance < hitRadius) {
            return axis.name;
          }
        }
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
    
    const R = RotateGizmo.RADIUS;
    const segments = RotateGizmo.SEGMENTS;
    const camPos = this.camera.getPosition();
    
    // Render each circle segment with front/back coloring
    const circleConfigs = [
      { axis: 'x' as const, getPoint: (a: number) => [0, Math.cos(a) * R, Math.sin(a) * R], getNormal: (a: number) => [0, Math.cos(a), Math.sin(a)] },
      { axis: 'y' as const, getPoint: (a: number) => [Math.cos(a) * R, 0, Math.sin(a) * R], getNormal: (a: number) => [Math.cos(a), 0, Math.sin(a)] },
      { axis: 'z' as const, getPoint: (a: number) => [Math.cos(a) * R, Math.sin(a) * R, 0], getNormal: (a: number) => [Math.cos(a), Math.sin(a), 0] },
    ];
    
    for (const config of circleConfigs) {
      for (let i = 0; i < segments; i++) {
        const a1 = (i / segments) * Math.PI * 2;
        const a2 = ((i + 1) / segments) * Math.PI * 2;
        
        const p1 = config.getPoint(a1);
        const p2 = config.getPoint(a2);
        const midAngle = (a1 + a2) / 2;
        const normal = config.getNormal(midAngle);
        
        // World position of midpoint (accounting for scale)
        const scale = this.getScreenSpaceScale();
        const midWorld = [
          this.targetPosition[0] + ((p1[0] + p2[0]) / 2) * scale,
          this.targetPosition[1] + ((p1[1] + p2[1]) / 2) * scale,
          this.targetPosition[2] + ((p1[2] + p2[2]) / 2) * scale,
        ];
        
        const toCamera = [
          camPos[0] - midWorld[0],
          camPos[1] - midWorld[1],
          camPos[2] - midWorld[2],
        ];
        const dot = normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2];
        const isFront = dot > 0;
        
        // Create segment buffer
        const lineData = new Float32Array([p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]]);
        const tempBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(loc.aPosition);
        gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
        
        const isSelected = this.isDraggingFlag && this.activeAxis === config.axis;
        let color: [number, number, number];
        if (isSelected) {
          color = AXIS_COLORS[`${config.axis}Highlight` as keyof typeof AXIS_COLORS] as [number, number, number];
        } else if (isFront) {
          color = AXIS_COLORS[config.axis];
        } else {
          color = AXIS_COLORS[`${config.axis}Dim` as keyof typeof AXIS_COLORS] as [number, number, number];
        }
        
        this.setColor(color);
        gl.drawArrays(gl.LINES, 0, 2);
        
        gl.disableVertexAttribArray(loc.aPosition);
        gl.deleteBuffer(tempBuffer);
      }
    }
    
    this.endRender();
  }
  
  handleMouseDown(screenX: number, screenY: number): boolean {
    if (!this.enabled) return false;
    
    const axis = this.hitTestAxis(screenX, screenY);
    if (axis) {
      this.isDraggingFlag = true;
      this.activeAxis = axis;
      
      const angle = this.getMouseAngleOnCircle(screenX, screenY, axis);
      this.rotationLastAngle = angle ?? 0;
      
      return true;
    }
    
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    
    const axisIndex = { x: 0, y: 1, z: 2 }[this.activeAxis];
    const currentAngle = this.getMouseAngleOnCircle(screenX, screenY, this.activeAxis);
    
    if (currentAngle !== null) {
      let deltaAngle = currentAngle - this.rotationLastAngle;
      
      // Handle wraparound
      if (deltaAngle > 180) deltaAngle -= 360;
      else if (deltaAngle < -180) deltaAngle += 360;
      
      this.targetRotation[axisIndex] += deltaAngle;
      this.rotationLastAngle = currentAngle;
      
      if (this.onTransformChange) {
        this.onTransformChange('rotation', [...this.targetRotation]);
      }
    }
    
    return true;
  }
  
  handleMouseUp(): void {
    this.isDraggingFlag = false;
    this.activeAxis = null;
  }
  
  destroy(): void {
    super.destroy();
  }
}
