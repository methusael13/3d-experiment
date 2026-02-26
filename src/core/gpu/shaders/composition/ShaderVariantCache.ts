import type { GPUContext } from '../../GPUContext';
import type { ComposedShader } from './types';
import { ShaderComposer } from './ShaderComposer';

/**
 * Cached shader variant entry.
 */
export interface ShaderVariantEntry {
  /** The composed shader metadata (WGSL, layouts, feature list) */
  composed: ComposedShader;

  /** The compiled GPU shader module */
  shaderModule: GPUShaderModule;
}

/**
 * Caches compiled GPU shader modules by feature key.
 * A feature key is a sorted, '+'-joined list of active features
 * (e.g., "ibl+shadow+textured+wind").
 *
 * Variants are created lazily on first use and cached indefinitely.
 * Call invalidate() if a shader module source changes during development.
 */
export class ShaderVariantCache {
  private cache = new Map<string, ShaderVariantEntry>();
  private composer: ShaderComposer;

  constructor(composer?: ShaderComposer) {
    this.composer = composer ?? new ShaderComposer();
  }

  /**
   * Get a cached variant or compose + compile a new one.
   *
   * @param featureIds - Feature IDs for this variant (e.g., ['shadow', 'ibl', 'textured'])
   * @param ctx - GPUContext for shader module compilation
   * @returns The cached or newly created variant entry
   */
  getOrCreate(featureIds: string[], ctx: GPUContext): ShaderVariantEntry {
    const key = this.composer.buildFeatureKey(featureIds);

    const cached = this.cache.get(key);
    if (cached) return cached;

    // Compose the shader
    const composed = this.composer.compose(featureIds);

    // Compile to GPU shader module
    const shaderModule = ctx.createShaderModule(
      composed.wgsl,
      `object-variant-${key}`,
    );

    const entry: ShaderVariantEntry = { composed, shaderModule };
    this.cache.set(key, entry);

    return entry;
  }

  /**
   * Check if a variant is already cached.
   */
  has(featureIds: string[]): boolean {
    const key = this.composer.buildFeatureKey(featureIds);
    return this.cache.has(key);
  }

  /**
   * Invalidate a specific variant or all variants.
   *
   * @param featureKey - If provided, invalidate only this key. Otherwise invalidate all.
   */
  invalidate(featureKey?: string): void {
    if (featureKey) {
      this.cache.delete(featureKey);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): { totalVariants: number; keys: string[] } {
    return {
      totalVariants: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Get the underlying composer (for direct composition without caching).
   */
  getComposer(): ShaderComposer {
    return this.composer;
  }

  /**
   * Destroy all cached entries.
   */
  destroy(): void {
    this.cache.clear();
  }
}