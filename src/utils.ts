import { mat4, vec3, quat, ReadonlyVec3, ReadonlyQuat } from 'gl-matrix';

// Coordinate system: OpenGL (right-handed)
// +X is to the right
// +Y is up
// +Z is towards the viewer (out of screen)
// Camera looks down -Z axis

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
 * 
 * @param position - Camera position {x, y, z} in world space
 * @param target - Point the camera is looking at {x, y, z}
 * @param up - Up direction vector {x, y, z}
 * @returns View matrix
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
 * 
 * @param position - Camera position {x, y, z}
 * @param direction - Direction vector {x, y, z} (will be normalized)
 * @returns Target point {x, y, z}
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
 * Transforms a point from world coordinates to camera-relative coordinates.
 * 
 * @param point - 3D point {x, y, z} in world space
 * @param viewMatrix - View matrix from createViewMatrix
 * @returns 3D point {x, y, z} in camera space
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
 * 
 * Projects a 3D point onto the near plane using perspective division.
 * Objects closer to camera appear larger.
 * 
 * @param point - 3D point {x, y, z} in camera space
 * @param near - Near clipping plane distance (positive value)
 * @param fov - Field of view in radians (vertical)
 * @returns 2D point {x, y} in NDC (-1 to 1), or null if behind camera
 */
export const perspectiveProject = (
  point: Point3D,
  near: number = 1,
  fov: number = Math.PI / 2
): Point2D | null => {
  // In OpenGL, camera looks down -Z, so visible objects have negative z
  // We use -z for the perspective division
  const z = -point.z;
  
  // Point is behind or at the camera
  if (z <= near) {
    return null;
  }
  
  // Perspective division with FOV scaling
  // fovScale = 1 / tan(fov/2) gives us the projection plane distance
  const fovScale = 1 / Math.tan(fov / 2);
  
  return {
    x: (point.x * fovScale) / z,
    y: (point.y * fovScale) / z,
  };
};

/**
 * Camera space to screen space with aspect ratio correction
 * 
 * Camera space:
 * -1,1---------0,1--------1,1
 *   |                      |
 *   |                      |
 * -1,0---------0,0--------1,0
 *   |                      |
 *   |                      |
 * -1,-1--------0,-1-------1,-1
 *
 * Handles projection including:
 * - Coordinate mapping: (-1..1) to (0..width|height)
 * - Y-axis inversion (screen Y grows downward)
 * - Aspect ratio correction (objects maintain proportions)
 */
export const cameraToScreen = (
  point: Point2D,
  width: number,
  height: number
): Point2D => {
  const aspectRatio = width / height;
  if (aspectRatio >= 1) {
    // Wide screen: compress x to maintain proportions
    return {
      x: (point.x / aspectRatio + 1) * 0.5 * width,
      y: (1 - (point.y + 1) * 0.5) * height,
    };
  } else {
    // Tall screen: compress y to maintain proportions
    return {
      x: (point.x + 1) * 0.5 * width,
      y: (1 - (point.y * aspectRatio + 1) * 0.5) * height,
    };
  }
};

/**
 * Draw a point in the canvas context
 * @param point - {x, y}
 * @param ctx - Canvas 2D rendering context
 * @param color - Fill color
 * @param size - Point size in pixels (default 2)
 */
export const drawPoint = (
  point: Point2D,
  ctx: CanvasRenderingContext2D,
  color: string,
  size: number = 2
): void => {
  const halfSize = size / 2;
  ctx.fillStyle = color;
  ctx.fillRect(
    point.x - halfSize,
    point.y - halfSize,
    size,
    size
  );
};

/**
 * Draw a line between two screen points
 * @param from - Start point {x, y}
 * @param to - End point {x, y}
 * @param ctx - Canvas 2D rendering context
 * @param color - Stroke color
 * @param lineWidth - Line width (default 1)
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
 * @returns Identity quaternion
 */
export const createRotation = (): quat => quat.create();

/**
 * Rotate a quaternion around X axis
 * @param rotation - Current rotation
 * @param angle - Angle in radians
 * @returns New rotation
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
 * @param rotation - Current rotation
 * @param angle - Angle in radians
 * @returns New rotation
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
 * @param rotation - Current rotation
 * @param angle - Angle in radians
 * @returns New rotation
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
 * @param point - Point to rotate {x, y, z}
 * @param rotation - Quaternion rotation
 * @returns Rotated point {x, y, z}
 */
export const applyRotation = (point: Point3D, rotation: ReadonlyQuat): Point3D => {
  const v = vec3.fromValues(point.x, point.y, point.z);
  vec3.transformQuat(v, v, rotation);
  return { x: v[0], y: v[1], z: v[2] };
};

/**
 * Spherical linear interpolation between two quaternions
 * @param from - Start rotation
 * @param to - End rotation
 * @param t - Interpolation factor (0 to 1)
 * @returns Interpolated rotation
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
