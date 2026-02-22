/**
 * VegetationTileCache
 * 
 * Manages vegetation instance data per terrain tile with:
 * - Per-plant-type spawn results (each plant type has its own instance buffer)
 * - LRU eviction when cache exceeds max size
 * - LOD-aware density mapping
 * - Tile lifecycle tracking (visible, hidden, LOD change)
 * - Integration hooks for CDLOD terrain system
 */

import { UnifiedGPUBuffer, UnifiedGPUTexture } from '../gpu';
import type { VegetationMesh } from './VegetationMeshRenderer';
import type { SpawnResult } from './VegetationSpawner';
import type { VegetationTileData, PlantTileData } from './VegetationRenderer';

// ==================== Types ====================

/**
 * Per-plant spawn data stored within a tile cache entry.
 */
interface PlantCacheEntry {
  plantId: string;
  fallbackColor: [number, number, number];
  atlasRegion: [number, number, number, number];
  spawnResult: SpawnResult;
  billboardTexture: UnifiedGPUTexture | null;
  mesh: VegetationMesh | null;
  renderMode: number;
  billboardDistance: number;
}

/**
 * Internal tile entry with lifecycle metadata.
 */
interface TileCacheEntry {
  tileId: string;
  /** Terrain tile LOD level (0 = closest) */
  lodLevel: number;
  /** Per-plant spawn results (keyed by plant ID) */
  plants: Map<string, PlantCacheEntry>;
  /** Whether all plants have been spawned for this tile */
  spawnComplete: boolean;
  /** Frame number when last used */
  lastUsedFrame: number;
  /** Whether tile is currently visible */
  visible: boolean;
  /** World-space bounding box [minX, minZ, maxX, maxZ] */
  bounds: [number, number, number, number];
  /** Timestamp when tile first became visible (for latency tracking) */
  visibleSince: number;
}

/**
 * LOD density configuration.
 */
export interface LODDensityConfig {
  /** LOD level */
  level: number;
  /** Density multiplier (0-1, relative to base density) */
  densityMultiplier: number;
  /** Maximum distance from camera for this LOD */
  maxDistance: number;
}

/**
 * Default LOD density mapping.
 */
export const DEFAULT_LOD_DENSITIES: LODDensityConfig[] = [
  { level: 0, densityMultiplier: 1.0, maxDistance: 50 },
  { level: 1, densityMultiplier: 0.6, maxDistance: 100 },
  { level: 2, densityMultiplier: 0.3, maxDistance: 200 },
  { level: 3, densityMultiplier: 0.1, maxDistance: 400 },
];

/**
 * Cache statistics.
 */
export interface TileCacheStats {
  /** Total cached tiles */
  totalTiles: number;
  /** Currently visible tiles */
  visibleTiles: number;
  /** Total instances across all tiles */
  totalInstances: number;
  /** Total mesh instances */
  meshInstances: number;
  /** Total billboard instances */
  billboardInstances: number;
  /** Pool size (reusable buffers) */
  poolSize: number;
}

// ==================== VegetationTileCache ====================

export class VegetationTileCache {
  /** All cached tiles by ID */
  private tiles: Map<string, TileCacheEntry> = new Map();
  
  /** Maximum number of tiles to cache before eviction */
  private maxCacheSize: number;
  
  /** Current frame number (incremented each update) */
  private currentFrame: number = 0;
  
  /** LOD density configuration */
  private lodDensities: LODDensityConfig[];
  
  /** Released instance buffers available for reuse */
  private bufferPool: UnifiedGPUBuffer[] = [];
  
  constructor(maxCacheSize: number = 128, lodDensities?: LODDensityConfig[]) {
    this.maxCacheSize = maxCacheSize;
    this.lodDensities = lodDensities ?? [...DEFAULT_LOD_DENSITIES];
  }
  
  // ==================== Tile Lifecycle ====================
  
  /**
   * Mark a tile as visible. Creates a cache entry if it doesn't exist.
   * Returns true if the tile needs spawning (new or LOD changed).
   */
  onTileVisible(
    tileId: string,
    lodLevel: number,
    bounds: [number, number, number, number]
  ): boolean {
    const existing = this.tiles.get(tileId);
    
    if (existing) {
      existing.visible = true;
      existing.lastUsedFrame = this.currentFrame;
      existing.bounds = bounds;
      
      // Check if LOD level changed — needs re-spawn
      if (existing.lodLevel !== lodLevel) {
        existing.lodLevel = lodLevel;
        // Release old plant buffers to pool
        this._releaseTilePlants(existing);
        return true; // Needs re-spawn
      }
      
      return !existing.spawnComplete; // Needs spawn if not complete yet
    }
    
    // New tile
    this.tiles.set(tileId, {
      tileId,
      lodLevel,
      plants: new Map(),
      spawnComplete: false,
      lastUsedFrame: this.currentFrame,
      visible: true,
      bounds,
      visibleSince: performance.now(),
    });
    
    // Evict if over capacity
    if (this.tiles.size > this.maxCacheSize) {
      this.evictOldTiles();
    }
    
    return true; // Needs spawning
  }
  
