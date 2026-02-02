/**
 * WebGPU Renderer Types
 * 
 * Common interfaces for GPU renderers to enable loose coupling.
 * Shadow-specific types are now defined in ShadowRendererGPU.ts
 */

import { vec3 } from 'gl-matrix';

/**
 * Axis-aligned bounding box for culling
 */
export interface BoundingBox {
  min: vec3;
  max: vec3;
}

/**
 * Interface for objects that can receive shadows
 */
export interface ShadowReceiver {
  /**
   * Enable/disable shadow receiving for this object
   */
  setShadowReceiving(enabled: boolean): void;
}
