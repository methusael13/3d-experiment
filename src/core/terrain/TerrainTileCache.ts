/**
 * TerrainTileCache - LRU cache for terrain tiles
 * 
 * Manages GPU textures for terrain heightmaps and normal maps
 * with automatic eviction when capacity is reached.
 */

import { GPUContext, UnifiedGPUTexture } from '../gpu';

/**
 * Terrain tile key - identifies a unique tile
 */
export interface TileKey {
  /** World X coordinate (center) */
  x: number;
  /** World Z coordinate (center) */
  z: number;
  /** LOD level (0 = finest) */
  lod: number;
}

/**
 * Terrain tile data stored in cache
 */
export interface TileData {
  /** Heightmap texture (r32float) */
  heightmap: UnifiedGPUTexture;
  /** Normal map texture (rgba8snorm) */
  normalMap: UnifiedGPUTexture;
  /** When this tile was last accessed */
  lastAccessed: number;
  /** Whether this tile is still being generated */
  generating: boolean;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Current number of tiles in cache */
  size: number;
  /** Maximum cache capacity */
  capacity: number;
  /** Cache hits */
  hits: number;
  /** Cache misses */
  misses: number;
  /** Total evictions */
  evictions: number;
}

/**
 * Convert tile key to string for map lookup
 */
function keyToString(key: TileKey): string {
  return `${key.x}_${key.z}_${key.lod}`;
}

/**
 * TerrainTileCache - LRU cache for terrain tiles
 */
export class TerrainTileCache {
  private ctx: GPUContext;
  private tiles: Map<string, TileData> = new Map();
  private capacity: number;
  private tileResolution: number;
  
  // Statistics
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  
  // Callbacks
  private onEvict?: (key: TileKey, data: TileData) => void;
  
  /**
   * Create a terrain tile cache
   * @param ctx GPU context
   * @param capacity Maximum number of tiles to store
   * @param tileResolution Resolution of each tile (e.g., 256, 512)
   */
  constructor(
    ctx: GPUContext,
    capacity = 64,
    tileResolution = 256
  ) {
    this.ctx = ctx;
    this.capacity = capacity;
    this.tileResolution = tileResolution;
  }
  
  /**
   * Get a tile from the cache
   * @returns The tile data, or undefined if not in cache
   */
  get(key: TileKey): TileData | undefined {
    const keyStr = keyToString(key);
    const tile = this.tiles.get(keyStr);
    
    if (tile) {
      this.hits++;
      tile.lastAccessed = performance.now();
      return tile;
    }
    
    this.misses++;
    return undefined;
  }
  
  /**
   * Check if a tile exists in the cache
   */
  has(key: TileKey): boolean {
    return this.tiles.has(keyToString(key));
  }
  
  /**
   * Set a tile in the cache
   * This will evict the least recently used tile if at capacity
   */
  set(key: TileKey, heightmap: UnifiedGPUTexture, normalMap: UnifiedGPUTexture): void {
    const keyStr = keyToString(key);
    
    // If tile already exists, update it
    if (this.tiles.has(keyStr)) {
      const existing = this.tiles.get(keyStr)!;
      existing.heightmap.destroy();
      existing.normalMap.destroy();
      existing.heightmap = heightmap;
      existing.normalMap = normalMap;
      existing.lastAccessed = performance.now();
      existing.generating = false;
      return;
    }
    
    // Evict if at capacity
    if (this.tiles.size >= this.capacity) {
      this.evictLRU();
    }
    
    // Add new tile
    this.tiles.set(keyStr, {
      heightmap,
      normalMap,
      lastAccessed: performance.now(),
      generating: false,
    });
  }
  
