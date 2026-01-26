/**
 * RotateGizmo - Circle-based rotation gizmo
 * Extends BaseGizmo with arc rotation for X/Y/Z axes
 */

import { mat4, vec3, quat } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis, AXIS_COLORS } from './BaseGizmo';
import { screenToRay, rayPlaneIntersect } from '../../../core/utils/raycastUtils';
import { Vec3 } from '../../../core/types';
import { toVec3 } from '../../../core/utils/mathUtils';

/**
 * Rotate gizmo with circular rings for each axis
 */
export class RotateGizmo extends BaseGizmo {
  // Geometry constants
  private static readonly RADIUS = 0.8;
  private static readonly SEGMENTS = 32;
  
  // Drag state - vector-based tracking for smooth rotation
  private rotationLastVec: Vec3 = [1, 0, 0];

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    super(gl, camera);
  }
  
  /**
   * Get rotation plane info for an axis (respects local/world orientation)
   */
  private getRotationPlaneInfo(axis: 'x' | 'y' | 'z') {
    // World-space basis for each axis
    const worldBasis = {
      x: {
        normal: [1, 0, 0] as Vec3,
        u: [0, 1, 0] as Vec3,
        v: [0, 0, 1] as Vec3,
      },
      y: {
        normal: [0, 1, 0] as Vec3,
        u: [0, 0, 1] as Vec3,
        v: [1, 0, 0] as Vec3,
      },
      z: {
        normal: [0, 0, 1] as Vec3,
        u: [1, 0, 0] as Vec3,
        v: [0, 1, 0] as Vec3,
      },
    };
    
    if (this.orientation === 'world') {
      return worldBasis[axis];
    }
    
    // Local mode: rotate the basis vectors by object's rotation
    const rotMat = this.getRotationMatrix();
    const basis = worldBasis[axis];
    
    const rotateVec = (v: Vec3): Vec3 => {
      const result = vec3.create();
      vec3.transformMat4(result, v as unknown as vec3, rotMat);
      return [result[0], result[1], result[2]];
    };
    
    return {
      normal: rotateVec(basis.normal),
      u: rotateVec(basis.u),
      v: rotateVec(basis.v),
    };
  }
  
  /**
   * Get normalized direction vector from center to point on rotation plane
   */
  private getVectorOnPlane(screenX: number, screenY: number, axis: 'x' | 'y' | 'z'): Vec3 | null {
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, this.camera as any, this.canvasWidth, this.canvasHeight);
    const planeInfo = this.getRotationPlaneInfo(axis);
    
    const intersection = rayPlaneIntersect(
      rayOrigin,
      rayDir,
      this.targetPosition,
      planeInfo.normal
    );
    
    if (!intersection) return null;
    
    // Vector from center to intersection
    const v = vec3.fromValues(
      intersection[0] - this.targetPosition[0],
      intersection[1] - this.targetPosition[1],
      intersection[2] - this.targetPosition[2]
    );
    
    // Normalize
    const len = vec3.length(v);
    if (len < 0.0001) return null;
    vec3.scale(v, v, 1 / len);
    
    return [v[0], v[1], v[2]];
  }
  
  /**
   * Calculate signed angle between two vectors using cross product for sign
   * Returns angle in radians
   */
  private signedAngleBetweenVectors(
    v1: Vec3,
    v2: Vec3,
    normal: Vec3
  ): number {
    const vv1 = toVec3(v1);
    const vv2 = toVec3(v2);

    // Dot product for angle magnitude
    const dot = vec3.dot(vv1, vv2);
    const cosAngle = Math.max(-1, Math.min(1, dot)); // Clamp for numerical stability
    const angle = Math.acos(cosAngle);
    
    // Cross product for sign determination
    const cross1to2 = vec3.create();
    vec3.cross(cross1to2, vv1, vv2);
    
    // Sign is determined by whether cross product aligns with plane normal
    const signDot = Math.sign(vec3.dot(cross1to2, toVec3(normal)));
    
    return signDot >= 0 ? angle : -angle;
  }
  
  /**
   * Get point on circle for an axis (respects local/world orientation)
   */
  private getCirclePoint(axis: 'x' | 'y' | 'z', angle: number, radius: number): Vec3 {
    // Local space point on circle
    let localPoint: Vec3;
    switch (axis) {
      case 'x':
        localPoint = [0, Math.cos(angle) * radius, Math.sin(angle) * radius];
        break;
      case 'y':
        localPoint = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
        break;
      case 'z':
        localPoint = [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
        break;
    }
    
    if (this.orientation === 'local') {
      const rotMat = this.getRotationMatrix();
      const result = vec3.create();
      vec3.transformMat4(result, localPoint as unknown as vec3, rotMat);
      localPoint = [result[0], result[1], result[2]];
    }
    
    return localPoint;
  }
  
  /**
   * Get normal vector for circle segment (respects local/world orientation)
   */
  private getCircleNormal(axis: 'x' | 'y' | 'z', angle: number): Vec3 {
    let localNormal: Vec3;
    switch (axis) {
      case 'x':
        localNormal = [0, Math.cos(angle), Math.sin(angle)];
        break;
      case 'y':
        localNormal = [Math.cos(angle), 0, Math.sin(angle)];
        break;
      case 'z':
        localNormal = [Math.cos(angle), Math.sin(angle), 0];
        break;
    }
    
    if (this.orientation === 'local') {
      const rotMat = this.getRotationMatrix();
      const result = vec3.create();
      vec3.transformMat4(result, localNormal as unknown as vec3, rotMat);
      localNormal = [result[0], result[1], result[2]];
    }
    
    return localNormal;
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
    
    const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
    
    for (const axis of axes) {
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const localPoint = this.getCirclePoint(axis, angle, R);
        const normal = this.getCircleNormal(axis, angle);
        
        // World position
        const worldPos: Vec3 = [
          this.targetPosition[0] + localPoint[0] * scale,
          this.targetPosition[1] + localPoint[1] * scale,
          this.targetPosition[2] + localPoint[2] * scale,
        ];
        
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
            return axis;
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
    const scale = this.getScreenSpaceScale();
    
    const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
    
    for (const axis of axes) {
      for (let i = 0; i < segments; i++) {
        const a1 = (i / segments) * Math.PI * 2;
        const a2 = ((i + 1) / segments) * Math.PI * 2;
        
        const p1 = this.getCirclePoint(axis, a1, R);
        const p2 = this.getCirclePoint(axis, a2, R);
        const midAngle = (a1 + a2) / 2;
        const normal = this.getCircleNormal(axis, midAngle);
        
        // World position of midpoint (accounting for scale)
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
        
        const isSelected = this.isDraggingFlag && this.activeAxis === axis;
        let color: Vec3;
        if (isSelected) {
          color = AXIS_COLORS[`${axis}Highlight` as keyof typeof AXIS_COLORS] as Vec3;
        } else if (isFront) {
          color = AXIS_COLORS[axis];
        } else {
          color = AXIS_COLORS[`${axis}Dim` as keyof typeof AXIS_COLORS] as Vec3;
        }
        
        this.setColor(color);
        gl.drawArrays(gl.LINES, 0, 2);
        
        gl.disableVertexAttribArray(loc.aPosition);
        gl.deleteBuffer(tempBuffer);
      }
    }
    
    // Draw debug rotation plane when dragging
    if (this.isDraggingFlag && this.activeAxis) {
      this.renderDebugPlane(scale);
    }
    
    this.endRender();
  }
  
  /**
   * Render a debug visualization of the rotation plane
   */
  private renderDebugPlane(scale: number): void {
    if (!this.activeAxis) return;
    
    const gl = this.gl;
    const loc = BaseGizmo.shaderLocations!;
    const planeInfo = this.getRotationPlaneInfo(this.activeAxis);
    
    // Draw grid lines on the rotation plane
    const gridSize = RotateGizmo.RADIUS * 1.5;
    const gridLines = 5;
    
    // Semi-transparent color based on axis
    const axisColor = AXIS_COLORS[this.activeAxis];
    this.setColor([axisColor[0] * 0.5, axisColor[1] * 0.5, axisColor[2] * 0.5]);
    
    // Draw grid lines along U direction
    for (let i = -gridLines; i <= gridLines; i++) {
      const offset = (i / gridLines) * gridSize;
      const p1: Vec3 = [
        planeInfo.u[0] * offset - planeInfo.v[0] * gridSize,
        planeInfo.u[1] * offset - planeInfo.v[1] * gridSize,
        planeInfo.u[2] * offset - planeInfo.v[2] * gridSize,
      ];
      const p2: Vec3 = [
        planeInfo.u[0] * offset + planeInfo.v[0] * gridSize,
        planeInfo.u[1] * offset + planeInfo.v[1] * gridSize,
        planeInfo.u[2] * offset + planeInfo.v[2] * gridSize,
      ];
      
      const lineData = new Float32Array([p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]]);
      const tempBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.aPosition);
      gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, 2);
      gl.disableVertexAttribArray(loc.aPosition);
      gl.deleteBuffer(tempBuffer);
    }
    
    // Draw grid lines along V direction
    for (let i = -gridLines; i <= gridLines; i++) {
      const offset = (i / gridLines) * gridSize;
      const p1: Vec3 = [
        planeInfo.v[0] * offset - planeInfo.u[0] * gridSize,
        planeInfo.v[1] * offset - planeInfo.u[1] * gridSize,
        planeInfo.v[2] * offset - planeInfo.u[2] * gridSize,
      ];
      const p2: Vec3 = [
        planeInfo.v[0] * offset + planeInfo.u[0] * gridSize,
        planeInfo.v[1] * offset + planeInfo.u[1] * gridSize,
        planeInfo.v[2] * offset + planeInfo.u[2] * gridSize,
      ];
      
      const lineData = new Float32Array([p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]]);
      const tempBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.aPosition);
      gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, 2);
      gl.disableVertexAttribArray(loc.aPosition);
      gl.deleteBuffer(tempBuffer);
    }
    
    // Draw plane normal as a line
    this.setColor([1, 1, 1]); // White for normal
    const normalLength = gridSize * 0.5;
    const normalLine = new Float32Array([
      0, 0, 0,
      planeInfo.normal[0] * normalLength,
      planeInfo.normal[1] * normalLength,
      planeInfo.normal[2] * normalLength,
    ]);
    const normalBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normalLine, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, 2);
    gl.disableVertexAttribArray(loc.aPosition);
    gl.deleteBuffer(normalBuffer);
  }
  
  handleMouseDown(screenX: number, screenY: number): boolean {
    if (!this.enabled) return false;
    
    const axis = this.hitTestAxis(screenX, screenY);
    if (axis) {
      this.isDraggingFlag = true;
      this.activeAxis = axis;
      
      // Store initial vector for vector-based rotation tracking
      const vec = this.getVectorOnPlane(screenX, screenY, axis);
      if (vec) {
        this.rotationLastVec = vec;
      }
      
      return true;
    }
    
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.isDraggingFlag || !this.activeAxis) return false;
    
    const currentVec = this.getVectorOnPlane(screenX, screenY, this.activeAxis);
    if (!currentVec) return true;
    
    const planeInfo = this.getRotationPlaneInfo(this.activeAxis);
    
    // Calculate signed angle between last and current vectors
    let deltaAngle = this.signedAngleBetweenVectors(
      this.rotationLastVec,
      currentVec,
      planeInfo.normal
    );
    
    // Skip tiny movements (numerical noise)
    if (Math.abs(deltaAngle) < 0.0001) return true;
    
    // Get the rotation axis (local axis in local mode, world axis in world mode)
    const rotationAxis = this.getAxisDirection(this.activeAxis);
    
    // Create delta rotation quaternion around the rotation axis
    const deltaQuat = quat.create();
    quat.setAxisAngle(deltaQuat, rotationAxis as unknown as vec3, deltaAngle);
    
    // Pre-multiply: applies rotation in world frame (around specified axis)
    quat.multiply(this.targetRotationQuat, deltaQuat, this.targetRotationQuat);
    quat.normalize(this.targetRotationQuat, this.targetRotationQuat);
    
    // Update last vector for next frame
    this.rotationLastVec = currentVec;
    
    // Output quaternion directly - no Euler conversion!
    if (this.onTransformChange) {
      this.onTransformChange('rotation', quat.clone(this.targetRotationQuat));
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
