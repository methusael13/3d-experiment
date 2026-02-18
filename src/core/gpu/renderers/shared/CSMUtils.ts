/**
 * CSMUtils - Shared Cascaded Shadow Map utilities
 * 
 * Extracted from ShadowRendererGPU so both the shadow pipeline and
 * debug visualizations (CameraFrustumRendererGPU) can reuse the same
 * cascade split / frustum-fitting logic.
 */

import { mat4, vec3, vec4 } from 'gl-matrix';

/** Maximum number of CSM cascades */
export const MAX_CASCADES = 4;

/** Result from computing a cascade's light-space matrix */
export interface CascadeLightResult {
  lightSpaceMatrix: mat4;
  radius: number;
  /** Light-view matrix (rotation + translation, for debug visualization of the ortho box) */
  lightView: mat4;
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

/**
 * Calculate cascade split distances using the practical split scheme.
 * Blends between logarithmic (better near detail) and linear (even distribution).
 *
 * @param nearPlane  Camera near plane
 * @param farPlane   Camera far plane (or shadow distance)
 * @param cascadeCount  Number of cascades (2-4)
 * @param lambda     0 = fully linear, 1 = fully logarithmic
 */
export function calculateCascadeSplits(
  nearPlane: number,
  farPlane: number,
  cascadeCount: number,
  lambda: number
): number[] {
  const splits: number[] = [];
  for (let i = 1; i <= cascadeCount; i++) {
    const p = i / cascadeCount;
    const logSplit = nearPlane * Math.pow(farPlane / nearPlane, p);
    const linearSplit = nearPlane + (farPlane - nearPlane) * p;
    splits.push(lambda * logSplit + (1 - lambda) * linearSplit);
  }
  return splits;
}

/**
 * Get world-space frustum corners for a camera sub-frustum [nearPlane, farPlane].
 * 
 * Builds a perspective projection for the given range, then inverse-projects
 * the 8 NDC cube corners back to world space.
 *
 * @returns Array of 8 vec4 corners (w=1) in world space
 */
export function getFrustumCornersWorldSpace(
  cameraView: mat4 | Float32Array,
  cameraProj: mat4 | Float32Array,
  nearPlane: number,
  farPlane: number
): vec4[] {
  // Extract FOV and aspect from the camera projection matrix
  const tanHalfFov = 1.0 / (cameraProj as Float32Array)[5];
  const aspect = (cameraProj as Float32Array)[5] / (cameraProj as Float32Array)[0];

  // Build sub-frustum perspective matrix
  const subProj = mat4.create();
  const fov = 2.0 * Math.atan(tanHalfFov);
  mat4.perspective(subProj, fov, aspect, nearPlane, farPlane);

  // inverse(subProj * cameraView)
  const viewProj = mat4.create();
  mat4.multiply(viewProj, subProj, cameraView as mat4);
  const invViewProj = mat4.create();
  mat4.invert(invViewProj, viewProj);

  // 8 NDC cube corners → world space
  const corners: vec4[] = [];
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        const pt: vec4 = vec4.fromValues(
          2.0 * x - 1.0,
          2.0 * y - 1.0,
          2.0 * z - 1.0,
          1.0
        );
        vec4.transformMat4(pt, pt, invViewProj);
        pt[0] /= pt[3];
        pt[1] /= pt[3];
        pt[2] /= pt[3];
        pt[3] = 1.0;
        corners.push(pt);
      }
    }
  }
  return corners;
}

/**
 * Build a global light rotation matrix from the light direction.
 * 
 * This produces a rotation-only matrix (no translation) that all cascades share.
 * Using the same rotation for every cascade guarantees identical shadow projection
 * angles, preventing shadow duplication artifacts.
 *
 * The matrix transforms world-space points into light-view space where:
 * - Z axis = light direction (looking down -Z in view convention)
 * - X axis = light's "right"
 * - Y axis = light's "up"
 *
 * @param lightDir  Normalized direction FROM scene TOWARD light (i.e. -lightRayDirection)
 * @returns A rotation-only mat4 (no translation component)
 */
