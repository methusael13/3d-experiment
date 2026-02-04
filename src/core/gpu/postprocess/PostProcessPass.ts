/**
 * PostProcessPass - Base class for post-processing effects
 * 
 * Each effect implements this interface to be managed by PostProcessStack
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';

/**
 * Input textures available to post-process passes
 */
export interface PostProcessInputs {
  /** HDR scene color */
  color: UnifiedGPUTexture;
  /** Scene depth buffer */
  depth: UnifiedGPUTexture;
  /** View-space normals (optional, for SSAO) */
  normals?: UnifiedGPUTexture;
  /** Previous frame result (for temporal effects) */
  previousFrame?: UnifiedGPUTexture;
}

/**
 * Camera/view matrices for screen-space effects
 */
export interface PostProcessUniforms {
  /** Projection matrix */
  projectionMatrix: Float32Array;
  /** Inverse projection matrix */
  inverseProjectionMatrix: Float32Array;
  /** View matrix */
  viewMatrix: Float32Array;
  /** Inverse view matrix */
  inverseViewMatrix: Float32Array;
  /** Camera near plane */
  near: number;
  /** Camera far plane */
  far: number;
  /** Viewport width */
  width: number;
  /** Viewport height */
  height: number;
  /** Frame time delta */
  deltaTime: number;
  /** Total elapsed time */
  time: number;
}

/**
 * Abstract base class for post-processing effects
 */
export abstract class PostProcessPass {
  protected ctx: GPUContext;
  protected enabled: boolean = true;
  protected name: string;
  
  constructor(ctx: GPUContext, name: string) {
    this.ctx = ctx;
    this.name = name;
  }
  
  /**
   * Get the pass name (for debugging/UI)
   */
  getName(): string {
    return this.name;
  }
  
  /**
   * Enable/disable this pass
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  
  /**
   * Check if pass is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Called when viewport size changes
   * Override to resize intermediate textures
   */
  abstract resize(width: number, height: number): void;
  
  /**
   * Render the effect
   * @param encoder - Command encoder for recording commands
   * @param inputs - Input textures (color, depth, normals)
   * @param output - Output texture view to render to
   * @param uniforms - Camera and viewport uniforms
   */
  abstract render(
    encoder: GPUCommandEncoder,
    inputs: PostProcessInputs,
    output: GPUTextureView,
    uniforms: PostProcessUniforms
  ): void;
  
  /**
   * Clean up GPU resources
   */
  abstract destroy(): void;
}
