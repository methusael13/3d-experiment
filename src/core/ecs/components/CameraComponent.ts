import { mat4 } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';

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

const DEFAULT_FOV = Math.PI / 3;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 1000;

/**
 * CameraComponent — Camera projection & view state.
 *
 * Holds FOV, near/far, aspect, and cached view/projection/VP matrices.
 * A camera can exist without a player (orbit cam, cutscene cam).
 * A player can exist without a camera (NPC).
 *
 * CameraSystem reads TransformComponent position + PlayerComponent yaw/pitch
 * (if present) to compute view/VP matrices. If no PlayerComponent is present,
 * the camera uses TransformComponent orientation directly.
 */
export class CameraComponent extends Component {
  readonly type: ComponentType = 'camera';

  // ==================== Projection Parameters ====================

  fov = DEFAULT_FOV;
  near = DEFAULT_NEAR;
  far = DEFAULT_FAR;
  aspect = 16 / 9;

  // ==================== Cached Matrices ====================

  viewMatrix = mat4.create();
  projMatrix = mat4.create();
  vpMatrix = mat4.create();

  constructor(options?: {
    fov?: number;
    near?: number;
    far?: number;
  }) {
    super();
    if (options) {
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
   * Recompute view and VP matrices from a given position and yaw/pitch orientation.
   * Position comes from TransformComponent (the single source of truth).
   * Yaw/pitch come from PlayerComponent (if present).
   */
  updateMatrices(position: [number, number, number] | Float32Array, yaw: number, pitch: number): void {
    // Calculate look direction from yaw and pitch
    const lookDirX = Math.sin(yaw) * Math.cos(pitch);
    const lookDirY = Math.sin(pitch);
    const lookDirZ = Math.cos(yaw) * Math.cos(pitch);

    // Target = position + lookDir
    const targetX = position[0] + lookDirX;
    const targetY = position[1] + lookDirY;
    const targetZ = position[2] + lookDirZ;

    mat4.lookAt(
      this.viewMatrix,
      position as any,
      [targetX, targetY, targetZ] as any,
      [0, 1, 0],
    );

    mat4.multiply(this.vpMatrix, this.projMatrix, this.viewMatrix);
  }
}