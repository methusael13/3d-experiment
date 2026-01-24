import { PrimitiveObject } from '../PrimitiveObject';
import type { GeometryData, AABB, PrimitiveConfig, SerializedPrimitiveObject } from '../types';

/**
 * Cube primitive - a 6-faced box with configurable size
 */
export class Cube extends PrimitiveObject {
  constructor(
    gl: WebGL2RenderingContext,
    name?: string,
    config: PrimitiveConfig = {}
  ) {
    super(gl, name ?? 'Cube', config);
  }
  
  get primitiveType(): string {
    return 'cube';
  }
  
  /**
   * Generate cube geometry from config (static utility method)
   */
  static generateGeometry(config: PrimitiveConfig = {}): GeometryData {
    const size = config.size ?? 1;
    const h = size / 2;
    
    // 6 faces, 4 vertices each = 24 vertices
    // Each face has its own vertices for correct normals
    const positions = new Float32Array([
      // Front face (Z+)
      -h, -h,  h,   h, -h,  h,   h,  h,  h,  -h,  h,  h,
      // Back face (Z-)
       h, -h, -h,  -h, -h, -h,  -h,  h, -h,   h,  h, -h,
      // Top face (Y+)
      -h,  h,  h,   h,  h,  h,   h,  h, -h,  -h,  h, -h,
      // Bottom face (Y-)
      -h, -h, -h,   h, -h, -h,   h, -h,  h,  -h, -h,  h,
      // Right face (X+)
       h, -h,  h,   h, -h, -h,   h,  h, -h,   h,  h,  h,
      // Left face (X-)
      -h, -h, -h,  -h, -h,  h,  -h,  h,  h,  -h,  h, -h,
    ]);
    
    const normals = new Float32Array([
      // Front
      0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
      // Back
      0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,
      // Top
      0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
      // Bottom
      0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,
      // Right
      1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
      // Left
      -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
    ]);
    
    const uvs = new Float32Array([
      // Front
      0, 0,  1, 0,  1, 1,  0, 1,
      // Back
      0, 0,  1, 0,  1, 1,  0, 1,
      // Top
      0, 0,  1, 0,  1, 1,  0, 1,
      // Bottom
      0, 0,  1, 0,  1, 1,  0, 1,
      // Right
      0, 0,  1, 0,  1, 1,  0, 1,
      // Left
      0, 0,  1, 0,  1, 1,  0, 1,
    ]);
    
    const indices = new Uint16Array([
      // Front
      0, 1, 2,  0, 2, 3,
      // Back
      4, 5, 6,  4, 6, 7,
      // Top
      8, 9, 10,  8, 10, 11,
      // Bottom
      12, 13, 14,  12, 14, 15,
      // Right
      16, 17, 18,  16, 18, 19,
      // Left
      20, 21, 22,  20, 22, 23,
    ]);
    
    return { positions, normals, uvs, indices };
  }
  
  /**
   * Instance method delegates to static (implements abstract method)
   */
  protected generateGeometry(): GeometryData {
    return Cube.generateGeometry(this._primitiveConfig);
  }
  
  protected computeLocalBounds(): AABB {
    const size = this._primitiveConfig.size ?? 1;
    const h = size / 2;
    return {
      min: [-h, -h, -h],
      max: [h, h, h],
    };
  }
  
  /**
   * Create a duplicate of this cube
   */
  clone(gl: WebGL2RenderingContext): Cube {
    const cloned = new Cube(gl, `${this.name} (copy)`, this._primitiveConfig);
    cloned.copyTransformFrom(this);
    cloned.setMaterial(this.getMaterial());
    cloned.position[0] += 0.5;
    cloned.position[2] += 0.5;
    return cloned;
  }
  
  /**
   * Create from serialized data
   */
  static fromSerialized(gl: WebGL2RenderingContext, data: SerializedPrimitiveObject): Cube {
    const cube = new Cube(gl, data.name, data.primitiveConfig);
    cube.deserialize(data);
    return cube;
  }
}
