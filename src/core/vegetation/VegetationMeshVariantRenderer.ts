/**
 * VegetationMeshVariantRenderer
 * 
 * Bridge between VegetationManager's GPU culling output and the ECS/Variant
 * renderer pipeline. Manages lightweight ECS entities that represent vegetation
 * draw groups (plant-type × tile × submesh), syncing GPU buffer references
 * from the culling pipeline into VegetationInstanceComponent properties
 * each frame.
 * 
 * Entity lifecycle:
 * - Created when a new plant-type+tile combo with a mesh appears in preparedPlants
 * - Updated each frame with fresh culled buffer refs + wind params
 * - Destroyed when the tile is unloaded or the plant type is removed
 * 
 * This class does NOT issue draw calls — the VariantRenderer handles that
 * through the standard MeshRenderSystem → variant pipeline path.
 * 
 * GPU Wiring:
 * - Registers each vegetation submesh's vertex/index buffers in VariantMeshPool
 *   via addMeshFromRawBuffers() (identity model matrix, PBR material)
 * - Creates MeshComponent on each entity so MeshRenderSystem can find GPU mesh IDs
 * - Binds the culled vegInstances storage buffer as a texture-group resource
 *   via VariantMeshPool.setTextureResource() each frame
 */

import type { GPUContext } from '../gpu/GPUContext';
import type { VariantMeshPool } from '../gpu/pipeline/VariantMeshPool';
import type { World } from '../ecs/World';
import { Entity } from '../ecs/Entity';
import { TransformComponent } from '../ecs/components/TransformComponent';
import { MeshComponent } from '../ecs/components/MeshComponent';
import { ShadowComponent } from '../ecs/components/ShadowComponent';
import { VegetationInstanceComponent } from '../ecs/components/VegetationInstanceComponent';
import { RES } from '../gpu/shaders/composition/resourceNames';
import type { VegetationMesh, VegetationSubMesh } from './types';
import type { WindParams } from './types';
import type { CullResult } from './VegetationCullingPipeline';
import type { GPUMaterial, GPUMaterialTextures } from '../gpu/renderers/ObjectRendererGPU';

// ==================== Types ====================

/** Key for tracking vegetation draw group entities */
type DrawGroupKey = string; // `${plantId}:${subMeshIdx}`

interface DrawGroupEntity {
  entity: Entity;
  vegComp: VegetationInstanceComponent;
  meshComp: MeshComponent;
  plantId: string;
  tileId: string;
  subMeshIdx: number;
  /** GPU mesh ID in VariantMeshPool (for cleanup + texture resource binding) */
  poolMeshId: number;
}

// ==================== VegetationMeshVariantRenderer ====================

export class VegetationMeshVariantRenderer {
  private ctx: GPUContext;
  private world: World | null = null;
  
  /** Active vegetation draw group entities, keyed by `plantId:subMeshIdx` */
  private drawGroups: Map<DrawGroupKey, DrawGroupEntity> = new Map();
  
  /** Set of keys that were active this frame (for pruning stale entities) */
  private _activeKeysThisFrame: Set<DrawGroupKey> = new Set();
  
  private initialized = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  /**
   * Set the ECS World reference. Must be called before syncFrame.
   * The world is used to add/remove vegetation draw group entities.
   */
  setWorld(world: World): void {
    this.world = world;
    this.initialized = true;
  }
  
