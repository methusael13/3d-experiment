/**
 * RenderPass - Interface for modular render passes
 * 
 * Each pass implements execute() to perform its rendering work.
 * Passes are executed in order by the pipeline.
 */

import type { RenderContext } from './RenderContext';

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
