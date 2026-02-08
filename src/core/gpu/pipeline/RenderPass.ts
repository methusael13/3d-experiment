/**
 * RenderPass - Interface for modular render passes
 * 
 * Each pass implements execute() to perform its rendering work.
 * Passes are executed in order by the pipeline.
 * 
 * Pass Categories:
 * - 'scene': Renders to HDR buffer, goes through post-processing (terrain, objects, sky, water)
 * - 'viewport': Renders directly to final backbuffer AFTER post-processing (gizmos, grid, debug)
 */

import type { RenderContext } from './RenderContext';

/**
 * Pass category determines when the pass executes relative to post-processing
 * - 'scene': Before post-processing (HDR buffer)
 * - 'viewport': After post-processing (final backbuffer)
 */
export type PassCategory = 'scene' | 'viewport';

/**
 * Base interface for all render passes
 */
export interface RenderPass {
  /** Unique name for debugging */
  readonly name: string;
  
  /** Whether this pass is currently enabled */
  enabled: boolean;
  
  /** Priority for sorting (lower = earlier) */
  readonly priority: number;
  
  /** 
   * Pass category: 'scene' for HDR rendering, 'viewport' for post-PP overlays
   * Default is 'scene' for backwards compatibility
   */
  readonly category: PassCategory;
  
  /** Execute the render pass */
  execute(ctx: RenderContext): void;
  
  /** Optional cleanup */
  destroy?(): void;
}

/**
 * Abstract base class for render passes
 */
export abstract class BaseRenderPass implements RenderPass {
  abstract readonly name: string;
  abstract readonly priority: number;
  readonly category: PassCategory = 'scene'; // Default to scene
  enabled = true;
  
  abstract execute(ctx: RenderContext): void;
  
  destroy(): void {
    // Override in subclasses if needed
  }
}

/**
 * Pass priorities (execution order)
 */
export const PassPriority = {
  SHADOW: 100,
  SKY: 200,
  OPAQUE: 300,
  TRANSPARENT: 400,
  OVERLAY: 500,
  DEBUG: 600,
  POST_PROCESS: 700,
} as const;
