import { mat4, vec3 } from 'gl-matrix';
import { SceneObject } from './SceneObject';
import type { SerializedSceneObject } from './types';

/**
 * Camera projection modes
 */
export type ProjectionMode = 'perspective' | 'orthographic';

/**
 * Orbit camera state - used for serialization and state management
 * This is the state representation used by the orbit camera controller
 */
export interface CameraState {
  /** Horizontal rotation angle (azimuth) in radians */
  angleX: number;
  /** Vertical rotation angle (elevation) in radians */
  angleY: number;
  /** Distance from camera to target/origin */
  distance: number;
  /** Origin X position */
  originX: number;
  /** Origin Y position */
  originY: number;
  /** Origin Z position */
  originZ: number;
  /** Pan offset X */
  offsetX: number;
  /** Pan offset Y */
  offsetY: number;
  /** Pan offset Z */
  offsetZ: number;
}

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
  /** Orbit state (optional, for orbit-style cameras) */
  orbitState?: CameraState;
}

/**
 * Camera object for the scene.
 * Provides view and projection matrix computation.
 * Supports both target-based and orbit-based control modes.
 */
export class CameraObject extends SceneObject {
  /** Projection mode */
  public projectionMode: ProjectionMode = 'perspective';
  
  /** Field of view in degrees (for perspective) */
  public fov: number = 45;
  
  /** Near clipping plane */
  public near: number = 0.1;
  
  /** Far clipping plane */
  public far: number = 100;
  
  /** Orthographic size (half-height of view volume) */
  public orthoSize: number = 5;
  
  /** Look-at target point (computed from orbit state or set directly) */
  public target: vec3 = vec3.create();
  
  // ==================== Orbit Camera State ====================
  
  /** Horizontal rotation angle (azimuth) in radians */
  private _angleX: number = 0.5;
  
  /** Vertical rotation angle (elevation) in radians */
  private _angleY: number = 0.3;
  
  /** Distance from camera to target/origin */
  private _distance: number = 5;
  
  /** Origin position (orbit center) */
  private _origin: vec3 = vec3.create();
  
  /** Pan offset from origin */
  private _offset: vec3 = vec3.create();
  
  /** Minimum zoom distance */
  private _minDistance: number = 0.5;
  
  /** Maximum zoom distance */
  private _maxDistance: number = 100;
  
