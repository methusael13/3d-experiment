import { mat4, vec3 } from 'gl-matrix';
import { SceneObject } from './SceneObject';
import type { SerializedSceneObject } from './types';

/**
 * Camera projection modes
 */
export type ProjectionMode = 'perspective' | 'orthographic';

/**
 * Serialized camera data
 */
export interface SerializedCameraObject extends SerializedSceneObject {
  type: 'camera';
  projectionMode: ProjectionMode;
  fov: number;
  near: number;
  far: number;
  orthoSize: number;
  target?: [number, number, number];
}

/**
 * Camera object for the scene.
 * Provides view and projection matrix computation.
 */
export class CameraObject extends SceneObject {
  /** Projection mode */
  public projectionMode: ProjectionMode = 'perspective';
  
  /** Field of view in degrees (for perspective) */
  public fov: number = 60;
  
  /** Near clipping plane */
  public near: number = 0.1;
  
  /** Far clipping plane */
  public far: number = 1000;
  
  /** Orthographic size (half-height of view volume) */
  public orthoSize: number = 5;
  
  /** Look-at target point (optional, for orbit-style cameras) */
  public target: vec3 | null = null;
  
  /** Cached view matrix */
  private viewMatrix: mat4 = mat4.create();
  
  /** Cached projection matrix */
  private projectionMatrix: mat4 = mat4.create();
  
  /** Cached view-projection matrix */
  private vpMatrix: mat4 = mat4.create();
  
  /** Aspect ratio (set externally based on viewport) */
  private aspectRatio: number = 1;
  
  /** Flag to track if matrices need recalculation */
  private dirty: boolean = true;
  
  constructor(name: string = 'Camera') {
    super(name);
    // Default camera position
    this.position = vec3.fromValues(0, 2, 5);
  }
  
  /**
   * Object type identifier
   */
  get objectType(): string {
    return 'camera';
  }
  
  /**
   * Set the viewport aspect ratio
   */
  setAspectRatio(width: number, height: number): void {
    this.aspectRatio = width / height;
    this.dirty = true;
  }
  
  /**
   * Set field of view in degrees
   */
  setFOV(degrees: number): void {
    this.fov = Math.max(1, Math.min(179, degrees));
    this.dirty = true;
  }
  
  /**
   * Set near and far clipping planes
   */
  setClipPlanes(near: number, far: number): void {
    this.near = Math.max(0.001, near);
    this.far = Math.max(this.near + 0.001, far);
    this.dirty = true;
  }
  
  /**
   * Set orthographic size
   */
  setOrthoSize(size: number): void {
    this.orthoSize = Math.max(0.1, size);
    this.dirty = true;
  }
  
  /**
   * Set look-at target
   */
  setTarget(target: vec3 | [number, number, number] | null): void {
    if (target) {
      this.target = vec3.clone(target as vec3);
    } else {
      this.target = null;
    }
    this.dirty = true;
  }
  
  /**
   * Look at a specific point
   */
  lookAt(target: vec3 | [number, number, number]): void {
    this.setTarget(target);
  }
  
  /**
   * Get the view matrix
   */
  getViewMatrix(): mat4 {
    this.updateMatricesIfNeeded();
    return this.viewMatrix;
  }
  
  /**
   * Get the projection matrix
   */
  getProjectionMatrix(): mat4 {
    this.updateMatricesIfNeeded();
    return this.projectionMatrix;
  }
  
  /**
   * Get the combined view-projection matrix
   */
  getViewProjectionMatrix(): mat4 {
    this.updateMatricesIfNeeded();
    return this.vpMatrix;
  }
  
  /**
   * Mark matrices as needing update (call after changing position/rotation)
   */
  markDirty(): void {
    this.dirty = true;
  }
  
  /**
   * Override position setter to mark dirty
   */
  setPosition(pos: vec3 | [number, number, number]): void {
    super.setPosition(pos);
    this.dirty = true;
  }
  
  /**
   * Override rotation setter to mark dirty
   */
  setRotation(rot: vec3 | [number, number, number]): void {
    super.setRotation(rot);
    this.dirty = true;
  }
  
  /**
   * Update cached matrices if needed
   */
  private updateMatricesIfNeeded(): void {
    if (!this.dirty) return;
    
    this.computeViewMatrix();
    this.computeProjectionMatrix();
    mat4.multiply(this.vpMatrix, this.projectionMatrix, this.viewMatrix);
    
    this.dirty = false;
  }
  
  /**
   * Compute the view matrix
   */
  private computeViewMatrix(): void {
    if (this.target) {
      // Look-at style view matrix
      const up = vec3.fromValues(0, 1, 0);
      mat4.lookAt(this.viewMatrix, this.position, this.target, up);
    } else {
      // Rotation-based view matrix (inverse of model matrix)
      const modelMatrix = this.getModelMatrix();
      mat4.invert(this.viewMatrix, modelMatrix);
    }
  }
  
