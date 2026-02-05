/**
 * PostProcessPipeline - Plugin-based post-processing system
 * 
 * Manages a chain of post-processing effects with automatic buffer allocation.
 * Effects declare their inputs/outputs and the pipeline resolves dependencies.
 */

import { mat4 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { BufferPool } from './BufferPool';
import { FullscreenQuad } from './FullscreenQuad';

// ========== Types ==========

/**
 * Standard inputs available to all effects
 */
export type StandardInput = 'color' | 'depth';

/**
 * Uniforms available to post-processing effects
 */
export interface EffectUniforms {
  near: number;
  far: number;
  width: number;
  height: number;
  time: number;
  deltaTime: number;
  projectionMatrix: Float32Array;
  inverseProjectionMatrix: Float32Array;
  viewMatrix: Float32Array;
  inverseViewMatrix: Float32Array;
}

/**
 * Context provided to each effect during execution
 */
export interface EffectContext {
  ctx: GPUContext;
  encoder: GPUCommandEncoder;
  uniforms: EffectUniforms;
  fullscreenQuad: FullscreenQuad;
  
  /** Check if a texture exists by name (O(1) Map lookup) */
  hasTexture(name: StandardInput | string): boolean;
  
  /** Get a texture by name (standard inputs or effect outputs) */
  getTexture(name: StandardInput | string): UnifiedGPUTexture;
  
  /** Get the final output view (swap chain) */
  getOutputView(): GPUTextureView;
  
  /** Acquire an intermediate buffer from the pool */
  acquireBuffer(format: GPUTextureFormat, label?: string): UnifiedGPUTexture;
  
  /** Release a buffer back to the pool */
  releaseBuffer(texture: UnifiedGPUTexture): void;
}

/**
 * Interface for post-processing effects
 */
export interface PostProcessEffect {
  /** Unique name for this effect */
  readonly name: string;
  
  /** Whether the effect is currently enabled */
  enabled: boolean;
  
  /** 
   * List of input textures this effect needs
   * Can be standard inputs ('color', 'depth') or outputs from other effects
   */
  readonly inputs: (StandardInput | string)[];
  
  /**
   * List of output texture names this effect produces
   * Empty array means it outputs directly to final output
   */
  readonly outputs: string[];
  
  /**
   * Output format for each named output
   * Maps output name → texture format
   */
  readonly outputFormats: Map<string, GPUTextureFormat>;
  
  /** Initialize GPU resources */
  init(ctx: GPUContext, width: number, height: number): void;
  
  /** Resize effect resources */
  resize(width: number, height: number): void;
  
  /** Execute the effect */
  execute(ctx: EffectContext): void;
  
  /** Clean up GPU resources */
  destroy(): void;
}

/**
 * Base class for post-processing effects
 */
export abstract class BaseEffect implements PostProcessEffect {
  abstract readonly name: string;
  abstract readonly inputs: (StandardInput | string)[];
  abstract readonly outputs: string[];
  
  enabled = true;
  outputFormats: Map<string, GPUTextureFormat> = new Map();
  
  protected ctx!: GPUContext;
  protected width = 0;
  protected height = 0;
  
  init(ctx: GPUContext, width: number, height: number): void {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.onInit();
  }
  
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.onResize();
  }
  
  abstract execute(ctx: EffectContext): void;
  
  destroy(): void {
    this.onDestroy();
  }
  
  /** Override to initialize resources */
  protected onInit(): void {}
  
  /** Override to handle resize */
  protected onResize(): void {}
  
  /** Override to clean up resources */
  protected onDestroy(): void {}
}

// ========== Pipeline ==========

interface EffectEntry {
  effect: PostProcessEffect;
  order: number;
  outputTextures: Map<string, UnifiedGPUTexture>;
}

/**
 * PostProcessPipeline - Manages post-processing effects with automatic buffer management
 */
export class PostProcessPipeline {
  private ctx: GPUContext;
  private width: number;
  private height: number;
  
