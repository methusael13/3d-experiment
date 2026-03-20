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

/** Optional scene bounding box for Z-range expansion in shadow cascades */
export interface SceneAABB {
  min: vec3;
  max: vec3;
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
 * 2. Compute bounding sphere (center + radius) — used for texel snap granularity
 * 3. Build per-cascade lightView centered on frustum center
 * 4. Compute tight AABB of frustum corners in light-view space for XY bounds
 * 5. Snap tight AABB bounds to sphere-derived texel grid (prevents shimmer)
 * 6. Compute Z range from projected corners, expand minZ for shadow casters
 * 7. Build ortho projection (WebGPU [0,1] depth)
 *
 * The tight AABB approach ensures each cascade's ortho volume only covers its own
 * frustum slice region, preventing higher cascades from completely overlapping lower
 * ones. The sphere-derived texel snap step still prevents sub-texel shadow shimmer.
 *
 * @param lightDir        Normalized direction from scene toward light
 * @param lightRotation   Global light rotation matrix (from buildLightRotationMatrix)
 * @param cameraView      Camera view matrix
 * @param cameraProj      Camera projection matrix
 * @param cascadeNear     Near split distance for this cascade
 * @param cascadeFar      Far split distance for this cascade
 * @param shadowRadius    Used for Z-range expansion (scene scale)
 * @param shadowMapSize   Shadow map resolution for texel snapping (e.g. 2048)
 * @param sceneAABB       Optional world-space AABB of the scene (e.g. terrain bounds).
 *                        When provided, the ortho Z-range is expanded to fully contain
 *                        all 8 AABB corners, ensuring tall geometry (cliffs, mountains)
 *                        is never clipped by the shadow near/far planes.
 */
export function calculateCascadeLightMatrix(
  lightDir: vec3,
  cameraView: mat4 | Float32Array,
  cameraProj: mat4 | Float32Array,
  cascadeNear: number,
  cascadeFar: number,
  shadowRadius: number,
  shadowMapSize: number = 2048,
  sceneAABB?: SceneAABB,
): CascadeLightResult {
  // 0 — global light rotation (computed from lightDir, identical for all cascades)
  const lightRotation = buildLightRotationMatrix(lightDir);

  // 1 — frustum corners
  const corners = getFrustumCornersWorldSpace(cameraView, cameraProj, cascadeNear, cascadeFar);

  // 2 — bounding sphere: center = average of corners, radius = max distance from center
  // The sphere radius is used ONLY for texel snap granularity (prevents shadow shimmer
  // on camera rotation). The actual ortho XY bounds come from a tight AABB (step 5).
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

  // 3 — Build per-cascade lightView = globalRotation + translation to frustum center
  const lightView = mat4.clone(lightRotation);
  lightView[12] = -(lightRotation[0] * center[0] + lightRotation[4] * center[1] + lightRotation[8] * center[2]);
  lightView[13] = -(lightRotation[1] * center[0] + lightRotation[5] * center[1] + lightRotation[9] * center[2]);
  lightView[14] = -(lightRotation[2] * center[0] + lightRotation[6] * center[1] + lightRotation[10] * center[2]);

  // 4 — Compute tight AABB of frustum corners in light-view space
  // This gives XY bounds that tightly wrap only this cascade's frustum slice,
  // preventing higher cascades from completely overlapping lower ones.
  let tightMinX = Infinity, tightMaxX = -Infinity;
  let tightMinY = Infinity, tightMaxY = -Infinity;
  let centeredMinZ = Infinity, centeredMaxZ = -Infinity;
  for (const c of corners) {
    const trf: vec4 = vec4.create();
    vec4.transformMat4(trf, c, lightView);
    tightMinX = Math.min(tightMinX, trf[0]);
    tightMaxX = Math.max(tightMaxX, trf[0]);
    tightMinY = Math.min(tightMinY, trf[1]);
    tightMaxY = Math.max(tightMaxY, trf[1]);
    centeredMinZ = Math.min(centeredMinZ, trf[2]);
    centeredMaxZ = Math.max(centeredMaxZ, trf[2]);
  }

  // 5 — Snap tight AABB bounds to sphere-derived texel grid (prevents shimmer)
  // The texel size is computed from the bounding sphere (rotation-invariant), ensuring
  // the snap granularity never changes with camera rotation. The tight bounds give us
  // proper cascade separation while the sphere-based snap prevents sub-texel drift.
  const worldUnitsPerTexel = (2.0 * sphereRadius) / shadowMapSize;

  const minX = Math.floor(tightMinX / worldUnitsPerTexel) * worldUnitsPerTexel;
  const maxX = Math.ceil(tightMaxX / worldUnitsPerTexel) * worldUnitsPerTexel;
  const minY = Math.floor(tightMinY / worldUnitsPerTexel) * worldUnitsPerTexel;
  const maxY = Math.ceil(tightMaxY / worldUnitsPerTexel) * worldUnitsPerTexel;

  // 6 — Z-range expansion for shadow casters
  // In light-view space (lookAt convention), the light looks down -Z:
  //   - More negative Z = farther from light (deeper into scene)
  //   - More positive Z = closer to light (toward light source)
  // Shadow casters between the frustum and the light source have higher Z values.
  // We expand maxZ (toward light) by shadowRadius to capture them.
  // A small expansion of minZ (away from light) prevents far-plane clipping on receivers.
  const frustumZDepth = centeredMaxZ - centeredMinZ;
  centeredMaxZ += shadowRadius;
  centeredMinZ -= frustumZDepth * 0.1;

  // 6b — Scene AABB Z-range expansion (optional)
  // When provided, expand Z range to include the scene AABB projected into light space,
  // ensuring tall geometry (cliffs, mountains) is never clipped by shadow near/far planes.
  if (sceneAABB) {
    const aabbCorners: vec3[] = [];
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          aabbCorners.push(vec3.fromValues(
            x === 0 ? sceneAABB.min[0] : sceneAABB.max[0],
            y === 0 ? sceneAABB.min[1] : sceneAABB.max[1],
            z === 0 ? sceneAABB.min[2] : sceneAABB.max[2],
          ));
        }
      }
    }
    for (const ac of aabbCorners) {
      const trf: vec4 = vec4.create();
      vec4.transformMat4(trf, [ac[0], ac[1], ac[2], 1.0] as vec4, lightView);
      centeredMinZ = Math.min(centeredMinZ, trf[2]);
      centeredMaxZ = Math.max(centeredMaxZ, trf[2]);
    }
  }

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