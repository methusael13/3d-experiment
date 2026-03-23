/**
 * VegetationRenderer - Orchestrates billboard, grass blade, and variant mesh vegetation renderers.
 * 
 * Now includes a GPU culling compute pass that runs BEFORE the render pass:
 * 1. prepareFrame() — runs culling compute passes for all visible plants,
 *    producing compacted instance buffers + indirect draw args
 * 2. render() — uses drawIndirect/drawIndexedIndirect with only visible instances
 * 
 * Mesh vegetation rendering is handled by the ECS variant renderer pipeline
 * via VegetationMeshVariantRenderer (which creates lightweight ECS entities
 * that MeshRenderSystem groups into variant batches for PBR rendering).
 * Billboard and grass blade rendering remain as standalone GPU renderers.
 */

import { GPUContext, UnifiedGPUBuffer, UnifiedGPUTexture } from '../gpu';
import { VegetationBillboardRenderer } from './VegetationBillboardRenderer';
import { VegetationGrassBladeRenderer } from './VegetationGrassBladeRenderer';
import { VegetationCullingPipeline, type CullResult } from './VegetationCullingPipeline';
import { VegetationMeshVariantRenderer } from './VegetationMeshVariantRenderer';
import { VegetationShadowMap } from './VegetationShadowMap';
import type { VegetationMesh, WindParams, VegetationLightParams } from './types';
import type { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';
import { extractFrustumPlanes } from '../utils/mathUtils';
import type { World } from '../ecs/World';

// ==================== Types ====================

/**
 * Per-plant-type rendering data within a tile.
 * Each plant type gets its own instance buffer and draw call.
 */
export interface PlantTileData {
  /** Plant type ID (matches PlantType.id) */
  plantId: string;
  /** Fallback color [R, G, B] (0-1) when no texture is assigned */
  fallbackColor: [number, number, number];
  /** Atlas region [uOffset, vOffset, uSize, vSize] normalized (0-1). [0,0,0,0] = no atlas */
  atlasRegion: [number, number, number, number];
  /** Instance buffer for this plant type's instances */
  instanceBuffer: UnifiedGPUBuffer;
  /** GPU counter buffer from spawn: [totalCount, meshCount, billboardCount] as u32 */
  counterBuffer: GPUBuffer;
  /** Max possible instances (buffer capacity) */
  maxInstances: number;
  /** Billboard texture for this plant type */
  billboardTexture: UnifiedGPUTexture | null;
  /** Billboard normal map (RGB tangent-space normal) */
  billboardNormalTexture: UnifiedGPUTexture | null;
  /** Billboard translucency map (R channel = translucency) */
  billboardTranslucencyTexture: UnifiedGPUTexture | null;
  /** 3D mesh for this plant type (null = billboard only) */
  mesh: VegetationMesh | null;
  /** Render mode: 0=billboard, 1=mesh, 2=hybrid (used for per-frame LOD in cull shader) */
  renderMode: number;
  /** Distance threshold for hybrid mode: closer = mesh, farther = billboard */
  billboardDistance: number;
  /** Per-plant wind influence factor (0 = static, 1 = full wind). Default: 1.0 */
  windInfluence: number;
  /** Whether this plant casts shadows (mesh/hybrid only). Default: false */
  castShadows: boolean;
  /** Maximum distance from camera for shadow casting (meters). Default: 50 */
  shadowCastDistance: number;
}

/**
 * Data for a single vegetation tile containing per-plant-type instances.
 */
export interface VegetationTileData {
  tileId: string;
  /** World-space XZ bounds [minX, minZ, maxX, maxZ] for frustum culling */
  bounds: [number, number, number, number];
  /** CDLOD quadtree LOD level (0 = root/coarsest, N = leaf/finest) */
  lodLevel: number;
  /** Per-plant-type rendering data */
  plants: PlantTileData[];
}

/**
 * Prepared per-plant cull result, stored between prepareFrame and render.
 */
interface PreparedPlant {
  plant: PlantTileData;
  cullResult: CullResult;
  /** CDLOD LOD level of the tile this plant belongs to */
  lodLevel: number;
}

// ==================== VegetationRenderer ====================

export class VegetationRenderer {
  private ctx: GPUContext;
  private billboardRenderer: VegetationBillboardRenderer;
  private grassBladeRenderer: VegetationGrassBladeRenderer;
  private cullingPipeline: VegetationCullingPipeline;
  private meshVariantRenderer: VegetationMeshVariantRenderer;
  private initialized = false;
  private frameCount = 0;
  
  // Prepared cull results from prepareFrame(), consumed by render()
  private preparedPlants: PreparedPlant[] = [];
  private hasPreparedFrame = false;
  /** Whether mesh entity sync has already run this frame (to avoid double-sync) */
  private hasSyncedEntities = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.billboardRenderer = new VegetationBillboardRenderer(ctx);
    this.grassBladeRenderer = new VegetationGrassBladeRenderer(ctx);
    this.cullingPipeline = new VegetationCullingPipeline(ctx);
    this.meshVariantRenderer = new VegetationMeshVariantRenderer(ctx);
  }
  
  /**
   * Initialize sub-renderers and the culling pipeline.
   */
  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;
    
    this.billboardRenderer.initialize(depthFormat, colorFormat);
    this.grassBladeRenderer.initialize(depthFormat, colorFormat);
    this.cullingPipeline.initialize();
    this.initialized = true;
  }

  /**
   * Set the ECS World reference for variant mesh rendering.
   * Must be called before the first render frame.
   */
  setWorld(world: World): void {
    this.meshVariantRenderer.setWorld(world);
  }
  
  /**
   * Prepare frame: run GPU culling compute passes for all visible plants.
   * 
   * This MUST be called before the render pass begins, because:
   * - Culling is a compute pass that writes to storage buffers
   * - Render pass reads those buffers via drawIndirect
   * - WebGPU requires compute→render ordering via separate command buffers
   * 
   * The command encoder is submitted here. The subsequent render() call
   * will use the culled results via drawIndirect within the render pass.
   * 
   * @param tiles - Visible tiles (already frustum-culled at tile level)
   * @param viewProjection - Current VP matrix for frustum plane extraction
   * @param cameraPosition - Camera world position
   * @param maxDistance - Max vegetation render distance
   */
  prepareFrame(
    tiles: VegetationTileData[],
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    maxDistance: number = 200,
  ): void {
    if (!this.initialized) return;
    
    // Reset culling pipeline buffer pool
    this.cullingPipeline.resetFrame();
    this.preparedPlants = [];
    this.hasPreparedFrame = true;
    this.hasSyncedEntities = false;
    
    // Extract frustum planes for per-instance culling
    const frustumPlanes = extractFrustumPlanes(viewProjection);
    
    // Create command encoder for all culling compute passes
    const encoder = this.ctx.device.createCommandEncoder({ label: 'vegetation-cull-encoder' });
    
    let totalCullDispatches = 0;
    
    for (const tile of tiles) {
      for (const plant of tile.plants) {
        // Collect per-submesh index counts for indirect draw args
        const meshIndexCounts: number[] = [];
        if (plant.mesh) {
          for (const sub of plant.mesh.subMeshes) {
            meshIndexCounts.push(sub.indexCount);
          }
        }
        
        // Run culling compute pass — totalInstances read from GPU counter buffer
        const cullResult = this.cullingPipeline.cull(
          encoder,
          plant.instanceBuffer,
          plant.maxInstances,
          frustumPlanes,
          cameraPosition,
          maxDistance,
          meshIndexCounts,
          plant.renderMode ?? 0,
          plant.billboardDistance ?? 50,
          plant.counterBuffer,
        );
        
        // Run a second shadow cull pass if this plant casts shadows and its
        // shadowCastDistance differs from the color maxDistance. This produces
        // separate shadow mesh + draw args buffers on the CullResult.
        if (plant.castShadows && plant.mesh && plant.shadowCastDistance !== maxDistance) {
          this.cullingPipeline.cullForShadow(
            encoder,
            cullResult,
            plant.instanceBuffer,
            plant.maxInstances,
            frustumPlanes,
            cameraPosition,
            plant.shadowCastDistance,
            meshIndexCounts,
            plant.counterBuffer,
          );
          totalCullDispatches++;
        }
        
        this.preparedPlants.push({ plant, cullResult, lodLevel: tile.lodLevel });
        totalCullDispatches++;
      }
    }

    // Submit all culling compute passes as a single command buffer
    // This will execute before any subsequent render pass command buffer
    if (totalCullDispatches > 0) {
      this.ctx.queue.submit([encoder.finish()]);
    }
  }
  
  /**
   * Sync vegetation mesh draw group entities into the ECS world.
   * 
   * This MUST be called BEFORE the shadow pass so that VegetationInstanceComponent
   * entities have their GPU buffer references (vegInstances, drawArgsBuffer) bound.
   * The shadow pass's VariantRenderer.renderDepthOnly() reads these entities to
   * issue drawIndexedIndirect for vegetation shadow depth.
   * 
   * Safe to call multiple times per frame — subsequent calls are no-ops.
   * 
   * @param wind - Current wind parameters
   * @param time - Current animation time
   * @param maxDistance - Max vegetation render distance
   */
  syncMeshEntities(
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
  ): void {
    if (!this.initialized || this.hasSyncedEntities) return;
    if (!this.hasPreparedFrame || this.preparedPlants.length === 0) return;
    
    this.meshVariantRenderer.syncFrame(
      this.preparedPlants.map(pp => ({
        plant: {
          plantId: pp.plant.plantId,
          mesh: pp.plant.mesh,
          windInfluence: pp.plant.windInfluence,
          castShadows: pp.plant.castShadows,
          shadowCastDistance: pp.plant.shadowCastDistance ?? 50,
        },
        cullResult: pp.cullResult,
        lodLevel: pp.lodLevel,
      })),
      wind,
      time,
      maxDistance,
    );
    
    this.hasSyncedEntities = true;
  }
  
  /**
   * Render all vegetation using indirect draw with culled results.
   * 
   * Billboard and grass blade rendering happens here via standalone GPU renderers.
   * Mesh rendering is handled separately by the ECS variant pipeline — this method
   * syncs culled buffer refs into VegetationMeshVariantRenderer, which manages
   * lightweight ECS entities that VariantRenderer draws with drawIndexedIndirect.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    tiles: VegetationTileData[],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    light?: VegetationLightParams,
  ): number {
    if (!this.initialized) return 0;
    
    // Set scene environment on sub-renderers for shadow/light receiving
    this.grassBladeRenderer.setSceneEnvironment(this._sceneEnvironment);
    this.billboardRenderer.setSceneEnvironment(this._sceneEnvironment);
    
    // Reset dynamic uniform buffer slot counters for this frame
    this.billboardRenderer.resetFrame();
    this.grassBladeRenderer.resetFrame();
    
    let drawCalls = 0;
    if (this.hasPreparedFrame && this.preparedPlants.length > 0) {
      // === Billboard + grass blade indirect draw path ===
      drawCalls += this._renderBillboardsAndGrass(passEncoder, viewProjection, cameraPosition, wind, time, maxDistance, light);
      
      // === Sync mesh draw groups to ECS entities (if not already done by pre-shadow phase) ===
      // This is a no-op if syncMeshEntities() was already called earlier in the frame.
      this.syncMeshEntities(wind, time, maxDistance);
    }
    
    // Debug stats (throttled)
    this.frameCount++;
    if (this.frameCount % 120 === 0) {
      this._logDebugStats(tiles);
    }

    return drawCalls;
  }
  
  /**
   * Render billboards and grass blades using culled instance buffers.
   * Mesh rendering is handled by the ECS variant pipeline.
   */
  private _renderBillboardsAndGrass(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number,
    light?: VegetationLightParams,
  ): number {
    let drawCalls = 0;
    for (const { plant, cullResult, lodLevel } of this.preparedPlants) {
      // Scale wind by per-plant windInfluence (0 = static rock, 1 = full wind)
      const plantWind: WindParams = plant.windInfluence < 0.999
        ? { ...wind, strength: wind.strength * plant.windInfluence, gustStrength: wind.gustStrength * plant.windInfluence }
        : wind;
      
      // Grass blade mode: renderMode 3 — use grass blade renderer instead of billboard
      if (plant.renderMode === 3) {
        drawCalls += this.grassBladeRenderer.renderIndirect(
          passEncoder,
          viewProjection,
          cameraPosition,
          cullResult.billboardBuffer.buffer,
          cullResult.drawArgsBuffer.buffer,
          plant.fallbackColor,
          plantWind,
          time,
          maxDistance,
          lodLevel,
          light,
        );
        continue;
      }
      
      // Billboard indirect draw — GPU draw args contain the actual instance count
      // (0 if none survived culling). Mesh plants with renderMode 1 or 2 also have
      // billboard instances in the billboard buffer (for hybrid LOD far range).
      drawCalls += this.billboardRenderer.renderIndirect(
        passEncoder,
        viewProjection,
        cameraPosition,
        cullResult.billboardBuffer.buffer,
        cullResult.drawArgsBuffer.buffer,
        plant.billboardTexture,
        plant.billboardNormalTexture,
        plant.billboardTranslucencyTexture,
        plant.fallbackColor,
        plant.atlasRegion,
        plantWind,
        time,
        maxDistance,
        lodLevel,
        light,
      );
      
      // NOTE: Mesh indirect draw calls are NOT issued here.
      // They are handled by the ECS variant renderer via VegetationMeshVariantRenderer
      // entities → MeshRenderSystem → VariantRenderer.renderColor() → drawIndexedIndirect.
    }

    return drawCalls;
  }
  
  /**
   * Log debug stats every N frames.
   */
  private _logDebugStats(tiles: VegetationTileData[]): void {
    let totalPlants = 0;
    let totalMaxInstances = 0;
    
    for (const tile of tiles) {
      for (const plant of tile.plants) {
        totalPlants++;
        totalMaxInstances += plant.maxInstances;
      }
    }
    
    if (totalPlants > 0) {
      const activeVariantEntities = this.meshVariantRenderer.getActiveCount();
      console.log(
        `[Vegetation INDIRECT] ${totalPlants} plant draws, ${totalMaxInstances} max instances | ` +
        `Tiles: ${tiles.length} | Prepared: ${this.preparedPlants.length} | ` +
        `Variant entities: ${activeVariantEntities}`
      );
    }
  }
  
  /**
   * Set the scene environment for shadow receiving on sub-renderers.
   */
  setSceneEnvironment(env: SceneEnvironment | null): void {
    this._sceneEnvironment = env;
  }
  
  private _sceneEnvironment: SceneEnvironment | null = null;
  
  // ==================== Grass Blade Shadow Casting ====================
  
  // Dedicated shadow map for grass blade vegetation
  private vegetationShadowMap: VegetationShadowMap | null = null;
  
  /**
   * Get or lazily create the vegetation shadow map.
   */
  private ensureVegetationShadowMap(): VegetationShadowMap {
    if (!this.vegetationShadowMap) {
      this.vegetationShadowMap = new VegetationShadowMap(this.ctx);
      this.vegetationShadowMap.initialize();
    }
    return this.vegetationShadowMap;
  }
  
  /**
   * Render grass blade shadow depth pass into the dedicated vegetation shadow map.
   * 
   * This renders all grass-blade plants that have castShadows=true into a
   * 1024×1024 depth texture using the grass blade depth-only shader.
   * 
   * Must be called AFTER prepareFrame() (which produces culled billboard buffers)
   * and BEFORE the main render pass (so the shadow map is ready for sampling).
   * 
   * @param encoder - Command encoder to record the shadow render pass into
   * @param lightDirection - Normalized sun direction (pointing towards light)
   * @param cameraPosition - Camera world position (shadow map center)
   * @param wind - Current wind parameters
   * @param time - Animation time
   * @returns Number of shadow draw calls issued
   */
  renderGrassShadowPass(
    encoder: GPUCommandEncoder,
    lightDirection: [number, number, number],
    cameraPosition: [number, number, number],
    wind: WindParams,
    time: number,
  ): number {
    if (!this.initialized || !this.hasPreparedFrame) return 0;
    
    // Check if any grass-blade plants have castShadows=true
    let hasGrassShadowCasters = false;
    let maxShadowDistance = 0;
    for (const { plant } of this.preparedPlants) {
      if (plant.renderMode === 3 && plant.castShadows) {
        hasGrassShadowCasters = true;
        maxShadowDistance = Math.max(maxShadowDistance, plant.shadowCastDistance);
      }
    }
    
    if (!hasGrassShadowCasters) return 0;
    
    // Initialize shadow map if needed
    const shadowMap = this.ensureVegetationShadowMap();
    
    // Update light-space matrix with the max shadow distance as radius
    shadowMap.updateLightMatrix(lightDirection, cameraPosition, maxShadowDistance);
    
    const shadowView = shadowMap.getShadowTextureView();
    if (!shadowView) return 0;
    
    const resolution = shadowMap.getResolution();
    
    // Begin shadow depth render pass
    const passEncoder = encoder.beginRenderPass({
      label: 'vegetation-grass-shadow-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    
    passEncoder.setViewport(0, 0, resolution, resolution, 0, 1);
    
    // Reset shadow frame slot counter
    this.grassBladeRenderer.resetShadowFrame();
    
    const lightSpaceMatrix = shadowMap.getLightSpaceMatrix() as Float32Array;
    let drawCalls = 0;
    
    for (const { plant, cullResult } of this.preparedPlants) {
      if (plant.renderMode !== 3 || !plant.castShadows) continue;
      
      // Scale wind by per-plant windInfluence
      const plantWind: WindParams = plant.windInfluence < 0.999
        ? { ...wind, strength: wind.strength * plant.windInfluence, gustStrength: wind.gustStrength * plant.windInfluence }
        : wind;
      
      // Render grass blades into shadow map using the billboard buffer
      // (grass blades are routed to billboard output by the cull shader)
      drawCalls += this.grassBladeRenderer.renderShadowPassIndirect(
        passEncoder,
        lightSpaceMatrix,
        cameraPosition,
        cullResult.billboardBuffer.buffer,
        cullResult.drawArgsBuffer.buffer,
        plantWind,
        time,
        plant.shadowCastDistance,
        shadowMap.getDepthFormat(),
      );
    }
    
    passEncoder.end();
    return drawCalls;
  }
  
  /**
   * Get the vegetation shadow map (for external sampling by terrain/grass shaders).
   * Returns null if no grass shadow casters exist or shadow map hasn't been created.
   */
  getVegetationShadowMap(): VegetationShadowMap | null {
    return this.vegetationShadowMap;
  }
  
  // ==================== Mesh Shadow Casting ====================
  // NOTE: Vegetation mesh shadow casting is handled by the variant depth pipeline.
  // The VariantRenderer.renderDepthOnly() path handles vegetation-instancing entities
  // automatically when they have the 'vegetation-instancing' feature.
  
  /**
   * Get the billboard sub-renderer (for direct use).
   */
  getBillboardRenderer(): VegetationBillboardRenderer {
    return this.billboardRenderer;
  }
  
  /**
   * Get the mesh variant renderer bridge (for World setup).
   */
  getMeshVariantRenderer(): VegetationMeshVariantRenderer {
    return this.meshVariantRenderer;
  }
  
  /**
   * Clean up all GPU resources.
   */
  destroy(): void {
    this.billboardRenderer.destroy();
    this.grassBladeRenderer.destroy();
    this.cullingPipeline.destroy();
    this.meshVariantRenderer.destroy();
    this.vegetationShadowMap?.destroy();
    this.vegetationShadowMap = null;
    this.preparedPlants = [];
    this.initialized = false;
  }
}