  private effects: Map<string, EffectEntry> = new Map();
  private executionOrder: PostProcessEffect[] = [];
  private needsReorder = false;
  
  private bufferPool: BufferPool;
  private fullscreenQuad: FullscreenQuad;
  
  // Named textures produced by effects
  private namedTextures: Map<string, UnifiedGPUTexture> = new Map();
  
  constructor(ctx: GPUContext, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    
    this.bufferPool = new BufferPool(ctx, width, height);
    this.fullscreenQuad = new FullscreenQuad(ctx);
  }
  
  /**
   * Add an effect to the pipeline
   */
  addEffect(effect: PostProcessEffect, order?: number): this {
    if (this.effects.has(effect.name)) {
      console.warn(`[PostProcessPipeline] Effect "${effect.name}" already exists, replacing`);
      this.removeEffect(effect.name);
    }
    
    // Initialize the effect
    effect.init(this.ctx, this.width, this.height);
    
    // Determine order (later order = later in chain)
    const effectOrder = order ?? this.effects.size * 100;
    
    // Allocate persistent textures for effect outputs
    const outputTextures = new Map<string, UnifiedGPUTexture>();
    for (const outputName of effect.outputs) {
      const format = effect.outputFormats.get(outputName) ?? 'rgba16float';
      const texture = UnifiedGPUTexture.create2D(this.ctx, {
        label: `effect-${effect.name}-${outputName}`,
        width: this.width,
        height: this.height,
        format,
        renderTarget: true,
        sampled: true,
      });
      outputTextures.set(outputName, texture);
      // Only expose outputs to namedTextures if effect is enabled
      if (effect.enabled) {
        this.namedTextures.set(outputName, texture);
      }
    }
    
    this.effects.set(effect.name, { effect, order: effectOrder, outputTextures });
    this.needsReorder = true;
    
    return this;
  }
  
  /**
   * Remove an effect from the pipeline
   */
  removeEffect(name: string): void {
    const entry = this.effects.get(name);
    if (!entry) return;
    
    // Clean up effect resources
    entry.effect.destroy();
    
    // Destroy output textures
    for (const [outputName, texture] of entry.outputTextures) {
      texture.destroy();
      this.namedTextures.delete(outputName);
    }
    
    this.effects.delete(name);
    this.needsReorder = true;
  }
  
  /**
   * Enable or disable an effect
   * Updates namedTextures immediately so downstream effects see correct state
   */
  setEnabled(name: string, enabled: boolean): void {
    const entry = this.effects.get(name);
    if (!entry || entry.effect.enabled === enabled) return;
    
    entry.effect.enabled = enabled;
    
    // Update namedTextures: expose outputs only when enabled
    for (const [outputName, texture] of entry.outputTextures) {
      if (enabled) {
        this.namedTextures.set(outputName, texture);
      } else {
        this.namedTextures.delete(outputName);
      }
    }
  }
  
  /**
   * Check if an effect is enabled
   */
  isEnabled(name: string): boolean {
    return this.effects.get(name)?.effect.enabled ?? false;
  }
  
  /**
   * Get an effect by name
   */
  getEffect<T extends PostProcessEffect>(name: string): T | null {
    return (this.effects.get(name)?.effect as T) ?? null;
  }
  
  /**
   * Check if pipeline has any enabled effects
   */
  hasEnabledEffects(): boolean {
    for (const entry of this.effects.values()) {
      if (entry.effect.enabled) return true;
    }
    return false;
  }
  
