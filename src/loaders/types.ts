/**
 * Shared types for model loaders
 */

// ============ OBJ Wireframe Types ============

/**
 * 3D vertex position
 */
export interface Vertex3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Wireframe model for OBJ files
 */
export interface WireframeModel {
  vertices: Vertex3D[];
  edges: [number, number][];
}

// ============ GLB Types ============

/**
 * Mesh data extracted from GLB
 */
export interface GLBMesh {
  positions: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  uvs: Float32Array | null;
  normals: Float32Array | null;
  tangents?: Float32Array | null;
  materialIndex: number | undefined;
}

/**
 * Texture color space for gamma correction
 * - 'srgb': Needs gamma correction in shader (albedo, emissive)
 * - 'linear': Already linear, no conversion needed (normal, metallic-roughness, occlusion)
 */
export type TextureColorSpace = 'srgb' | 'linear';

/**
 * Texture usage type for shader handling
 */
export type TextureType = 
  | 'baseColor'      // sRGB - needs gamma correction
  | 'emissive'       // sRGB - needs gamma correction
  | 'normal'         // Linear - no conversion
  | 'metallicRoughness' // Linear - no conversion
  | 'occlusion';     // Linear - no conversion

/**
 * Texture with type metadata for proper shader handling
 */
export interface GLBTexture {
  image: HTMLImageElement;
  type: TextureType;
  colorSpace: TextureColorSpace;
}

/**
 * PBR Material from GLB
 */
export interface GLBMaterial {
  baseColorFactor: [number, number, number, number];
  baseColorTextureIndex?: number;
  metallicFactor: number;
  roughnessFactor: number;
  metallicRoughnessTextureIndex?: number;
  normalTextureIndex?: number;
  normalScale: number;
  occlusionTextureIndex?: number;
  occlusionStrength: number;
  emissiveFactor: [number, number, number];
  emissiveTextureIndex?: number;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  // KHR_materials_transmission extension
  transmission: number;
  transmissionTextureIndex?: number;
  // KHR_materials_ior extension
  ior: number;
  // KHR_materials_clearcoat extension
  clearcoatFactor: number;
  clearcoatRoughness: number;
  // KHR_materials_unlit extension
  unlit: boolean;
}

/**
 * A node from the glTF scene graph, grouping meshes with a transform.
 * Used to split multi-object files (e.g., Polyhaven tree packs) into
 * separate selectable objects.
 */
export interface GLBNode {
  /** Node name from glTF (e.g., "japanese_maple_01") */
  name: string;
  /** Indices into the parent GLBModel.meshes[] array */
  meshIndices: number[];
  /** World-space translation (composed from node hierarchy) */
  translation: [number, number, number];
  /** World-space rotation as quaternion [x, y, z, w] */
  rotation: [number, number, number, number];
  /** World-space scale */
  scale: [number, number, number];
}

/**
 * Complete GLB model data
 */
export interface GLBModel {
  meshes: GLBMesh[];
  /** Raw texture images (legacy - use texturesWithType for new code) */
  textures: HTMLImageElement[];
  /** Textures with type metadata for gamma correction */
  texturesWithType: GLBTexture[];
  materials: GLBMaterial[];
  /** 
   * Scene graph nodes with their transforms and mesh references.
   * Only populated when the glTF has a scene graph with nodes.
   * Each node groups one or more meshes with a world transform.
   */
  nodes?: GLBNode[];
}

/**
 * Loader options
 */
export interface LoaderOptions {
  /** Whether to normalize model to fit in unit cube (default: true) */
  normalize?: boolean;
}

/**
 * Map texture type to color space for gamma correction
 */
export const TEXTURE_COLOR_SPACES: Record<TextureType, TextureColorSpace> = {
  'baseColor': 'srgb',
  'emissive': 'srgb',
  'normal': 'linear',
  'metallicRoughness': 'linear',
  'occlusion': 'linear',
};

/**
 * Helper to check if a texture needs gamma correction (sRGB → linear)
 */
export function needsGammaCorrection(texture: GLBTexture): boolean {
  return texture.colorSpace === 'srgb';
}

/**
 * Helper to get texture type from material and texture index
 */
export function getTextureType(material: GLBMaterial, textureIndex: number): TextureType | null {
  if (material.baseColorTextureIndex === textureIndex) return 'baseColor';
  if (material.emissiveTextureIndex === textureIndex) return 'emissive';
  if (material.normalTextureIndex === textureIndex) return 'normal';
  if (material.metallicRoughnessTextureIndex === textureIndex) return 'metallicRoughness';
  if (material.occlusionTextureIndex === textureIndex) return 'occlusion';
  return null;
}
