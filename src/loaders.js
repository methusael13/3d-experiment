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
 * 
 * gltf-loader-ts accessorData() returns a Uint8Array view of the raw buffer
 * starting at the accessor's position. We need to:
 * 1. Create a typed view of the correct type (Float32, Uint16, etc.)
 * 2. Handle interleaved data if byteStride is set
 * 
 * @param {Uint8Array} rawBuffer - Raw buffer data from accessorData()
 * @param {object} accessor - glTF accessor object
 * @param {object} bufferView - glTF buffer view object (for stride info)
 */
function toTypedArray(rawBuffer, accessor, bufferView = null) {
  const TypedArray = GLTF_COMPONENT_TYPE_ARRAYS[accessor.componentType];
  const numComponents = TYPE_SIZES[accessor.type];
  const count = accessor.count;
  const length = count * numComponents;
  const bytesPerElement = TypedArray.BYTES_PER_ELEMENT;
  
  // Tightly packed element size
  const elementSize = numComponents * bytesPerElement;
  
  // Buffer view stride (0 or undefined means tightly packed)
  const stride = bufferView?.byteStride || elementSize;
  
  // Accessor's byte offset within the buffer view
  // gltf-loader-ts accessorData() returns data starting at bufferView start,
  // so we need to add the accessor's byteOffset manually
  const accessorByteOffset = accessor.byteOffset || 0;
  
  // Always use DataView to read data - handles unaligned byte offsets safely
  // Direct TypedArray construction fails when rawBuffer.byteOffset isn't aligned
  // to the element size (e.g., Float32Array needs offset divisible by 4)
  const result = new TypedArray(length);
  const dataView = new DataView(rawBuffer.buffer, rawBuffer.byteOffset);
  
  for (let i = 0; i < count; i++) {
    // Each element is stride bytes apart, starting from accessor's offset
    const elementOffset = accessorByteOffset + i * stride;
    
    for (let j = 0; j < numComponents; j++) {
      const componentOffset = elementOffset + j * bytesPerElement;
      const resultIndex = i * numComponents + j;
      
      if (TypedArray === Float32Array) {
        result[resultIndex] = dataView.getFloat32(componentOffset, true);
      } else if (TypedArray === Uint32Array) {
        result[resultIndex] = dataView.getUint32(componentOffset, true);
      } else if (TypedArray === Uint16Array) {
        result[resultIndex] = dataView.getUint16(componentOffset, true);
      } else if (TypedArray === Int16Array) {
        result[resultIndex] = dataView.getInt16(componentOffset, true);
      } else if (TypedArray === Uint8Array) {
        result[resultIndex] = dataView.getUint8(componentOffset);
      } else if (TypedArray === Int8Array) {
        result[resultIndex] = dataView.getInt8(componentOffset);
      }
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
          const bufferView = accessor.bufferView !== undefined ? gltf.bufferViews[accessor.bufferView] : null;
          meshData.positions = toTypedArray(rawData, accessor, bufferView);
        }
        
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.TEXCOORD_0);
          const accessor = gltf.accessors[primitive.attributes.TEXCOORD_0];
          const bufferView = accessor.bufferView !== undefined ? gltf.bufferViews[accessor.bufferView] : null;
          meshData.uvs = toTypedArray(rawData, accessor, bufferView);
        }
        
        if (primitive.attributes.NORMAL !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.NORMAL);
          const accessor = gltf.accessors[primitive.attributes.NORMAL];
          const bufferView = accessor.bufferView !== undefined ? gltf.bufferViews[accessor.bufferView] : null;
          meshData.normals = toTypedArray(rawData, accessor, bufferView);
        }
        
        if (primitive.attributes.TANGENT !== undefined) {
          const rawData = await asset.accessorData(primitive.attributes.TANGENT);
          const accessor = gltf.accessors[primitive.attributes.TANGENT];
          const bufferView = accessor.bufferView !== undefined ? gltf.bufferViews[accessor.bufferView] : null;
          meshData.tangents = toTypedArray(rawData, accessor, bufferView);
        }
        
        if (primitive.indices !== undefined) {
          const rawData = await asset.accessorData(primitive.indices);
          const accessor = gltf.accessors[primitive.indices];
          const bufferView = accessor.bufferView !== undefined ? gltf.bufferViews[accessor.bufferView] : null;
          meshData.indices = toTypedArray(rawData, accessor, bufferView);
        }
        
        result.meshes.push(meshData);
      }
    }
  }
  
  // Extract materials (PBR Metallic-Roughness workflow)
  result.materials = (gltf.materials || []).map(mat => {
    const pbr = mat.pbrMetallicRoughness || {};
    return {
      // Base color (albedo)
      baseColorFactor: pbr.baseColorFactor || [1, 1, 1, 1],
      baseColorTextureIndex: pbr.baseColorTexture?.index,
      
      // PBR metallic-roughness
      metallicFactor: pbr.metallicFactor ?? 1.0,
      roughnessFactor: pbr.roughnessFactor ?? 1.0,
      metallicRoughnessTextureIndex: pbr.metallicRoughnessTexture?.index,
      
      // Normal map
      normalTextureIndex: mat.normalTexture?.index,
      normalScale: mat.normalTexture?.scale ?? 1.0,
      
      // Occlusion (AO)
      occlusionTextureIndex: mat.occlusionTexture?.index,
      occlusionStrength: mat.occlusionTexture?.strength ?? 1.0,
      
      // Emissive
      emissiveFactor: mat.emissiveFactor || [0, 0, 0],
      emissiveTextureIndex: mat.emissiveTexture?.index,
      
      // Alpha mode
      alphaMode: mat.alphaMode || 'OPAQUE',
      alphaCutoff: mat.alphaCutoff ?? 0.5,
      doubleSided: mat.doubleSided ?? false,
    };
  });
  
  return normalizeGLBModel(result);
}
