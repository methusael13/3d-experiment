/**
 * Scene Graph with BVH (Bounding Volume Hierarchy) for efficient spatial queries
 * OOP-based implementation using classes
 */

import { vec3 } from 'gl-matrix';
import type { AABB } from './sceneObjects/types';
import type { GLBModel } from '../loaders';

// ============ Types ============

/**
 * Euler rotation angles in degrees [x, y, z]
 */
export type EulerRotation = [number, number, number];

/**
 * Options for creating a scene graph node
 */
export interface SceneNodeOptions<T = unknown> {
  position?: vec3 | [number, number, number];
  rotation?: EulerRotation;
  scale?: vec3 | [number, number, number];
  localBounds?: AABB;
  userData?: T | null;
}

/**
 * Ray hit result from scene graph raycast
 */
export interface RayHit<T = unknown> {
  node: SceneGraphNode<T>;
  distance: number;
  hitPoint: vec3;
}

/**
 * Internal BVH tree node
 */
interface BVHNode<T = unknown> {
  bounds: BoundingBox;
  left: BVHNode<T> | null;
  right: BVHNode<T> | null;
  leaf: SceneGraphNode<T> | null;
}

// ============ BoundingBox Class ============

/**
 * Axis-Aligned Bounding Box with utility methods
 */
export class BoundingBox implements AABB {
  min: vec3;
  max: vec3;

  constructor(
    min: vec3 | [number, number, number] = [Infinity, Infinity, Infinity],
    max: vec3 | [number, number, number] = [-Infinity, -Infinity, -Infinity]
  ) {
    this.min = vec3.fromValues(min[0], min[1], min[2]);
    this.max = vec3.fromValues(max[0], max[1], max[2]);
  }

  /**
   * Create an empty (invalid) bounding box
   */
  static empty(): BoundingBox {
    return new BoundingBox();
  }