  /**
   * Sync vegetation mesh draw groups for the current frame.
   * 
   * Called by VegetationRenderer after prepareFrame() produces culled results.
   * For each plant with a mesh, creates or updates ECS entities with fresh
   * GPU buffer references and wind parameters.
   * 
   * @param preparedPlants - Array of plants with their cull results from prepareFrame()
   * @param wind - Current wind parameters
   * @param time - Current animation time
   * @param maxDistance - Max vegetation render distance
   */
  syncFrame(
    preparedPlants: Array<{
      plant: {
        plantId: string;
        mesh: VegetationMesh | null;
        windInfluence: number;
        castShadows: boolean;
        shadowCastDistance: number;
      };
      cullResult: CullResult;
      lodLevel: number;
      tileId?: string;
    }>,
    wind: WindParams,
    time: number,
    maxDistance: number,
  ): void {
    if (!this.initialized || !this.world) return;
    
    this._activeKeysThisFrame.clear();
    
    // Track per-plantId occurrence index so multiple tiles with the same plant
    // get separate ECS entities (each tile has its own cull result buffers).
    const plantOccurrenceCount = new Map<string, number>();

    for (const { plant, cullResult } of preparedPlants) {
      if (!plant.mesh) continue;
      
      const mesh = plant.mesh;
      const plantId = plant.plantId;
      const occurrence = plantOccurrenceCount.get(plantId) ?? 0;
      plantOccurrenceCount.set(plantId, occurrence + 1);
      
      // Scale wind by per-plant windInfluence
      const scaledWindStrength = wind.strength * plant.windInfluence;
      const scaledGustStrength = wind.gustStrength * plant.windInfluence;
      
      for (let subMeshIdx = 0; subMeshIdx < mesh.subMeshes.length; subMeshIdx++) {
        const subMesh = mesh.subMeshes[subMeshIdx];
        const key: DrawGroupKey = `${plantId}:${occurrence}:${subMeshIdx}`;
        this._activeKeysThisFrame.add(key);
        
        let group = this.drawGroups.get(key);
        if (!group) {
          // Create new ECS entity for this draw group
          const newGroup = this._createDrawGroupEntity(plantId, subMeshIdx, mesh, subMesh);
          if (!newGroup) continue; // Skip if creation failed
          group = newGroup;
          this.drawGroups.set(key, group);
        }
        
        // Update buffer references + wind params each frame
        const vegComp = group.vegComp;
        vegComp.culledInstanceBuffer = cullResult.meshBuffer.buffer;
        vegComp.drawArgsBuffer = cullResult.drawArgsBuffer.buffer;
        vegComp.drawArgsOffset = 16 + subMeshIdx * 20; // billboard=16 bytes, each mesh arg=20 bytes
        
        // Bind shadow-specific buffers if a separate shadow cull pass was run.
        // When non-null, VariantRenderer.renderDepthOnly() uses these instead of
        // the color buffers, allowing shadow rendering with shadowCastDistance.
        if (cullResult.shadowMeshBuffer && cullResult.shadowDrawArgsBuffer) {
          vegComp.shadowCulledInstanceBuffer = cullResult.shadowMeshBuffer.buffer;
          vegComp.shadowDrawArgsBuffer = cullResult.shadowDrawArgsBuffer.buffer;
          vegComp.shadowDrawArgsOffset = 16 + subMeshIdx * 20;
        } else {
          vegComp.shadowCulledInstanceBuffer = null;
          vegComp.shadowDrawArgsBuffer = null;
          vegComp.shadowDrawArgsOffset = 0;
        }
        
        vegComp.windStrength = scaledWindStrength;
        vegComp.windFrequency = wind.frequency;
        vegComp.windDirection = [...wind.direction];
        vegComp.gustStrength = scaledGustStrength;
        vegComp.gustFrequency = wind.gustFrequency;
        vegComp.windMultiplier = subMesh.windMultiplier;
        vegComp.time = time;
        vegComp.maxDistance = maxDistance;
        vegComp.active = true;
        
        // Update ShadowComponent with per-plant castShadows + shadowCastDistance.
        // VariantRenderer.renderDepthOnly() checks ShadowComponent.castsShadow
        // to decide whether to include this entity in the shadow depth pass.
        const shadowComp = group.entity.getComponent<ShadowComponent>('shadow');
        if (shadowComp) {
          shadowComp.castsShadow = plant.castShadows;
          shadowComp.maxShadowDistance = plant.shadowCastDistance;
        }
        
        // Bind the culled instance buffer as a texture-group resource (RES.VEG_INSTANCES)
        // so the composed shader can read PlantInstance structs by instance_index.
        // This must be done every frame because the buffer reference may change
        // when the culling pipeline recycles buffers.
        if (cullResult.meshBuffer.buffer) {
          this.ctx.variantMeshPool.setTextureResource(
            group.poolMeshId,
            RES.VEG_INSTANCES,
            { buffer: cullResult.meshBuffer.buffer },
          );
        }
      }
    }
    
    // Deactivate stale draw groups (tiles that were unloaded or plants that changed)
    for (const [key, group] of this.drawGroups) {
      if (!this._activeKeysThisFrame.has(key)) {
        group.vegComp.active = false;
        group.vegComp.culledInstanceBuffer = null;
        group.vegComp.drawArgsBuffer = null;
      }
    }
  }
  
