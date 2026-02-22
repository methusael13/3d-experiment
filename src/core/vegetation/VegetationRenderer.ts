/**
 * VegetationRenderer - Orchestrates billboard and mesh vegetation renderers.
 * 
 * Now includes a GPU culling compute pass that runs BEFORE the render pass:
 * 1. prepareFrame() — runs culling compute passes for all visible plants,
 *    producing compacted instance buffers + indirect draw args
 * 2. render() — uses drawIndirect/drawIndexedIndirect with only visible instances
 * 
 * This eliminates wasted vertex shader invocations from non-visible or
 * wrong-render-type instances.
 */

import { GPUContext, UnifiedGPUBuffer, UnifiedGPUTexture } from '../gpu';
import { VegetationBillboardRenderer } from './VegetationBillboardRenderer';
import { VegetationMeshRenderer, type VegetationMesh } from './VegetationMeshRenderer';
import { VegetationGrassBladeRenderer } from './VegetationGrassBladeRenderer';
import { VegetationCullingPipeline, type CullResult } from './VegetationCullingPipeline';
import type { WindParams, VegetationLightParams } from './types';
import { extractFrustumPlanes } from '../utils/mathUtils';

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
  /** 3D mesh for this plant type (null = billboard only) */
  mesh: VegetationMesh | null;
  /** Render mode: 0=billboard, 1=mesh, 2=hybrid (used for per-frame LOD in cull shader) */
  renderMode: number;
  /** Distance threshold for hybrid mode: closer = mesh, farther = billboard */
  billboardDistance: number;
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

/** Max mesh instances per draw to prevent GPU stall (shader skips non-mesh instances anyway) */
const MAX_MESH_DRAW_INSTANCES = 4096;

export class VegetationRenderer {
  private ctx: GPUContext;
  private billboardRenderer: VegetationBillboardRenderer;
  private meshRenderer: VegetationMeshRenderer;
  private grassBladeRenderer: VegetationGrassBladeRenderer;
  private cullingPipeline: VegetationCullingPipeline;
  private initialized = false;
  private frameCount = 0;
  
