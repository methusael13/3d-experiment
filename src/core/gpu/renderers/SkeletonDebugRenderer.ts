/**
 * SkeletonDebugRenderer - Renders Blender-style pyramid bones and joint markers
 * as a debug overlay for animated entities.
 *
 * Each bone is drawn as a 4-sided tapering pyramid (wide at parent, narrow at child),
 * exactly like Blender's Armature display mode. This makes hierarchy and bone
 * direction immediately visible — the wide end is the parent, the narrow tip
 * points to the child joint.
 *
 * Uses the existing GizmoRendererGPU's dynamic triangle rendering.
 *
 * Data flow:
 *   SkeletonComponent.globalTransforms → extract joint world positions
 *   → apply entity modelMatrix → build pyramid bone triangles + root octahedron
 *   → render via GizmoRendererGPU.renderDynamicTriangles
 */

import { mat4, vec3 } from 'gl-matrix';
import type { GizmoRendererGPU, GizmoColor } from './GizmoRendererGPU';
import type { SkeletonComponent } from '../../ecs/components/SkeletonComponent';
import type { TransformComponent } from '../../ecs/components/TransformComponent';
import type { World } from '../../ecs/World';

// ==================== Colors ====================

/** Root joint marker: orange-red */
const ROOT_COLOR: GizmoColor = [1.0, 0.35, 0.1, 1.0];

/** Bone pyramid: cyan/teal */
const BONE_COLOR: GizmoColor = [0.0, 0.85, 0.85, 1.0];

/** Leaf joint tip marker: green */
const LEAF_COLOR: GizmoColor = [0.2, 0.9, 0.3, 1.0];

/** Bone outline wireframe: darker teal for edge visibility */
const BONE_OUTLINE_COLOR: GizmoColor = [0.0, 0.5, 0.55, 1.0];

// ==================== Geometry Helpers ====================

/**
 * Width ratio of the pyramid base relative to bone length.
 * Blender uses ~0.1 of the bone length for the bulge width.
 */
const PYRAMID_WIDTH_RATIO = 0.12;

/**
 * How far along the bone (0→1) the widest point of the pyramid sits.
 * Blender places the bulge at ~25% from the parent.
 */
const PYRAMID_BULGE_T = 0.25;

/** Reusable vec3 temporaries */
const _v0 = vec3.create();
const _v1 = vec3.create();
const _v2 = vec3.create();
const _up = vec3.fromValues(0, 1, 0);
const _altUp = vec3.fromValues(0, 0, 1);
const _perpA = vec3.create();
const _perpB = vec3.create();
const _mid = vec3.create();

/**
 * Build a Blender-style pyramid bone between parent and child world positions.
 * The bone is a double-pyramid (octahedron stretched along the bone axis):
 *   - Tip at parent position (head)
 *   - Tip at child position (tail)
 *   - 4 vertices at the mid-bulge forming a square cross-section
 *
 * This creates 8 triangular faces (4 from parent to mid, 4 from mid to child).
 */
function addPyramidBone(
  out: number[],
  parent: [number, number, number],
  child: [number, number, number],
): void {
  // Direction from parent to child
  vec3.set(_v0, child[0] - parent[0], child[1] - parent[1], child[2] - parent[2]);
  const boneLength = vec3.length(_v0);
  if (boneLength < 0.0001) return; // Degenerate bone

  // Normalize direction
  vec3.scale(_v0, _v0, 1 / boneLength);

  // Width of the pyramid at the bulge
  const width = boneLength * PYRAMID_WIDTH_RATIO;

  // Find two perpendicular vectors to the bone direction
  // Choose an up vector that isn't parallel to the bone
  const dotUp = Math.abs(vec3.dot(_v0, _up));
  const refUp = dotUp > 0.95 ? _altUp : _up;

  vec3.cross(_perpA, _v0, refUp);
  vec3.normalize(_perpA, _perpA);
  vec3.cross(_perpB, _v0, _perpA);
  vec3.normalize(_perpB, _perpB);

  // Scale perpendiculars by width
  vec3.scale(_perpA, _perpA, width);
  vec3.scale(_perpB, _perpB, width);

  // Mid-point (where the bulge is)
  _mid[0] = parent[0] + (child[0] - parent[0]) * PYRAMID_BULGE_T;
  _mid[1] = parent[1] + (child[1] - parent[1]) * PYRAMID_BULGE_T;
  _mid[2] = parent[2] + (child[2] - parent[2]) * PYRAMID_BULGE_T;

  // 4 bulge vertices (square cross-section at the mid-point)
  const m0: [number, number, number] = [_mid[0] + _perpA[0], _mid[1] + _perpA[1], _mid[2] + _perpA[2]];
  const m1: [number, number, number] = [_mid[0] + _perpB[0], _mid[1] + _perpB[1], _mid[2] + _perpB[2]];
  const m2: [number, number, number] = [_mid[0] - _perpA[0], _mid[1] - _perpA[1], _mid[2] - _perpA[2]];
  const m3: [number, number, number] = [_mid[0] - _perpB[0], _mid[1] - _perpB[1], _mid[2] - _perpB[2]];

  // Head tip = parent, Tail tip = child
  const head = parent;
  const tail = child;

  // 4 triangles from head to mid-bulge (parent → mid square)
  pushTri(out, head, m0, m1);
  pushTri(out, head, m1, m2);
  pushTri(out, head, m2, m3);
  pushTri(out, head, m3, m0);

  // 4 triangles from mid-bulge to tail (mid square → child)
  pushTri(out, tail, m1, m0);
  pushTri(out, tail, m2, m1);
  pushTri(out, tail, m3, m2);
  pushTri(out, tail, m0, m3);
}

