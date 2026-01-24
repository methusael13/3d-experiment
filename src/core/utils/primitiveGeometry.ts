/**
 * Primitive geometry utilities
 * 
 * This module provides a convenient factory function for generating primitive geometry.
 * The actual geometry generation is delegated to the respective primitive classes.
 * 
 * Note: For new code, prefer using the static methods directly:
 *   - Cube.generateGeometry(config)
 *   - UVSphere.generateGeometry(config)
 *   - Plane.generateGeometry(config)
 */

import { Cube } from '../sceneObjects/primitives/Cube';
import { UVSphere } from '../sceneObjects/primitives/UVSphere';
import { Plane } from '../sceneObjects/primitives/Plane';
import type { GeometryData, PrimitiveConfig } from '../sceneObjects/types';

/**
 * Primitive type string literal
 */
export type PrimitiveType = 'cube' | 'plane' | 'sphere';

/**
 * Bounding box type
 */
export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Re-export GeometryData for convenience
 */
export type { GeometryData, PrimitiveConfig };

/**
 * Generate geometry based on primitive type
 * Delegates to the static generateGeometry method of each primitive class
 * 
 * @param primitiveType - 'cube' | 'plane' | 'sphere'
 * @param config - { size, subdivision }
 */
export function generatePrimitiveGeometry(
  primitiveType: PrimitiveType,
  config: PrimitiveConfig = {}
): GeometryData {
  switch (primitiveType) {
    case 'cube':
      return Cube.generateGeometry(config);
    case 'plane':
      return Plane.generateGeometry(config);
    case 'sphere':
      return UVSphere.generateGeometry(config);
    default:
      throw new Error(`Unknown primitive type: ${primitiveType}`);
  }
}

/**
 * Compute axis-aligned bounding box for geometry
 * @param positions - Vertex positions (x,y,z interleaved)
 */
export function computeBounds(positions: Float32Array): BoundingBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  
  return { min, max };
}