  /**
   * Create a unit cube bounding box centered at origin
   */
  static unitCube(): BoundingBox {
    return new BoundingBox([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  }

  /**
   * Create from AABB interface
   */
  static fromAABB(aabb: AABB): BoundingBox {
    return new BoundingBox(
      [aabb.min[0], aabb.min[1], aabb.min[2]],
      [aabb.max[0], aabb.max[1], aabb.max[2]]
    );
  }

  /**
   * Check if bounding box is valid (has been expanded at least once)
   */
  isValid(): boolean {
    return this.min[0] !== Infinity;
  }

  /**
   * Expand to include a point
   */
  expand(point: vec3 | [number, number, number]): this {
    this.min[0] = Math.min(this.min[0], point[0]);
    this.min[1] = Math.min(this.min[1], point[1]);
    this.min[2] = Math.min(this.min[2], point[2]);
    this.max[0] = Math.max(this.max[0], point[0]);
    this.max[1] = Math.max(this.max[1], point[1]);
    this.max[2] = Math.max(this.max[2], point[2]);
    return this;
  }

  /**
   * Merge with another bounding box, returning a new one
   */
  merge(other: AABB): BoundingBox {
    return new BoundingBox(
      [
        Math.min(this.min[0], other.min[0]),
        Math.min(this.min[1], other.min[1]),
        Math.min(this.min[2], other.min[2]),
      ],
      [
        Math.max(this.max[0], other.max[0]),
        Math.max(this.max[1], other.max[1]),
        Math.max(this.max[2], other.max[2]),
      ]
    );
  }

  /**
   * Get center point
   */
  center(): vec3 {
    return vec3.fromValues(
      (this.min[0] + this.max[0]) * 0.5,
      (this.min[1] + this.max[1]) * 0.5,
      (this.min[2] + this.max[2]) * 0.5
    );
  }

  /**
   * Get size (extents)
   */
  size(): vec3 {
    return vec3.fromValues(
      this.max[0] - this.min[0],
      this.max[1] - this.min[1],
      this.max[2] - this.min[2]
    );
  }

  /**
   * Transform to world space given position, rotation (degrees), and scale
   */
  transform(
    position: vec3 | [number, number, number],
    rotation: EulerRotation,
    scale: vec3 | [number, number, number]
  ): BoundingBox {
    // Get 8 corners of local AABB
    const corners: [number, number, number][] = [
      [this.min[0], this.min[1], this.min[2]],
      [this.max[0], this.min[1], this.min[2]],
      [this.min[0], this.max[1], this.min[2]],
      [this.max[0], this.max[1], this.min[2]],
      [this.min[0], this.min[1], this.max[2]],
      [this.max[0], this.min[1], this.max[2]],
      [this.min[0], this.max[1], this.max[2]],
      [this.max[0], this.max[1], this.max[2]],
    ];

    // Convert rotation to radians
    const rx = rotation[0] * Math.PI / 180;
    const ry = rotation[1] * Math.PI / 180;
    const rz = rotation[2] * Math.PI / 180;

    // Precompute trig
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    const worldBounds = BoundingBox.empty();

    for (const corner of corners) {
      // Scale
      let x = corner[0] * scale[0];
      let y = corner[1] * scale[1];
      let z = corner[2] * scale[2];

      // Rotate X
      let y1 = y * cx - z * sx;
      let z1 = y * sx + z * cx;
      y = y1; z = z1;

      // Rotate Y
      let x1 = x * cy + z * sy;
      z1 = -x * sy + z * cy;
      x = x1; z = z1;

      // Rotate Z
      x1 = x * cz - y * sz;
      y1 = x * sz + y * cz;
      x = x1; y = y1;

      // Translate
      x += position[0];
      y += position[1];
      z += position[2];

      worldBounds.expand([x, y, z]);
    }

    return worldBounds;
  }

  /**
   * Ray intersection test (slab method)
   * @returns Distance to intersection or null if no hit
   */
  intersectsRay(rayOrigin: vec3, rayDir: vec3): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;

    for (let i = 0; i < 3; i++) {
      if (Math.abs(rayDir[i]) < 1e-8) {
        // Ray parallel to slab
        if (rayOrigin[i] < this.min[i] || rayOrigin[i] > this.max[i]) {
          return null;
        }
      } else {
        const invD = 1 / rayDir[i];
        let t0 = (this.min[i] - rayOrigin[i]) * invD;
        let t1 = (this.max[i] - rayOrigin[i]) * invD;

        if (invD < 0) {
          [t0, t1] = [t1, t0];
        }

        tmin = Math.max(tmin, t0);
        tmax = Math.min(tmax, t1);

        if (tmax < tmin) {
          return null;
        }
      }
    }

    return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
  }

  /**
   * Test if this AABB intersects another
   */
  intersects(other: AABB): boolean {
    return (
      this.min[0] <= other.max[0] && this.max[0] >= other.min[0] &&
      this.min[1] <= other.max[1] && this.max[1] >= other.min[1] &&
      this.min[2] <= other.max[2] && this.max[2] >= other.min[2]
    );
  }

  /**
   * Clone this bounding box
   */
  clone(): BoundingBox {
    return new BoundingBox(
      [this.min[0], this.min[1], this.min[2]],
      [this.max[0], this.max[1], this.max[2]]
    );
  }
}

// ============ SceneGraphNode Class ============

/**
 * A node in the scene graph with transform and bounds
 */
export class SceneGraphNode<T = unknown> {
  readonly id: string;
  position: vec3;
  rotation: EulerRotation;
  scale: vec3;
  localBounds: BoundingBox;
  worldBounds: BoundingBox;
  userData: T | null;

  constructor(id: string, options: SceneNodeOptions<T> = {}) {
    const {
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      scale = [1, 1, 1],
      localBounds,
      userData = null,
    } = options;

    this.id = id;
    this.position = vec3.fromValues(position[0], position[1], position[2]);
    this.rotation = [...rotation] as EulerRotation;
    this.scale = vec3.fromValues(scale[0], scale[1], scale[2]);
    this.localBounds = localBounds 
      ? BoundingBox.fromAABB(localBounds) 
      : BoundingBox.unitCube();
    this.worldBounds = this.localBounds.transform(this.position, this.rotation, this.scale);
    this.userData = userData;
  }

  /**
   * Update world bounds after transform changes
   */
  updateWorldBounds(): void {
    this.worldBounds = this.localBounds.transform(this.position, this.rotation, this.scale);
  }

  /**
   * Set position and update world bounds
   */
  setPosition(x: number, y: number, z: number): this {
    vec3.set(this.position, x, y, z);
    this.updateWorldBounds();
    return this;
  }

  /**
   * Set rotation (Euler angles in degrees) and update world bounds
   */
  setRotation(x: number, y: number, z: number): this {
    this.rotation = [x, y, z];
    this.updateWorldBounds();
    return this;
  }

