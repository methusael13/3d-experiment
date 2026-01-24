/**
 * GLBLoader - Loads GLB/glTF binary files
 */

import { GltfLoader, GLTF_COMPONENT_TYPE_ARRAYS, GltfAsset } from 'gltf-loader-ts';
import { BaseLoader } from './BaseLoader';
import type { 
  GLBModel, 
  GLBMesh, 
  GLBMaterial, 
  GLBTexture, 
  TextureType, 
  LoaderOptions,
  TextureColorSpace,
} from './types';
import { TEXTURE_COLOR_SPACES } from './types';

// ============ Constants ============

const TYPE_SIZES: Record<string, number> = {
  'SCALAR': 1,
  'VEC2': 2,
  'VEC3': 3,
  'VEC4': 4,
  'MAT2': 4,
  'MAT3': 9,
  'MAT4': 16,
};

// ============ Internal Types ============

interface GltfAccessor {
  componentType: number;
  type: string;
  count: number;
  byteOffset?: number;
  bufferView?: number;
}

interface GltfBufferView {
  byteStride?: number;
}

type TypedArrayConstructor = 
  | Float32ArrayConstructor 
  | Uint32ArrayConstructor 
  | Uint16ArrayConstructor 
  | Int16ArrayConstructor 
  | Uint8ArrayConstructor 
  | Int8ArrayConstructor;

// ============ Helper Functions ============

/**
 * Convert raw buffer to properly typed array using accessor metadata
 */
function toTypedArray(
  rawBuffer: Uint8Array,
  accessor: GltfAccessor,
  bufferView: GltfBufferView | null = null
): Float32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array {
  const TypedArray = GLTF_COMPONENT_TYPE_ARRAYS[accessor.componentType] as TypedArrayConstructor;
  const numComponents = TYPE_SIZES[accessor.type];
  const count = accessor.count;
  const length = count * numComponents;
  const bytesPerElement = TypedArray.BYTES_PER_ELEMENT;
  
  const elementSize = numComponents * bytesPerElement;
  const stride = bufferView?.byteStride || elementSize;
  const accessorByteOffset = accessor.byteOffset || 0;
  
  const result = new TypedArray(length);
  const dataView = new DataView(rawBuffer.buffer, rawBuffer.byteOffset);
  
  for (let i = 0; i < count; i++) {
    const elementOffset = accessorByteOffset + i * stride;
    
    for (let j = 0; j < numComponents; j++) {
      const componentOffset = elementOffset + j * bytesPerElement;
      const resultIndex = i * numComponents + j;
      
      if (TypedArray === Float32Array) {
        (result as Float32Array)[resultIndex] = dataView.getFloat32(componentOffset, true);
      } else if (TypedArray === Uint32Array) {
        (result as Uint32Array)[resultIndex] = dataView.getUint32(componentOffset, true);
      } else if (TypedArray === Uint16Array) {
        (result as Uint16Array)[resultIndex] = dataView.getUint16(componentOffset, true);
      } else if (TypedArray === Int16Array) {
        (result as Int16Array)[resultIndex] = dataView.getInt16(componentOffset, true);
      } else if (TypedArray === Uint8Array) {
        (result as Uint8Array)[resultIndex] = dataView.getUint8(componentOffset);
      } else if (TypedArray === Int8Array) {
        (result as Int8Array)[resultIndex] = dataView.getInt8(componentOffset);
      }
    }
  }
  
  return result;
}

/**
 * Normalize GLB model positions to fit in unit cube centered at origin
 */
