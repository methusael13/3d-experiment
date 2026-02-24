/**
 * GLBLoader - Loads GLB/glTF binary files
 */

import { GltfLoader, GLTF_COMPONENT_TYPE_ARRAYS, GltfAsset } from 'gltf-loader-ts';
import { mat4, vec3, quat } from 'gl-matrix';
import { BaseLoader } from './BaseLoader';
import type { 
  GLBModel, 
  GLBMesh, 
  GLBMaterial, 
  GLBTexture, 
  GLBNode,
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

// ============ Scene Graph Parsing ============

/**
 * glTF node with TRS properties (from the gltf-loader-ts types)
 */
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number]; // quaternion [x, y, z, w]
  scale?: [number, number, number];
  matrix?: number[]; // 4x4 column-major matrix
}

/**
 * Get the local transform matrix for a glTF node.
 * If the node has a `matrix` property, use it directly.
 * Otherwise compose from TRS.
 */
function getNodeLocalMatrix(node: GltfNode): mat4 {
  const out = mat4.create();
  
  if (node.matrix) {
    // glTF matrix is column-major, same as gl-matrix
    for (let i = 0; i < 16; i++) {
      out[i] = node.matrix[i];
    }
    return out;
  }
  
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1]; // identity quaternion
  const s = node.scale ?? [1, 1, 1];
  
  mat4.fromRotationTranslationScale(
    out,
    quat.fromValues(r[0], r[1], r[2], r[3]),
    vec3.fromValues(t[0], t[1], t[2]),
    vec3.fromValues(s[0], s[1], s[2]),
  );
  
  return out;
}

/**
 * Walk the glTF scene graph and collect all nodes that reference meshes,
 * with their composed world transforms.
 */
function parseSceneGraph(
  gltf: any,
  meshIndexRanges: Array<{ start: number; count: number }>
): GLBNode[] {
  const nodes: GLBNode[] = [];
  const gltfNodes: GltfNode[] = gltf.nodes ?? [];
  
  if (gltfNodes.length === 0) return nodes;
  
  // Get root node indices from the default scene (or all root nodes)
  let rootIndices: number[] = [];
  if (gltf.scenes && gltf.scene !== undefined && gltf.scenes[gltf.scene]) {
    rootIndices = gltf.scenes[gltf.scene].nodes ?? [];
  } else if (gltf.scenes && gltf.scenes.length > 0) {
    rootIndices = gltf.scenes[0].nodes ?? [];
  } else {
    // No scene defined — treat all nodes without parents as roots
    const hasParent = new Set<number>();
    for (const node of gltfNodes) {
      if (node.children) {
        for (const child of node.children) {
          hasParent.add(child);
        }
      }
    }
    rootIndices = gltfNodes.map((_, i) => i).filter(i => !hasParent.has(i));
  }
  
  // Recursive walk
  function walkNode(nodeIndex: number, parentWorldMatrix: mat4): void {
    const node = gltfNodes[nodeIndex];
    if (!node) return;
    
    const localMatrix = getNodeLocalMatrix(node);
    const worldMatrix = mat4.create();
    mat4.multiply(worldMatrix, parentWorldMatrix, localMatrix);
    
    // If this node references a mesh, record it
    if (node.mesh !== undefined && node.mesh < meshIndexRanges.length) {
      const range = meshIndexRanges[node.mesh];
      const meshIndices: number[] = [];
      for (let i = range.start; i < range.start + range.count; i++) {
        meshIndices.push(i);
      }
      
      // Decompose world matrix into TRS
      const t = vec3.create();
      const r = quat.create();
      const s = vec3.create();
      mat4.getTranslation(t, worldMatrix);
      mat4.getRotation(r, worldMatrix);
      mat4.getScaling(s, worldMatrix);
      
      nodes.push({
        name: node.name ?? `Node_${nodeIndex}`,
        meshIndices,
        translation: [t[0], t[1], t[2]],
        rotation: [r[0], r[1], r[2], r[3]],
        scale: [s[0], s[1], s[2]],
      });
    }
    
    // Recurse into children
    if (node.children) {
      for (const childIndex of node.children) {
        walkNode(childIndex, worldMatrix);
      }
    }
  }
  
  const identity = mat4.create();
  for (const rootIndex of rootIndices) {
    walkNode(rootIndex, identity);
  }
  
  return nodes;
}