  /**
   * Resize all effects and buffers
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    
    this.width = width;
    this.height = height;
    
    this.bufferPool.resize(width, height);
    
    // Resize all effects and their output textures
    for (const entry of this.effects.values()) {
      entry.effect.resize(width, height);
      
      // Recreate output textures
      for (const [outputName, oldTexture] of entry.outputTextures) {
        oldTexture.destroy();
        
        const format = entry.effect.outputFormats.get(outputName) ?? 'rgba16float';
        const newTexture = UnifiedGPUTexture.create2D(this.ctx, {
          label: `effect-${entry.effect.name}-${outputName}`,
          width,
          height,
          format,
          renderTarget: true,
          sampled: true,
        });
        
        entry.outputTextures.set(outputName, newTexture);
        // Only expose to namedTextures if effect is enabled
        if (entry.effect.enabled) {
          this.namedTextures.set(outputName, newTexture);
        }
      }
    }
  }
  
  /**
   * Execute the post-processing pipeline
   */
  execute(
    encoder: GPUCommandEncoder,
    sceneColor: UnifiedGPUTexture,
    sceneDepth: UnifiedGPUTexture,
    finalOutput: GPUTextureView,
    uniforms: EffectUniforms
  ): void {
    // Recompute execution order if needed
    if (this.needsReorder) {
      this.computeExecutionOrder();
      this.needsReorder = false;
    }
    
    // Get enabled effects in order
    const enabledEffects = this.executionOrder.filter(e => e.enabled);
    
    if (enabledEffects.length === 0) {
      return;
    }
    
    // Store scene textures as named inputs
    this.namedTextures.set('color', sceneColor);
    this.namedTextures.set('depth', sceneDepth);
    
    // Track which effect outputs to the final view
    const lastEffect = enabledEffects[enabledEffects.length - 1];
    const lastEffectOutputsToFinal = lastEffect.outputs.length === 0;
    
    // Execute each effect
    for (let i = 0; i < enabledEffects.length; i++) {
      const effect = enabledEffects[i];
      const isLast = i === enabledEffects.length - 1;
      const outputsToFinal = isLast && lastEffectOutputsToFinal;
      
      // Create effect context
      const effectContext = this.createEffectContext(
        encoder,
        uniforms,
        finalOutput,
        outputsToFinal
      );
      
      effect.execute(effectContext);
    }
    
    // Release temporary buffers
    this.bufferPool.releaseAll();
  }
  
  /**
   * Create context for an effect execution
   */
  private createEffectContext(
    encoder: GPUCommandEncoder,
    uniforms: EffectUniforms,
    finalOutput: GPUTextureView,
    outputsToFinal: boolean
  ): EffectContext {
    return {
      ctx: this.ctx,
      encoder,
      uniforms,
      fullscreenQuad: this.fullscreenQuad,
      
      hasTexture: (name: StandardInput | string): boolean => {
        return this.namedTextures.has(name);
      },
      
      getTexture: (name: StandardInput | string): UnifiedGPUTexture => {
        const texture = this.namedTextures.get(name);
        if (!texture) {
          throw new Error(`[PostProcessPipeline] Texture "${name}" not found`);
        }
        return texture;
      },
      
      getOutputView: (): GPUTextureView => finalOutput,
      
      acquireBuffer: (format: GPUTextureFormat, label?: string): UnifiedGPUTexture => {
        return this.bufferPool.acquire(format, label);
      },
      
      releaseBuffer: (texture: UnifiedGPUTexture): void => {
        this.bufferPool.release(texture);
      },
    };
  }
  
  /**
   * Compute execution order based on dependencies
   */
  private computeExecutionOrder(): void {
    // Get all effects sorted by their declared order
    const sorted = Array.from(this.effects.values())
      .sort((a, b) => a.order - b.order)
      .map(e => e.effect);
    
    // TODO: Could add topological sort based on input/output dependencies
    // For now, just use declared order
    this.executionOrder = sorted;
  }
  
  /**
   * Clean up all resources
   */
  destroy(): void {
    for (const entry of this.effects.values()) {
      entry.effect.destroy();
      for (const texture of entry.outputTextures.values()) {
        texture.destroy();
      }
    }
    this.effects.clear();
    this.namedTextures.clear();
    this.executionOrder = [];
    
    this.bufferPool.destroy();
    this.fullscreenQuad.destroy();
  }
}