/**
 * Build wireframe edges for a pyramid bone (outlines only).
 * 8 edges: 4 from head to mid, 4 from mid to tail.
 */
function addPyramidBoneOutline(
  out: number[],
  parent: [number, number, number],
  child: [number, number, number],
): void {
  vec3.set(_v0, child[0] - parent[0], child[1] - parent[1], child[2] - parent[2]);
  const boneLength = vec3.length(_v0);
  if (boneLength < 0.0001) return;

  vec3.scale(_v0, _v0, 1 / boneLength);
  const width = boneLength * PYRAMID_WIDTH_RATIO;

  const dotUp = Math.abs(vec3.dot(_v0, _up));
  const refUp = dotUp > 0.95 ? _altUp : _up;
  vec3.cross(_perpA, _v0, refUp);
  vec3.normalize(_perpA, _perpA);
  vec3.cross(_perpB, _v0, _perpA);
  vec3.normalize(_perpB, _perpB);
  vec3.scale(_perpA, _perpA, width);
  vec3.scale(_perpB, _perpB, width);

  _mid[0] = parent[0] + (child[0] - parent[0]) * PYRAMID_BULGE_T;
  _mid[1] = parent[1] + (child[1] - parent[1]) * PYRAMID_BULGE_T;
  _mid[2] = parent[2] + (child[2] - parent[2]) * PYRAMID_BULGE_T;

  const m0: [number, number, number] = [_mid[0] + _perpA[0], _mid[1] + _perpA[1], _mid[2] + _perpA[2]];
  const m1: [number, number, number] = [_mid[0] + _perpB[0], _mid[1] + _perpB[1], _mid[2] + _perpB[2]];
  const m2: [number, number, number] = [_mid[0] - _perpA[0], _mid[1] - _perpA[1], _mid[2] - _perpA[2]];
  const m3: [number, number, number] = [_mid[0] - _perpB[0], _mid[1] - _perpB[1], _mid[2] - _perpB[2]];

  // Head to mid edges
  pushLine(out, parent, m0);
  pushLine(out, parent, m1);
  pushLine(out, parent, m2);
  pushLine(out, parent, m3);
  // Mid ring edges
  pushLine(out, m0, m1);
  pushLine(out, m1, m2);
  pushLine(out, m2, m3);
  pushLine(out, m3, m0);
  // Mid to tail edges
  pushLine(out, m0, child);
  pushLine(out, m1, child);
  pushLine(out, m2, child);
  pushLine(out, m3, child);
}

