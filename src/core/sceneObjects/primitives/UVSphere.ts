import { PrimitiveObject } from '../PrimitiveObject';
import type { GeometryData, AABB, PrimitiveConfig, SerializedPrimitiveObject } from '../types';

/**
 * UV Sphere primitive - a sphere generated using latitude/longitude divisions
 */
export class UVSphere extends PrimitiveObject {
  constructor(
    gl: WebGL2RenderingContext,
    name?: string,
    config: PrimitiveConfig = {}
  ) {
    super(gl, name ?? 'UV Sphere', config);
  }
  
  get primitiveType(): string {
    return 'sphere';
  }
  
  /**
   * Generate UV sphere geometry from config (static utility method)
   */
  static generateGeometry(config: PrimitiveConfig = {}): GeometryData {
    const size = config.size ?? 1;
    const subdivisions = config.subdivision ?? 16;
    
    // Size is diameter, radius is half
    const radius = size / 2;
    
    const latBands = Math.max(4, Math.floor(subdivisions / 2));
    const longBands = subdivisions;
    
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    
    // Generate vertices
    for (let lat = 0; lat <= latBands; lat++) {
      const theta = (lat * Math.PI) / latBands;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);
      
      for (let lon = 0; lon <= longBands; lon++) {
        const phi = (lon * 2 * Math.PI) / longBands;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);
        
        // Normal is just the unit sphere position
        const nx = cosPhi * sinTheta;
        const ny = cosTheta;
        const nz = sinPhi * sinTheta;
        
        // Position = normal * radius
        const x = nx * radius;
        const y = ny * radius;
        const z = nz * radius;
        
        // UV coordinates
        const u = lon / longBands;
        const v = lat / latBands;
        
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        uvs.push(u, v);
      }
    }
    
    // Generate indices with correct CCW winding for outward-facing triangles
    for (let lat = 0; lat < latBands; lat++) {
      for (let lon = 0; lon < longBands; lon++) {
        const first = lat * (longBands + 1) + lon;
        const second = first + longBands + 1;
        
        // Two triangles per quad - CCW winding when viewed from outside
        indices.push(first, first + 1, second);
        indices.push(first + 1, second + 1, second);
      }
    }
    
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint16Array(indices),
    };
  }
  
  /**
   * Instance method delegates to static (implements abstract method)
   */
  protected generateGeometry(): GeometryData {
    return UVSphere.generateGeometry(this._primitiveConfig);
  }
  
  protected computeLocalBounds(): AABB {
    const size = this._primitiveConfig.size ?? 1;
    const r = size / 2;
    return {
      min: [-r, -r, -r],
      max: [r, r, r],
    };
  }
  
  /**
   * Create a duplicate of this sphere
   */
  clone(gl: WebGL2RenderingContext): UVSphere {
    const cloned = new UVSphere(gl, `${this.name} (copy)`, this._primitiveConfig);
    cloned.copyTransformFrom(this);
    cloned.setMaterial(this.getMaterial());
    cloned.position[0] += 0.5;
    cloned.position[2] += 0.5;
    return cloned;
  }
  
  /**
   * Create from serialized data
   */
  static fromSerialized(gl: WebGL2RenderingContext, data: SerializedPrimitiveObject): UVSphere {
    const sphere = new UVSphere(gl, data.name, data.primitiveConfig);
    sphere.deserialize(data);
    return sphere;
  }
}
