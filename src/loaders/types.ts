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

// ---- Skeleton & Animation Types ----

/**
 * A single bone/joint in the skeleton hierarchy.
 * Index order matches the glTF skin.joints[] array.
 */
export interface GLBJoint {
  /** Human-readable name from glTF node (e.g., "mixamorig:Hips") */
  name: string;

  /** Index of this joint in the GLBSkeleton.joints[] array */
  index: number;

  /**
   * Parent joint index in GLBSkeleton.joints[] array.
   * -1 for the root joint (no parent).
   */
  parentIndex: number;

  /** Child joint indices in GLBSkeleton.joints[] array */
  children: number[];

  /**
   * Local bind-pose transform (from glTF node TRS).
   * This is the rest/bind pose of the joint — the default position
   * when no animation is applied.
   */
  localBindTransform: {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // quaternion [x, y, z, w]
    scale: [number, number, number];
  };
}

/**
 * Skeleton data parsed from a glTF `skin` node.
 *
 * The skeleton is a tree of joints (bones). Each joint has a local bind-pose
 * transform and an inverse bind matrix. At runtime, the AnimationSystem
 * computes:
 *
 *   boneMatrix[i] = globalJointTransform[i] × inverseBindMatrix[i]
 *
 * which transforms vertices from bind-pose model space into animated
 * world-relative space.
 */
export interface GLBSkeleton {
  /** Ordered array of joints. Indices match glTF skin.joints[]. */
  joints: GLBJoint[];

  /**
   * Inverse bind matrices — one mat4 per joint.
   * Flat Float32Array of length `joints.length × 16`.
   * Column-major order (same as gl-matrix / glTF).
   *
   * inverseBindMatrix[i] transforms a vertex from model space to
   * joint-local space of joint i in its bind pose.
   */
  inverseBindMatrices: Float32Array;

  /** Index into joints[] for the skeleton root */
  rootJointIndex: number;

  /**
   * World transform of the armature root node (skin.skeleton or parent of root joints).
   * Flat Float32Array of length 16 (one mat4, column-major).
   *
   * In many glTF files (especially Blender exports), root bone joints are children
   * of an "Armature" node that has a non-identity transform (e.g., 90° X rotation
   * for Z-up → Y-up conversion). The inverse bind matrices include this transform,
   * so the bone matrix computation must also apply it to root joints.
   *
   * Identity (16 floats) when no armature parent exists or it has identity transform.
   */
  armatureTransform: Float32Array;
}

/**
 * A single animation channel targeting one joint's TRS property.
 */
export interface GLBAnimationChannel {
  /**
   * Index into GLBSkeleton.joints[].
   * -1 if the target node is not part of the skin (non-joint animation).
   */
  jointIndex: number;

  /** Which transform property this channel animates */
  path: 'translation' | 'rotation' | 'scale';

  /**
   * Keyframe timestamps in seconds.
   * Monotonically increasing. First value is typically 0.
   */
  times: Float32Array;

  /**
   * Keyframe values, tightly packed:
   * - translation: 3 floats per keyframe (x, y, z)
   * - rotation:    4 floats per keyframe (x, y, z, w) quaternion
   * - scale:       3 floats per keyframe (x, y, z)
   *
   * For CUBICSPLINE interpolation, each keyframe has 3× the values
   * (in-tangent, value, out-tangent), but LINEAR is the common case.
   */
  values: Float32Array;

  /** Interpolation method from glTF animation sampler */
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

/**
 * A complete animation clip (e.g., "idle", "Walking", "Running").
 * Contains all channels that animate the skeleton joints over time.
 */
export interface GLBAnimationClip {
  /** Clip name from glTF (e.g., "mixamo.com" for unnamed, or "Idle") */
  name: string;

  /** Total duration in seconds (max timestamp across all channels) */
  duration: number;

  /** All channels in this clip */
  channels: GLBAnimationChannel[];
}

// ---- Mesh Types ----

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

  /**
   * Joint indices per vertex (from glTF JOINTS_0 attribute).
   * vec4 per vertex — 4 bone influences per vertex.
   * Values are indices into GLBSkeleton.joints[].
   * Uint8Array for ≤256 joints (common), Uint16Array otherwise.
   */
  jointIndices?: Uint8Array | Uint16Array | null;

  /**
   * Joint weights per vertex (from glTF WEIGHTS_0 attribute).
   * vec4 per vertex — sum of weights should be 1.0 for each vertex.
   * Matches jointIndices element-by-element.
   */
  jointWeights?: Float32Array | null;
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
  | 'occlusion'      // Linear - no conversion
  | 'bump'           // Linear - grayscale height map
  | 'displacement';  // Linear - grayscale height map

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
  // Bump / displacement texture support
  // Extracted from KHR_materials_displacement extension or
  // matched by texture filename patterns during asset indexing
  bumpTextureIndex?: number;
  bumpScale: number;
  displacementTextureIndex?: number;
  displacementScale: number;
  displacementBias: number;
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

  /**
   * Skeleton hierarchy and bind-pose data.
   * Present only if the glTF file contains a `skin` node.
   * Null/undefined for static (non-skinned) models.
   */
  skeleton?: GLBSkeleton | null;

  /**
   * Animation clips parsed from glTF `animations[]`.
   * Empty array if no animations are present.
   * Each clip can be registered in AnimationComponent.clips by name.
   */
  animations?: GLBAnimationClip[];
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
  'bump': 'linear',
  'displacement': 'linear',
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
  if (material.bumpTextureIndex === textureIndex) return 'bump';
  if (material.displacementTextureIndex === textureIndex) return 'displacement';
  return null;
}