  /**
   * Create an ECS entity for a vegetation draw group.
   * 
   * The entity has:
   * - TransformComponent with identity matrix (instance buffer provides world position)
   * - MeshComponent with GPU mesh ID registered in VariantMeshPool
   * - VegetationInstanceComponent for GPU buffer refs and wind params
   * 
   * Registers the submesh's vertex/index buffers in VariantMeshPool via
   * addMeshFromRawBuffers() with identity model matrix and PBR material
   * derived from the submesh's base color texture.
   */
  private _createDrawGroupEntity(
    plantId: string,
    subMeshIdx: number,
    mesh: VegetationMesh,
    subMesh: VegetationSubMesh,
  ): DrawGroupEntity | null {
    const entity = new Entity(`veg-${plantId}-s${subMeshIdx}`);
    // Mark as internal so it doesn't appear in the Objects panel
    entity.internal = true;
    
    // Identity transform (instance buffer provides world positioning)
    const transform = new TransformComponent();
    entity.addComponent(transform);
    
    // Register submesh in VariantMeshPool with identity model matrix + PBR material
    const meshPool = this.ctx.variantMeshPool;
    
    // Build PBR material from submesh data
    // Use MASK alpha mode for vegetation — leaf textures have transparent regions
    // that must be discarded via alpha cutoff to avoid rendering as opaque black.
    const material: Partial<GPUMaterial> = {
      albedo: [0.7, 0.7, 0.7],
      metallic: 0.0,
      roughness: 0.5,
      doubleSided: true, // Vegetation is typically double-sided
      alphaMode: 'MASK',
      alphaCutoff: 0.5,
    };
    
    // Set up all available PBR textures from the submesh
    const hasAnyTexture = subMesh.baseColorTexture || subMesh.normalTexture || 
      subMesh.metallicRoughnessTexture || subMesh.occlusionTexture || subMesh.emissiveTexture;
    if (hasAnyTexture) {
      const textures: Partial<GPUMaterialTextures> = {};
      if (subMesh.baseColorTexture) textures.baseColor = subMesh.baseColorTexture;
      if (subMesh.normalTexture) textures.normal = subMesh.normalTexture;
      if (subMesh.metallicRoughnessTexture) textures.metallicRoughness = subMesh.metallicRoughnessTexture;
      if (subMesh.occlusionTexture) textures.occlusion = subMesh.occlusionTexture;
      if (subMesh.emissiveTexture) textures.emissive = subMesh.emissiveTexture;
      material.textures = textures as GPUMaterialTextures;
    }
    
    // Compute vertex count from index data
    // The interleaved buffer is 32 bytes per vertex (8 floats × 4 bytes)
    const vertexBufferSize = subMesh.vertexBuffer.size;
    const vertexCount = vertexBufferSize / 32;
    
    const poolMeshId = meshPool.addMeshFromRawBuffers(
      subMesh.vertexBuffer,
      subMesh.indexBuffer,
      subMesh.indexCount,
      vertexCount,
      subMesh.indexFormat,
      material,
    );
    
    // Create MeshComponent that references the pool mesh ID
    // This is a lightweight MeshComponent — it doesn't own a GLBModel,
    // it just stores the GPU mesh ID so MeshRenderSystem can find it.
    const meshComp = new MeshComponent();
    meshComp.gpuMeshIds = [poolMeshId];
    meshComp.gpuContext = this.ctx;
    entity.addComponent(meshComp);
    
    // Vegetation instance component (buffer refs set per-frame by syncFrame)
    const vegComp = new VegetationInstanceComponent();
    vegComp.plantId = plantId;
    vegComp.active = false;
    entity.addComponent(vegComp);
    
    // Shadow component — controls whether this plant participates in shadow passes.
    // castsShadow and maxShadowDistance are updated per-frame by syncFrame()
    // from the per-plant castShadows/shadowCastDistance settings.
    const shadowComp = new ShadowComponent();
    shadowComp.castsShadow = false; // Default off, updated per-frame
    shadowComp.receivesShadow = false; // Vegetation receives shadows via PBR pipeline, not ShadowComponent
    shadowComp.maxShadowDistance = 50;
    entity.addComponent(shadowComp);
    
    // Add to ECS world
    this.world!.addEntity(entity);
    
    console.log(`[VegetationMeshVariantRenderer] Created entity "${entity.name}" poolMeshId=${poolMeshId}`);
    
    return {
      entity,
      vegComp,
      meshComp,
      plantId,
      tileId: '',
      subMeshIdx,
      poolMeshId,
    };
  }
  
  /**
   * Remove all vegetation draw group entities from the ECS world.
   * Called when vegetation is disabled or the system is destroyed.
   */
  clearAllEntities(): void {
    if (!this.world) return;
    
    const meshPool = this.ctx.variantMeshPool;
    for (const [_key, group] of this.drawGroups) {
      // Remove mesh from pool (keeps raw vertex/index buffers)
      meshPool.removeMeshKeepBuffers(group.poolMeshId);
      this.world.destroyEntity(group.entity.id);
    }
    this.drawGroups.clear();
    this._activeKeysThisFrame.clear();
  }
  
  /**
   * Remove draw group entities for a specific plant type.
   */
  removeEntitiesForPlant(plantId: string): void {
    if (!this.world) return;
    
    const meshPool = this.ctx.variantMeshPool;
    const keysToRemove: DrawGroupKey[] = [];
    for (const [key, group] of this.drawGroups) {
      if (group.plantId === plantId) {
        meshPool.removeMeshKeepBuffers(group.poolMeshId);
        this.world.destroyEntity(group.entity.id);
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      this.drawGroups.delete(key);
    }
  }
  
  /**
   * Get the number of active vegetation draw group entities.
   */
  getActiveCount(): number {
    let count = 0;
    for (const group of this.drawGroups.values()) {
      if (group.vegComp.active) count++;
    }
    return count;
  }
  
  destroy(): void {
    this.clearAllEntities();
    this.world = null;
    this.initialized = false;
  }
}
