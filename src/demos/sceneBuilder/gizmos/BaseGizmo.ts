/**
 * BaseGizmo - Abstract base class for all transform gizmos
 * Provides shared shader, screen-space scaling, and common utilities
 */

import { mat4, vec3, quat } from 'gl-matrix';
import type { Vec3, RGB } from '../../../core/types';

/**
 * Camera interface for gizmo rendering
 */
export interface GizmoCamera {
  getPosition(): Vec3;
  getViewProjectionMatrix(): mat4;
  getFOV?(): number;
}

/**
 * Callback type for transform changes
 * For rotation, value is a quat (4 elements); for position/scale, value is Vec3 (3 elements)
 */
export type TransformChangeCallback = (
  type: 'position' | 'rotation' | 'scale',
  value: Vec3 | quat
) => void;

/**
 * Gizmo axis type
 */
export type GizmoAxis = 'x' | 'y' | 'z' | null;

/**
 * Gizmo orientation mode
 */
export type GizmoOrientation = 'world' | 'local';

/**
 * Colors for gizmo axes
 */
export const AXIS_COLORS: Record<string, RGB> = {
  x: [1.0, 0.2, 0.2],      // Red
  y: [0.2, 0.9, 0.2],      // Green
  z: [0.2, 0.4, 1.0],      // Blue
  xHighlight: [1.0, 0.6, 0.0],  // Orange
  yHighlight: [1.0, 1.0, 0.0],  // Yellow
  zHighlight: [0.0, 1.0, 1.0],  // Cyan
  xDim: [0.3, 0.1, 0.1],
  yDim: [0.1, 0.25, 0.1],
  zDim: [0.1, 0.15, 0.3],
};

/**
 * Shared shader locations interface
 */
export interface GizmoShaderLocations {
  aPosition: number;
  uViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/**
 * Abstract base class for transform gizmos
 */
export abstract class BaseGizmo {
  protected readonly gl: WebGL2RenderingContext;
  protected readonly camera: GizmoCamera;
  
  // Shared shader (static, created once)
  protected static shaderProgram: WebGLProgram | null = null;
  protected static shaderLocations: GizmoShaderLocations | null = null;
  protected static shaderRefCount = 0;
  
  // Target transform
  protected targetPosition: Vec3 = [0, 0, 0];
  protected targetRotation: Vec3 = [0, 0, 0];
  protected targetRotationQuat: quat = quat.create(); // Internal quaternion representation
  protected targetScale: Vec3 = [1, 1, 1];
  
  // State
  protected enabled = false;
  protected isDraggingFlag = false;
  protected activeAxis: GizmoAxis = null;
  protected orientation: GizmoOrientation = 'world';
  
  // Canvas dimensions for hit testing
  protected canvasWidth = 800;
  protected canvasHeight = 600;
  
  // Callbacks
  protected onTransformChange: TransformChangeCallback | null = null;
  
  // Reusable model matrix
  protected readonly modelMatrix = mat4.create();
  
  // Screen-space scale configuration
  protected static readonly BASE_SCREEN_SIZE = 100; // Base size in pixels
  protected static readonly DEFAULT_FOV = Math.PI / 4; // 45 degrees
  
  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    this.gl = gl;
    this.camera = camera;
    
    // Initialize shared shader
    BaseGizmo.shaderRefCount++;
    if (!BaseGizmo.shaderProgram) {
      this.createSharedShader();
    }
  }
  
  /**
   * Create the shared shader program
   */
  private createSharedShader(): void {
    const gl = this.gl;
    
    const vsSource = `#version 300 es
      precision highp float;
      in vec3 aPosition;
      uniform mat4 uViewProjection;
      uniform mat4 uModel;
      uniform vec3 uColor;
      out vec3 vColor;
      void main() {
        gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
        vColor = uColor;
      }
    `;
    
    const fsSource = `#version 300 es
      precision mediump float;
      in vec3 vColor;
      out vec4 fragColor;
      void main() {
        fragColor = vec4(vColor, 1.0);
      }
    `;
    
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Gizmo shader link error:', gl.getProgramInfoLog(program));
    }
    