  // Prepared cull results from prepareFrame(), consumed by render()
  private preparedPlants: PreparedPlant[] = [];
  private hasPreparedFrame = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.billboardRenderer = new VegetationBillboardRenderer(ctx);
    this.meshRenderer = new VegetationMeshRenderer(ctx);
    this.grassBladeRenderer = new VegetationGrassBladeRenderer(ctx);
    this.cullingPipeline = new VegetationCullingPipeline(ctx);
  }
  
  /**
   * Initialize both sub-renderers and the culling pipeline.
   */
  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;
    
    this.billboardRenderer.initialize(depthFormat, colorFormat);
    this.meshRenderer.initialize(depthFormat, colorFormat);
    this.grassBladeRenderer.initialize(depthFormat, colorFormat);
    this.cullingPipeline.initialize();
    this.initialized = true;
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
    
    // Extract frustum planes for per-instance culling
    const frustumPlanes = extractFrustumPlanes(viewProjection);
    
    // Create command encoder for all culling compute passes
    const encoder = this.ctx.device.createCommandEncoder({ label: 'vegetation-cull-encoder' });
    
    let totalCullDispatches = 0;
    
    for (const tile of tiles) {
      for (const plant of tile.plants) {
        // Determine mesh index count for indirect draw args
        let meshIndexCount = 0;
        if (plant.mesh) {
          for (const sub of plant.mesh.subMeshes) {
            meshIndexCount = Math.max(meshIndexCount, sub.indexCount);
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
          meshIndexCount,
          plant.renderMode ?? 0,
          plant.billboardDistance ?? 50,
          plant.counterBuffer,
        );
        
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
   * Render all vegetation using indirect draw with culled results.
   * 
   * If prepareFrame() was called, uses drawIndirect with culled buffers.
   * Otherwise falls back to the legacy direct draw path.
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
  ): void {
    if (!this.initialized) return;
    
    // Reset dynamic uniform buffer slot counters for this frame
    this.billboardRenderer.resetFrame();
    this.meshRenderer.resetFrame();
    this.grassBladeRenderer.resetFrame();
    
    if (this.hasPreparedFrame && this.preparedPlants.length > 0) {
      // === Indirect draw path (GPU-culled) ===
      this._renderIndirect(passEncoder, viewProjection, cameraPosition, wind, time, maxDistance, light);
    } else {
      // === Legacy direct draw path (fallback) ===
      this._renderDirect(passEncoder, viewProjection, cameraPosition, tiles, wind, time, maxDistance, light);
    }
    
    // Debug stats (throttled)
    this.frameCount++;
    if (this.frameCount % 120 === 0) {
      this._logDebugStats(tiles);
    }

    // Clear prepared state for next frame
    this.hasPreparedFrame = false;
  }
  
  /**
   * Indirect draw path — uses culled instance buffers from prepareFrame().
   */
  private _renderIndirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number,
    light?: VegetationLightParams,
  ): void {
    for (const { plant, cullResult, lodLevel } of this.preparedPlants) {
      // Grass blade mode: renderMode 3 — use grass blade renderer instead of billboard
      if (plant.renderMode === 3) {
        this.grassBladeRenderer.renderIndirect(
          passEncoder,
          viewProjection,
          cameraPosition,
          cullResult.billboardBuffer.buffer,
          cullResult.drawArgsBuffer.buffer,
          plant.fallbackColor,
          wind,
          time,
          maxDistance,
          lodLevel,
          light,
        );
        continue;
      }
      
      // Always dispatch billboard indirect draw — the GPU draw args contain the
      // actual instance count (0 if none survived culling). We can't rely on
      // spawn-time billboardCount because the cull shader re-evaluates hybrid LOD.
      this.billboardRenderer.renderIndirect(
        passEncoder,
        viewProjection,
        cameraPosition,
        cullResult.billboardBuffer.buffer,
        cullResult.drawArgsBuffer.buffer,
        plant.billboardTexture,
        plant.fallbackColor,
        plant.atlasRegion,
        wind,
        time,
        maxDistance,
        lodLevel,
      );
      
      // Always dispatch mesh indirect draw if the plant has a mesh loaded.
      // GPU draw args will have instanceCount=0 if no mesh instances survived culling.
      if (plant.mesh) {
        this.meshRenderer.renderIndirect(
          passEncoder,
          viewProjection,
          cameraPosition,
          plant.mesh,
          cullResult.meshBuffer.buffer,
          cullResult.drawArgsBuffer.buffer,
          wind,
          time,
          maxDistance,
        );
      }
    }
  }
  
  /**
   * Legacy direct draw path — no GPU culling, shaders skip wrong render type.
   */
  private _renderDirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    tiles: VegetationTileData[],
    wind: WindParams,
    time: number,
    maxDistance: number,
    light?: VegetationLightParams,
  ): void {
    // Legacy direct path — uses maxInstances as instance count (GPU shader skips empty slots)
    for (const tile of tiles) {
      for (const plant of tile.plants) {
        if (plant.renderMode === 3) {
          // Grass blade mode
          this.grassBladeRenderer.render(
            passEncoder, viewProjection, cameraPosition,
            plant.instanceBuffer, plant.maxInstances,
            plant.fallbackColor,
            wind, time, maxDistance, light,
          );
          continue;
        }
        this.billboardRenderer.render(
          passEncoder, viewProjection, cameraPosition,
          plant.instanceBuffer, plant.maxInstances,
          plant.billboardTexture, plant.fallbackColor, plant.atlasRegion,
          wind, time, maxDistance,
        );
        if (plant.mesh) {
          this.meshRenderer.render(
            passEncoder, viewProjection, cameraPosition,
            plant.mesh, plant.instanceBuffer, plant.maxInstances,
            wind, time, maxDistance,
          );
        }
      }
    }
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
      const mode = this.hasPreparedFrame ? 'INDIRECT' : 'DIRECT';
      console.log(
        `[Vegetation ${mode}] ${totalPlants} plant draws, ${totalMaxInstances} max instances | ` +
        `Tiles: ${tiles.length} | Prepared: ${this.preparedPlants.length}`
      );
    }
  }
  
  /**
   * Get the billboard sub-renderer (for direct use).
   */
  getBillboardRenderer(): VegetationBillboardRenderer {
    return this.billboardRenderer;
  }
  
  /**
   * Get the mesh sub-renderer (for direct use).
   */
  getMeshRenderer(): VegetationMeshRenderer {
    return this.meshRenderer;
  }
  
  /**
   * Clean up all GPU resources.
   */
  destroy(): void {
    this.billboardRenderer.destroy();
    this.meshRenderer.destroy();
    this.grassBladeRenderer.destroy();
    this.cullingPipeline.destroy();
    this.preparedPlants = [];
    this.initialized = false;
  }
}