function pushTri(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function pushLine(out: number[], a: [number, number, number], b: [number, number, number]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/**
 * Generate octahedron vertices centered at a point.
 * Used only for the root joint marker (so you can clearly see the skeleton root).
 */
function addOctahedron(out: number[], cx: number, cy: number, cz: number, size: number): void {
  const s = size;
  const px: [number, number, number] = [cx + s, cy, cz];
  const nx: [number, number, number] = [cx - s, cy, cz];
  const py: [number, number, number] = [cx, cy + s, cz];
  const ny: [number, number, number] = [cx, cy - s, cz];
  const pz: [number, number, number] = [cx, cy, cz + s];
  const nz: [number, number, number] = [cx, cy, cz - s];

  const faces: [typeof px, typeof px, typeof px][] = [
    [px, pz, py], [pz, nx, py], [nx, nz, py], [nz, px, py],
    [pz, px, ny], [nx, pz, ny], [nz, nx, ny], [px, nz, ny],
  ];
  for (const [a, b, c] of faces) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
}

// ==================== Temporary vec3 for mat4 transforms ====================
const _tempPos = vec3.create();

/**
 * Extract translation (column 3) from a column-major mat4 stored in a Float32Array.
 */
function extractTranslation(mat: Float32Array, offset: number, out: vec3): void {
  out[0] = mat[offset + 12];
  out[1] = mat[offset + 13];
  out[2] = mat[offset + 14];
}

// ==================== SkeletonDebugRenderer ====================

/** Root joint octahedron size */
const ROOT_JOINT_SIZE = 0.02;

/** Leaf joint octahedron size (small marker at bone tips) */
const LEAF_JOINT_SIZE = 0.008;

/**
 * Renders skeleton debug overlays for entities with showSkeleton enabled.
 *
 * Each frame:
 * 1. Queries ECS world for entities with SkeletonComponent.showSkeleton === true
 * 2. Extracts joint world positions from globalTransforms × entity modelMatrix
 * 3. Builds Blender-style pyramid bone triangles + root/leaf markers
 * 4. Renders using GizmoRendererGPU's dynamic geometry methods
 */
export class SkeletonDebugRenderer {
  /**
   * Render skeleton overlays for all entities with showSkeleton enabled.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: Float32Array,
    gizmoRenderer: GizmoRendererGPU,
    world: World,
  ): void {
    const entities = world.queryAny('skeleton');

    for (const entity of entities) {
      const skel = entity.getComponent<SkeletonComponent>('skeleton');
      if (!skel?.showSkeleton || !skel.skeleton || !skel.globalTransforms) continue;

      const transform = entity.getComponent<TransformComponent>('transform');
      if (!transform) continue;

      const skeleton = skel.skeleton;
      const globalTransforms = skel.globalTransforms;
      const modelMatrix = transform.modelMatrix as unknown as mat4;
      const jointCount = skeleton.joints.length;

      // ── 1. Extract world-space joint positions ──
      const worldPositions: [number, number, number][] = new Array(jointCount);

      for (let i = 0; i < jointCount; i++) {
        extractTranslation(globalTransforms, i * 16, _tempPos);
        vec3.transformMat4(_tempPos, _tempPos, modelMatrix);
        worldPositions[i] = [_tempPos[0], _tempPos[1], _tempPos[2]];
      }

      // ── 2. Build pyramid bone triangles ──
      const boneTriangles: number[] = [];
      const boneOutlineLines: number[] = [];

      for (let i = 0; i < jointCount; i++) {
        const joint = skeleton.joints[i];
        if (joint.parentIndex < 0) continue;

        const parentPos = worldPositions[joint.parentIndex];
        const childPos = worldPositions[i];
        addPyramidBone(boneTriangles, parentPos, childPos);
        addPyramidBoneOutline(boneOutlineLines, parentPos, childPos);
      }

      // ── 3. Build joint markers — merge INTO boneTriangles to avoid buffer overwrite ──
      // GizmoRendererGPU has a single shared dynamic vertex buffer. Each renderDynamicTriangles
      // call overwrites it, so the GPU only sees the LAST written data. We must batch ALL
      // triangles into one array (single draw call) to avoid missing geometry.
      for (let i = 0; i < jointCount; i++) {
        const joint = skeleton.joints[i];
        const [x, y, z] = worldPositions[i];

        if (joint.parentIndex < 0) {
          addOctahedron(boneTriangles, x, y, z, ROOT_JOINT_SIZE);
        } else if (joint.children.length === 0) {
          addOctahedron(boneTriangles, x, y, z, LEAF_JOINT_SIZE);
        }
      }

      // Single batched draw call for ALL triangles (pyramids + joint markers)
      if (boneTriangles.length > 0) {
        gizmoRenderer.renderDynamicTriangles(passEncoder, vpMatrix, boneTriangles, BONE_COLOR);
      }
    }
  }
}
