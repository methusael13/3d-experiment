/**
 * OBJLoader - Loads OBJ files as wireframe models
 */

import { BaseLoader } from './BaseLoader';
import type { WireframeModel, Vertex3D, LoaderOptions } from './types';

/**
 * Loader for OBJ files (wireframe only)
 * 
 * Supported OBJ features:
 * - v x y z - vertex positions
 * - f v1 v2 v3... - faces (triangles, quads, polygons)
 * - f v1/vt1 v2/vt2... - faces with texture coords (texture ignored)
 * - f v1/vt1/vn1 v2/vt2/vn2... - faces with tex and normals (both ignored)
 * 
 * @example
 * ```ts
 * const loader = new OBJLoader('/models/cube.obj');
 * const model = await loader.load();
 * // model.vertices - array of { x, y, z }
 * // model.edges - array of [index1, index2] pairs
 * ```
 */
export class OBJLoader extends BaseLoader<WireframeModel> {
  constructor(url: string, options: LoaderOptions = {}) {
    super(url, options);
  }
  
  getSupportedExtensions(): string[] {
    return ['.obj'];
  }
  
  async load(): Promise<WireframeModel> {
    const objText = await this.fetchText();
    const rawModel = this.parseOBJ(objText);
    
    if (this.options.normalize) {
      return this.normalizeModel(rawModel);
    }
    
    return rawModel;
  }
  
  /**
   * Parse OBJ file text into vertices and edges
   */
  private parseOBJ(objText: string): WireframeModel {
    const vertices: Vertex3D[] = [];
    const edgeSet = new Set<string>();
    
    const lines = objText.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const parts = trimmed.split(/\s+/);
      const type = parts[0];
      
      if (type === 'v') {
        vertices.push({
          x: parseFloat(parts[1]),
          y: parseFloat(parts[2]),
          z: parseFloat(parts[3]),
        });
      } else if (type === 'f') {
        // Parse face indices (handles v, v/vt, v/vt/vn, v//vn formats)
        const faceIndices = parts.slice(1).map(p => {
          const vertexIndex = parseInt(p.split('/')[0], 10);
          // OBJ indices are 1-based, can be negative (relative)
          return vertexIndex > 0 ? vertexIndex - 1 : vertices.length + vertexIndex;
        });
        
        // Create edges for each face
        for (let i = 0; i < faceIndices.length; i++) {
          const a = faceIndices[i];
          const b = faceIndices[(i + 1) % faceIndices.length];
          // Normalize edge key to avoid duplicates
          const edgeKey = a < b ? `${a},${b}` : `${b},${a}`;
          edgeSet.add(edgeKey);
        }
      }
    }
    
    // Convert edge set to array
    const edges: [number, number][] = Array.from(edgeSet).map(key => {
      const [a, b] = key.split(',').map(Number);
      return [a, b];
    });
    
    return { vertices, edges };
  }
  
  /**
   * Center and normalize model to fit in a unit cube at origin
   */
  private normalizeModel(model: WireframeModel): WireframeModel {
    if (model.vertices.length === 0) {
      return model;
    }
    
    // Find bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const v of model.vertices) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      minZ = Math.min(minZ, v.z);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
      maxZ = Math.max(maxZ, v.z);
    }
    
    // Compute center and scale
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const maxSize = Math.max(sizeX, sizeY, sizeZ);
    const scale = maxSize > 0 ? 1 / maxSize : 1;
    
    // Transform vertices
    const vertices = model.vertices.map(v => ({
      x: (v.x - centerX) * scale,
      y: (v.y - centerY) * scale,
      z: (v.z - centerZ) * scale,
    }));
    
    return { vertices, edges: model.edges };
  }
}

/**
 * Convenience function to load an OBJ file
 * @param url - URL to the OBJ file
 * @param options - Loader options
 * @returns Wireframe model with vertices and edges
 * 
 * @example
 * ```ts
 * const model = await loadOBJ('/models/cube.obj');
 * ```
 */
export async function loadOBJ(url: string, options?: LoaderOptions): Promise<WireframeModel> {
  const loader = new OBJLoader(url, options);
  return loader.load();
}