export function buildLightRotationMatrix(lightDir: vec3): mat4 {
  // Choose a stable up vector that avoids degeneracy when light is nearly vertical
  let up: vec3 = [0, 1, 0];
  if (Math.abs(lightDir[1]) > 0.99) {
    up = [0, 0, 1];
  }

  // Use lookAt with eye at origin looking along -lightDir (lookAt convention: camera looks down -Z)
  // eye = [0,0,0], target = -lightDir gives us the rotation we need
  const rotationMatrix = mat4.create();
  mat4.lookAt(
    rotationMatrix,
    [0, 0, 0] as vec3,                                  // eye at origin
    [-lightDir[0], -lightDir[1], -lightDir[2]] as vec3,  // look toward -lightDir
    up
  );
  // lookAt at origin produces a pure rotation matrix (no translation)
  return rotationMatrix;
}

/**
 * Calculate a stable light-space ortho matrix for one cascade.
 *
 * Uses a global light rotation matrix (shared by all cascades) to ensure
 * identical projection angles. Per-cascade, only the center translation and
 * ortho bounds differ.
 *
 * Algorithm:
 * 1. Get world-space corners of camera sub-frustum [cascadeNear, cascadeFar]
 * 2. Compute bounding sphere (center + radius) — rotation-invariant
 * 3. Transform center to light space using the global rotation
 * 4. Snap center XY to texel grid to prevent sub-texel drift
 * 5. Compute Z range from projected corners, expand minZ for shadow casters
 * 6. Build lightView = globalRotation + translation to snapped center
 * 7. Build ortho projection (WebGPU [0,1] depth)
 *
 * @param lightDir        Normalized direction from scene toward light
 * @param lightRotation   Global light rotation matrix (from buildLightRotationMatrix)
 * @param cameraView      Camera view matrix
 * @param cameraProj      Camera projection matrix
 * @param cascadeNear     Near split distance for this cascade
 * @param cascadeFar      Far split distance for this cascade
 * @param shadowRadius    Used for Z-range expansion (scene scale)
 * @param shadowMapSize   Shadow map resolution for texel snapping (e.g. 2048)
 */