/**
 * Bake node world transforms into mesh vertex positions and normals.
 * For each node, builds its world transform matrix from the decomposed TRS,
 * then transforms all vertex positions (as points) and normals (as directions)
 * of the node's associated meshes.
 * 
 * After baking, the node transforms are reset to identity (translation=[0,0,0],
 * rotation=identity, scale=[1,1,1]) since the transforms are now in the vertices.
 */
function bakeNodeTransforms(model: GLBModel): void {
  if (!model.nodes || model.nodes.length === 0) return;
  
  for (const node of model.nodes) {
    // Check if this node has a non-identity transform
    const hasTranslation = node.translation[0] !== 0 || node.translation[1] !== 0 || node.translation[2] !== 0;
    const hasRotation = node.rotation[0] !== 0 || node.rotation[1] !== 0 || node.rotation[2] !== 0 || node.rotation[3] !== 1;
    const hasScale = node.scale[0] !== 1 || node.scale[1] !== 1 || node.scale[2] !== 1;
    
    if (!hasTranslation && !hasRotation && !hasScale) continue;
    
    // Build world transform matrix from decomposed TRS
    const worldMatrix = mat4.create();
    mat4.fromRotationTranslationScale(
      worldMatrix,
      quat.fromValues(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]),
      vec3.fromValues(node.translation[0], node.translation[1], node.translation[2]),
      vec3.fromValues(node.scale[0], node.scale[1], node.scale[2]),
    );
    
    // Extract the 3x3 normal matrix (inverse transpose of upper-left 3x3)
    // For uniform scale this is just the rotation matrix
    const normalMatrix = mat4.create();
    mat4.invert(normalMatrix, worldMatrix);
    mat4.transpose(normalMatrix, normalMatrix);
    
    // Transform each mesh associated with this node
    for (const meshIdx of node.meshIndices) {
      const mesh = model.meshes[meshIdx];
      if (!mesh) continue;
      
      // Transform positions (as points: w=1)
      if (mesh.positions) {
        const pos = mesh.positions;
        const v = vec3.create();
        for (let i = 0; i < pos.length; i += 3) {
          vec3.set(v, pos[i], pos[i + 1], pos[i + 2]);
          vec3.transformMat4(v, v, worldMatrix);
          pos[i] = v[0];
          pos[i + 1] = v[1];
          pos[i + 2] = v[2];
        }
      }
      
      // Transform normals (as directions: w=0, using normal matrix)
      if (mesh.normals) {
        const nrm = mesh.normals;
        const n = vec3.create();
        for (let i = 0; i < nrm.length; i += 3) {
          vec3.set(n, nrm[i], nrm[i + 1], nrm[i + 2]);
          vec3.transformMat4(n, n, normalMatrix);
          vec3.normalize(n, n);
          nrm[i] = n[0];
          nrm[i + 1] = n[1];
          nrm[i + 2] = n[2];
        }
      }
      
      // Transform tangents if present (direction, w=0)
      if (mesh.tangents) {
        const tan = mesh.tangents;
        const t = vec3.create();
        for (let i = 0; i < tan.length; i += 4) {
          vec3.set(t, tan[i], tan[i + 1], tan[i + 2]);
          vec3.transformMat4(t, t, normalMatrix);
          vec3.normalize(t, t);
          tan[i] = t[0];
          tan[i + 1] = t[1];
          tan[i + 2] = t[2];
          // tan[i+3] (handedness) stays unchanged
        }
      }
    }
    
    // Reset node transform to identity (transforms are now baked into vertices)
    node.translation = [0, 0, 0];
    node.rotation = [0, 0, 0, 1];
    node.scale = [1, 1, 1];
  }
}

/**
 * Describes a single node extracted from a multi-node GLB file.
 * Contains its own GLBModel with only the meshes belonging to this node,
 * plus the node's name and world-space transform.
 */
export interface GLBNodeModel {
  /** Node name from the glTF file */
  name: string;
  /** GLBModel containing only this node's meshes (shares textures/materials with siblings) */
  model: GLBModel;
  /** World-space translation from the scene graph */
  translation: [number, number, number];
  /** World-space rotation as quaternion [x, y, z, w] */
  rotation: [number, number, number, number];
  /** World-space scale */
  scale: [number, number, number];
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
    
    // Extract meshes (flat list of all primitives across all glTF meshes)
    // Also build a mapping: gltf mesh index → range of result.meshes[] indices
    const meshIndexRanges: Array<{ start: number; count: number }> = [];
    