  /**
   * Reserve a slot for a tile being generated
   * Prevents duplicate generation requests
   */
  reserve(key: TileKey): boolean {
    const keyStr = keyToString(key);
    
    // Already reserved or exists
    if (this.tiles.has(keyStr)) {
      return false;
    }
    
    // Evict if at capacity
    if (this.tiles.size >= this.capacity) {
      this.evictLRU();
    }
    
    // Create placeholder textures
    const heightmap = UnifiedGPUTexture.createHeightmap(
      this.ctx,
      this.tileResolution,
      this.tileResolution,
      `tile-heightmap-${keyStr}`
    );
    
    const normalMap = UnifiedGPUTexture.create2D(this.ctx, {
      label: `tile-normalmap-${keyStr}`,
      width: this.tileResolution,
      height: this.tileResolution,
      format: 'rgba8snorm',
    });
    
    this.tiles.set(keyStr, {
      heightmap,
      normalMap,
      lastAccessed: performance.now(),
      generating: true,
    });
    
    return true;
  }
  
  /**
   * Mark a reserved tile as complete
   */
  complete(key: TileKey, heightmap: UnifiedGPUTexture, normalMap: UnifiedGPUTexture): void {
    const keyStr = keyToString(key);
    const tile = this.tiles.get(keyStr);
    
    if (tile) {
      // Destroy placeholder textures
      tile.heightmap.destroy();
      tile.normalMap.destroy();
      // Replace with actual data
      tile.heightmap = heightmap;
      tile.normalMap = normalMap;
      tile.lastAccessed = performance.now();
      tile.generating = false;
    } else {
      // Tile wasn't reserved, just set it
      this.set(key, heightmap, normalMap);
    }
  }
  
  /**
   * Check if a tile is still being generated
   */
  isGenerating(key: TileKey): boolean {
    const tile = this.tiles.get(keyToString(key));
    return tile?.generating ?? false;
  }
  
  /**
   * Remove a tile from the cache
   */
  remove(key: TileKey): void {
    const keyStr = keyToString(key);
    const tile = this.tiles.get(keyStr);
    
    if (tile) {
      tile.heightmap.destroy();
      tile.normalMap.destroy();
      this.tiles.delete(keyStr);
    }
  }
  
  /**
   * Evict the least recently used tile
   */
  private evictLRU(): void {
    let oldest: { key: string; time: number } | null = null;
    
    for (const [key, tile] of this.tiles) {
      // Don't evict tiles being generated
      if (tile.generating) continue;
      
      if (!oldest || tile.lastAccessed < oldest.time) {
        oldest = { key, time: tile.lastAccessed };
      }
    }
    
    if (oldest) {
      const tile = this.tiles.get(oldest.key)!;
      
      // Parse key back to TileKey for callback
      const parts = oldest.key.split('_');
      const tileKey: TileKey = {
        x: parseFloat(parts[0]),
        z: parseFloat(parts[1]),
        lod: parseInt(parts[2], 10),
      };
      
      // Call eviction callback
      this.onEvict?.(tileKey, tile);
      
      // Destroy textures
      tile.heightmap.destroy();
      tile.normalMap.destroy();
      this.tiles.delete(oldest.key);
      
      this.evictions++;
    }
  }
  
  /**
   * Clear all tiles from the cache
   */
  clear(): void {
    for (const tile of this.tiles.values()) {
      tile.heightmap.destroy();
      tile.normalMap.destroy();
    }
    this.tiles.clear();
  }
  
  /**
   * Get all tiles within a world region
   */
  getTilesInRegion(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    lod: number
  ): TileData[] {
    const results: TileData[] = [];
    
    for (const [keyStr, tile] of this.tiles) {
      const parts = keyStr.split('_');
      const x = parseFloat(parts[0]);
      const z = parseFloat(parts[1]);
      const tileLod = parseInt(parts[2], 10);
      
      if (tileLod === lod && x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
        results.push(tile);
      }
    }
    
    return results;
  }
  
  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      size: this.tiles.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
  
  /**
   * Set eviction callback
   */
  setOnEvict(callback: (key: TileKey, data: TileData) => void): void {
    this.onEvict = callback;
  }
  
  /**
   * Get current size
   */
  get size(): number {
    return this.tiles.size;
  }
  
  /**
   * Clean up all resources
   */
  destroy(): void {
    this.clear();
    this.onEvict = undefined;
  }
}
