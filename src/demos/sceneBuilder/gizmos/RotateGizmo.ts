/**
 * RotateGizmo - Circle-based rotation gizmo
 * Extends BaseGizmo with arc rotation for X/Y/Z axes
 */

import { mat4, vec3, quat } from 'gl-matrix';
import { BaseGizmo, GizmoCamera, GizmoAxis, AXIS_COLORS } from './BaseGizmo';
import { screenToRay, rayPlaneIntersect } from '../../../core/utils/raycastUtils';

/**
 * Rotate gizmo with circular rings for each axis
 */
export class RotateGizmo extends BaseGizmo {
  // Geometry constants
  private static readonly RADIUS = 0.8;
  private static readonly SEGMENTS = 32;
  
  // Drag state - vector-based tracking for smooth rotation
  private rotationLastVec: [number, number, number] = [1, 0, 0];

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
        normal: [1, 0, 0] as [number, number, number],
        u: [0, 1, 0] as [number, number, number],
        v: [0, 0, 1] as [number, number, number],
      },
      y: {
        normal: [0, 1, 0] as [number, number, number],
        u: [0, 0, 1] as [number, number, number],
        v: [1, 0, 0] as [number, number, number],
      },
      z: {
        normal: [0, 0, 1] as [number, number, number],
        u: [1, 0, 0] as [number, number, number],
        v: [0, 1, 0] as [number, number, number],
      },
    };
    
    if (this.orientation === 'world') {
      return worldBasis[axis];
    }
    
    // Local mode: rotate the basis vectors by object's rotation
    const rotMat = this.getRotationMatrix();
    const basis = worldBasis[axis];
    
    const rotateVec = (v: [number, number, number]): [number, number, number] => {
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
  private getVectorOnPlane(screenX: number, screenY: number, axis: 'x' | 'y' | 'z'): [number, number, number] | null {
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
    v1: [number, number, number],
    v2: [number, number, number],
    normal: [number, number, number]
  ): number {
    // Dot product for angle magnitude
    const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
    const cosAngle = Math.max(-1, Math.min(1, dot)); // Clamp for numerical stability
    const angle = Math.acos(cosAngle);
    
    // Cross product for sign determination
    const cross = [
      v1[1] * v2[2] - v1[2] * v2[1],
      v1[2] * v2[0] - v1[0] * v2[2],
      v1[0] * v2[1] - v1[1] * v2[0],
    ];
    
    // Sign is determined by whether cross product aligns with plane normal
    const signDot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
    
    return signDot >= 0 ? angle : -angle;
  }
  
  /**
   * Get point on circle for an axis (respects local/world orientation)
   */
  private getCirclePoint(axis: 'x' | 'y' | 'z', angle: number, radius: number): [number, number, number] {
    // Local space point on circle
    let localPoint: [number, number, number];
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
  private getCircleNormal(axis: 'x' | 'y' | 'z', angle: number): [number, number, number] {
    let localNormal: [number, number, number];
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
        const worldPos: [number, number, number] = [
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
        let color: [number, number, number];
        if (isSelected) {
          color = AXIS_COLORS[`${axis}Highlight` as keyof typeof AXIS_COLORS] as [number, number, number];
        } else if (isFront) {
          color = AXIS_COLORS[axis];
        } else {
          color = AXIS_COLORS[`${axis}Dim` as keyof typeof AXIS_COLORS] as [number, number, number];
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
      const p1: [number, number, number] = [
        planeInfo.u[0] * offset - planeInfo.v[0] * gridSize,
        planeInfo.u[1] * offset - planeInfo.v[1] * gridSize,
        planeInfo.u[2] * offset - planeInfo.v[2] * gridSize,
      ];
      const p2: [number, number, number] = [
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
      const p1: [number, number, number] = [
        planeInfo.v[0] * offset - planeInfo.u[0] * gridSize,
        planeInfo.v[1] * offset - planeInfo.u[1] * gridSize,
        planeInfo.v[2] * offset - planeInfo.u[2] * gridSize,
      ];
      const p2: [number, number, number] = [
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
    
    // Convert to Euler only for output callback (UI display)
    const euler = this.quatToEuler(this.targetRotationQuat);
    this.targetRotation[0] = euler[0];
    this.targetRotation[1] = euler[1];
    this.targetRotation[2] = euler[2];
    
    // Update last vector for next frame
    this.rotationLastVec = currentVec;
    
    if (this.onTransformChange) {
      this.onTransformChange('rotation', [...this.targetRotation]);
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
