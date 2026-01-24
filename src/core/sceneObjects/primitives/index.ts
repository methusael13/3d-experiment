/**
 * Primitive shape classes - barrel exports
 * 
 * IMPORTANT: PrimitiveObject must be imported FIRST to avoid circular dependency issues
 * since Cube, Plane, UVSphere all extend PrimitiveObject
 */

// Import base class FIRST (before subclasses that extend it)
import { PrimitiveObject } from '../PrimitiveObject';

// Then import concrete implementations
import { Cube } from './Cube';
import { Plane } from './Plane';
import { UVSphere } from './UVSphere';
import type { 
  PrimitiveConfig, 
  PrimitiveType, 
  SerializedPrimitiveObject,
  GeometryData,
} from '../types';

// Re-exports
export { Cube, Plane, UVSphere, PrimitiveObject };
export type { PrimitiveConfig, PrimitiveType, SerializedPrimitiveObject, GeometryData };

/**
 * Factory function to create primitives by type string
 * Used for deserialization and backward compatibility
 */
export function createPrimitive(
  gl: WebGL2RenderingContext,
  primitiveType: string,
  name?: string,
  config?: { size?: number; subdivision?: number }
): Cube | Plane | UVSphere {
  switch (primitiveType) {
    case 'cube':
      return new Cube(gl, name, config);
    case 'plane':
      return new Plane(gl, name, config);
    case 'sphere':
      return new UVSphere(gl, name, config);
    default:
      throw new Error(`Unknown primitive type: ${primitiveType}`);
  }
}

/**
 * Create primitive from serialized data
 */
export function createPrimitiveFromSerialized(
  gl: WebGL2RenderingContext,
  data: { primitiveType: string; name?: string; primitiveConfig?: any; [key: string]: any }
): Cube | Plane | UVSphere {
  switch (data.primitiveType) {
    case 'cube':
      return Cube.fromSerialized(gl, data as any);
    case 'plane':
      return Plane.fromSerialized(gl, data as any);
    case 'sphere':
      return UVSphere.fromSerialized(gl, data as any);
    default:
      throw new Error(`Unknown primitive type: ${data.primitiveType}`);
  }
}