    if (gltf.meshes) {
      for (const mesh of gltf.meshes) {
        const rangeStart = result.meshes.length;
        
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
        
        meshIndexRanges.push({ 
          start: rangeStart, 
          count: result.meshes.length - rangeStart 
        });
      }
    }
    
    // Parse scene graph nodes to build GLBNode[]
    result.nodes = parseSceneGraph(gltf, meshIndexRanges);
    
    // Bake node world transforms into vertex positions and normals
    // This ensures models exported from Z-up tools (Blender, 3ds Max) display correctly
    // by applying the root node's coordinate system rotation to all vertices
    bakeNodeTransforms(result);
    
    // Extract materials (PBR Metallic-Roughness workflow)
    result.materials = (gltf.materials || []).map(mat => {
      const pbr = mat.pbrMetallicRoughness || {};
      
      // Parse KHR_materials_transmission extension
      const transmissionExt = (mat.extensions as Record<string, unknown>)?.['KHR_materials_transmission'] as {
        transmissionFactor?: number;
        transmissionTexture?: { index: number };
      } | undefined;
      
      // Parse KHR_materials_ior extension
      const iorExt = (mat.extensions as Record<string, unknown>)?.['KHR_materials_ior'] as {
        ior?: number;
      } | undefined;
      
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
        // KHR_materials_transmission
        transmission: transmissionExt?.transmissionFactor ?? 0.0,
        transmissionTextureIndex: transmissionExt?.transmissionTexture?.index,
        // KHR_materials_ior (default 1.5 per glTF spec)
        ior: iorExt?.ior ?? 1.5,
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

/**
 * Load a GLB file and split it into separate models per scene graph node.
 * 
 * For single-node files (e.g., FlightHelmet), returns an array with one entry.
 * For multi-node files (e.g., Polyhaven tree packs with 3 variants), returns
 * one entry per mesh-bearing node, each with its own GLBModel subset.
 * 
 * Textures and materials are shared (referenced) across all returned models
 * to avoid duplicate GPU uploads.
 * 
 * @param url - URL to the GLB file
 * @param options - Loader options
 * @returns Array of node models, one per scene graph node that has meshes
 * 
 * @example
 * ```ts
 * const nodes = await loadGLBNodes('/models/trees.glb');
 * // nodes[0].name === "pine_tree_01"
 * // nodes[1].name === "pine_tree_02"
 * // nodes[2].name === "pine_tree_03"
 * // Each has its own .model with only that tree's meshes
 * ```
 */
export async function loadGLBNodes(url: string, options?: LoaderOptions): Promise<GLBNodeModel[]> {
  const fullModel = await loadGLB(url, options);
  
  // If no nodes parsed, or only one node, return the whole model as a single entry
  if (!fullModel.nodes || fullModel.nodes.length <= 1) {
    const nodeName = fullModel.nodes?.[0]?.name ?? 'Root';
    const nodeTranslation = fullModel.nodes?.[0]?.translation ?? [0, 0, 0];
    const nodeRotation = fullModel.nodes?.[0]?.rotation ?? [0, 0, 0, 1];
    const nodeScale = fullModel.nodes?.[0]?.scale ?? [1, 1, 1];
    
    return [{
      name: nodeName,
      model: fullModel,
      translation: nodeTranslation as [number, number, number],
      rotation: nodeRotation as [number, number, number, number],
      scale: nodeScale as [number, number, number],
    }];
  }
  
  // Split into separate models per node
  const result: GLBNodeModel[] = [];
  
  for (const node of fullModel.nodes) {
    // Extract only this node's meshes
    const nodeMeshes = node.meshIndices.map(i => fullModel.meshes[i]);
    
    // Build a sub-model that shares textures/materials but has its own mesh subset
    const nodeModel: GLBModel = {
      meshes: nodeMeshes,
      textures: fullModel.textures,           // shared reference
      texturesWithType: fullModel.texturesWithType, // shared reference
      materials: fullModel.materials,          // shared reference
      nodes: [{
        ...node,
        meshIndices: nodeMeshes.map((_, i) => i), // re-index to local mesh array
      }],
    };
    
    result.push({
      name: node.name,
      model: nodeModel,
      translation: node.translation,
      rotation: node.rotation,
      scale: node.scale,
    });
  }
  
  return result;
}
