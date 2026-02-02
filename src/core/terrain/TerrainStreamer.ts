/**
 * TerrainStreamer - On-demand terrain tile streaming
 * 
 * Watches camera position and generates terrain tiles as needed,
 * using the TerrainTileCache for storage and HeightmapGenerator/ErosionSimulator
 * for tile generation.
 */

import { vec3 } from 'gl-matrix';
import { GPUContext, UnifiedGPUTexture } from '../gpu';
import { HeightmapGenerator, NoiseParams, createDefaultNoiseParams } from './HeightmapGenerator';
import { ErosionSimulator, HydraulicErosionParams, ThermalErosionParams } from './ErosionSimulator';
import { TerrainTileCache, TileKey, TileData } from './TerrainTileCache';
import { TerrainNode } from './TerrainQuadtree';

/**
 * Streamer configuration
 */
export interface TerrainStreamerConfig {
  /** Resolution for full-quality tiles (LOD 0-2) */
  highResolution: number;
  /** Resolution for medium-quality tiles (LOD 3-4) */
  mediumResolution: number;
  /** Resolution for low-quality tiles (LOD 5+) */
  lowResolution: number;
  /** World size of each tile */
  tileWorldSize: number;
  /** Height scale for the terrain (applied at render time) */
  heightScale: number;
  /** Maximum tiles to generate per frame */
  maxTilesPerFrame: number;
  /** Priority radius - tiles within this distance are high priority */
  priorityRadius: number;
  /** Noise parameters for heightmap generation */
  noiseParams: NoiseParams;
  /** Hydraulic erosion iterations (per LOD tier) */
  hydraulicIterations: { high: number; medium: number; low: number };
  /** Thermal erosion iterations (per LOD tier) */
  thermalIterations: { high: number; medium: number; low: number };
  /** Normal map strength */
  normalStrength: number;
}

/**
 * Tile request with priority
 */
interface TileRequest {
  key: TileKey;
  priority: number;
  worldX: number;
  worldZ: number;
  lodLevel: number;
}

/**
 * Streamer statistics
 */
export interface StreamerStats {
  pendingRequests: number;
  tilesGenerated: number;
  tilesPerSecond: number;
  cacheStats: { size: number; capacity: number; hits: number; misses: number };
}

/**
 * Default streamer configuration
 */
export function createDefaultStreamerConfig(): TerrainStreamerConfig {
  return {
    highResolution: 512,
    mediumResolution: 256,
    lowResolution: 128,
    tileWorldSize: 512,
    heightScale: 512,
    maxTilesPerFrame: 1,
    priorityRadius: 1024,
    noiseParams: createDefaultNoiseParams(),
    hydraulicIterations: { high: 20, medium: 10, low: 5 },
    thermalIterations: { high: 8, medium: 4, low: 2 },
    normalStrength: 1.0,
  };
}

/**
 * TerrainStreamer - Manages on-demand terrain tile generation
 */
export class TerrainStreamer {
  private ctx: GPUContext;
  private config: TerrainStreamerConfig;
  
  // Components
  private heightmapGenerator: HeightmapGenerator;
  private erosionSimulator: ErosionSimulator;
  private tileCache: TerrainTileCache;
  
  // Request queue
  private requestQueue: TileRequest[] = [];
  private activeGeneration: TileKey | null = null;
  
  // Statistics
  private tilesGenerated = 0;
  private generationStartTime = 0;
  private lastStatsTime = 0;
  private recentGenerationCount = 0;
  private tilesPerSecond = 0;
  
  // Camera tracking
  private lastCameraX = 0;
  private lastCameraZ = 0;
  
  constructor(
    ctx: GPUContext,
    cacheCapacity = 128,
    config?: Partial<TerrainStreamerConfig>
  ) {
    this.ctx = ctx;
    this.config = { ...createDefaultStreamerConfig(), ...config };
    
    // Create components
    this.heightmapGenerator = new HeightmapGenerator(ctx);
    this.erosionSimulator = new ErosionSimulator(ctx);
    this.tileCache = new TerrainTileCache(ctx, cacheCapacity, this.config.highResolution);
    
    // Track evictions for debugging
    this.tileCache.setOnEvict((key, _data) => {
      console.debug(`Tile evicted: (${key.x}, ${key.z}) LOD ${key.lod}`);
    });
  }
  