  // ==================== Internal State ====================
  
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
    // Initialize from orbit state
    this.updatePositionFromOrbit();
  }
  
  // ==================== Orbit State Accessors ====================
  
  get angleX(): number { return this._angleX; }
  set angleX(value: number) { this._angleX = value; this.dirty = true; }
  
  get angleY(): number { return this._angleY; }
  set angleY(value: number) { 
    this._angleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, value)); 
    this.dirty = true; 
  }
  
  get distance(): number { return this._distance; }
  set distance(value: number) { 
    this._distance = Math.max(0.1, value); 
    this.dirty = true; 
  }
  
  get origin(): vec3 { return this._origin; }
  set origin(value: vec3 | [number, number, number]) { 
    vec3.copy(this._origin, value as vec3);
    this.dirty = true; 
  }
  
  get offset(): vec3 { return this._offset; }
  set offset(value: vec3 | [number, number, number]) { 
    vec3.copy(this._offset, value as vec3);
    this.dirty = true; 
  }
  
  /**
   * Object type identifier
   */
  get objectType(): string {
    return 'camera';
  }
  
  // ==================== Orbit Control Methods ====================
  
  /**
   * Update camera position from orbit state (angleX, angleY, distance, origin, offset)
   */
  updatePositionFromOrbit(): void {
    const targetX = this._origin[0] + this._offset[0];
    const targetY = this._origin[1] + this._offset[1];
    const targetZ = this._origin[2] + this._offset[2];
    
    const x = Math.sin(this._angleX) * Math.cos(this._angleY) * this._distance;
    const y = Math.sin(this._angleY) * this._distance;
    const z = Math.cos(this._angleX) * Math.cos(this._angleY) * this._distance;
    
    this.position[0] = x + targetX;
    this.position[1] = y + targetY;
    this.position[2] = z + targetZ;
    
    this.target[0] = targetX;
    this.target[1] = targetY;
    this.target[2] = targetZ;
    
    this.dirty = true;
  }
  
  /**
   * Orbit the camera by delta angles (in radians)
   */
  orbitBy(deltaX: number, deltaY: number): void {
    this._angleX -= deltaX;
    this._angleY += deltaY;
    this._angleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this._angleY));
    this.updatePositionFromOrbit();
  }
  
  /**
   * Pan the camera by screen delta (in world units)
   */
  panBy(dx: number, dy: number): void {
    const rightX = Math.cos(this._angleX);
    const rightZ = -Math.sin(this._angleX);
    const upX = -Math.sin(this._angleX) * Math.sin(this._angleY);
    const upY = Math.cos(this._angleY);
    const upZ = -Math.cos(this._angleX) * Math.sin(this._angleY);
    
    const panSpeed = 0.01 * this._distance * 0.5;
    this._offset[0] -= (dx * rightX - dy * upX) * panSpeed;
    this._offset[1] += dy * upY * panSpeed;
    this._offset[2] -= (dx * rightZ - dy * upZ) * panSpeed;
    
    this.updatePositionFromOrbit();
  }
  
  /**
   * Set zoom distance limits
   */
  setZoomLimits(min: number, max: number): void {
    this._minDistance = Math.max(0.1, min);
    this._maxDistance = Math.max(this._minDistance, max);
    // Clamp current distance to new limits
    this._distance = Math.max(this._minDistance, Math.min(this._maxDistance, this._distance));
    this.updatePositionFromOrbit();
  }
  
  /**
   * Get current zoom limits
   */
  getZoomLimits(): { min: number; max: number } {
    return { min: this._minDistance, max: this._maxDistance };
  }
  
  /**
   * Zoom by delta (positive = zoom out, negative = zoom in)
   * Uses stored min/max distance limits
   */
  zoomBy(delta: number): void {
    this._distance += delta * 0.01;
    this._distance = Math.max(this._minDistance, Math.min(this._maxDistance, this._distance));
    this.updatePositionFromOrbit();
  }
  
  /**
   * Get the orbit state for serialization
   */
  getOrbitState(): CameraState {
    return {
      angleX: this._angleX,
      angleY: this._angleY,
      distance: this._distance,
      originX: this._origin[0],
      originY: this._origin[1],
      originZ: this._origin[2],
      offsetX: this._offset[0],
      offsetY: this._offset[1],
      offsetZ: this._offset[2],
    };
  }
  
  /**
   * Set the orbit state from deserialized data
   */
  setOrbitState(state: Partial<CameraState> | null | undefined): void {
    if (!state) return;
    
    if (state.angleX !== undefined) this._angleX = state.angleX;
    if (state.angleY !== undefined) this._angleY = state.angleY;
    if (state.distance !== undefined) this._distance = state.distance;
    if (state.originX !== undefined) this._origin[0] = state.originX;
    if (state.originY !== undefined) this._origin[1] = state.originY;
    if (state.originZ !== undefined) this._origin[2] = state.originZ;
    if (state.offsetX !== undefined) this._offset[0] = state.offsetX;
    if (state.offsetY !== undefined) this._offset[1] = state.offsetY;
    if (state.offsetZ !== undefined) this._offset[2] = state.offsetZ;
    
    this.updatePositionFromOrbit();
  }
  
  /**
   * Reset origin to world center, preserving camera angle
   */
  resetOrigin(): void {
    const dx = this.position[0];
    const dy = this.position[1];
    const dz = this.position[2];
    
    this._distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    this._angleY = Math.atan2(dy, horizontalDist);
    this._angleX = Math.atan2(dx, dz);
    
    vec3.zero(this._origin);
    vec3.zero(this._offset);
    
    this.updatePositionFromOrbit();
  }
  
  /**
   * Set origin from a world position
   */
  setOriginPosition(newOrigin: [number, number, number] | vec3): void {
    const camPos = this.position;
    
    const dx = camPos[0] - newOrigin[0];
    const dy = camPos[1] - newOrigin[1];
    const dz = camPos[2] - newOrigin[2];
    
    this._distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    this._angleY = Math.atan2(dy, horizontalDist);
    this._angleX = Math.atan2(dx, dz);
    
    vec3.copy(this._origin, newOrigin as vec3);
    vec3.zero(this._offset);
    
    this.updatePositionFromOrbit();
  }
  
  // ==================== Basic Setters ====================
  
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
      vec3.copy(this.target, target as vec3);
    }
    // Note: target is always a vec3 now, never null
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
   * Get camera position as Vec3 tuple (for compatibility with ViewportCamera interface)
   */
  getPosition(): [number, number, number] {
    return [this.position[0], this.position[1], this.position[2]];
  }
  
  /**
   * Get camera target position as Vec3 tuple
   */
  getTarget(): [number, number, number] {
    return [this.target[0], this.target[1], this.target[2]];
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
    // Always use look-at style (target is always set from orbit state)
    const up = vec3.fromValues(0, 1, 0);
    mat4.lookAt(this.viewMatrix, this.position, this.target, up);
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
      target: [this.target[0], this.target[1], this.target[2]],
      orbitState: this.getOrbitState(),
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
    
    // Prefer orbit state if available, otherwise use target
    if (data.orbitState) {
      this.setOrbitState(data.orbitState);
    } else if (data.target) {
      this.setTarget(data.target);
    }
    
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
