import { PrimitiveObject } from '../PrimitiveObject';
import type { GeometryData, AABB, PrimitiveConfig, SerializedPrimitiveObject } from '../types';

/**
 * Plane primitive - a flat quad on the XZ plane with Y-up normal
 */
export class Plane extends PrimitiveObject {
  constructor(
    name?: string,
    config: PrimitiveConfig = {}
  ) {
    super(name ?? 'Plane', config);
  }
  
  get primitiveType(): string {
    return 'plane';
  }
  
  /**
   * Generate plane geometry from config (static utility method)
   */
  static generateGeometry(config: PrimitiveConfig = {}): GeometryData {
    const size = config.size ?? 1;
    const h = size / 2;
    
    // 4 vertices for a simple quad
    const positions = new Float32Array([
      -h, 0,  h,   // bottom-left (in world: -X, +Z)
       h, 0,  h,   // bottom-right (+X, +Z)
       h, 0, -h,   // top-right (+X, -Z)
      -h, 0, -h,   // top-left (-X, -Z)
    ]);
    
    const normals = new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    ]);
    
    const uvs = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]);
    
    const indices = new Uint16Array([
      0, 1, 2,
      0, 2, 3,
    ]);
    
    return { positions, normals, uvs, indices };
  }
  
  /**
   * Instance method delegates to static (implements abstract method)
   */
  protected generateGeometry(): GeometryData {
    return Plane.generateGeometry(this._primitiveConfig);
  }
  
  protected computeLocalBounds(): AABB {
    const size = this._primitiveConfig.size ?? 1;
    const h = size / 2;
    // Plane is flat on Y, so Y bounds are minimal
    return {
      min: [-h, 0, -h],
      max: [h, 0, h],
    };
  }
  
  /**
   * Create a duplicate of this plane
   */
  clone(): Plane {
    const cloned = new Plane(`${this.name} (copy)`, this._primitiveConfig);
    cloned.copyTransformFrom(this);
    cloned.setMaterial(this.getMaterial());
    cloned.position[0] += 0.5;
    cloned.position[2] += 0.5;
    return cloned;
  }
  
  /**
   * Create from serialized data
   */
  static fromSerialized(data: SerializedPrimitiveObject): Plane {
    const plane = new Plane(data.name, data.primitiveConfig);
    plane.deserialize(data);
    return plane;
  }
}
