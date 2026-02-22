/**
 * Math utilities for 3D graphics
 * Coordinate system: OpenGL (right-handed)
 * +X is to the right, +Y is up, +Z is towards the viewer
 */

import { mat4, vec3, quat, ReadonlyVec3, ReadonlyQuat } from 'gl-matrix';
import { Vec3 } from '../types';

/**
 * 3D point with named components
 */
export interface Point3D {
  x: number;
  y: number;
  z: number;
}

/**
 * 2D point with named components
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * Creates a view matrix from camera position, target, and up vector.
 */
export const createViewMatrix = (
  position: Point3D,
  target: Point3D,
  up: Point3D
): mat4 => {
  const viewMatrix = mat4.create();
  mat4.lookAt(
    viewMatrix,
    [position.x, position.y, position.z],
    [target.x, target.y, target.z],
    [up.x, up.y, up.z]
  );
  return viewMatrix;
};

/**
 * Computes target point given camera position and direction vector.
 */
export const getTargetFromDirection = (
  position: Point3D,
  direction: Point3D
): Point3D => {
  const dir = vec3.fromValues(direction.x, direction.y, direction.z);
  vec3.normalize(dir, dir);
  return {
    x: position.x + dir[0],
    y: position.y + dir[1],
    z: position.z + dir[2],
  };
};

/**
 * World space to camera space using view matrix.
 */
export const worldToCamera = (
  point: Point3D,
  viewMatrix: mat4
): Point3D => {
  const p = vec3.fromValues(point.x, point.y, point.z);
  const result = vec3.create();
  vec3.transformMat4(result, p, viewMatrix);
  return {
    x: result[0],
    y: result[1],
    z: result[2],
  };
};

/**
 * Perspective projection: 3D camera space → 2D normalized device coordinates
 */
export const perspectiveProject = (
  point: Point3D,
  near: number = 1,
  fov: number = Math.PI / 2
): Point2D | null => {
  const z = -point.z;
  if (z <= near) return null;
  
  const fovScale = 1 / Math.tan(fov / 2);
  return {
    x: (point.x * fovScale) / z,
    y: (point.y * fovScale) / z,
  };
};

/**
 * Camera space to screen space with aspect ratio correction
 */
export const cameraToScreen = (
  point: Point2D,
  width: number,
  height: number
): Point2D => {
  const aspectRatio = width / height;
  if (aspectRatio >= 1) {
    return {
      x: (point.x / aspectRatio + 1) * 0.5 * width,
      y: (1 - (point.y + 1) * 0.5) * height,
    };
  } else {
    return {
      x: (point.x + 1) * 0.5 * width,
      y: (1 - (point.y * aspectRatio + 1) * 0.5) * height,
    };
  }
};

/**
 * Draw a point in the canvas context
 */
export const drawPoint = (
  point: Point2D,
  ctx: CanvasRenderingContext2D,
  color: string,
  size: number = 2
): void => {
  const halfSize = size / 2;
  ctx.fillStyle = color;
  ctx.fillRect(point.x - halfSize, point.y - halfSize, size, size);
};

/**
 * Draw a line between two screen points
 */
export const drawLine = (
  from: Point2D,
  to: Point2D,
  ctx: CanvasRenderingContext2D,
  color: string,
  lineWidth: number = 1
): void => {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
};

/**
 * Create an identity quaternion (no rotation)
 */
export const createRotation = (): quat => quat.create();

/**
 * Rotate a quaternion around X axis
 */
export const rotateX = (rotation: ReadonlyQuat, angle: number): quat => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [1, 0, 0], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Rotate a quaternion around Y axis
 */
export const rotateY = (rotation: ReadonlyQuat, angle: number): quat => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [0, 1, 0], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Rotate a quaternion around Z axis
 */
export const rotateZ = (rotation: ReadonlyQuat, angle: number): quat => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [0, 0, 1], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Apply quaternion rotation to a 3D point
 */
