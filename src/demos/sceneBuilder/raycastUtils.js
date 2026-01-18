import { mat4 } from 'gl-matrix';

/**
 * Transform a point by a matrix (with perspective divide)
 */
export function transformPoint(point, matrix) {
  const out = [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12] * point[3],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13] * point[3],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14] * point[3],
    matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15] * point[3],
  ];
  // Perspective divide
  if (out[3] !== 0) {
    out[0] /= out[3];
    out[1] /= out[3];
    out[2] /= out[3];
  }
  return out;
}

/**
 * Normalize a 3D vector in place
 */
export function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len > 0) {
    v[0] /= len;
    v[1] /= len;
    v[2] /= len;
  }
}

/**
 * Get approximate bounding sphere radius for an object
 */
export function getObjectRadius(obj) {
  const avgScale = (obj.scale[0] + obj.scale[1] + obj.scale[2]) / 3;
  return avgScale * 0.5; // Assume unit-sized models with 0.5 radius
}

/**
 * Ray-sphere intersection test
 * @returns {number|null} Distance to intersection or null if no hit
 */
export function rayIntersectsSphere(rayOrigin, rayDir, sphereCenter, sphereRadius) {
  const oc = [
    rayOrigin[0] - sphereCenter[0],
    rayOrigin[1] - sphereCenter[1],
    rayOrigin[2] - sphereCenter[2],
  ];
  
  const a = rayDir[0] * rayDir[0] + rayDir[1] * rayDir[1] + rayDir[2] * rayDir[2];
  const b = 2 * (oc[0] * rayDir[0] + oc[1] * rayDir[1] + oc[2] * rayDir[2]);
  const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - sphereRadius * sphereRadius;
  
  const discriminant = b * b - 4 * a * c;
  
  if (discriminant < 0) return null;
  
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t > 0 ? t : null;
}

/**
 * Project a world position to screen coordinates
 */
export function projectToScreen(worldPos, camera, canvasWidth, canvasHeight) {
  const vpMatrix = camera.getViewProjectionMatrix();
  const pos4 = [worldPos[0], worldPos[1], worldPos[2], 1];
  
  const clipPos = [
    vpMatrix[0] * pos4[0] + vpMatrix[4] * pos4[1] + vpMatrix[8] * pos4[2] + vpMatrix[12] * pos4[3],
    vpMatrix[1] * pos4[0] + vpMatrix[5] * pos4[1] + vpMatrix[9] * pos4[2] + vpMatrix[13] * pos4[3],
    vpMatrix[2] * pos4[0] + vpMatrix[6] * pos4[1] + vpMatrix[10] * pos4[2] + vpMatrix[14] * pos4[3],
    vpMatrix[3] * pos4[0] + vpMatrix[7] * pos4[1] + vpMatrix[11] * pos4[2] + vpMatrix[15] * pos4[3],
  ];
  
  if (clipPos[3] !== 0) {
    clipPos[0] /= clipPos[3];
    clipPos[1] /= clipPos[3];
  }
  
  const screenX = (clipPos[0] * 0.5 + 0.5) * canvasWidth;
  const screenY = (1 - (clipPos[1] * 0.5 + 0.5)) * canvasHeight;
  
  return [screenX, screenY];
}

/**
 * Create a ray from screen coordinates
 */
export function screenToRay(screenX, screenY, camera, canvasWidth, canvasHeight) {
  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = -((screenY / canvasHeight) * 2 - 1); // Flip Y
  
  const vpMatrix = camera.getViewProjectionMatrix();
  const invVPMatrix = mat4.create();
  mat4.invert(invVPMatrix, vpMatrix);
  
  const nearPoint = [ndcX, ndcY, -1, 1];
  const farPoint = [ndcX, ndcY, 1, 1];
  
  const worldNear = transformPoint(nearPoint, invVPMatrix);
  const worldFar = transformPoint(farPoint, invVPMatrix);
  
  const rayOrigin = [worldNear[0], worldNear[1], worldNear[2]];
  const rayDir = [
    worldFar[0] - worldNear[0],
    worldFar[1] - worldNear[1],
    worldFar[2] - worldNear[2],
  ];
  
  return { rayOrigin, rayDir };
}

/**
 * Raycast to Y=0 plane
 * @returns {[number, number]|null} Hit position [x, z] or null if no hit
 */
export function raycastToGround(screenX, screenY, camera, canvasWidth, canvasHeight, gridBounds) {
  const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera, canvasWidth, canvasHeight);
  
  // Ray-plane intersection with Y=0 plane
  if (Math.abs(rayDir[1]) < 0.0001) return null; // Ray parallel to ground
  
  const t = -rayOrigin[1] / rayDir[1];
  if (t < 0) return null; // Intersection behind camera
  
  const hitX = rayOrigin[0] + t * rayDir[0];
  const hitZ = rayOrigin[2] + t * rayDir[2];
  
  // Check if within grid bounds
  if (Math.abs(hitX) <= gridBounds && Math.abs(hitZ) <= gridBounds) {
    return [hitX, hitZ];
  }
  
  return null;
}
