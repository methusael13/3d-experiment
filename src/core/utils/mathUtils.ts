/**
 * Math utilities for 3D graphics
 * Coordinate system: OpenGL (right-handed)
 * +X is to the right, +Y is up, +Z is towards the viewer
 */

import { mat4, vec3, quat, ReadonlyVec3, ReadonlyQuat } from 'gl-matrix';

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