export const applyRotation = (point: Point3D, rotation: ReadonlyQuat): Point3D => {
  const v = vec3.fromValues(point.x, point.y, point.z);
  vec3.transformQuat(v, v, rotation);
  return { x: v[0], y: v[1], z: v[2] };
};

/**
 * Spherical linear interpolation between two quaternions
 */
export const slerpRotation = (
  from: ReadonlyQuat,
  to: ReadonlyQuat,
  t: number
): quat => {
  const result = quat.create();
  quat.slerp(result, from, to, t);
  return result;
};

export const toVec3 = (vector: Vec3) =>
  vec3.fromValues(vector[0], vector[1], vector[2]);

// ==================== Euler ↔ Quaternion Conversions ====================

/**
 * Convert Euler angles (degrees, intrinsic XYZ order) to quaternion.
 * 
 * Intrinsic XYZ means: first rotate around local X, then local Y, then local Z.
 * This is equivalent to extrinsic ZYX (world axes in reverse order).
 * 
 * The quaternion multiplication order for intrinsic XYZ is: qz * qy * qx
 * (applied right-to-left, so X is applied first to the object)
 * 
 * @param euler - [rx, ry, rz] in degrees
 * @returns Quaternion representing the rotation
 */
export const eulerToQuat = (euler: [number, number, number]): quat => {
  const degToRad = Math.PI / 180;
  
  const rx = euler[0] * degToRad;
  const ry = euler[1] * degToRad;
  const rz = euler[2] * degToRad;
  
  // Half angles
  const cx = Math.cos(rx / 2);
  const sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2);
  const sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2);
  const sz = Math.sin(rz / 2);
  
  // Intrinsic XYZ = extrinsic ZYX
  // q = qz * qy * qx (multiplication order)
  const q = quat.create();
  q[0] = sx * cy * cz - cx * sy * sz;  // x
  q[1] = cx * sy * cz + sx * cy * sz;  // y
  q[2] = cx * cy * sz - sx * sy * cz;  // z
  q[3] = cx * cy * cz + sx * sy * sz;  // w
  
  return q;
};

/**
 * Convert quaternion to Euler angles (degrees, intrinsic XYZ order).
 * 
 * Extracts Euler angles that, when applied as intrinsic XYZ rotations,
 * produce the same rotation as the input quaternion.
 * 
 * @param q - Quaternion to convert
 * @returns [rx, ry, rz] in degrees
 */
export const quatToEuler = (q: ReadonlyQuat): vec3 => {
  const radToDeg = 180 / Math.PI;
  
  const x = q[0], y = q[1], z = q[2], w = q[3];
  
  // Rotation matrix elements (only the ones we need)
  // For intrinsic XYZ, we extract from the matrix differently
  const m00 = 1 - 2 * (y * y + z * z);
  const m01 = 2 * (x * y + w * z);
  const m02 = 2 * (x * z - w * y);
  const m10 = 2 * (x * y - w * z);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z + w * x);
  const m20 = 2 * (x * z + w * y);
  const m21 = 2 * (y * z - w * x);
  const m22 = 1 - 2 * (x * x + y * y);
  
  let rx: number, ry: number, rz: number;
  
  // For intrinsic XYZ (extrinsic ZYX), the matrix is:
  // R = Rz * Ry * Rx
  // m02 = -sin(ry), so ry = -asin(m02)
  
  const sinRy = -m02;
  
  if (Math.abs(sinRy) >= 0.9999) {
    // Gimbal lock: ry ≈ ±90°
    ry = sinRy > 0 ? Math.PI / 2 : -Math.PI / 2;
    // In gimbal lock, rz and rx become coupled
    // Set rz = 0 and solve for rx
    rz = 0;
    rx = Math.atan2(-m21, m11);
  } else {
    ry = Math.asin(sinRy);
    // m12 / m22 = tan(rx) when cos(ry) ≠ 0
    rx = Math.atan2(m12, m22);
    // m01 / m00 = tan(rz) when cos(ry) ≠ 0
    rz = Math.atan2(m01, m00);
  }
  
  return vec3.fromValues(rx * radToDeg, ry * radToDeg, rz * radToDeg);
};