  /**
   * Mark a tile as hidden. Keeps it in cache for potential reuse.
   */
  onTileHidden(tileId: string): void {
    const entry = this.tiles.get(tileId);
    if (entry) {
      entry.visible = false;
    }
  }
  
  /**
   * Handle LOD level change for a tile.
   * Returns true if the tile needs re-spawning at the new LOD.
   */
  onTileLODChange(tileId: string, newLod: number): boolean {
    const entry = this.tiles.get(tileId);
    if (!entry) return false;
    
    if (entry.lodLevel !== newLod) {
      entry.lodLevel = newLod;
      entry.lastUsedFrame = this.currentFrame;
      
      // Release old plant buffers
      this._releaseTilePlants(entry);
      
      return true; // Needs re-spawn at new LOD
    }
    
    return false;
  }
  
  /**
   * Store spawn result for a specific plant type on a tile.
   */
  setPlantSpawnResult(
    tileId: string,
    plantId: string,
    fallbackColor: [number, number, number],
    atlasRegion: [number, number, number, number],
    result: SpawnResult,
  ): void {
    const entry = this.tiles.get(tileId);
    if (!entry) return;
    
    // Release old buffer if this plant was already spawned
    const existing = entry.plants.get(plantId);
    if (existing) {
      this.bufferPool.push(existing.spawnResult.instanceBuffer);
    }
    
    entry.plants.set(plantId, {
      plantId,
      fallbackColor,
      atlasRegion,
      spawnResult: result,
      billboardTexture: null,
      mesh: null,
      renderMode: 0,
      billboardDistance: 50,
    });
    
    entry.lastUsedFrame = this.currentFrame;
  }
  
  /**
   * Mark a tile's spawning as complete (all plants have been spawned).
   */
  markSpawnComplete(tileId: string): void {
    const entry = this.tiles.get(tileId);
    if (entry) {
      entry.spawnComplete = true;
      // Log latency from visibility to spawn completion
      const latencyMs = performance.now() - entry.visibleSince;
      console.log(`[VegTileLatency] ${tileId} LOD=${entry.lodLevel} visible→spawned: ${latencyMs.toFixed(1)}ms`);
    }
  }
  
  getPlantTexture(tileId: string, plantId: string): UnifiedGPUTexture | null {
    const entry = this.tiles.get(tileId);
    const plant = entry?.plants.get(plantId);

    return plant ? plant.billboardTexture : null;
  }

  /**
   * Set the billboard texture for a specific plant on a tile.
   */
  setPlantTexture(tileId: string, plantId: string, texture: UnifiedGPUTexture | null): void {
    const entry = this.tiles.get(tileId);
    const plant = entry?.plants.get(plantId);
    if (plant) {
      plant.billboardTexture = texture;
    }
  }
  
  getPlantMesh(tileId: string, plantId: string): VegetationMesh | null {
    const entry = this.tiles.get(tileId);
    const plant = entry?.plants.get(plantId);

    return plant ? plant.mesh : null;
  }

  /**
   * Set the vegetation mesh for a specific plant on a tile.
   */
  setPlantMesh(tileId: string, plantId: string, mesh: VegetationMesh | null): void {
    const entry = this.tiles.get(tileId);
    const plant = entry?.plants.get(plantId);
    if (plant) {
      plant.mesh = mesh;
    }
  }
  
  /**
   * Set the render mode and billboard distance for a plant on a tile.
   * Used for per-frame hybrid LOD re-evaluation in the cull shader.
   * @param renderMode 0=billboard, 1=mesh, 2=hybrid
   * @param billboardDistance Distance threshold for hybrid: closer = mesh, farther = billboard
   */
  setPlantRenderParams(tileId: string, plantId: string, renderMode: number, billboardDistance: number): void {
    const entry = this.tiles.get(tileId);
    const plant = entry?.plants.get(plantId);
    if (plant) {
      plant.renderMode = renderMode;
      plant.billboardDistance = billboardDistance;
    }
  }
  
  // ==================== Querying ====================
  
  /**
   * Get all visible tiles with spawn data, formatted for VegetationRenderer.
   */
  getVisibleTileData(): VegetationTileData[] {
    const result: VegetationTileData[] = [];
    
    for (const entry of this.tiles.values()) {
      if (!entry.visible || entry.plants.size === 0) continue;
      
      const plants: PlantTileData[] = [];
      
      for (const plantEntry of entry.plants.values()) {
        
        plants.push({
          plantId: plantEntry.plantId,
          fallbackColor: plantEntry.fallbackColor,
          atlasRegion: plantEntry.atlasRegion,
          instanceBuffer: plantEntry.spawnResult.instanceBuffer,
          counterBuffer: plantEntry.spawnResult.counterBuffer,
          maxInstances: plantEntry.spawnResult.maxInstances,
          billboardTexture: plantEntry.billboardTexture,
          mesh: plantEntry.mesh,
          renderMode: plantEntry.renderMode,
          billboardDistance: plantEntry.billboardDistance,
        });
      }
      
      if (plants.length === 0) continue;
      
      result.push({
        tileId: entry.tileId,
        bounds: entry.bounds,
        lodLevel: entry.lodLevel,
        plants,
      });
    }
    
    return result;
  }
  
