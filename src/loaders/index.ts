/**
 * Model loaders barrel exports
 * 
 * @example
 * ```ts
 * // Using the convenience function
 * import { loadGLB } from './loaders';
 * const model = await loadGLB('/models/helmet.glb');
 * 
 * // Using the class directly
 * import { GLBLoader } from './loaders';
 * const loader = new GLBLoader('/models/helmet.glb', { normalize: false });
 * const model = await loader.load();
 * ```
 */

// Base class
export { BaseLoader } from './BaseLoader';

// GLB/glTF loader
export { GLBLoader, loadGLB } from './GLBLoader';

// OBJ loader (wireframe)
export { OBJLoader, loadOBJ } from './OBJLoader';

// HDR loader
export {
  HDRLoader,
  type HDRData,
  type PrefilteredHDR,
  type PrefilteredHDRWithMIS,
  type EnvMapPDFCDF,
  type ProgressCallback,
} from './HDRLoader';

// Types
export type {
  // OBJ types
  Vertex3D,
  WireframeModel,
  // GLB types
  GLBModel,
  GLBMesh,
  GLBMaterial,
  GLBTexture,
  TextureType,
  TextureColorSpace,
  LoaderOptions,
} from './types';

// Scene Serializer
export {
  SceneSerializer,
  sceneSerializer,
  // Backward-compatible functions
  importModelFile,
  importGLTFDirectory,
  getModelUrl,
  isImportedModel,
  clearImportedModels,
  saveScene,
  parseCameraState,
  parseLightingState,
  parseGroupsState,
  // Types
  type ImportedModelData,
  type ImportResult,
  type CameraState,
  type SerializedLightingState,
  type GroupState,
  type SerializedWindState,
  type SerializedObjectWindSettings,
  type SerializedTerrainBlendSettings,
  type SerializedScene,
  type SaveableSceneObject,
  type SaveableGroup,
  type SaveSceneOptions,
} from './SceneSerializer';

// Helper functions
export {
  TEXTURE_COLOR_SPACES,
  needsGammaCorrection,
  getTextureType,
} from './types';
