import { mat4 } from 'gl-matrix';
import { SceneObject } from './SceneObject';
import type {
  AABB
} from './types';

/**
 * Base class for scene objects that can be rendered.
 * Extends SceneObject with rendering capabilities and bounding box support.
 */
export abstract class RenderableObject extends SceneObject {
  // Note to be migrated to be better aligned with WebGPU's command buffer based rendering

  /** Cached local-space bounding box */
  protected localBounds: AABB | null = null;
  
  constructor(name: string = 'Renderable') {
    super(name);
  }
  
  /**
   * Get the local-space bounding box
   */
  getBounds(): AABB | null {
    return this.localBounds;
  }
  
  /**
   * Get the world-space bounding box (transformed by model matrix)
   */
  getWorldBounds(): AABB | null {
    if (!this.localBounds) return null;
    
    const modelMatrix = this.getModelMatrix();
    const corners = this.getBoundingBoxCorners(this.localBounds);
    
    // Transform all corners and find new AABB
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const corner of corners) {
      const transformed = this.transformPoint(corner, modelMatrix);
      minX = Math.min(minX, transformed[0]);
      minY = Math.min(minY, transformed[1]);
      minZ = Math.min(minZ, transformed[2]);
      maxX = Math.max(maxX, transformed[0]);
      maxY = Math.max(maxY, transformed[1]);
      maxZ = Math.max(maxZ, transformed[2]);
    }
    
    return {
      min: new Float32Array([minX, minY, minZ]),
      max: new Float32Array([maxX, maxY, maxZ]),
    };
  }
  
  /**
   * Clean up the renderer and release GPU resources
   */
  destroy(): void {
    this.localBounds = null;
  }
  
  /**
   * Get the 8 corners of a bounding box
   */
  private getBoundingBoxCorners(bounds: AABB): [number, number, number][] {
    const { min, max } = bounds;
    return [
      [min[0], min[1], min[2]],
      [max[0], min[1], min[2]],
      [min[0], max[1], min[2]],
      [max[0], max[1], min[2]],
      [min[0], min[1], max[2]],
      [max[0], min[1], max[2]],
      [min[0], max[1], max[2]],
      [max[0], max[1], max[2]],
    ];
  }
  
  /**
   * Transform a point by a matrix
   */
  private transformPoint(
    point: [number, number, number],
    matrix: mat4
  ): [number, number, number] {
    const x = point[0], y = point[1], z = point[2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    return [
      (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
      (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
      (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
    ];
  }
  
  /**
   * Get the center point of the bounding box in world space
   */
  getCenter(): [number, number, number] {
    const worldBounds = this.getWorldBounds();
    if (!worldBounds) {
      return [this.position[0], this.position[1], this.position[2]];
    }
    
    return [
      (worldBounds.min[0] + worldBounds.max[0]) / 2,
      (worldBounds.min[1] + worldBounds.max[1]) / 2,
      (worldBounds.min[2] + worldBounds.max[2]) / 2,
    ];
  }
  
  /**
   * Get the size of the bounding box
   */
  getSize(): [number, number, number] {
    const worldBounds = this.getWorldBounds();
    if (!worldBounds) {
      return [0, 0, 0];
    }
    
    return [
      worldBounds.max[0] - worldBounds.min[0],
      worldBounds.max[1] - worldBounds.min[1],
      worldBounds.max[2] - worldBounds.min[2],
    ];
  }
  
  /**
   * Get the maximum dimension of the bounding box
   */
  getMaxDimension(): number {
    const size = this.getSize();
    return Math.max(size[0], size[1], size[2]);
  }
}
