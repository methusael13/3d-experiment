import { mat4 } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { Vec3 } from '../../types';

// ==================== Reversed-Z Perspective ====================

/**
 * Create a reversed-Z perspective projection matrix.
 * Reversed-Z maps near plane to depth 1 and far plane to depth 0,
 * which provides better depth precision for large scenes.
 * Matches the WebGPU terrain renderer which uses depthCompare: 'greater'.
 */
function perspectiveReversedZ(out: mat4, fovy: number, aspect: number, near: number, far: number): mat4 {
  const f = 1.0 / Math.tan(fovy / 2);

  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 0;

  out[0] = f / aspect;
  out[5] = f;
  out[10] = near / (far - near);
  out[11] = -1;
  out[14] = (near * far) / (far - near);

  return out;
}

// ==================== Constants ====================

const DEFAULT_PLAYER_HEIGHT = 1.8;
const DEFAULT_MOVE_SPEED = 5.0;
const DEFAULT_SPRINT_MULTIPLIER = 2.0;
const DEFAULT_MOUSE_SENSITIVITY = 0.002;
const DEFAULT_FOV = Math.PI / 3;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 1000;
const MAX_PITCH = Math.PI / 2 - 0.01;
const MIN_PITCH = -MAX_PITCH;

// Default grid bounds when no terrain is present
const DEFAULT_BOUNDS_HALF = 100;

/**
 * FPSCameraComponent — First-person camera state for terrain/ground exploration.
 *
 * Holds position, orientation, movement parameters, key state, and cached matrices.
 * Processed by FPSCameraSystem.
 */
export class FPSCameraComponent extends Component {
  readonly type: ComponentType = 'fps-camera';

  // ==================== Position & Orientation ====================

  position: Vec3 = [0, 0, 0];
  yaw = 0;   // Horizontal rotation (radians)
  pitch = 0; // Vertical rotation (radians)

  // ==================== Movement Parameters ====================

  playerHeight = DEFAULT_PLAYER_HEIGHT;
  moveSpeed = DEFAULT_MOVE_SPEED;
  sprintMultiplier = DEFAULT_SPRINT_MULTIPLIER;
  mouseSensitivity = DEFAULT_MOUSE_SENSITIVITY;

  // Pitch limits (gimbal lock prevention)
  maxPitch = MAX_PITCH;
  minPitch = MIN_PITCH;

  // ==================== Movement Key State ====================
  // Written by FPSCameraSystem from InputManager events

  forward = false;
  backward = false;
  left = false;
  right = false;
  sprint = false;

  // ==================== Projection Parameters ====================

  fov = DEFAULT_FOV;
  near = DEFAULT_NEAR;
  far = DEFAULT_FAR;
  aspect = 16 / 9;

  // ==================== Bounds ====================
  // Updated by FPSCameraSystem based on terrain or default grid

  boundsMinX = -DEFAULT_BOUNDS_HALF;
  boundsMaxX = DEFAULT_BOUNDS_HALF;
  boundsMinZ = -DEFAULT_BOUNDS_HALF;
  boundsMaxZ = DEFAULT_BOUNDS_HALF;

  // ==================== Cached Matrices ====================

  viewMatrix = mat4.create();
  projMatrix = mat4.create();
  vpMatrix = mat4.create();

  // ==================== Activation State ====================

  /** Whether the FPS camera is currently the active view camera */
  active = false;

  /** Whether the camera needs initial spawn positioning (set Y from terrain/ground) */
  needsSpawn = true;

  constructor(options?: {
    playerHeight?: number;
    moveSpeed?: number;
    sprintMultiplier?: number;
    mouseSensitivity?: number;
    fov?: number;
    near?: number;
    far?: number;
  }) {
    super();
    if (options) {
      if (options.playerHeight !== undefined) this.playerHeight = options.playerHeight;
      if (options.moveSpeed !== undefined) this.moveSpeed = options.moveSpeed;
      if (options.sprintMultiplier !== undefined) this.sprintMultiplier = options.sprintMultiplier;
      if (options.mouseSensitivity !== undefined) this.mouseSensitivity = options.mouseSensitivity;
      if (options.fov !== undefined) this.fov = options.fov;
      if (options.near !== undefined) this.near = options.near;
      if (options.far !== undefined) this.far = options.far;
    }
    // Initialize projection
    perspectiveReversedZ(this.projMatrix, this.fov, this.aspect, this.near, this.far);
  }

  /**
   * Update aspect ratio and recompute projection matrix.
   */
  setAspectRatio(width: number, height: number): void {
    this.aspect = width / height;
    perspectiveReversedZ(this.projMatrix, this.fov, this.aspect, this.near, this.far);
  }

  /**
   * Recompute view and VP matrices from current position/orientation.
   */
  updateMatrices(): void {
    // Calculate look direction from yaw and pitch
    const lookDirX = Math.sin(this.yaw) * Math.cos(this.pitch);
    const lookDirY = Math.sin(this.pitch);
    const lookDirZ = Math.cos(this.yaw) * Math.cos(this.pitch);

    // Target = position + lookDir
    const targetX = this.position[0] + lookDirX;
    const targetY = this.position[1] + lookDirY;
    const targetZ = this.position[2] + lookDirZ;

    mat4.lookAt(
      this.viewMatrix,
      this.position as any,
      [targetX, targetY, targetZ] as any,
      [0, 1, 0],
    );

    mat4.multiply(this.vpMatrix, this.projMatrix, this.viewMatrix);
  }

  /**
   * Reset key state (useful on deactivation to prevent stuck keys).
   */
  resetKeys(): void {
    this.forward = false;
    this.backward = false;
    this.left = false;
    this.right = false;
    this.sprint = false;
  }
}