  /**
   * Update streamer with current camera position and required nodes
   * Call this every frame with the quadtree selection results
   */
  update(cameraPosition: vec3, requiredNodes: TerrainNode[]): void {
    this.lastCameraX = cameraPosition[0];
    this.lastCameraZ = cameraPosition[2];
    
    // Convert nodes to tile requests
    for (const node of requiredNodes) {
      const key = this.nodeToTileKey(node);
      
      // Skip if already cached or being generated
      if (this.tileCache.has(key)) continue;
      if (this.activeGeneration && this.keyEquals(this.activeGeneration, key)) continue;
      if (this.isInQueue(key)) continue;
      
      // Calculate priority (closer = higher)
      const dx = node.center[0] - cameraPosition[0];
      const dz = node.center[2] - cameraPosition[2];
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      // Higher LOD (finer detail) gets higher priority
      const lodPriority = (10 - node.lodLevel) * 1000;
      const distancePriority = Math.max(0, 10000 - distance);
      const priority = lodPriority + distancePriority;
      
      this.requestQueue.push({
        key,
        priority,
        worldX: node.center[0],
        worldZ: node.center[2],
        lodLevel: node.lodLevel,
      });
    }
    
    // Sort by priority (highest first)
    this.requestQueue.sort((a, b) => b.priority - a.priority);
    
    // Update stats
    this.updateStats();
  }
  
  /**
   * Process tile generation queue
   * Call this every frame to generate pending tiles
   * Returns true if a tile was generated this frame
   */
  async processQueue(): Promise<boolean> {
    if (this.activeGeneration) {
      return false; // Already generating
    }
    
    if (this.requestQueue.length === 0) {
      return false; // Nothing to do
    }
    
    // Get highest priority request
    const request = this.requestQueue.shift()!;
    
    // Double-check it's not already cached (may have been added while queued)
    if (this.tileCache.has(request.key)) {
      return this.processQueue(); // Try next
    }
    
    // Reserve slot in cache
    if (!this.tileCache.reserve(request.key)) {
      return this.processQueue(); // Try next
    }
    
    this.activeGeneration = request.key;
    this.generationStartTime = performance.now();
    
    try {
      // Generate tile
      const { heightmap, normalMap } = await this.generateTile(request);
      
      // Store in cache
      this.tileCache.complete(request.key, heightmap, normalMap);
      
      this.tilesGenerated++;
      this.recentGenerationCount++;
      
      return true;
    } catch (error) {
      console.error('Tile generation failed:', error);
      this.tileCache.remove(request.key);
      return false;
    } finally {
      this.activeGeneration = null;
    }
  }
  
  /**
   * Generate a single tile
   */
  private async generateTile(request: TileRequest): Promise<{
    heightmap: UnifiedGPUTexture;
    normalMap: UnifiedGPUTexture;
  }> {
    // Determine resolution and iterations based on LOD
    const { resolution, hydraulicIters, thermalIters } = this.getLODParams(request.lodLevel);
    
    // Generate base heightmap
    // Offset noise by world position to get seamless tiling
    const offsetParams: NoiseParams = {
      ...this.config.noiseParams,
      offsetX: request.worldX / this.config.tileWorldSize,
      offsetY: request.worldZ / this.config.tileWorldSize,
    };
    
    let heightmap = this.heightmapGenerator.generateHeightmap(
      resolution,
      offsetParams
    );
    
    // Wait for GPU
    await this.ctx.device.queue.onSubmittedWorkDone();
    
    // Apply erosion if iterations > 0
    if (hydraulicIters > 0 || thermalIters > 0) {
      this.erosionSimulator.initialize(heightmap);
      
      if (hydraulicIters > 0) {
        this.erosionSimulator.applyHydraulicErosion(hydraulicIters);
        await this.ctx.device.queue.onSubmittedWorkDone();
      }
      
      if (thermalIters > 0) {
        this.erosionSimulator.applyThermalErosion(thermalIters);
        await this.ctx.device.queue.onSubmittedWorkDone();
      }
      
      // Get eroded heightmap
      const erodedHeightmap = this.erosionSimulator.getResultHeightmap();
      if (erodedHeightmap) {
        heightmap.destroy();
        heightmap = erodedHeightmap;
      }
    }
    
    // Generate normal map
    // Use tile world size for proper texel-to-world calculations
    // heightScale is now a separate config param (not in noiseParams)
    const normalMap = this.heightmapGenerator.generateNormalMap(
      heightmap,
      this.config.tileWorldSize,
      this.config.heightScale,
      this.config.normalStrength
    );
    
    await this.ctx.device.queue.onSubmittedWorkDone();
    
    return { heightmap, normalMap };
  }
  