  /**
   * Get tiles that need spawning (visible but not spawn-complete).
   */
  getTilesNeedingSpawn(): { tileId: string; lodLevel: number; bounds: [number, number, number, number] }[] {
    const result: { tileId: string; lodLevel: number; bounds: [number, number, number, number] }[] = [];
    
    for (const entry of this.tiles.values()) {
      if (entry.visible && !entry.spawnComplete) {
        result.push({
          tileId: entry.tileId,
          lodLevel: entry.lodLevel,
          bounds: entry.bounds,
        });
      }
    }
    
    return result;
  }
  
  /**
   * Check if a tile has spawn data (at least one plant spawned).
   */
  hasTileData(tileId: string): boolean {
    const entry = this.tiles.get(tileId);
    return entry !== undefined && entry.plants.size > 0;
  }
  
  /**
   * Get LOD density multiplier for a given level.
   */
  getLODDensity(lodLevel: number): number {
    const config = this.lodDensities.find(d => d.level === lodLevel);
    return config?.densityMultiplier ?? 0;
  }
  
  /**
   * Get max distance for a given LOD level.
   */
  getLODMaxDistance(lodLevel: number): number {
    const config = this.lodDensities.find(d => d.level === lodLevel);
    return config?.maxDistance ?? 0;
  }
  
  /**
   * Check if a LOD level should have vegetation at all.
   */
  shouldHaveVegetation(lodLevel: number): boolean {
    return this.getLODDensity(lodLevel) > 0;
  }
  
  // ==================== Buffer Pool ====================
  
  /**
   * Get a buffer from the pool (for VegetationSpawner reuse).
   */
  acquireBuffer(): UnifiedGPUBuffer | null {
    return this.bufferPool.pop() ?? null;
  }
  
  /**
   * Return a buffer to the pool.
   */
  releaseBuffer(buffer: UnifiedGPUBuffer): void {
    this.bufferPool.push(buffer);
  }
  
  // ==================== Cache Management ====================
  
  /**
   * Advance the frame counter. Call once per frame.
   */
  advanceFrame(): void {
    this.currentFrame++;
  }
  
  /**
   * Release all plant buffers for a tile entry back to the pool.
   */
  private _releaseTilePlants(entry: TileCacheEntry): void {
    for (const plantEntry of entry.plants.values()) {
      this.bufferPool.push(plantEntry.spawnResult.instanceBuffer);
    }
    entry.plants.clear();
    entry.spawnComplete = false;
  }
  
  /**
   * Evict least-recently-used tiles to stay under max cache size.
   */
  evictOldTiles(targetSize?: number): void {
    const target = targetSize ?? this.maxCacheSize;
    
    if (this.tiles.size <= target) return;
    
    // Sort by last used frame (oldest first), skip visible tiles
    const evictionCandidates: TileCacheEntry[] = [];
    for (const entry of this.tiles.values()) {
      if (!entry.visible) {
        evictionCandidates.push(entry);
      }
    }
    
    // Sort oldest first
    evictionCandidates.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    
    // Evict until under target
    let evicted = 0;
    while (this.tiles.size > target && evictionCandidates.length > 0) {
      const toEvict = evictionCandidates.shift()!;
      
      // Return buffers to pool
      this._releaseTilePlants(toEvict);
      
      this.tiles.delete(toEvict.tileId);
      evicted++;
    }
    
    if (evicted > 0) {
      console.log(`[VegetationTileCache] Evicted ${evicted} tiles, ${this.tiles.size} remaining`);
    }
  }
  
  /**
   * Clear all cached tiles.
   */
  clear(): void {
    for (const entry of this.tiles.values()) {
      this._releaseTilePlants(entry);
    }
    this.tiles.clear();
  }
  
  /**
   * Update LOD density configuration.
   */
  setLODDensities(densities: LODDensityConfig[]): void {
    this.lodDensities = [...densities];
  }
  
  // ==================== Statistics ====================
  
  /**
   * Get cache statistics.
   */
  getStats(): TileCacheStats {
    let visibleTiles = 0;
    let totalInstances = 0;
    let meshInstances = 0;
    let billboardInstances = 0;
    
    for (const entry of this.tiles.values()) {
      if (entry.visible) visibleTiles++;
      for (const plant of entry.plants.values()) {
        // CPU counts unavailable — use maxInstances as upper bound
        totalInstances += plant.spawnResult.maxInstances;
      }
    }
    
    return {
      totalTiles: this.tiles.size,
      visibleTiles,
      totalInstances,
      meshInstances,
      billboardInstances,
      poolSize: this.bufferPool.length,
    };
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    // Destroy all pooled buffers
    for (const buf of this.bufferPool) {
      buf.destroy();
    }
    
    // Destroy all tile instance buffers
    for (const entry of this.tiles.values()) {
      for (const plant of entry.plants.values()) {
        plant.spawnResult.instanceBuffer.destroy();
      }
    }
    
    this.tiles.clear();
    this.bufferPool = [];
  }
}