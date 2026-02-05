/**
 * BufferPool - Efficient texture management for post-processing
 * 
 * Maintains a pool of reusable GPU textures organized by format.
 * Textures are acquired for a frame, used by effects, then released back.
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';

interface PooledTexture {
  texture: UnifiedGPUTexture;
  inUse: boolean;
}

interface FormatPool {
  textures: PooledTexture[];
}

/**
 * BufferPool manages reusable intermediate textures for post-processing
 */
export class BufferPool {
  private ctx: GPUContext;
  private width: number;
  private height: number;
  private pools: Map<GPUTextureFormat, FormatPool> = new Map();
  
  constructor(ctx: GPUContext, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }
  
  /**
   * Acquire a texture from the pool
   * Creates a new one if none available
   */
  acquire(format: GPUTextureFormat, label?: string): UnifiedGPUTexture {
    let pool = this.pools.get(format);
    
    if (!pool) {
      pool = { textures: [] };
      this.pools.set(format, pool);
    }
    
    // Find an available texture
    for (const pooled of pool.textures) {
      if (!pooled.inUse) {
        pooled.inUse = true;
        return pooled.texture;
      }
    }
    
    // Create a new texture
    const texture = this.createTexture(format, label ?? `pool-${format}-${pool.textures.length}`);
    pool.textures.push({ texture, inUse: true });
    
    return texture;
  }
  
  /**
   * Release a texture back to the pool
   */
  release(texture: UnifiedGPUTexture): void {
    for (const pool of this.pools.values()) {
      for (const pooled of pool.textures) {
        if (pooled.texture === texture) {
          pooled.inUse = false;
          return;
        }
      }
    }
  }
  
  /**
   * Release all textures (call at end of frame)
   */
  releaseAll(): void {
    for (const pool of this.pools.values()) {
      for (const pooled of pool.textures) {
        pooled.inUse = false;
      }
    }
  }
  
  /**
   * Resize all pooled textures
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    
    this.width = width;
    this.height = height;
    
    // Destroy and recreate all textures
    for (const [format, pool] of this.pools) {
      for (const pooled of pool.textures) {
        pooled.texture.destroy();
      }
      
      // Recreate textures at new size
      pool.textures = pool.textures.map((pooled, i) => ({
        texture: this.createTexture(format, `pool-${format}-${i}`),
        inUse: false,
      }));
    }
  }
  
  /**
   * Create a texture for the pool
   */
  private createTexture(format: GPUTextureFormat, label: string): UnifiedGPUTexture {
    // Determine usage based on format
    const isDepth = format.includes('depth');
    
    if (isDepth) {
      return UnifiedGPUTexture.createDepth(
        this.ctx,
        this.width,
        this.height,
        format as 'depth24plus' | 'depth32float',
        label
      );
    }
    
    return UnifiedGPUTexture.create2D(this.ctx, {
      label,
      width: this.width,
      height: this.height,
      format,
      renderTarget: true,
      sampled: true,
    });
  }
  
  /**
   * Clean up all resources
   */
  destroy(): void {
    for (const pool of this.pools.values()) {
      for (const pooled of pool.textures) {
        pooled.texture.destroy();
      }
    }
    this.pools.clear();
  }
  
  /**
   * Get statistics about pool usage
   */
  getStats(): { format: GPUTextureFormat; total: number; inUse: number }[] {
    const stats: { format: GPUTextureFormat; total: number; inUse: number }[] = [];
    
    for (const [format, pool] of this.pools) {
      stats.push({
        format,
        total: pool.textures.length,
        inUse: pool.textures.filter(p => p.inUse).length,
      });
    }
    
    return stats;
  }
}