export function calculateCascadeLightMatrix(
  lightDir: vec3,
  cameraView: mat4 | Float32Array,
  cameraProj: mat4 | Float32Array,
  cascadeNear: number,
  cascadeFar: number,
  shadowRadius: number,
  shadowMapSize: number = 2048
): CascadeLightResult {
  // 0 — global light rotation (computed from lightDir, identical for all cascades)
  const lightRotation = buildLightRotationMatrix(lightDir);

  // 1 — frustum corners
  const corners = getFrustumCornersWorldSpace(cameraView, cameraProj, cascadeNear, cascadeFar);

  // 2 — bounding sphere: center = average of corners, radius = max distance from center
  // Using a sphere instead of tight AABB ensures the ortho box size is rotation-invariant
  const center: vec3 = vec3.fromValues(0, 0, 0);
  for (const c of corners) {
    center[0] += c[0]; center[1] += c[1]; center[2] += c[2];
  }
  center[0] /= corners.length;
  center[1] /= corners.length;
  center[2] /= corners.length;

  let sphereRadius = 0;
  for (const c of corners) {
    const dx = c[0] - center[0];
    const dy = c[1] - center[1];
    const dz = c[2] - center[2];
    sphereRadius = Math.max(sphereRadius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  // Round up to prevent jitter from floating point
  sphereRadius = Math.ceil(sphereRadius * 16) / 16;

  // 3 — Transform center to light space using global rotation
  const centerLightSpace: vec4 = vec4.create();
  vec4.transformMat4(centerLightSpace, [center[0], center[1], center[2], 1.0] as vec4, lightRotation);

  // 4 — Texel snapping: snap XY to texel grid so shadow map doesn't shift sub-texel
  const worldUnitsPerTexelX = (2.0 * sphereRadius) / shadowMapSize;
  const worldUnitsPerTexelY = (2.0 * sphereRadius) / shadowMapSize;

  const snappedX = Math.floor(centerLightSpace[0] / worldUnitsPerTexelX) * worldUnitsPerTexelX;
  const snappedY = Math.floor(centerLightSpace[1] / worldUnitsPerTexelY) * worldUnitsPerTexelY;

  // 5 — Z range: project all corners to light space to find actual Z extent
  let minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) {
    const trf: vec4 = vec4.create();
    vec4.transformMat4(trf, c, lightRotation);
    minZ = Math.min(minZ, trf[2]);
    maxZ = Math.max(maxZ, trf[2]);
  }

  // Expand minZ (toward light) to capture shadow casters behind the frustum slice.
  // Don't expand maxZ much — receivers are within the frustum.
  minZ -= shadowRadius;
  maxZ += shadowRadius * 0.1; // small forward expansion to avoid clipping

  // 6 — Build per-cascade lightView = globalRotation + translation to snapped center
  // The lightView matrix is the global rotation with the snapped light-space center as origin
  const lightView = mat4.clone(lightRotation);
  // Adjust the translation column (12,13,14) to position the light at the snapped center
  // We need to offset the existing translation by the snapped center position
  // Since lightRotation has no translation (eye at origin), we just set it:
  lightView[12] = -(lightRotation[0] * center[0] + lightRotation[4] * center[1] + lightRotation[8] * center[2]);
  lightView[13] = -(lightRotation[1] * center[0] + lightRotation[5] * center[1] + lightRotation[9] * center[2]);
  lightView[14] = -(lightRotation[2] * center[0] + lightRotation[6] * center[1] + lightRotation[10] * center[2]);

  // Recompute bounds relative to this centered lightView
  // Since we translated to the cascade center, X/Y bounds are symmetric from sphere radius
  // Apply texel snap offset
  const snapOffsetX = snappedX - centerLightSpace[0];
  const snapOffsetY = snappedY - centerLightSpace[1];

  const minX = -sphereRadius + snapOffsetX;
  const maxX = sphereRadius + snapOffsetX;
  const minY = -sphereRadius + snapOffsetY;
  const maxY = sphereRadius + snapOffsetY;

  // Recompute Z bounds relative to the centered view
  // Transform corners with the centered lightView
  let centeredMinZ = Infinity, centeredMaxZ = -Infinity;
  for (const c of corners) {
    const trf: vec4 = vec4.create();
    vec4.transformMat4(trf, c, lightView);
    centeredMinZ = Math.min(centeredMinZ, trf[2]);
    centeredMaxZ = Math.max(centeredMaxZ, trf[2]);
  }
  // Expand Z proportionally to frustum depth (not by absolute shadowRadius).
  // The back expansion (toward light) captures shadow casters behind the frustum slice.
  // Using sphere diameter (2× radius) ensures tall objects outside the frustum can still cast.
  // A small forward expansion prevents near-plane clipping on receivers.
  const frustumZDepth = centeredMaxZ - centeredMinZ;
  const zBackExpansion = Math.max(sphereRadius * 2.0, frustumZDepth);
  centeredMinZ -= zBackExpansion;
  centeredMaxZ += frustumZDepth * 0.1;

  // 7 — ortho projection (WebGPU [0,1] depth)
  // In lookAt convention, camera looks down -Z. Objects in front have negative Z in view space.
  // orthoZO expects: near maps to z_ndc=0, far maps to z_ndc=1.
  // near = -centeredMaxZ (closest to light), far = -centeredMinZ (farthest from light)
  const projMatrix = mat4.create();
  mat4.orthoZO(projMatrix, minX, maxX, minY, maxY, -centeredMaxZ, -centeredMinZ);

  const lightSpaceMatrix = mat4.create();
  mat4.multiply(lightSpaceMatrix, projMatrix, lightView);

  return {
    lightSpaceMatrix,
    radius: sphereRadius,
    lightView,
    minX, maxX, minY, maxY,
    minZ: centeredMinZ, maxZ: centeredMaxZ,
  };
}

/**
 * Compute the 8 world-space corners of a light ortho box.
 *
 * Given the light-view matrix and the AABB extents (from calculateCascadeLightMatrix),
 * builds the 8 corners in light-view space and transforms them back to world space.
 */
export function getLightOrthoBoxCorners(
  lightView: mat4,
  minX: number, maxX: number,
  minY: number, maxY: number,
  minZ: number, maxZ: number,
): vec3[] {
  const invLightView = mat4.create();
  mat4.invert(invLightView, lightView);

  const corners: vec3[] = [];
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        const pt = vec3.fromValues(
          x === 0 ? minX : maxX,
          y === 0 ? minY : maxY,
          z === 0 ? minZ : maxZ,
        );
        vec3.transformMat4(pt, pt, invLightView);
        corners.push(pt);
      }
    }
  }
  return corners;
}