/**
 * Check if two Euler angle triplets represent the same rotation.
 * Handles wrap-around and equivalent representations.
 * 
 * @param a - First Euler angles [rx, ry, rz] in degrees
 * @param b - Second Euler angles [rx, ry, rz] in degrees
 * @param tolerance - Angle tolerance in degrees (default 0.001)
 * @returns true if rotations are equivalent
 */
export const eulerEquals = (
  a: [number, number, number],
  b: [number, number, number],
  tolerance: number = 0.001
): boolean => {
  // Convert both to quaternions and compare
  const qa = eulerToQuat(a);
  const qb = eulerToQuat(b);
  
  // Quaternions q and -q represent the same rotation
  const dot = quat.dot(qa, qb);
  return Math.abs(Math.abs(dot) - 1) < tolerance * Math.PI / 180;
};

/**
 * Extract 6 frustum planes from a view-projection matrix.
 * Each plane is [a, b, c, d] where ax + by + cz + d >= 0 is inside.
 */
export function extractFrustumPlanes(vp: Float32Array): Float32Array {
  // 6 planes × 4 components = 24 floats
  const planes = new Float32Array(24);

  // Left:   row3 + row0
  planes[0] = vp[3] + vp[0];
  planes[1] = vp[7] + vp[4];
  planes[2] = vp[11] + vp[8];
  planes[3] = vp[15] + vp[12];

  // Right:  row3 - row0
  planes[4] = vp[3] - vp[0];
  planes[5] = vp[7] - vp[4];
  planes[6] = vp[11] - vp[8];
  planes[7] = vp[15] - vp[12];

  // Bottom: row3 + row1
  planes[8] = vp[3] + vp[1];
  planes[9] = vp[7] + vp[5];
  planes[10] = vp[11] + vp[9];
  planes[11] = vp[15] + vp[13];

  // Top:    row3 - row1
  planes[12] = vp[3] - vp[1];
  planes[13] = vp[7] - vp[5];
  planes[14] = vp[11] - vp[9];
  planes[15] = vp[15] - vp[13];

  // Near:   row3 + row2 (WebGPU Z is 0 to 1)
  planes[16] = vp[2];
  planes[17] = vp[6];
  planes[18] = vp[10];
  planes[19] = vp[14];

  // Far:    row3 - row2
  planes[20] = vp[3] - vp[2];
  planes[21] = vp[7] - vp[6];
  planes[22] = vp[11] - vp[10];
  planes[23] = vp[15] - vp[14];

  // Normalize each plane
  for (let i = 0; i < 6; i++) {
    const base = i * 4;
    const len = Math.sqrt(planes[base] ** 2 + planes[base + 1] ** 2 + planes[base + 2] ** 2);
    if (len > 0) {
      planes[base] /= len;
      planes[base + 1] /= len;
      planes[base + 2] /= len;
      planes[base + 3] /= len;
    }
  }

  return planes;
}

/**
 * Test if an AABB (defined by XZ bounds + Y range) is inside the frustum.
 * Returns true if the box is at least partially inside.
 * 
 * bounds: [minX, minZ, maxX, maxZ]
 * Y range estimated from heightScale
 */
export function isAABBInFrustum(
  planes: Float32Array,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const base = i * 4;
    const a = planes[base], b = planes[base + 1], c = planes[base + 2], d = planes[base + 3];

    // Find the corner of the AABB that is most in the direction of the plane normal
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;

    // If the most-positive corner is behind the plane, the AABB is fully outside
    if (a * px + b * py + c * pz + d < 0) {
      return false;
    }
  }
  return true;
}
