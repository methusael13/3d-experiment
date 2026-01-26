import { mat4, vec3 } from 'gl-matrix';
import type { SceneLightingParams } from '../sceneObjects/lights';

/**
 * Axis-Aligned Bounding Box
 */
export interface AABB {
  min: vec3;
  max: vec3;
}

/**
 * Raw geometry data returned by primitive generators
 */
export interface GeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

/**
 * PBR Material properties
 */
export interface PBRMaterial {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
}

/**
 * Primitive geometry configuration
 */
export interface PrimitiveConfig {
  size?: number;
  subdivision?: number;
}

/**
 * Primitive types supported
 */
export type PrimitiveType = 'cube' | 'plane' | 'sphere';

/**
 * GPU Mesh data reference (for shadow rendering, etc.)
 */
export interface GPUMesh {
  posBuffer: WebGLBuffer;
  uvBuffer?: WebGLBuffer | null;
  normalBuffer: WebGLBuffer | null;
  tangentBuffer?: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  indexCount: number;
  indexType: 5123 | 5125; // gl.UNSIGNED_SHORT | gl.UNSIGNED_INT
  vertexCount: number;
  materialIndex: number;
}

/**
 * Light parameters passed to shaders
 * @deprecated Use SceneLightingParams from lightingManager instead
 */
export type LightParams = SceneLightingParams;

/**
 * Wind parameters for vegetation
 */
export interface WindParams {
  enabled: boolean;
  time: number;
  strength: number;
  direction: [number, number];
  turbulence: number;
  debug?: number;
}

/**
 * Per-object wind settings
 */
export interface ObjectWindSettings {
  enabled: boolean;
  influence: number;
  stiffness: number;
  anchorHeight: number;
  leafMaterialIndices?: Set<number>;
  branchMaterialIndices?: Set<number>;
  displacement?: [number, number];
}

/**
 * Terrain blend parameters
 */
export interface TerrainBlendParams {
  enabled: boolean;
  blendDistance?: number;
  depthTexture?: WebGLTexture | null;
  screenSize?: [number, number];
  nearPlane?: number;
  farPlane?: number;
}

/**
 * Interface that all renderers must implement
 */
export interface IRenderer {
  /** GPU mesh data for shadow/depth passes */
  gpuMeshes: GPUMesh[];
  
  /** Whether the renderer has been destroyed */
  readonly isDestroyed: boolean;
  
  /**
   * Render the object
   */
  render(
    vpMatrix: mat4,
    modelMatrix: mat4,
    isSelected: boolean,
    wireframeMode?: boolean,
    lightParams?: LightParams | null,
    windParams?: WindParams | null,
    objectWindSettings?: ObjectWindSettings | null,
    terrainBlendParams?: TerrainBlendParams | null
  ): void;
  
  /**
   * Clean up GPU resources
   */
  destroy(): void;
}

/**
 * Primitive-specific renderer interface
 */
export interface IPrimitiveRenderer extends IRenderer {
  /**
   * Update geometry when config changes (legacy)
   */
  updateGeometry(config: PrimitiveConfig): void;
  
  /**
   * Update geometry from raw geometry data
   */
  updateGeometryData(geometry: GeometryData): void;
  
  /**
   * Get current bounding box
   */
  getBounds(): AABB;
  
  /**
   * Set PBR material properties
   */
  setMaterial(material: Partial<PBRMaterial>): void;
  
  /**
   * Get current PBR material properties
   */
  getMaterial(): PBRMaterial;
  
  /**
   * Render vertex normal lines for debugging
   */
  renderNormals(vpMatrix: mat4, modelMatrix: mat4): void;
}

/**
 * Serialized scene object data (for save/load)
 */
export interface SerializedSceneObject {
  id?: string;
  name: string;
  position: [number, number, number];
  /** Euler rotation in degrees (backward compatibility) */
  rotation: [number, number, number];
  /** Quaternion rotation (primary storage, new format) */
  rotationQuat?: [number, number, number, number];
  scale: [number, number, number];
  visible?: boolean;
  groupId?: string | null;
}

/**
 * Serialized primitive object data
 */
export interface SerializedPrimitiveObject extends SerializedSceneObject {
  type: 'primitive';
  primitiveType: PrimitiveType;
  primitiveConfig: PrimitiveConfig;
  material: PBRMaterial;
}

/**
 * Serialized model object data
 */
export interface SerializedModelObject extends SerializedSceneObject {
  type?: 'model';
  modelPath: string;
}

/**
 * Serialized light data
 */
export interface SerializedLight extends SerializedSceneObject {
  type: string;
  enabled: boolean;
  intensity: number;
  color: [number, number, number];
  castsShadow: boolean;
}

/**
 * Shadow renderer interface for off-screen shadow map generation
 */
export interface IShadowRenderer {
  /** Get the shadow map texture */
  getTexture(): WebGLTexture | null;
  
  /** Get the light space matrix for shadow lookup */
  getLightSpaceMatrix(): mat4;
  
  /** Get current shadow map resolution */
  getResolution(): number;
  
  /** Change shadow map resolution */
  setResolution(res: number): void;
  
  /** Begin shadow pass - bind framebuffer and calculate light matrix */
  beginShadowPass(sunDir: vec3, sceneSize?: number): void;
  
  /** Render an object to the shadow map */
  renderObject(
    gpuMeshes: GPUMesh[],
    modelMatrix: mat4,
    windParams?: WindParams | null,
    objectWindSettings?: ObjectWindSettings | null
  ): void;
  
  /** End shadow pass - restore state */
  endShadowPass(canvasWidth: number, canvasHeight: number): void;
  
  /** Render debug thumbnail of shadow map */
  renderDebugThumbnail(
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number
  ): void;
  
  /** Clean up GPU resources */
  destroy(): void;
}

/**
 * Depth pre-pass renderer interface for terrain blend
 */
export interface IDepthPrePassRenderer {
  /** Get depth texture for sampling in main pass */
  getDepthTexture(): WebGLTexture | null;
  
  /** Resize framebuffer if canvas size changed */
  resize(width: number, height: number): void;
  
  /** Begin depth pre-pass */
  beginPass(vpMatrix: mat4): void;
  
  /** Render an object to the depth buffer */
  renderObject(
    gpuMeshes: GPUMesh[],
    vpMatrix: mat4,
    modelMatrix: mat4,
    windParams?: WindParams | null,
    objectWindSettings?: ObjectWindSettings | null,
    isTerrainBlendTarget?: boolean
  ): void;
  
  /** End depth pre-pass */
  endPass(canvasWidth: number, canvasHeight: number): void;
  
  /** Clean up GPU resources */
  destroy(): void;
}