  /**
   * Get resolution and iteration counts for a LOD level
   */
  private getLODParams(lodLevel: number): {
    resolution: number;
    hydraulicIters: number;
    thermalIters: number;
  } {
    if (lodLevel <= 2) {
      return {
        resolution: this.config.highResolution,
        hydraulicIters: this.config.hydraulicIterations.high,
        thermalIters: this.config.thermalIterations.high,
      };
    } else if (lodLevel <= 4) {
      return {
        resolution: this.config.mediumResolution,
        hydraulicIters: this.config.hydraulicIterations.medium,
        thermalIters: this.config.thermalIterations.medium,
      };
    } else {
      return {
        resolution: this.config.lowResolution,
        hydraulicIters: this.config.hydraulicIterations.low,
        thermalIters: this.config.thermalIterations.low,
      };
    }
  }
  
  /**
   * Convert quadtree node to tile key
   */
  private nodeToTileKey(node: TerrainNode): TileKey {
    // Quantize center to tile grid
    const tileSize = this.config.tileWorldSize;
    const tileX = Math.floor(node.center[0] / tileSize) * tileSize;
    const tileZ = Math.floor(node.center[2] / tileSize) * tileSize;
    
    return {
      x: tileX,
      z: tileZ,
      lod: node.lodLevel,
    };
  }
  
  /**
   * Check if a key is already in the request queue
   */
  private isInQueue(key: TileKey): boolean {
    return this.requestQueue.some(r => this.keyEquals(r.key, key));
  }
  
  /**
   * Compare two tile keys
   */
  private keyEquals(a: TileKey, b: TileKey): boolean {
    return a.x === b.x && a.z === b.z && a.lod === b.lod;
  }
  
  /**
   * Update statistics
   */
  private updateStats(): void {
    const now = performance.now();
    const elapsed = now - this.lastStatsTime;
    
    if (elapsed >= 1000) {
      this.tilesPerSecond = this.recentGenerationCount / (elapsed / 1000);
      this.recentGenerationCount = 0;
      this.lastStatsTime = now;
    }
  }
  
  // ============ Tile Access ============
  
  /**
   * Get tile data for a node
   * Returns undefined if tile is not ready
   */
  getTile(node: TerrainNode): TileData | undefined {
    const key = this.nodeToTileKey(node);
    const tile = this.tileCache.get(key);
    
    // Don't return tiles that are still generating
    if (tile?.generating) return undefined;
    
    return tile;
  }
  
  /**
   * Check if a tile is available
   */
  hasTile(node: TerrainNode): boolean {
    const key = this.nodeToTileKey(node);
    const tile = this.tileCache.get(key);
    return tile !== undefined && !tile.generating;
  }
  
  /**
   * Get the tile cache for direct access
   */
  getCache(): TerrainTileCache {
    return this.tileCache;
  }
  
  // ============ Statistics ============
  
  /**
   * Get streamer statistics
   */
  getStats(): StreamerStats {
    const cacheStats = this.tileCache.getStats();
    return {
      pendingRequests: this.requestQueue.length,
      tilesGenerated: this.tilesGenerated,
      tilesPerSecond: this.tilesPerSecond,
      cacheStats: {
        size: cacheStats.size,
        capacity: cacheStats.capacity,
        hits: cacheStats.hits,
        misses: cacheStats.misses,
      },
    };
  }
  
  /**
   * Clear all pending requests
   */
  clearQueue(): void {
    this.requestQueue = [];
  }
  
  // ============ Configuration ============
  
  setNoiseParams(params: Partial<NoiseParams>): void {
    this.config.noiseParams = { ...this.config.noiseParams, ...params };
  }
  
  getConfig(): TerrainStreamerConfig {
    return { ...this.config };
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    this.heightmapGenerator.destroy();
    this.erosionSimulator.destroy();
    this.tileCache.destroy();
    this.requestQueue = [];
  }
}