  /**
   * Compute the projection matrix
   */
  private computeProjectionMatrix(): void {
    if (this.projectionMode === 'perspective') {
      const fovRad = this.fov * Math.PI / 180;
      mat4.perspective(
        this.projectionMatrix,
        fovRad,
        this.aspectRatio,
        this.near,
        this.far
      );
    } else {
      // Orthographic
      const halfHeight = this.orthoSize;
      const halfWidth = halfHeight * this.aspectRatio;
      mat4.ortho(
        this.projectionMatrix,
        -halfWidth,
        halfWidth,
        -halfHeight,
        halfHeight,
        this.near,
        this.far
      );
    }
  }
  
  /**
   * Get distance from camera to target (for orbit cameras)
   */
  getDistanceToTarget(): number {
    if (!this.target) return 0;
    return vec3.distance(this.position, this.target);
  }
  
  /**
   * Set distance from camera to target (moves camera along look direction)
   */
  setDistanceToTarget(distance: number): void {
    if (!this.target) return;
    
    const direction = vec3.create();
    vec3.subtract(direction, this.position, this.target);
    vec3.normalize(direction, direction);
    vec3.scaleAndAdd(this.position, this.target, direction, distance);
    this.dirty = true;
  }
  
  /**
   * Orbit around the target by given angles (in degrees)
   */
  orbit(deltaAzimuth: number, deltaElevation: number): void {
    if (!this.target) return;
    
    const distance = this.getDistanceToTarget();
    
    // Get current spherical coordinates
    const offset = vec3.create();
    vec3.subtract(offset, this.position, this.target);
    
    // Convert to spherical (theta = azimuth, phi = elevation)
    const r = vec3.length(offset);
    let theta = Math.atan2(offset[0], offset[2]);
    let phi = Math.acos(Math.max(-1, Math.min(1, offset[1] / r)));
    
    // Apply deltas (convert degrees to radians)
    theta += deltaAzimuth * Math.PI / 180;
    phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi - deltaElevation * Math.PI / 180));
    
    // Convert back to Cartesian
    this.position[0] = this.target[0] + distance * Math.sin(phi) * Math.sin(theta);
    this.position[1] = this.target[1] + distance * Math.cos(phi);
    this.position[2] = this.target[2] + distance * Math.sin(phi) * Math.cos(theta);
    
    this.dirty = true;
  }
  
  /**
   * Pan the camera and target together
   */
  pan(deltaX: number, deltaY: number): void {
    const right = this.getRight();
    const up = this.getUp();
    
    const offset = vec3.create();
    vec3.scaleAndAdd(offset, offset, right, deltaX);
    vec3.scaleAndAdd(offset, offset, up, deltaY);
    
    vec3.add(this.position, this.position, offset);
    if (this.target) {
      vec3.add(this.target, this.target, offset);
    }
    
    this.dirty = true;
  }
  
  /**
   * Dolly the camera (move forward/backward)
   */
  dolly(delta: number): void {
    if (this.target) {
      // Move toward/away from target
      const newDistance = Math.max(0.1, this.getDistanceToTarget() - delta);
      this.setDistanceToTarget(newDistance);
    } else {
      // Move along forward direction
      const forward = this.getForward();
      vec3.scaleAndAdd(this.position, this.position, forward, delta);
    }
    this.dirty = true;
  }
  
  /**
   * Serialize the camera
   */
  serialize(): SerializedCameraObject {
    const base = super.serialize();
    return {
      ...base,
      type: 'camera',
      projectionMode: this.projectionMode,
      fov: this.fov,
      near: this.near,
      far: this.far,
      orthoSize: this.orthoSize,
      target: this.target ? [this.target[0], this.target[1], this.target[2]] : undefined,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedCameraObject>): void {
    super.deserialize(data);
    
    if (data.projectionMode !== undefined) this.projectionMode = data.projectionMode;
    if (data.fov !== undefined) this.fov = data.fov;
    if (data.near !== undefined) this.near = data.near;
    if (data.far !== undefined) this.far = data.far;
    if (data.orthoSize !== undefined) this.orthoSize = data.orthoSize;
    if (data.target) this.setTarget(data.target);
    
    this.dirty = true;
  }
  
  /**
   * Clean up (cameras don't have GPU resources)
   */
  destroy(): void {
    // Nothing to clean up
  }
  
  /**
   * Create a CameraObject from serialized data
   */
  static fromSerialized(data: SerializedCameraObject): CameraObject {
    const camera = new CameraObject(data.name);
    camera.deserialize(data);
    return camera;
  }
}
