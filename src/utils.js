import { mat4, vec3, quat } from 'gl-matrix';

// Coordinate system: OpenGL (right-handed)
// +X is to the right
// +Y is up
// +Z is towards the viewer (out of screen)
// Camera looks down -Z axis

/**
 * Creates a view matrix from camera position, target, and up vector.
 * 
 * @param {object} position - Camera position {x, y, z} in world space
 * @param {object} target - Point the camera is looking at {x, y, z}
 * @param {object} up - Up direction vector {x, y, z}
 * @returns {mat4} View matrix
 */
export const createViewMatrix = (position, target, up) => {
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
 * @param {object} position - Camera position {x, y, z}
 * @param {object} direction - Direction vector {x, y, z} (will be normalized)
 * @returns {object} Target point {x, y, z}
 */
export const getTargetFromDirection = (position, direction) => {
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
 * @param {object} point - 3D point {x, y, z} in world space
 * @param {mat4} viewMatrix - View matrix from createViewMatrix
 * @returns {object} 3D point {x, y, z} in camera space
 */
export const worldToCamera = (point, viewMatrix) => {
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
 * @param {object} point - 3D point {x, y, z} in camera space
 * @param {number} near - Near clipping plane distance (positive value)
 * @param {number} fov - Field of view in radians (vertical)
 * @returns {object|null} 2D point {x, y} in NDC (-1 to 1), or null if behind camera
 */
export const perspectiveProject = (point, near = 1, fov = Math.PI / 2) => {
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
export const cameraToScreen = (point, width, height) => {
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
 * @param {object} point - {x, y}
 * @param {CanvasRenderingContext2D} ctx 
 * @param {string} color
 * @param {number} size - Point size in pixels (default 2)
 */
export const drawPoint = (point, ctx, color, size = 2) => {
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
 * @param {object} from - {x, y}
 * @param {object} to - {x, y}
 * @param {CanvasRenderingContext2D} ctx 
 * @param {string} color
 * @param {number} lineWidth - (default 1)
 */
export const drawLine = (from, to, ctx, color, lineWidth = 1) => {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
};

/**
 * Create an identity quaternion (no rotation)
 * @returns {quat}
 */
export const createRotation = () => quat.create();

/**
 * Rotate a quaternion around X axis
 * @param {quat} rotation - Current rotation
 * @param {number} angle - Angle in radians
 * @returns {quat} New rotation
 */
export const rotateX = (rotation, angle) => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [1, 0, 0], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Rotate a quaternion around Y axis
 * @param {quat} rotation - Current rotation
 * @param {number} angle - Angle in radians
 * @returns {quat} New rotation
 */
export const rotateY = (rotation, angle) => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [0, 1, 0], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Rotate a quaternion around Z axis
 * @param {quat} rotation - Current rotation
 * @param {number} angle - Angle in radians
 * @returns {quat} New rotation
 */
export const rotateZ = (rotation, angle) => {
  const delta = quat.create();
  quat.setAxisAngle(delta, [0, 0, 1], angle);
  const result = quat.create();
  quat.multiply(result, rotation, delta);
  return result;
};

/**
 * Apply quaternion rotation to a 3D point
 * @param {object} point - {x, y, z}
 * @param {quat} rotation - Quaternion rotation
 * @returns {object} Rotated point {x, y, z}
 */
export const applyRotation = (point, rotation) => {
  const v = vec3.fromValues(point.x, point.y, point.z);
  vec3.transformQuat(v, v, rotation);
  return { x: v[0], y: v[1], z: v[2] };
};

/**
 * Spherical linear interpolation between two quaternions
 * @param {quat} from - Start rotation
 * @param {quat} to - End rotation
 * @param {number} t - Interpolation factor (0 to 1)
 * @returns {quat} Interpolated rotation
 */
export const slerpRotation = (from, to, t) => {
  const result = quat.create();
  quat.slerp(result, from, to, t);
  return result;
};
