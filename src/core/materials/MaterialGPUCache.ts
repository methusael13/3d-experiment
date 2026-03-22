/**
 * MaterialGPUCache - Shared texture loading with reference counting
 * 
 * Loads textures from asset paths and caches them for reuse across
 * multiple material previews. Uses reference counting so textures
 * are released when no longer needed.
 * 
 * Used by MaterialPreviewRenderer to load textures referenced by
 * PBR node connections (albedo, normal, roughness, etc.).
 */

import { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUTexture } from '../gpu/GPUTexture';
import { loadTextureFromURL, type TextureLoadResult } from '../gpu/TextureLoader';

// ============================================================================
// Types
// ============================================================================

interface CachedTexture {
  texture: UnifiedGPUTexture;
  width: number;
  height: number;
  refCount: number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Reference-counted GPU texture cache for material preview.
 * 
 * Usage:
 *   const cache = getMaterialGPUCache();
 *   await cache.init(gpuContext);
 *   const tex = await cache.acquire('/textures/albedo.png');
 *   // ... use tex.texture, tex.view ...
 *   cache.release('/textures/albedo.png');
 */
class MaterialGPUCacheImpl {
  private ctx: GPUContext | null = null;
  private cache: Map<string, CachedTexture> = new Map();
  private loading: Map<string, Promise<CachedTexture>> = new Map();
  private _placeholder: UnifiedGPUTexture | null = null;

  /**
   * Initialize with a GPU context. Must be called before acquire().
   */
  init(ctx: GPUContext): void {
    this.ctx = ctx;
  }

  /**
   * Get (or create) a 1×1 white placeholder texture.
   * Used when a texture slot has no connected source.
   */
  get placeholder(): UnifiedGPUTexture {
    if (!this.ctx) throw new Error('[MaterialGPUCache] Not initialized');
    
    if (!this._placeholder) {
      const tex = this.ctx.device.createTexture({
        label: 'material-cache-white-1x1',
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.ctx.queue.writeTexture(
        { texture: tex },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
      this._placeholder = {
        texture: tex,
        view: tex.createView(),
        format: 'rgba8unorm',
        width: 1,
        height: 1,
        destroy: () => tex.destroy(),
      } as UnifiedGPUTexture;
    }
    
    return this._placeholder;
  }

  /**
   * Get a 1×1 flat normal placeholder (128, 128, 255, 255).
   */
  private _normalPlaceholder: UnifiedGPUTexture | null = null;
  get normalPlaceholder(): UnifiedGPUTexture {
    if (!this.ctx) throw new Error('[MaterialGPUCache] Not initialized');
    
    if (!this._normalPlaceholder) {
      const tex = this.ctx.device.createTexture({
        label: 'material-cache-normal-1x1',
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.ctx.queue.writeTexture(
        { texture: tex },
        new Uint8Array([128, 128, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
      this._normalPlaceholder = {
        texture: tex,
        view: tex.createView(),
        format: 'rgba8unorm',
        width: 1,
        height: 1,
        destroy: () => tex.destroy(),
      } as UnifiedGPUTexture;
    }
    
    return this._normalPlaceholder;
  }

  /**
   * Acquire a texture by asset path. Increments reference count.
   * Returns the cached texture or loads it from the URL.
   * 
   * @param path Asset path (e.g., 'public/textures/terrain/albedo.png')
   * @returns The cached texture entry
   */
  async acquire(path: string): Promise<CachedTexture> {
    if (!this.ctx) throw new Error('[MaterialGPUCache] Not initialized');
    
    // Already cached — increment ref
    const existing = this.cache.get(path);
    if (existing) {
      existing.refCount++;
      return existing;
    }
    
    // Already loading — wait and increment ref
    const pending = this.loading.get(path);
    if (pending) {
      const entry = await pending;
      entry.refCount++;
      return entry;
    }
    
    // Load new texture
    const loadPromise = this.loadTexture(path);
    this.loading.set(path, loadPromise);
    
    try {
      const entry = await loadPromise;
      this.cache.set(path, entry);
      return entry;
    } finally {
      this.loading.delete(path);
    }
  }

  /**
   * Release a texture reference. Destroys the GPU texture when refCount hits 0.
   */
  release(path: string): void {
    const entry = this.cache.get(path);
    if (!entry) return;
    
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.texture.destroy();
      this.cache.delete(path);
    }
  }

  /**
   * Check if a path is currently cached.
   */
  has(path: string): boolean {
    return this.cache.has(path);
  }

  /**
   * Get a cached texture without incrementing refCount (peek).
   */
  peek(path: string): CachedTexture | undefined {
    return this.cache.get(path);
  }

  /**
   * Internal: load a texture from a URL path.
   */
  private async loadTexture(path: string): Promise<CachedTexture> {
    // Normalize path: ensure it starts with / for fetch
    const url = path.startsWith('/') ? path : `/${path}`;
    
    try {
      const result: TextureLoadResult = await loadTextureFromURL(this.ctx!, url, {
        label: `mat-cache:${path}`,
        generateMipmaps: true,
      });
      
      return {
        texture: result.texture,
        width: result.width,
        height: result.height,
        refCount: 1,
      };
    } catch (err) {
      console.warn(`[MaterialGPUCache] Failed to load texture: ${path}`, err);
      // Return placeholder on failure
      return {
        texture: this.placeholder,
        width: 1,
        height: 1,
        refCount: 1,
      };
    }
  }

  /**
   * Destroy all cached textures and reset.
   */
  destroy(): void {
    for (const entry of this.cache.values()) {
      entry.texture.destroy();
    }
    this.cache.clear();
    this.loading.clear();
    this._placeholder?.destroy();
    this._placeholder = null;
    this._normalPlaceholder?.destroy();
    this._normalPlaceholder = null;
    this.ctx = null;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: MaterialGPUCacheImpl | null = null;

/**
 * Get the global MaterialGPUCache singleton.
 */
export function getMaterialGPUCache(): MaterialGPUCacheImpl {
  if (!instance) {
    instance = new MaterialGPUCacheImpl();
  }
  return instance;
}

export type MaterialGPUCache = MaterialGPUCacheImpl;
