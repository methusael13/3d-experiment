/**
 * RenderPass - Base interface and abstract class for rendering passes
 */

import type { RenderContext, RenderObject, PassResult } from './types';

/**
 * Interface for a single render pass
 * Each pass performs one rendering operation (shadow, depth, color, post-process, etc.)
 */
export interface IRenderPass {
  /** Unique name for this pass */
  readonly name: string;
  
  /** Whether this pass is currently enabled */
  enabled: boolean;
  
  /** Priority for pass ordering (lower = earlier) */
  readonly priority: number;
  
  /**
   * Execute the render pass
   * @param context Shared render context with camera, lighting, settings
   * @param objects Objects to potentially render (pass may filter or ignore)
   * @returns Optional result for debugging/profiling
   */
  execute(context: RenderContext, objects: RenderObject[]): PassResult | void;
  
  /**
   * Called when viewport resizes
   * @param width New width in pixels
   * @param height New height in pixels
   */
  resize?(width: number, height: number): void;
  
  /**
   * Cleanup GPU resources
   */
  destroy?(): void;
}

/**
 * Pass priority constants
 * Defines the order in which passes execute
 */
export const PassPriority = {
  SHADOW: 100,          // Shadow map generation
  DEPTH_PREPASS: 200,   // Depth pre-pass for optimizations
  SKY: 300,             // Sky/environment background
  OPAQUE: 400,          // Main opaque geometry
  TRANSPARENT: 500,     // Transparent objects (sorted back-to-front)
  POST_PROCESS: 600,    // Contact shadows, bloom, etc.
  OVERLAY: 700,         // Grid, axes, gizmos
  UI: 800,              // Debug overlays, thumbnails
} as const;

/**
 * Abstract base class for render passes
 * Provides common functionality and default implementations
 */
export abstract class RenderPass implements IRenderPass {
  readonly name: string;
  enabled: boolean = true;
  readonly priority: number;
  
  protected gl: WebGL2RenderingContext;
  
  constructor(gl: WebGL2RenderingContext, name: string, priority: number) {
    this.gl = gl;
    this.name = name;
    this.priority = priority;
  }
  
  /**
   * Execute the render pass - must be implemented by subclasses
   */
  abstract execute(context: RenderContext, objects: RenderObject[]): PassResult | void;
  
  /**
   * Resize handler - override if pass has size-dependent resources
   */
  resize(width: number, height: number): void {
    // Default: no-op
  }
  
  /**
   * Cleanup - override to release GPU resources
   */
  destroy(): void {
    // Default: no-op
  }
  
  /**
   * Helper: Set viewport to full render target
   */
  protected setFullViewport(context: RenderContext): void {
    this.gl.viewport(0, 0, context.width, context.height);
  }
  
  /**
   * Helper: Bind framebuffer (null for default/screen)
   */
  protected bindFramebuffer(fbo: WebGLFramebuffer | null): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo);
  }
  
  /**
   * Helper: Clear color and depth
   */
  protected clear(color = true, depth = true): void {
    let mask = 0;
    if (color) mask |= this.gl.COLOR_BUFFER_BIT;
    if (depth) mask |= this.gl.DEPTH_BUFFER_BIT;
    if (mask) this.gl.clear(mask);
  }
  
  /**
   * Helper: Enable/disable depth testing
   */
  protected setDepthTest(enabled: boolean, write = true): void {
    const gl = this.gl;
    if (enabled) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(write);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
  }
  
  /**
   * Helper: Set culling mode
   */
  protected setCulling(mode: 'back' | 'front' | 'none'): void {
    const gl = this.gl;
    if (mode === 'none') {
      gl.disable(gl.CULL_FACE);
    } else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(mode === 'back' ? gl.BACK : gl.FRONT);
    }
  }
  
  /**
   * Helper: Set blending
   */
  protected setBlending(enabled: boolean, mode: 'alpha' | 'additive' = 'alpha'): void {
    const gl = this.gl;
    if (enabled) {
      gl.enable(gl.BLEND);
      if (mode === 'alpha') {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.blendFunc(gl.ONE, gl.ONE);
      }
    } else {
      gl.disable(gl.BLEND);
    }
  }
  
  /**
   * Helper: Unbind textures to prevent feedback loops
   */
  protected unbindTextures(count: number): void {
    const gl = this.gl;
    for (let i = 0; i < count; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}
