/**
 * RenderPipeline Types
 * Shared interfaces for the rendering pipeline system
 */

import { mat4 } from 'gl-matrix';
import type { Vec3 } from '../../types';
import type { SceneLightingParams } from '../../sceneObjects/lights';
import type { WindParams, ObjectWindSettings, TerrainBlendParams, IRenderer, GPUMesh } from '../../sceneObjects/types';
import type { TerrainObject } from '../../sceneObjects';

/**
 * Settings for terrain blending per object
 */
export interface TerrainBlendSettings {
  enabled: boolean;
  blendDistance: number;
}

/**
 * Contact shadow configuration
 */
export interface ContactShadowSettings {
  enabled: boolean;
  maxDistance: number;
  thickness: number;
  steps: number;
  intensity: number;
}

/**
 * Object data prepared for rendering
 */
export interface RenderObject {
  id: string;
  modelMatrix: mat4;
  renderer: IRenderer | null;
  gpuMeshes: GPUMesh[];
  isSelected: boolean;
  windSettings: ObjectWindSettings | null;
  terrainBlendSettings: TerrainBlendSettings | null;
  showNormals?: boolean;
  /** Terrain object reference (for terrain type objects) */
  terrain?: TerrainObject;
}

/**
 * Shared context passed to all render passes
 * Contains per-frame data that doesn't change between objects
 */
export interface RenderContext {
  // WebGL context
  gl: WebGL2RenderingContext;
  
  // Camera matrices
  vpMatrix: mat4;
  viewMatrix: mat4;
  projMatrix: mat4;
  cameraPos: Vec3;
  nearPlane: number;
  farPlane: number;
  
  // Viewport dimensions
  width: number;
  height: number;
  
  // Lighting (from LightingManager)
  lightParams: SceneLightingParams;
  
  // Wind animation state
  windParams: WindParams;
  
  // Shared textures (populated by passes, consumed by others)
  textures: {
    depth: WebGLTexture | null;
    terrainDepth: WebGLTexture | null;
    shadowMap: WebGLTexture | null;
    lightSpaceMatrix: mat4 | null;
    contactShadow: WebGLTexture | null;
    hdr: WebGLTexture | null;
    sceneColor: WebGLTexture | null;  // For post-processing
  };
  
  // Render settings
  settings: {
    shadowEnabled: boolean;
    shadowResolution: number;
    contactShadowEnabled: boolean;
    contactShadowSettings: ContactShadowSettings;
    wireframeMode: boolean;
    showGrid: boolean;
    showAxes: boolean;
    fpsMode: boolean;
  };
  
  // Frame info
  deltaTime: number;
  time: number;
}

/**
 * Framebuffer pool for managing render targets
 */
export interface FramebufferPool {
  get(name: string): WebGLFramebuffer | null;
  getTexture(name: string): WebGLTexture | null;
  create(name: string, width: number, height: number, format: FramebufferFormat): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

/**
 * Framebuffer format specification
 */
export interface FramebufferFormat {
  colorFormat: number;  // e.g., gl.RGBA8
  depthFormat?: number; // e.g., gl.DEPTH_COMPONENT24
  samples?: number;     // MSAA samples
}

/**
 * Result of a render pass (for debugging/profiling)
 */
export interface PassResult {
  name: string;
  objectsRendered: number;
  timeMs: number;
}

/**
 * Pipeline configuration
 */
export interface PipelineConfig {
  width: number;
  height: number;
  shadowResolution?: number;
  enableContactShadows?: boolean;
  enableMSAA?: boolean;
  msaaSamples?: number;
}

/**
 * Camera interface for pipeline
 */
export interface PipelineCamera {
  getPosition(): Vec3;
  getViewMatrix(): mat4;
  getProjectionMatrix(): mat4;
  getViewProjectionMatrix(): mat4;
  near: number;
  far: number;
}
