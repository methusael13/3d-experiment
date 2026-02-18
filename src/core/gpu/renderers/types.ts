/**
 * WebGPU Renderer Types
 * 
 * Common interfaces for GPU renderers to enable loose coupling.
 */

import { mat4, vec3 } from 'gl-matrix';

/**
 * Axis-aligned bounding box for culling
 */
export interface BoundingBox {
  min: vec3;
  max: vec3;
}

/**
 * Interface for objects that can cast shadows.
 * 
 * Scene objects (terrain, primitives, models) implement this interface
 * to participate in shadow map rendering. The ShadowPass queries the
 * scene for shadow casters and calls renderDepthOnly on each.
 */
export interface ShadowCaster {
  /**
   * Whether this object can currently cast shadows.
   * Should return false if:
   * - Shadow casting is disabled for this object
   * - Geometry is not ready/valid
   * - Object is hidden
   */
  canCastShadows: boolean;
  
  /**
   * Pre-write all shadow uniforms for multiple passes (CSM cascades + single map).
   * Called ONCE before any renderDepthOnly calls in a frame.
   * 
   * Implementors should write all light-space matrices into a dynamic uniform buffer
   * so each renderDepthOnly call can select the correct slot via dynamic offset,
   * avoiding writeBuffer race conditions when multiple passes share a buffer.
   * 
   * Optional: if not implemented, renderDepthOnly receives lightSpaceMatrix directly
   * and must handle its own uniform updates (legacy behavior).
   * 
   * @param matrices - Array of { lightSpaceMatrix, lightPosition } for each slot
   */
  prepareShadowPasses?(
    matrices: { lightSpaceMatrix: mat4; lightPosition: vec3 }[]
  ): void;
  
  /**
   * Render this object's depth to the shadow map.
   * Called during shadow pass with the light space matrix.
   * 
   * The implementation should:
   * 1. Set its shadow pipeline/bind groups
   * 2. Draw geometry to the current pass encoder
   * 
   * @param passEncoder - Active shadow render pass
   * @param lightSpaceMatrix - Light view-projection matrix
   * @param lightPosition - Light world position (for LOD selection)
   * @param slotIndex - Index into pre-written uniform slots (from prepareShadowPasses)
   */
  renderDepthOnly(
    passEncoder: GPURenderPassEncoder,
    lightSpaceMatrix: mat4,
    lightPosition: vec3,
    slotIndex: number
  ): void;
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