  /**
   * Set scale and update world bounds
   */
  setScale(x: number, y: number, z: number): this {
    vec3.set(this.scale, x, y, z);
    this.updateWorldBounds();
    return this;
  }

  /**
   * Set local bounds and update world bounds
   */
  setLocalBounds(bounds: AABB | BoundingBox): this {
    this.localBounds = bounds instanceof BoundingBox 
      ? bounds 
      : BoundingBox.fromAABB(bounds);
    this.updateWorldBounds();
    return this;
  }
}

// ============ SceneGraph Class ============

/**
 * BVH-accelerated scene graph for efficient spatial queries
 */
export class SceneGraph<T = unknown> {
  private nodes = new Map<string, SceneGraphNode<T>>();
  private bvhRoot: BVHNode<T> | null = null;
  private bvhDirty = true;

  /**
   * Add a node to the scene
   */
  add(id: string, options: SceneNodeOptions<T> = {}): SceneGraphNode<T> {
    const node = new SceneGraphNode(id, options);
    this.nodes.set(id, node);
    this.bvhDirty = true;
    return node;
  }

  /**
   * Remove a node by ID
   */
  remove(id: string): boolean {
    const removed = this.nodes.delete(id);
    if (removed) {
      this.bvhDirty = true;
    }
    return removed;
  }

  /**
   * Get a node by ID
   */
  get(id: string): SceneGraphNode<T> | null {
    return this.nodes.get(id) || null;
  }

  /**
   * Update a node's properties
   */
  update(id: string, updates: Partial<SceneNodeOptions<T>>): SceneGraphNode<T> | null {
    const node = this.nodes.get(id);
    if (!node) return null;

    let boundsChanged = false;

    if (updates.position) {
      vec3.set(node.position, updates.position[0], updates.position[1], updates.position[2]);
      boundsChanged = true;
    }
    if (updates.rotation) {
      node.rotation = [...updates.rotation] as EulerRotation;
      boundsChanged = true;
    }
    if (updates.scale) {
      vec3.set(node.scale, updates.scale[0], updates.scale[1], updates.scale[2]);
      boundsChanged = true;
    }
    if (updates.localBounds) {
      node.localBounds = updates.localBounds instanceof BoundingBox
        ? updates.localBounds
        : BoundingBox.fromAABB(updates.localBounds);
      boundsChanged = true;
    }
    if (updates.userData !== undefined) {
      node.userData = updates.userData;
    }

    if (boundsChanged) {
      node.updateWorldBounds();
      this.bvhDirty = true;
    }

    return node;
  }

