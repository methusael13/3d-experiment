/**
 * Scene Objects - OOP hierarchy for all scene entities
 * 
 * Class Hierarchy:
 * 
 * SceneObject (abstract base)
 * ├── RenderableObject (abstract, adds rendering)
 * │   ├── PrimitiveObject (cube, plane, sphere)
 * │   └── ModelObject (GLB/GLTF models)
 * ├── CameraObject
 * └── Light (abstract)
 *     ├── DirectionalLight (sun)
 *     ├── PointLight
 *     └── HDRLight (IBL environment)
 */

// Types and interfaces
export * from './types';

// Base classes
export { SceneObject } from './SceneObject';
export { RenderableObject } from './RenderableObject';

// Concrete scene objects
export { ModelObject, type GLBModel } from './ModelObject';
export { CameraObject, type ProjectionMode, type SerializedCameraObject, type CameraState } from './CameraObject';

// Lights (explicit exports to avoid conflicts with ./types)
export { 
  Light, 
  type LightType, 
  type BaseLightParams, 
  type RGBColor,
  DirectionalLight,
  type SerializedDirectionalLight,
  type DirectionalLightParams,
  PointLight,
  type SerializedPointLight,
  type PointLightParams,
  HDRLight,
  type SerializedHDRLight,
  type HDRLightParams,
  type AnyLightParams,
  // From lights/types.ts - exclude LightParams to avoid conflict
  TONE_MAPPING,
  type ToneMappingMode,
  TONE_MAPPING_NAMES,
  type ShadowParams,
  type SceneLightingParams,
} from './lights';

// Primitive classes
export { Cube, Plane, UVSphere, createPrimitive, createPrimitiveFromSerialized } from './primitives';

// Terrain
export { 
  TerrainObject, 
  type TerrainGenerationProgress, 
  type TerrainProgressCallback,
  type TerrainMeshData,
} from './TerrainObject';

// Type-only imports for union definitions (avoids circular dependency at runtime)
// Using 'import type' ensures these are erased at runtime and only used for TypeScript types
import type { Cube } from './primitives/Cube';
import type { Plane } from './primitives/Plane';
import type { UVSphere } from './primitives/UVSphere';
import type { ModelObject } from './ModelObject';
import type { PrimitiveObject } from './PrimitiveObject';
import type { SceneObject } from './SceneObject';
import type { TerrainObject } from './TerrainObject';

// RenderableObject needs a runtime import for instanceof check in type guard
// This is safe because RenderableObject only imports from SceneObject (no circular deps)
import { RenderableObject as RenderableObjectClass } from './RenderableObject';

/**
 * Union of all concrete primitive types
 */
export type AnyPrimitive = Cube | Plane | UVSphere;

/**
 * Union of all renderable scene objects (objects that can be rendered)
 */
export type RenderableSceneObject = AnyPrimitive | ModelObject | TerrainObject;

/**
 * Union of ALL scene object types that can be stored in a Scene
 * Extensible - add more types as needed (e.g., lights when they become selectable)
 */
export type AnySceneObject = RenderableSceneObject;

// ============================================================================
// Type Guards - Runtime type discrimination using objectType/primitiveType
// ============================================================================

/**
 * Check if object is any primitive type
 */
export function isPrimitiveObject(obj: SceneObject): obj is AnyPrimitive {
  return obj.objectType === 'primitive';
}

/**
 * Check if object is a ModelObject
 */
export function isModelObject(obj: SceneObject): obj is ModelObject {
  return obj.objectType === 'model';
}

/**
 * Check if object is a RenderableObject (has render capabilities)
 */
export function isRenderableObject(obj: SceneObject): obj is RenderableSceneObject {
  return obj instanceof RenderableObjectClass;
}

/**
 * Check if object is a Cube primitive
 */
export function isCube(obj: SceneObject): obj is Cube {
  return obj.objectType === 'primitive' && (obj as PrimitiveObject).primitiveType === 'cube';
}

/**
 * Check if object is a Plane primitive
 */
export function isPlane(obj: SceneObject): obj is Plane {
  return obj.objectType === 'primitive' && (obj as PrimitiveObject).primitiveType === 'plane';
}

/**
 * Check if object is a UVSphere primitive
 */
export function isUVSphere(obj: SceneObject): obj is UVSphere {
  return obj.objectType === 'primitive' && (obj as PrimitiveObject).primitiveType === 'sphere';
}

/**
 * Check if object is a TerrainObject
 */
export function isTerrainObject(obj: SceneObject): obj is TerrainObject {
  return obj.objectType === 'terrain';
}