function normalizeGLBModel(model: GLBModel): GLBModel {
  if (model.meshes.length === 0) return model;
  
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

// ============ GLBLoader Class ============

/**
 * Loader for GLB/glTF binary files
 * 
 * @example
 * ```ts
 * const loader = new GLBLoader('/models/helmet.glb');
 * const model = await loader.load();
 * 
 * // Or with options
 * const loader = new GLBLoader('/models/helmet.glb', { normalize: false });
 * const model = await loader.load();
 * ```
 */
export class GLBLoader extends BaseLoader<GLBModel> {
  constructor(url: string, options: LoaderOptions = {}) {
    super(url, options);
  }
  
  getSupportedExtensions(): string[] {
    return ['.glb', '.gltf'];
  }
  
  async load(): Promise<GLBModel> {
    const loader = new GltfLoader();
    const asset: GltfAsset = await loader.load(this.url);
    const gltf = asset.gltf;
    
    const result: GLBModel = {
      meshes: [],
      textures: [],
      texturesWithType: [],
      materials: [],
    };
    
    // Build texture usage map from materials
    const textureUsages = new Map<number, TextureType>();
    
    for (const mat of (gltf.materials || [])) {
      const pbr = mat.pbrMetallicRoughness || {};
      
      if (pbr.baseColorTexture?.index !== undefined) {
        textureUsages.set(pbr.baseColorTexture.index, 'baseColor');
      }
      if (pbr.metallicRoughnessTexture?.index !== undefined) {
        textureUsages.set(pbr.metallicRoughnessTexture.index, 'metallicRoughness');
      }
      if (mat.normalTexture?.index !== undefined) {
        textureUsages.set(mat.normalTexture.index, 'normal');
      }
      if (mat.occlusionTexture?.index !== undefined) {
        textureUsages.set(mat.occlusionTexture.index, 'occlusion');
      }
      if (mat.emissiveTexture?.index !== undefined) {
        textureUsages.set(mat.emissiveTexture.index, 'emissive');
      }
    }
    
    // Load textures with type information
    if (gltf.textures && gltf.images) {
      for (let texIndex = 0; texIndex < gltf.textures.length; texIndex++) {
        const texture = gltf.textures[texIndex];
        const imageIndex = texture.source;
        if (imageIndex !== undefined) {
          const imageData = await asset.imageData.get(imageIndex);
          if (imageData) {
            result.textures.push(imageData);
            
            const textureType = textureUsages.get(texIndex) || 'baseColor';
            result.texturesWithType.push({
              image: imageData,
              type: textureType,
              colorSpace: TEXTURE_COLOR_SPACES[textureType],
            });
          }
        }
      }
    }
    
    // Extract meshes
    if (gltf.meshes) {
      for (const mesh of gltf.meshes) {
        for (const primitive of mesh.primitives) {
          const meshData: GLBMesh = {
            positions: null,
            indices: null,
            uvs: null,
            normals: null,
            materialIndex: primitive.material,
          };
          
          if (primitive.attributes.POSITION !== undefined) {
            const rawData = await asset.accessorData(primitive.attributes.POSITION);
            const accessor = gltf.accessors![primitive.attributes.POSITION] as GltfAccessor;
            const bufferView = accessor.bufferView !== undefined 
              ? gltf.bufferViews![accessor.bufferView] as GltfBufferView 
              : null;
            meshData.positions = toTypedArray(rawData, accessor, bufferView) as Float32Array;
          }
          
          if (primitive.attributes.TEXCOORD_0 !== undefined) {
            const rawData = await asset.accessorData(primitive.attributes.TEXCOORD_0);
            const accessor = gltf.accessors![primitive.attributes.TEXCOORD_0] as GltfAccessor;
            const bufferView = accessor.bufferView !== undefined 
              ? gltf.bufferViews![accessor.bufferView] as GltfBufferView 
              : null;
            meshData.uvs = toTypedArray(rawData, accessor, bufferView) as Float32Array;
          }
          
          if (primitive.attributes.NORMAL !== undefined) {
            const rawData = await asset.accessorData(primitive.attributes.NORMAL);
            const accessor = gltf.accessors![primitive.attributes.NORMAL] as GltfAccessor;
            const bufferView = accessor.bufferView !== undefined 
              ? gltf.bufferViews![accessor.bufferView] as GltfBufferView 
              : null;
            meshData.normals = toTypedArray(rawData, accessor, bufferView) as Float32Array;
          }
          
          if (primitive.attributes.TANGENT !== undefined) {
            const rawData = await asset.accessorData(primitive.attributes.TANGENT);
            const accessor = gltf.accessors![primitive.attributes.TANGENT] as GltfAccessor;
            const bufferView = accessor.bufferView !== undefined 
              ? gltf.bufferViews![accessor.bufferView] as GltfBufferView 
              : null;
            meshData.tangents = toTypedArray(rawData, accessor, bufferView) as Float32Array;
          }
          
          if (primitive.indices !== undefined) {
            const rawData = await asset.accessorData(primitive.indices);
            const accessor = gltf.accessors![primitive.indices] as GltfAccessor;
            const bufferView = accessor.bufferView !== undefined 
              ? gltf.bufferViews![accessor.bufferView] as GltfBufferView 
              : null;
            meshData.indices = toTypedArray(rawData, accessor, bufferView) as Uint16Array | Uint32Array;
          }
          
          result.meshes.push(meshData);
        }
      }
    }
    
    // Extract materials (PBR Metallic-Roughness workflow)
    result.materials = (gltf.materials || []).map(mat => {
      const pbr = mat.pbrMetallicRoughness || {};
      return {
        baseColorFactor: (pbr.baseColorFactor || [1, 1, 1, 1]) as [number, number, number, number],
        baseColorTextureIndex: pbr.baseColorTexture?.index,
        metallicFactor: pbr.metallicFactor ?? 1.0,
        roughnessFactor: pbr.roughnessFactor ?? 1.0,
        metallicRoughnessTextureIndex: pbr.metallicRoughnessTexture?.index,
        normalTextureIndex: mat.normalTexture?.index,
        normalScale: mat.normalTexture?.scale ?? 1.0,
        occlusionTextureIndex: mat.occlusionTexture?.index,
        occlusionStrength: mat.occlusionTexture?.strength ?? 1.0,
        emissiveFactor: (mat.emissiveFactor || [0, 0, 0]) as [number, number, number],
        emissiveTextureIndex: mat.emissiveTexture?.index,
        alphaMode: (mat.alphaMode || 'OPAQUE') as 'OPAQUE' | 'MASK' | 'BLEND',
        alphaCutoff: mat.alphaCutoff ?? 0.5,
        doubleSided: mat.doubleSided ?? false,
      };
    });
    
    // Normalize if requested
    if (this.options.normalize) {
      return normalizeGLBModel(result);
    }
    
    return result;
  }
}

/**
 * Convenience function to load a GLB file
 * @param url - URL to the GLB file
 * @param options - Loader options
 * @returns Parsed GLB model
 * 
 * @example
 * ```ts
 * const model = await loadGLB('/models/helmet.glb');
 * ```
 */
export async function loadGLB(url: string, options?: LoaderOptions): Promise<GLBModel> {
  const loader = new GLBLoader(url, options);
  return loader.load();
}
