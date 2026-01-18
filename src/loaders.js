/**
 * Model loaders for OBJ and GLB formats
 */

import { GltfLoader, GLTF_COMPONENT_TYPE_ARRAYS } from 'gltf-loader-ts';

// ============ OBJ Loader ============

/**
 * Parse OBJ file format into vertices and edges for wireframe rendering
 * 
 * Supported OBJ features:
 * - v x y z - vertex positions
 * - f v1 v2 v3... - faces (triangles, quads, polygons)
 * - f v1/vt1 v2/vt2... - faces with texture coords (texture ignored)
 * - f v1/vt1/vn1 v2/vt2/vn2... - faces with tex and normals (both ignored)
 * 
 * @param {string} objText - Raw OBJ file content
 * @returns {object} { vertices: [{x,y,z}...], edges: [[i,j]...] }
 */
export function parseOBJ(objText) {
  const vertices = [];
  const edgeSet = new Set();
  
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
      const faceIndices = parts.slice(1).map(p => {
        const vertexIndex = parseInt(p.split('/')[0], 10);
        return vertexIndex > 0 ? vertexIndex - 1 : vertices.length + vertexIndex;
      });
      
      for (let i = 0; i < faceIndices.length; i++) {
        const a = faceIndices[i];
        const b = faceIndices[(i + 1) % faceIndices.length];
        const edgeKey = a < b ? `${a},${b}` : `${b},${a}`;
        edgeSet.add(edgeKey);
      }
    }
  }
  
  const edges = Array.from(edgeSet).map(key => {
    const [a, b] = key.split(',').map(Number);
    return [a, b];
  });
  
  return { vertices, edges };
}

/**
 * Center and normalize a model to fit in a unit cube at origin
 * 
 * @param {object} model - { vertices, edges }
 * @returns {object} Centered and normalized model
 */
export function normalizeModel(model) {
  if (model.vertices.length === 0) {
    return model;
  }
  
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
  
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const maxSize = Math.max(sizeX, sizeY, sizeZ);
  const scale = maxSize > 0 ? 1 / maxSize : 1;
  
  const vertices = model.vertices.map(v => ({
    x: (v.x - centerX) * scale,
    y: (v.y - centerY) * scale,
    z: (v.z - centerZ) * scale,
  }));
  
  return { vertices, edges: model.edges };
}

/**
 * Load and parse an OBJ file from URL
 * @param {string} url - URL to OBJ file
 * @returns {Promise<object>} Normalized wireframe model
 */
export async function loadOBJ(url) {
  const response = await fetch(url);
  const objText = await response.text();
  const rawModel = parseOBJ(objText);
  return normalizeModel(rawModel);
}

// ============ GLB Loader ============

const TYPE_SIZES = {
  'SCALAR': 1,
  'VEC2': 2,
  'VEC3': 3,
  'VEC4': 4,
  'MAT2': 4,
  'MAT3': 9,
  'MAT4': 16,
};

/**
 * Convert raw buffer to properly typed array using accessor metadata
 */
function toTypedArray(rawBuffer, accessor) {
  const TypedArray = GLTF_COMPONENT_TYPE_ARRAYS[accessor.componentType];
  const numComponents = TYPE_SIZES[accessor.type];
  const count = accessor.count;
  const length = count * numComponents;
  
  const byteOffset = accessor.byteOffset || 0;
  const result = new TypedArray(length);
  const dataView = new DataView(rawBuffer.buffer, rawBuffer.byteOffset + byteOffset);
  
  const bytesPerElement = TypedArray.BYTES_PER_ELEMENT;
  for (let i = 0; i < length; i++) {
    const offset = i * bytesPerElement;
    if (TypedArray === Float32Array) {
      result[i] = dataView.getFloat32(offset, true);
    } else if (TypedArray === Uint32Array) {
      result[i] = dataView.getUint32(offset, true);
    } else if (TypedArray === Uint16Array) {
      result[i] = dataView.getUint16(offset, true);
    } else if (TypedArray === Int16Array) {
      result[i] = dataView.getInt16(offset, true);
    } else if (TypedArray === Uint8Array) {
      result[i] = dataView.getUint8(offset);
    } else if (TypedArray === Int8Array) {
      result[i] = dataView.getInt8(offset);
    }
  }
  
  return result;
}

/**
 * Normalize GLB model positions to fit in unit cube centered at origin
 */
function normalizeGLBModel(model) {
  if (model.meshes.length === 0) return model;
  
  // Find bounding box across all meshes
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  
  for (const mesh of model.meshes) {
    if (!mesh.positions) continue;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]);
      maxX = Math.max(maxX, mesh.positions[i]);
      minY = Math.min(minY, mesh.positions[i + 1]);
      maxY = Math.max(maxY, mesh.positions[i + 1]);
      minZ = Math.min(minZ, mesh.positions[i + 2]);
      maxZ = Math.max(maxZ, mesh.positions[i + 2]);
    }
  }
  
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const maxSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const scale = maxSize > 0 ? 1 / maxSize : 1;
  
  // Normalize all mesh positions
  for (const mesh of model.meshes) {
    if (!mesh.positions) continue;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      mesh.positions[i] = (mesh.positions[i] - centerX) * scale;
      mesh.positions[i + 1] = (mesh.positions[i + 1] - centerY) * scale;
      mesh.positions[i + 2] = (mesh.positions[i + 2] - centerZ) * scale;
    }
  }
  
  return model;
}

/**
 * Load and parse a GLB file
 * @param {string} url - URL to GLB file
 * @returns {Promise<object>} Parsed model with meshes, textures, materials
 */
export async function loadGLB(url) {
  const loader = new GltfLoader();
  const asset = await loader.load(url);
  const gltf = asset.gltf;
  
  const result = {
    meshes: [],
    textures: [],
    materials: [],
  };
  
  // Load textures
  if (gltf.textures && gltf.images) {
    for (const texture of gltf.textures) {
      const imageIndex = texture.source;
      const imageData = await asset.imageData.get(imageIndex);
      result.textures.push(imageData);
    }
  }
  
  // Extract meshes
  if (gltf.meshes) {
    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives) {
        const meshData = {
          positions: null,
          indices: null,
          uvs: null,
          normals: null,
          materialIndex: primitive.material,
        };
        
        if (primitive.attributes.POSITION !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.POSITION);
          const accessor = gltf.accessors[primitive.attributes.POSITION];
          meshData.positions = toTypedArray(rawData, accessor);
        }
        
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.TEXCOORD_0);
          const accessor = gltf.accessors[primitive.attributes.TEXCOORD_0];
          meshData.uvs = toTypedArray(rawData, accessor);
        }
        
        if (primitive.attributes.NORMAL !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.NORMAL);
          const accessor = gltf.accessors[primitive.attributes.NORMAL];
          meshData.normals = toTypedArray(rawData, accessor);
        }
        
        if (primitive.indices !== undefined) {
          const rawData = await asset.accessorData(primitive.indices);
          const accessor = gltf.accessors[primitive.indices];
          meshData.indices = toTypedArray(rawData, accessor);
        }
        
        result.meshes.push(meshData);
      }
    }
  }
  
  // Extract materials
  result.materials = (gltf.materials || []).map(mat => ({
    baseColorFactor: mat.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1],
    baseColorTextureIndex: mat.pbrMetallicRoughness?.baseColorTexture?.index,
  }));
  
  return normalizeGLBModel(result);
}