    // Clean up individual shaders
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    
    BaseGizmo.shaderProgram = program;
    BaseGizmo.shaderLocations = {
      aPosition: gl.getAttribLocation(program, 'aPosition'),
      uViewProjection: gl.getUniformLocation(program, 'uViewProjection'),
      uModel: gl.getUniformLocation(program, 'uModel'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }
  
  /**
   * Compile a shader
   */
  protected compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Gizmo shader error:', gl.getShaderInfoLog(shader));
    }
    
    return shader;
  }
  
  /**
   * Calculate screen-space scale factor to keep gizmo constant pixel size
   */
  protected getScreenSpaceScale(): number {
    const cameraPos = this.camera.getPosition();
    const distance = vec3.distance(
      cameraPos as unknown as vec3,
      this.targetPosition as unknown as vec3
    );
    
    // Get FOV (use default if not available)
    const fov = this.camera.getFOV?.() ?? BaseGizmo.DEFAULT_FOV;
    
    // Calculate world-space size that appears as BASE_SCREEN_SIZE pixels
    const worldUnitsPerPixel = (2 * distance * Math.tan(fov / 2)) / this.canvasHeight;
    return worldUnitsPerPixel * BaseGizmo.BASE_SCREEN_SIZE;
  }
  
  /**
   * Set up model matrix with screen-space scaling
   */
  protected setupModelMatrix(): void {
    mat4.identity(this.modelMatrix);
    mat4.translate(this.modelMatrix, this.modelMatrix, this.targetPosition as unknown as vec3);
    
    const scale = this.getScreenSpaceScale();
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
  }
  
  /**
   * Begin rendering - use shader and set common uniforms
   */
  protected beginRender(vpMatrix: mat4): void {
    const gl = this.gl;
    const loc = BaseGizmo.shaderLocations!;
    
    gl.useProgram(BaseGizmo.shaderProgram);
    gl.uniformMatrix4fv(loc.uViewProjection, false, vpMatrix);
    
    this.setupModelMatrix();
    gl.uniformMatrix4fv(loc.uModel, false, this.modelMatrix);
    
    // Disable depth test so gizmo is always visible
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }
  
  /**
   * End rendering - restore GL state
   */
  protected endRender(): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }
  
  /**
   * Set color uniform
   */
  protected setColor(color: RGB): void {
    const loc = BaseGizmo.shaderLocations!;
    this.gl.uniform3fv(loc.uColor, color);
  }
  
  /**
   * Get color for axis based on drag state
   */
  protected getAxisColor(axis: 'x' | 'y' | 'z'): RGB {
    if (this.isDraggingFlag && this.activeAxis === axis) {
      return AXIS_COLORS[`${axis}Highlight`];
    }
    return AXIS_COLORS[axis];
  }
  
  /**
   * Project world position to screen coordinates
   */
  protected projectToScreen(worldPos: Vec3): [number, number] {
    const vpMatrix = this.camera.getViewProjectionMatrix();
    const pos4 = [worldPos[0], worldPos[1], worldPos[2], 1];
    
    const clipPos = [0, 0, 0, 1];
    clipPos[0] = vpMatrix[0] * pos4[0] + vpMatrix[4] * pos4[1] + vpMatrix[8] * pos4[2] + vpMatrix[12] * pos4[3];
    clipPos[1] = vpMatrix[1] * pos4[0] + vpMatrix[5] * pos4[1] + vpMatrix[9] * pos4[2] + vpMatrix[13] * pos4[3];
    clipPos[2] = vpMatrix[2] * pos4[0] + vpMatrix[6] * pos4[1] + vpMatrix[10] * pos4[2] + vpMatrix[14] * pos4[3];
    clipPos[3] = vpMatrix[3] * pos4[0] + vpMatrix[7] * pos4[1] + vpMatrix[11] * pos4[2] + vpMatrix[15] * pos4[3];
    
    if (clipPos[3] !== 0) {
      clipPos[0] /= clipPos[3];
      clipPos[1] /= clipPos[3];
    }
    
    const screenX = (clipPos[0] * 0.5 + 0.5) * this.canvasWidth;
    const screenY = (1 - (clipPos[1] * 0.5 + 0.5)) * this.canvasHeight;
    
    return [screenX, screenY];
  }
  
  /**
   * Get world position for axis endpoint (in screen-space scaled coordinates)
   */
  protected getAxisEndpoint(axis: 'x' | 'y' | 'z', length = 1.0): Vec3 {
    const scale = this.getScreenSpaceScale();
    const scaledLength = length * scale;
    
    switch (axis) {
      case 'x':
        return [this.targetPosition[0] + scaledLength, this.targetPosition[1], this.targetPosition[2]];
      case 'y':
        return [this.targetPosition[0], this.targetPosition[1] + scaledLength, this.targetPosition[2]];
      case 'z':
        return [this.targetPosition[0], this.targetPosition[1], this.targetPosition[2] + scaledLength];
    }
  }
  
  // ==================== Public API ====================
  
  /**
   * Set gizmo enabled state
   */
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      this.isDraggingFlag = false;
      this.activeAxis = null;
    }
  }
  
  /**
   * Set target transform
   * Converts Euler rotation to quaternion at entry point
   * @deprecated Use setTargetWithQuat for better precision
   */
  setTarget(position: Vec3, rotation: Vec3, scale: Vec3): void {
    this.targetPosition = [...position];
    this.targetRotation = [...rotation];
    this.targetScale = [...scale];
    
    // Convert Euler to quaternion at entry (XYZ intrinsic order)
    this.targetRotationQuat = this.eulerToQuat(rotation);
  }
  
  /**
   * Set target transform with quaternion rotation directly.
   * Avoids Euler→Quat conversion for better precision.
   */
  setTargetWithQuat(position: Vec3, rotationQuat: quat, scale: Vec3): void {
    this.targetPosition = [...position];
    quat.copy(this.targetRotationQuat, rotationQuat);
    this.targetScale = [...scale];
    // Update Euler for display purposes only
    this.targetRotation = [...this.quatToEuler(rotationQuat)];
  }
  
  /**
   * Set target position and scale only, preserving the internal rotation quaternion.
   * Used when syncing after drag end to avoid Euler→Quat conversion drift.
   */
  setTargetPositionAndScale(position: Vec3, scale: Vec3): void {
    this.targetPosition = [...position];
    this.targetScale = [...scale];
    // Note: targetRotation (Euler) is NOT updated - it may be stale
    // but that's fine since we use targetRotationQuat internally
  }
  
  /**
   * Set canvas dimensions for hit testing
   */
  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }
  
  /**
   * Set transform change callback
   */
  setOnChange(callback: TransformChangeCallback | null): void {
    this.onTransformChange = callback;
  }
  
  /**
   * Get current dragging state
   */
  get isDragging(): boolean {
    return this.isDraggingFlag;
  }
  
  /**
   * Get current target position
   */
  getTargetPosition(): Vec3 {
    return [...this.targetPosition];
  }
  
  /**
   * Set gizmo orientation mode (world or local)
   */
  setOrientation(mode: GizmoOrientation): void {
    this.orientation = mode;
  }
  
  /**
   * Get rotation matrix from internal quaternion
   * Uses mat4.fromQuat for numerical stability
   */
  protected getRotationMatrix(): mat4 {
    const rotMat = mat4.create();
    mat4.fromQuat(rotMat, this.targetRotationQuat);
    return rotMat;
  }
  
  /**
   * Convert Euler angles (degrees, XYZ intrinsic order) to quaternion.
   * Must match SceneObject.getModelMatrix() which applies: rotateX -> rotateY -> rotateZ
   * For intrinsic XYZ, quaternion multiplication is: q = qx * qy * qz
   */
  protected eulerToQuat(euler: Vec3): quat {
    const q = quat.create();
    const degToRad = Math.PI / 180;
    
    // Create individual axis rotations
    const qx = quat.create();
    const qy = quat.create();
    const qz = quat.create();
    
    quat.setAxisAngle(qx, [1, 0, 0], euler[0] * degToRad);
    quat.setAxisAngle(qy, [0, 1, 0], euler[1] * degToRad);
    quat.setAxisAngle(qz, [0, 0, 1], euler[2] * degToRad);
    
    // Intrinsic XYZ: first X, then Y (in X-rotated frame), then Z (in XY-rotated frame)
    // Quaternion order: q = qx * qy * qz
    quat.multiply(q, qx, qy);
    quat.multiply(q, q, qz);
    
    return q;
  }
  
  /**
   * Convert quaternion to Euler angles (degrees, XYZ intrinsic order).
   * Must produce values that when fed to SceneObject.getModelMatrix() (rotateX->Y->Z)
   * recreate the same rotation as the quaternion.
   * 
   * For intrinsic XYZ (Tait-Bryan angles), given rotation matrix from quat:
   * R = Rx(a) * Ry(b) * Rz(c)
   */
  protected quatToEuler(q: quat): Vec3 {
    const radToDeg = 180 / Math.PI;
    
    // Build rotation matrix from quaternion
    const x = q[0], y = q[1], z = q[2], w = q[3];
    
    // Rotation matrix elements (column-major like gl-matrix)
    const m00 = 1 - 2 * (y * y + z * z);
    const m01 = 2 * (x * y + w * z);
    const m02 = 2 * (x * z - w * y);
    const m10 = 2 * (x * y - w * z);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z + w * x);
    const m20 = 2 * (x * z + w * y);
    const m21 = 2 * (y * z - w * x);
    const m22 = 1 - 2 * (x * x + y * y);
    
    // Extract XYZ intrinsic Euler angles from rotation matrix
    // For R = Rx * Ry * Rz:
    // ry = -asin(m02)
    // rx = atan2(m12, m22)
    // rz = atan2(m01, m00)
    
    let rx: number, ry: number, rz: number;
    
    // Check for gimbal lock (m02 = ±1)
    if (Math.abs(m02) >= 0.9999) {
      // Gimbal lock: ry = ±90°
      ry = m02 < 0 ? Math.PI / 2 : -Math.PI / 2;
      rz = 0;
      rx = Math.atan2(-m10, m11);
    } else {
      ry = -Math.asin(Math.max(-1, Math.min(1, m02)));
      rx = Math.atan2(m12, m22);
      rz = Math.atan2(m01, m00);
    }
    
    return [rx * radToDeg, ry * radToDeg, rz * radToDeg];
  }
  
  /**
   * Get axis direction in world space based on orientation mode
   * In world mode, returns standard basis vectors
   * In local mode, returns rotated basis vectors
   */
  protected getAxisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
    // Standard basis vectors
    const basisVectors: Record<'x' | 'y' | 'z', Vec3> = {
      x: [1, 0, 0],
      y: [0, 1, 0],
      z: [0, 0, 1],
    };
    
    if (this.orientation === 'world') {
      return basisVectors[axis];
    }
    
    // Local mode: rotate the basis vector by object's rotation
    const rotMat = this.getRotationMatrix();
    const basis = vec3.fromValues(...basisVectors[axis]);
    const result = vec3.create();
    vec3.transformMat4(result, basis, rotMat);
    
    return [result[0], result[1], result[2]];
  }
  
  // ==================== Abstract Methods ====================
  
  /**
   * Render the gizmo
   */
  abstract render(vpMatrix: mat4): void;
  
  /**
   * Handle mouse down - returns true if gizmo was hit
   */
  abstract handleMouseDown(screenX: number, screenY: number): boolean;
  
  /**
   * Handle mouse move - returns true if drag was handled
   */
  abstract handleMouseMove(screenX: number, screenY: number): boolean;
  
  /**
   * Handle mouse up
   */
  abstract handleMouseUp(): void;
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    BaseGizmo.shaderRefCount--;
    
    // Only delete shared shader when last gizmo is destroyed
    if (BaseGizmo.shaderRefCount === 0 && BaseGizmo.shaderProgram) {
      this.gl.deleteProgram(BaseGizmo.shaderProgram);
      BaseGizmo.shaderProgram = null;
      BaseGizmo.shaderLocations = null;
    }
  }
}
