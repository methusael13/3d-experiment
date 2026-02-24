/**
 * VegetationManager - High-level orchestration for the vegetation system.
 * 
 * Now driven by the CDLOD terrain quadtree:
 * - Each frame, receives selected TerrainNodes from the quadtree
 * - Spawns vegetation per-node with LOD-scaled density
 * - Per-plant maxVegetationLOD controls which LOD levels a plant appears on
 * - GPU culling pipeline handles per-instance frustum/distance/hybrid culling
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  loadTextureFromURL,
} from '../gpu';
import { loadGLB } from '../../loaders/GLBLoader';
import type { GLBModel, GLBMesh } from '../../loaders/types';

import { VegetationSpawner, type SpawnRequest } from './VegetationSpawner';
import { loadCompositeAtlasTexture, clearCompositeCache } from './AtlasTextureCompositor';
import { VegetationRenderer, type VegetationTileData } from './VegetationRenderer';
import { VegetationTileCache } from './VegetationTileCache';
import type { VegetationMesh, VegetationSubMesh } from './VegetationMeshRenderer';
import type { PlantRegistry } from './PlantRegistry';
import type { TerrainNode } from '../terrain/TerrainQuadtree';
import type {
  PlantType,
  VegetationConfig,
  WindParams,
  ModelReference,
  VegetationLightParams,
} from './types';
import { createDefaultVegetationConfig, createDefaultWindParams } from './types';
import { DirectionalLight } from '../sceneObjects/lights/DirectionalLight';
import { Vec3 } from '../types';

// ==================== VegetationManager ====================

export class VegetationManager {
  private ctx: GPUContext;

  // Core components
  private spawner: VegetationSpawner;
  private renderer: VegetationRenderer;
  private tileCache: VegetationTileCache;

  // External references (owned by TerrainManager)
  private plantRegistry: PlantRegistry | null = null;
  private biomeMask: UnifiedGPUTexture | null = null;
  private heightmap: UnifiedGPUTexture | null = null;
  private terrainSize: number = 100;
  private heightScale: number = 50;

  // Configuration
  private config: VegetationConfig;
  private wind: WindParams;
  private light: VegetationLightParams | null = null;
  private startTime: number = performance.now() / 1000;

  // Quadtree LOD config
  private maxLodLevels: number = 10;

  // Mesh cache (GLTF models loaded from asset paths)
  private meshCache: Map<string, VegetationMesh> = new Map();
  private meshLoadingPromises: Map<string, Promise<VegetationMesh | null>> = new Map();

  // Billboard texture cache
  private textureCache: Map<string, UnifiedGPUTexture> = new Map();

  // Subscription cleanup
  private registryUnsubscribe: (() => void) | null = null;

  private initialized = false;
  private enabled = false;


  /** Track which CDLOD node IDs are currently active (from last quadtree selection) */
  private _activeNodeIds: Set<string> = new Set();

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.spawner = new VegetationSpawner(ctx);
    this.renderer = new VegetationRenderer(ctx);
    this.tileCache = new VegetationTileCache();
    this.config = createDefaultVegetationConfig();
    this.wind = createDefaultWindParams();
  }

  // ==================== Initialization ====================

  initialize(): void {
    if (this.initialized) return;
    this.renderer.initialize(this.ctx.depthFormat, this.ctx.hdrFormat);
    this.initialized = true;
    console.log('[VegetationManager] Initialized');
  }

  /**
   * Connect to the terrain system for data access.
   */
  connectToTerrain(
    plantRegistry: PlantRegistry,
    heightmap: UnifiedGPUTexture,
    biomeMask: UnifiedGPUTexture | null,
    terrainSize: number,
    heightScale: number,
    maxLodLevels: number = 10,
  ): void {
    this.plantRegistry = plantRegistry;
    this.heightmap = heightmap;
    this.biomeMask = biomeMask;
    this.terrainSize = terrainSize;
    this.heightScale = heightScale;
    this.maxLodLevels = maxLodLevels;
    this.enabled = true;

    // Unsubscribe from previous registry
    this.registryUnsubscribe?.();

    // Subscribe to registry changes
    this.registryUnsubscribe = plantRegistry.subscribe((event) => {
      this.tileCache.clear();
      this._activeNodeIds.clear();

      if (event.type === 'wind-changed') {
        this.setWind(event.wind);
      }
    });

    console.log('[VegetationManager] Connected to terrain',
      `(size=${terrainSize}, heightScale=${heightScale}, biomeMask=${biomeMask ? 'yes' : 'no'}, maxLod=${maxLodLevels})`);
  }

  /**
   * Update terrain data references (e.g., after erosion or biome mask regeneration).
   */
  updateTerrainData(
    heightmap?: UnifiedGPUTexture,
    biomeMask?: UnifiedGPUTexture | null,
  ): void {
    if (heightmap) this.heightmap = heightmap;
    if (biomeMask !== undefined) this.biomeMask = biomeMask;

    this.tileCache.clear();
    this._activeNodeIds.clear();
  }

  // ==================== CDLOD Integration ====================

  /**
   * Sync vegetation with CDLOD quadtree selection.
   * Called each frame with the terrain's selected nodes.
   * 
   * This replaces the old flat grid system — vegetation tiles now
   * exactly match the terrain's LOD tiles, inheriting:
   * - Frustum culling (nodes are already frustum-tested by quadtree)
   * - LOD-based density (close nodes = high density, far = sparse)
   * - Automatic coverage (every visible terrain patch gets vegetation)
   */
  syncWithCDLODSelection(selectedNodes: TerrainNode[]): void {
    if (!this.enabled || !this.config.enabled) return;

    const syncStart = performance.now();
    const newNodeIds = new Set<string>();

    for (const node of selectedNodes) {
      const tileId = `cdlod-${node.lodLevel}-${node.gridX}-${node.gridZ}`;
      newNodeIds.add(tileId);

      const bounds: [number, number, number, number] = [
        node.bounds.min[0], node.bounds.min[2],
        node.bounds.max[0], node.bounds.max[2],
      ];

      // Notify cache of visible tile (creates entry if new, handles LOD change)
      this.tileCache.onTileVisible(tileId, node.lodLevel, bounds);
    }

    // Hide nodes that are no longer selected
    for (const oldId of this._activeNodeIds) {
      if (!newNodeIds.has(oldId)) {
        this.tileCache.onTileHidden(oldId);
      }
    }

    const newCount = newNodeIds.size - this._activeNodeIds.size;
    const hiddenCount = [...this._activeNodeIds].filter(id => !newNodeIds.has(id)).length;
    this._activeNodeIds = newNodeIds;
    
    const syncMs = performance.now() - syncStart;
    if (newCount !== 0 || hiddenCount !== 0) {
      console.log(`[VegSync] ${selectedNodes.length} CDLOD nodes → ${newNodeIds.size} veg tiles (new: +${Math.max(0, newCount)}, hidden: -${hiddenCount}) ${syncMs.toFixed(1)}ms`);
    }
  }

  /**
   * Calculate density multiplier for a given LOD level.
   * Uses quadtree convention: 0 = root (coarsest), maxLodLevels-1 = leaf (finest).
   * 
   * Leaf (closest) = 1.0 (full density)
   * Each coarser level halves density: 0.5, 0.25, 0.125, ...
   */
  private _getLODDensityMultiplier(lodLevel: number): number {
    const leafLevel = this.maxLodLevels - 1;
    const levelsFromLeaf = leafLevel - lodLevel; // 0 = leaf, N = coarser
    return Math.pow(0.5, levelsFromLeaf);
  }

  /**
   * Check if a plant should spawn on a given LOD level.
   * Plant's maxVegetationLOD is the coarsest level it appears on.
   * lodLevel >= maxVegetationLOD means it's fine/close enough.
   * 
   * Wait — quadtree convention: higher lodLevel = finer/closer.
   * maxVegetationLOD = 0 means spawn on all levels including root.
   * So: spawn if node.lodLevel >= plant.maxVegetationLOD
   */
  private _shouldPlantSpawnAtLOD(plant: PlantType, lodLevel: number): boolean {
    return lodLevel >= plant.maxVegetationLOD;
  }

  // ==================== Per-Frame Update ====================

  /**
   * Get current animation time in seconds (auto-advancing via performance.now()).
   */
  private _getTime(): number {
    return performance.now() / 1000 - this.startTime;
  }

  /**
   * Process ALL pending tile spawns in a single frame.
   * Now synchronous — no mapAsync, no awaiting, fire-and-forget GPU compute.
   */
  private _processSpawns(): void {
    if (!this.biomeMask || !this.heightmap || !this.plantRegistry) return;

    const pendingTiles = this.tileCache.getTilesNeedingSpawn();
    if (pendingTiles.length === 0) return;

    const spawnStart = performance.now();
    for (const tile of pendingTiles) {
      this._spawnTileVegetation(tile);
    }
    const spawnMs = performance.now() - spawnStart;
    if (pendingTiles.length > 0) {
      console.log(`[VegSpawn] Spawned ${pendingTiles.length} tiles in ${spawnMs.toFixed(1)}ms (synchronous, no mapAsync)`);
    }
  }

  /**
   * Spawn vegetation for a single CDLOD tile.
   * Density is scaled by LOD level — finer (closer) tiles get more instances.
   */
  /**
   * Spawn vegetation for a single CDLOD tile — SYNCHRONOUS.
   * No await, no mapAsync. GPU compute dispatches fire-and-forget.
   */
  private _spawnTileVegetation(
    tile: { tileId: string; lodLevel: number; bounds: [number, number, number, number] }
  ): void {
    if (!this.biomeMask || !this.heightmap || !this.plantRegistry) return;

    const plants = this.plantRegistry.getAllPlants();
    if (plants.length === 0) return;

    const tileSize = tile.bounds[2] - tile.bounds[0];
    const tileOriginX = tile.bounds[0];
    const tileOriginZ = tile.bounds[1];

    // Use tile center as spawn camera — no distance-based spawn culling
    // (the GPU cull shader handles per-frame distance culling)
    const tileCenterX = (tile.bounds[0] + tile.bounds[2]) * 0.5;
    const tileCenterZ = (tile.bounds[1] + tile.bounds[3]) * 0.5;

    const request: SpawnRequest = {
      tileId: tile.tileId,
      tileOrigin: [tileOriginX, tileOriginZ],
      tileSize,
      cameraPosition: [tileCenterX, 0, tileCenterZ],
    };

    // LOD-based density multiplier
    const lodDensity = this._getLODDensityMultiplier(tile.lodLevel);

    for (let plantIdx = 0; plantIdx < plants.length; plantIdx++) {
      const plant = plants[plantIdx];
      if (!this._shouldPlantSpawnAtLOD(plant, tile.lodLevel)) continue;

      // Derive a per-plant seed from the global seed so each plant type
      // gets a unique spatial pattern (different jitter, probability rolls)
      const plantSeed = this.config.spawnSeed + plantIdx * 7919; // large prime offset

      // Synchronous spawn — no await!
      // lodDensity is now passed as lodDensityRatio for world-space grid thinning
      const result = this.spawner.spawnForPlant(
        request, plant,
        this.biomeMask!, this.heightmap!,
        this.terrainSize, this.heightScale,
        1.0,          // densityMultiplier: always 1.0 (density handled by fixed cellSize)
        plantSeed,
        lodDensity,   // lodDensityRatio: fraction of cells to keep at this LOD
      );

      // Compute atlas region
      let atlasRegion: [number, number, number, number] = [0, 0, 0, 0];
      if (plant.atlasRef && plant.atlasRef.regions.length > 0) {
        const [atlasW, atlasH] = plant.atlasRef.atlasSize;
        const regionIdx = plant.atlasRegionIndex ?? 0;
        const region = plant.atlasRef.regions[Math.min(regionIdx, plant.atlasRef.regions.length - 1)];
        atlasRegion = [
          region.u / atlasW, region.v / atlasH,
          region.width / atlasW, region.height / atlasH,
        ];
      }

      this.tileCache.setPlantSpawnResult(tile.tileId, plant.id, plant.color, atlasRegion, result);

      const renderModeMap: Record<string, number> = { 'billboard': 0, 'mesh': 1, 'hybrid': 2, 'grass-blade': 3 };
      this.tileCache.setPlantRenderParams(
        tile.tileId, plant.id,
        renderModeMap[plant.renderMode] ?? 0,
        plant.billboardDistance,
      );

      // Mesh/texture loading is async but non-blocking — fire and forget
      this._ensurePlantMesh(tile.tileId, plant);
      this._ensurePlantBillboardOrAtlas(tile.tileId, plant);
    }

    this.tileCache.markSpawnComplete(tile.tileId);
  }

  // ==================== Asset Loading ====================

  async loadVegetationMesh(modelRef: ModelReference): Promise<VegetationMesh | null> {
    // Include variant in cache key so different variants are cached separately
    const variantSuffix = modelRef.selectedVariant !== undefined && modelRef.selectedVariant >= 0 
      ? `#v${modelRef.selectedVariant}` 
      : '#combined';
    const cacheKey = modelRef.modelPath + variantSuffix;
    const cached = this.meshCache.get(cacheKey);
    if (cached) return cached;

    const pending = this.meshLoadingPromises.get(cacheKey);
    if (pending) return pending;

    const promise = this._loadMeshInternal(modelRef);
    this.meshLoadingPromises.set(cacheKey, promise);

    const result = await promise;
    this.meshLoadingPromises.delete(cacheKey);
    if (result) this.meshCache.set(cacheKey, result);
    return result;
  }

  private async _loadMeshInternal(modelRef: ModelReference): Promise<VegetationMesh | null> {
    try {
      let meshesToConvert: GLBMesh[];
      
      // If a specific variant is selected and model has multiple nodes, load only that variant
      if (modelRef.selectedVariant !== undefined && modelRef.selectedVariant >= 0 && modelRef.variantCount > 1) {
        const { loadGLBNodes } = await import('../../loaders/GLBLoader');
        const nodeModels = await loadGLBNodes(modelRef.modelPath, { normalize: true });
        const variantIdx = Math.min(modelRef.selectedVariant, nodeModels.length - 1);
        meshesToConvert = nodeModels[variantIdx].model.meshes;
        console.log(`[VegetationManager] Loading variant ${variantIdx} "${nodeModels[variantIdx].name}" (${meshesToConvert.length} meshes)`);
      } else {
        // Combined: load all meshes
        const glbModel: GLBModel = await loadGLB(modelRef.modelPath, { normalize: true });
        meshesToConvert = glbModel.meshes;
      }
      
      if (meshesToConvert.length === 0) return null;

      const subMeshes: VegetationSubMesh[] = [];
      for (const glbMesh of meshesToConvert) {
        const subMesh = this._convertGLBMeshToSubMesh(glbMesh, modelRef);
        if (subMesh) subMeshes.push(subMesh);
      }
      if (subMeshes.length === 0) return null;

      // Include variant in cache key name
      const variantLabel = modelRef.selectedVariant !== undefined && modelRef.selectedVariant >= 0
        ? ` (variant ${modelRef.selectedVariant})`
        : ' (combined)';
      return { id: modelRef.assetId, name: modelRef.assetName + variantLabel, subMeshes };
    } catch (err) {
      console.error(`[VegetationManager] Failed to load mesh ${modelRef.modelPath}:`, err);
      return null;
    }
  }

  private _convertGLBMeshToSubMesh(glbMesh: GLBMesh, modelRef: ModelReference): VegetationSubMesh | null {
    if (!glbMesh.positions || !glbMesh.indices) return null;

    const positions = glbMesh.positions;
    const normals = glbMesh.normals ?? new Float32Array(positions.length);
    const uvs = glbMesh.uvs ?? new Float32Array((positions.length / 3) * 2);
    const vertexCount = positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8);

    for (let i = 0; i < vertexCount; i++) {
      interleavedData[i * 8 + 0] = positions[i * 3 + 0];
      interleavedData[i * 8 + 1] = positions[i * 3 + 1];
      interleavedData[i * 8 + 2] = positions[i * 3 + 2];
      interleavedData[i * 8 + 3] = normals[i * 3 + 0];
      interleavedData[i * 8 + 4] = normals[i * 3 + 1];
      interleavedData[i * 8 + 5] = normals[i * 3 + 2];
      interleavedData[i * 8 + 6] = uvs[i * 2 + 0];
      interleavedData[i * 8 + 7] = uvs[i * 2 + 1];
    }

    const vertexBuffer = this.ctx.device.createBuffer({
      label: `vegetation-vb-${modelRef.assetId}`,
      size: interleavedData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.ctx.queue.writeBuffer(vertexBuffer, 0, interleavedData);

    const indices = glbMesh.indices;
    const is32Bit = indices instanceof Uint32Array;
    const indexByteSize = Math.ceil(indices.byteLength / 4) * 4;
    const indexBuffer = this.ctx.device.createBuffer({
      label: `vegetation-ib-${modelRef.assetId}`,
      size: indexByteSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    const alignedIndexData = new Uint8Array(indexByteSize);
    alignedIndexData.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
    this.ctx.queue.writeBuffer(indexBuffer, 0, alignedIndexData);

    return {
      vertexBuffer, indexBuffer,
      indexCount: indices.length,
      indexFormat: is32Bit ? 'uint32' : 'uint16',
      baseColorTexture: null,
      windMultiplier: 1.0,
    };
  }

  async loadBillboardTexture(texturePath: string): Promise<UnifiedGPUTexture | null> {
    const cached = this.textureCache.get(texturePath);
    if (cached) return cached;
    try {
      const result = await loadTextureFromURL(this.ctx, texturePath, { generateMipmaps: true, sRGB: true });
      this.textureCache.set(texturePath, result.texture);
      return result.texture;
    } catch (err) {
      console.error(`[VegetationManager] Failed to load texture ${texturePath}:`, err);
      return null;
    }
  }

  private async _ensurePlantMesh(tileId: string, plant: PlantType): Promise<boolean> {
    if (plant.modelRef && (plant.renderMode === 'mesh' || plant.renderMode === 'hybrid')) {
      if (this.tileCache.getPlantMesh(tileId, plant.id)) return true;
      const mesh = await this.loadVegetationMesh(plant.modelRef);
      if (mesh) { this.tileCache.setPlantMesh(tileId, plant.id, mesh); return true; }
    }
    return false;
  }

  private async _ensurePlantBillboardOrAtlas(tileId: string, plant: PlantType): Promise<boolean> {
    if (plant.modelRef?.billboardTexturePath && (plant.renderMode === 'billboard' || plant.renderMode === 'hybrid')) {
      if (this.tileCache.getPlantTexture(tileId, plant.id)) return true;
      const tex = await this.loadBillboardTexture(plant.modelRef.billboardTexturePath);
      if (tex) { this.tileCache.setPlantTexture(tileId, plant.id, tex); return true; }
    } else if (plant.atlasRef && plant.renderMode === 'billboard') {
      if (this.tileCache.getPlantTexture(tileId, plant.id)) return true;
      try {
        const tex = await loadCompositeAtlasTexture(this.ctx, plant.atlasRef.baseColorPath, plant.atlasRef.opacityPath);
        this.tileCache.setPlantTexture(tileId, plant.id, tex);
        return true;
      } catch (err) {
        console.error(`[VegetationManager] Failed to composite atlas for plant ${plant.id}:`, err);
      }
    }
    return false;
  }

  // ==================== Rendering ====================

  /**
   * Prepare GPU culling compute passes. Call BEFORE the render pass.
   */
  prepareFrame(
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
  ): boolean {
    if (!this.enabled || !this.config.enabled || !this.initialized) return false;

    this._processSpawns();

    const allTileData = this.tileCache.getVisibleTileData();
    if (allTileData.length === 0) return false;

    // No tile-level frustum culling needed — CDLOD already did it
    // Just sort front-to-back for early-Z
    const [cx, cy, cz] = cameraPosition;
    allTileData.sort((a, b) => {
      const acx = (a.bounds[0] + a.bounds[2]) * 0.5;
      const acz = (a.bounds[1] + a.bounds[3]) * 0.5;
      const bcx = (b.bounds[0] + b.bounds[2]) * 0.5;
      const bcz = (b.bounds[1] + b.bounds[3]) * 0.5;
      const da = (cx - acx) ** 2 + (cz - acz) ** 2;
      const db = (cx - bcx) ** 2 + (cz - bcz) ** 2;
      return da - db;
    });

    this._visibleTilesCache = allTileData;

    this.renderer.prepareFrame(
      this._visibleTilesCache,
      viewProjection,
      cameraPosition,
    );

    return true;
  }

  private _visibleTilesCache: VegetationTileData[] = [];

  /**
   * Render vegetation. Call within a render pass after prepareFrame.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    light?: VegetationLightParams,
  ): void {
    if (!this.enabled || !this.config.enabled || !this.initialized) return;

    this.renderer.render(
      passEncoder,
      viewProjection,
      cameraPosition,
      this._visibleTilesCache,
      this.wind,
      this._getTime(),
      200,
      light ?? this.light ?? undefined,
    );

    this._visibleTilesCache = [];
  }

  // ==================== Configuration ====================

  isEnabled(): boolean {
    return this.enabled && this.config.enabled;
  }

  setConfig(updates: Partial<VegetationConfig>): void {
    Object.assign(this.config, updates);
  }

  getConfig(): VegetationConfig {
    return { ...this.config };
  }

  setWind(updates: Partial<WindParams>): void {
    Object.assign(this.wind, updates);
  }

  getWind(): WindParams {
    return { ...this.wind };
  }

  /**
   * Set vegetation light parameters directly.
   */
  setLight(light: VegetationLightParams): void {
    this.light = light;
  }

  getLight(): VegetationLightParams | null {
    return this.light;
  }

  /**
   * Compute and store vegetation light params from scene light inputs.
   * Delegates to DirectionalLight for all color/intensity computations,
   * using its fromRendererParams() factory to reconstruct the light state
   * from the renderer's direction + color output.
   */
  updateLightFromScene(
    lightDirection: [number, number, number],
    lightColor: [number, number, number],
    ambientIntensity: number = 1.0,
  ): void {
    // Reconstruct a DirectionalLight from renderer params to reuse its
    // authoritative elevation-based color/intensity computations
    const dl = DirectionalLight.fromRendererParams(lightDirection, lightColor, ambientIntensity);
    const dir = dl.getDirection();
    const skyColor = dl.getSkyColor();
    const groundColor = dl.getGroundColor();
    
    // Scale sky/ground by ambient intensity
    const ai = ambientIntensity;
    
    this.light = {
      sunDirection: [dir[0], dir[1], dir[2]],
      sunColor: dl.getSunColor(),
      skyColor: [skyColor[0] * ai, skyColor[1] * ai, skyColor[2] * ai],
      groundColor: [groundColor[0] * ai, groundColor[1] * ai, groundColor[2] * ai],
      sunIntensityFactor: dl.getSunIntensityFactor(),
    };
  }

  // ==================== Statistics ====================

  getStats(): {
    tileCount: number;
    visibleTiles: number;
    totalInstances: number;
    meshInstances: number;
    billboardInstances: number;
    cachedMeshes: number;
    cachedTextures: number;
  } {
    const cacheStats = this.tileCache.getStats();
    return {
      tileCount: cacheStats.totalTiles,
      visibleTiles: cacheStats.visibleTiles,
      totalInstances: cacheStats.totalInstances,
      meshInstances: cacheStats.meshInstances,
      billboardInstances: cacheStats.billboardInstances,
      cachedMeshes: this.meshCache.size,
      cachedTextures: this.textureCache.size,
    };
  }

  // ==================== Cleanup ====================

  destroy(): void {
    this.spawner.destroy();
    this.renderer.destroy();
    this.tileCache.destroy();

    for (const tex of this.textureCache.values()) tex.destroy();
    this.textureCache.clear();
    clearCompositeCache();

    this.meshCache.clear();
    this.meshLoadingPromises.clear();

    this.registryUnsubscribe?.();
    this.registryUnsubscribe = null;

    this.initialized = false;
    this.enabled = false;

    console.log('[VegetationManager] Destroyed');
  }
}