  /**
   * Get all nodes
   */
  getAll(): SceneGraphNode<T>[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Rebuild BVH tree
   */
  rebuild(): void {
    const nodeList = this.getAll();

    if (nodeList.length === 0) {
      this.bvhRoot = null;
      this.bvhDirty = false;
      return;
    }

    this.bvhRoot = this.buildBVHNode(nodeList, 0);
    this.bvhDirty = false;
  }

  /**
   * Build BVH node recursively (median split)
   */
  private buildBVHNode(nodeList: SceneGraphNode<T>[], depth: number): BVHNode<T> | null {
    if (nodeList.length === 0) return null;

    // Compute bounds of all nodes
    let bounds = BoundingBox.empty();
    for (const node of nodeList) {
      bounds = bounds.merge(node.worldBounds);
    }

    // Leaf node
    if (nodeList.length === 1) {
      return {
        bounds,
        left: null,
        right: null,
        leaf: nodeList[0],
      };
    }

    // Choose split axis (cycle through X, Y, Z based on depth)
    const axis = depth % 3;

    // Sort by AABB center on chosen axis
    nodeList.sort((a, b) => {
      const centerA = a.worldBounds.center();
      const centerB = b.worldBounds.center();
      return centerA[axis] - centerB[axis];
    });

    // Split at median
    const mid = Math.floor(nodeList.length / 2);
    const leftNodes = nodeList.slice(0, mid);
    const rightNodes = nodeList.slice(mid);

    return {
      bounds,
      left: this.buildBVHNode(leftNodes, depth + 1),
      right: this.buildBVHNode(rightNodes, depth + 1),
      leaf: null,
    };
  }

  /**
   * Cast ray through scene, return closest hit
   */
  castRay(rayOrigin: vec3, rayDir: vec3): RayHit<T> | null {
    if (this.bvhDirty) {
      this.rebuild();
    }

    if (!this.bvhRoot) return null;

    // Normalize ray direction
    const dir = vec3.create();
    vec3.normalize(dir, rayDir);

    let closestHit: RayHit<T> | null = null;
    let closestDist = Infinity;

    const traverse = (bvhNode: BVHNode<T> | null): void => {
      if (!bvhNode) return;

      // Early out if ray doesn't hit this node's bounds
      const boxDist = bvhNode.bounds.intersectsRay(rayOrigin, dir);
      if (boxDist === null || boxDist > closestDist) return;

      if (bvhNode.leaf) {
        // Test against leaf node's bounds
        const dist = bvhNode.leaf.worldBounds.intersectsRay(rayOrigin, dir);
        if (dist !== null && dist < closestDist) {
          closestDist = dist;
          closestHit = {
            node: bvhNode.leaf,
            distance: dist,
            hitPoint: vec3.fromValues(
              rayOrigin[0] + dir[0] * dist,
              rayOrigin[1] + dir[1] * dist,
              rayOrigin[2] + dir[2] * dist
            ),
          };
        }
      } else {
        // Traverse children (front-to-back order)
        const leftDist = bvhNode.left?.bounds.intersectsRay(rayOrigin, dir) ?? null;
        const rightDist = bvhNode.right?.bounds.intersectsRay(rayOrigin, dir) ?? null;

        if (leftDist !== null && rightDist !== null) {
          if (leftDist < rightDist) {
            traverse(bvhNode.left);
            traverse(bvhNode.right);
          } else {
            traverse(bvhNode.right);
            traverse(bvhNode.left);
          }
        } else if (leftDist !== null) {
          traverse(bvhNode.left);
        } else if (rightDist !== null) {
          traverse(bvhNode.right);
        }
      }
    };

    traverse(this.bvhRoot);

    return closestHit;
  }

  /**
   * Query all nodes intersecting an AABB
   */
  queryBounds(queryAABB: AABB): SceneGraphNode<T>[] {
    if (this.bvhDirty) {
      this.rebuild();
    }

    const results: SceneGraphNode<T>[] = [];
    const queryBox = queryAABB instanceof BoundingBox 
      ? queryAABB 
      : BoundingBox.fromAABB(queryAABB);

    const traverse = (bvhNode: BVHNode<T> | null): void => {
      if (!bvhNode) return;

      if (!bvhNode.bounds.intersects(queryBox)) return;

      if (bvhNode.leaf) {
        if (bvhNode.leaf.worldBounds.intersects(queryBox)) {
          results.push(bvhNode.leaf);
        }
      } else {
        traverse(bvhNode.left);
        traverse(bvhNode.right);
      }
    };

    traverse(this.bvhRoot);

    return results;
  }

  /**
   * Clear all nodes
   */
  clear(): void {
    this.nodes.clear();
    this.bvhRoot = null;
    this.bvhDirty = false;
  }

  /**
   * Get the root bounding box encompassing all nodes in the scene.
   * Returns null if there are no nodes.
   */
  getRootBounds(): BoundingBox | null {
    if (this.bvhDirty) {
      this.rebuild();
    }
    return this.bvhRoot?.bounds.clone() ?? null;
  }

  /**
   * Get number of nodes
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Check if BVH needs rebuilding
   */
  get isDirty(): boolean {
    return this.bvhDirty;
  }
}

// ============ Utility Functions ============

/**
 * Compute bounding box from GLB model vertices
 */
export function computeBoundsFromGLB(glbModel: GLBModel): BoundingBox {
  const bounds = BoundingBox.empty();

  for (const mesh of glbModel.meshes) {
    if (mesh.positions) {
      const positions = mesh.positions;
      const count = positions.length / 3;

      for (let i = 0; i < count; i++) {
        bounds.expand([
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        ]);
      }
    }
  }

  // If no valid bounds found, return unit cube
  if (!bounds.isValid()) {
    return BoundingBox.unitCube();
  }

  return bounds;
}

// ============ Legacy Compatibility Functions ============
// These functions maintain backward compatibility with the old API

/**
 * @deprecated Use BoundingBox.empty() or new BoundingBox()
 */
export function createAABB(
  min: [number, number, number] = [Infinity, Infinity, Infinity],
  max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
): AABB {
  return new BoundingBox(min, max);
}

/**
 * @deprecated Use SceneGraph class instead
 */
export function createSceneGraph<T = unknown>(): SceneGraph<T> {
  return new SceneGraph<T>();
}
