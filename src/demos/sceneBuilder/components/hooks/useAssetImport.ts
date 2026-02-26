/**
 * useAssetImport - Hook for importing assets to the scene (ECS Step 3)
 * Uses ECS factories to create model entities in the World.
 */

import { useCallback } from 'preact/hooks';
import { getSceneBuilderStore, type SceneBuilderStore } from '../state';
import { sceneSerializer } from '../../../../loaders/SceneSerializer';
import { loadGLB, loadGLBNodes, getModelUrl, type GLBModel } from '../../../../loaders';
import { promptImportMode } from '../ui/ImportModeDialog/ImportModeDialog';
import { createModelEntity } from '@/core/ecs/factories';
import { MeshComponent } from '@/core/ecs/components/MeshComponent';
import { BoundsComponent } from '@/core/ecs/components/BoundsComponent';
import type { Asset } from './useAssetLibrary';
import type { Entity } from '@/core/ecs/Entity';

export interface AssetImportResult {
  success: boolean;
  entity?: Entity;
  /** All created entities (for multi-node imports) */
  entities?: Entity[];
  error?: string;
}

/**
 * Hook that provides asset import functionality
 */
export function useAssetImport() {
  const store = getSceneBuilderStore();
  
  const importAsset = useCallback(async (asset: Asset): Promise<AssetImportResult> => {
    const world = store.world;
    if (!world) {
      console.warn('[useAssetImport] Cannot add asset: world not initialized');
      return { success: false, error: 'World not initialized' };
    }
    
    if (asset.type !== 'model') {
      console.log(`[useAssetImport] Asset type "${asset.type}" not yet supported`);
      return { success: false, error: `Asset type "${asset.type}" not supported` };
    }
    
    try {
      let modelFile = asset.files.find(f => f.fileType === 'model' && (f.lodLevel === null || f.lodLevel === 0));
      if (!modelFile) {
        modelFile = asset.files.find(f => f.path.endsWith('.gltf') || f.path.endsWith('.glb'));
      }
      
      const filePath = modelFile?.path ?? asset.path;
      const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
      const resolvedUrl = getModelUrl(normalizedPath);
      
      // Probe for multi-node content
      const nodeModels = await loadGLBNodes(resolvedUrl);
      
      let importAsSeparate = false;
      if (nodeModels.length > 1) {
        const nodeNames = nodeModels.map(n => n.name);
        const mode = await promptImportMode(asset.name, nodeNames);
        if (mode === 'cancel') {
          return { success: false, error: 'Import cancelled by user' };
        }
        importAsSeparate = (mode === 'separate');
      }
      
      const entities: Entity[] = [];
      
      if (importAsSeparate) {
        // Create a separate entity per node
        // Each GLBNodeModel has the same shape as GLBModel
        for (const nodeModel of nodeModels) {
          const entity = createModelEntity(world, {
            name: nodeModel.name || asset.name,
            modelPath: normalizedPath,
          });
          
          // Set the GLB model data on MeshComponent and compute bounds
          const mesh = entity.getComponent<MeshComponent>('mesh');
          if (mesh) {
            mesh.modelPath = normalizedPath;
            mesh.model = nodeModel as unknown as GLBModel;
            const boundsComp = entity.getComponent<BoundsComponent>('bounds');
            if (boundsComp) {
              boundsComp.localBounds = mesh.computeLocalBounds();
              boundsComp.dirty = true;
            }
            // Init GPU after model data is set (onEntityAdded fires before model is available)
            store.initEntityWebGPU(entity);
          }
          
          entities.push(entity);
        }
      } else {
        // Import as single combined entity
        const model = await loadGLB(resolvedUrl);
        if (model) {
          const entity = createModelEntity(world, {
            name: asset.name,
            modelPath: normalizedPath,
          });
          
          const mesh = entity.getComponent<MeshComponent>('mesh');
          if (mesh) {
            mesh.modelPath = normalizedPath;
            mesh.model = model;
            const boundsComp = entity.getComponent<BoundsComponent>('bounds');
            if (boundsComp) {
              boundsComp.localBounds = mesh.computeLocalBounds();
              boundsComp.dirty = true;
            }
            // Init GPU after model data is set (onEntityAdded fires before model is available)
            store.initEntityWebGPU(entity);
          }
          
          entities.push(entity);
        }
      }
      
      if (entities.length > 0) {
        // Register asset references
        for (const entity of entities) {
          sceneSerializer.registerAssetRef(entity.id, {
            assetId: asset.id,
            assetName: asset.name,
            assetType: asset.type,
            assetSubtype: asset.subtype ?? undefined,
          });
        }
        
        // Select new entities
        if (entities.length === 1) {
          world.select(entities[0].id);
        } else {
          world.selectAll(entities.map(e => e.id));
        }
        
        // GPU init happens automatically via world.onEntityAdded → store.initEntityWebGPU
        
        console.log(`[useAssetImport] Added asset "${asset.name}" (${entities.length} entity(ies))`);
        return { success: true, entity: entities[0], entities };
      } else {
        console.error(`[useAssetImport] Failed to add asset "${asset.name}"`);
        return { success: false, error: 'Failed to add entity to world' };
      }
    } catch (err) {
      console.error(`[useAssetImport] Error importing asset "${asset.name}":`, err);
      return { success: false, error: String(err) };
    }
  }, [store]);
  
  return { importAsset };
}

/**
 * Standalone function for importing assets (non-hook version)
 */
export async function importAssetToScene(asset: Asset): Promise<AssetImportResult> {
  const store = getSceneBuilderStore();
  const world = store.world;
  
  if (!world) {
    console.warn('[importAssetToScene] Cannot add asset: world not initialized');
    return { success: false, error: 'World not initialized' };
  }
  
  if (asset.type !== 'model') {
    return { success: false, error: `Asset type "${asset.type}" not supported` };
  }
  
  try {
    let modelFile = asset.files.find(f => f.fileType === 'model' && (f.lodLevel === null || f.lodLevel === 0));
    if (!modelFile) {
      modelFile = asset.files.find(f => f.path.endsWith('.gltf') || f.path.endsWith('.glb'));
    }
    
    const filePath = modelFile?.path ?? asset.path;
    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    const resolvedUrl = getModelUrl(normalizedPath);
    
    const nodeModels = await loadGLBNodes(resolvedUrl);
    
    let importAsSeparate = false;
    if (nodeModels.length > 1) {
      const nodeNames = nodeModels.map(n => n.name);
      const mode = await promptImportMode(asset.name, nodeNames);
      if (mode === 'cancel') {
        return { success: false, error: 'Import cancelled by user' };
      }
      importAsSeparate = (mode === 'separate');
    }
    
    const entities: Entity[] = [];
    
    if (importAsSeparate) {
      for (const nodeModel of nodeModels) {
        const entity = createModelEntity(world, {
          name: nodeModel.name || asset.name,
          modelPath: normalizedPath,
        });
        const mesh = entity.getComponent<MeshComponent>('mesh');
        if (mesh) {
          mesh.modelPath = normalizedPath;
          mesh.model = nodeModel as unknown as GLBModel;
          const boundsComp = entity.getComponent<BoundsComponent>('bounds');
          if (boundsComp) {
            boundsComp.localBounds = mesh.computeLocalBounds();
            boundsComp.dirty = true;
          }
          store.initEntityWebGPU(entity);
        }
        entities.push(entity);
      }
    } else {
      const model = await loadGLB(resolvedUrl);
      if (model) {
        const entity = createModelEntity(world, {
          name: asset.name,
          modelPath: normalizedPath,
        });
        const mesh = entity.getComponent<MeshComponent>('mesh');
        if (mesh) {
          mesh.modelPath = normalizedPath;
          mesh.model = model;
          const boundsComp = entity.getComponent<BoundsComponent>('bounds');
          if (boundsComp) {
            boundsComp.localBounds = mesh.computeLocalBounds();
            boundsComp.dirty = true;
          }
          store.initEntityWebGPU(entity);
        }
        entities.push(entity);
      }
    }
    
    if (entities.length > 0) {
      for (const entity of entities) {
        sceneSerializer.registerAssetRef(entity.id, {
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
          assetSubtype: asset.subtype ?? undefined,
        });
      }
      
      if (entities.length === 1) {
        world.select(entities[0].id);
      } else {
        world.selectAll(entities.map(e => e.id));
      }
      
      console.log(`[importAssetToScene] Added asset "${asset.name}" (${entities.length} entity(ies))`);
      return { success: true, entity: entities[0], entities };
    } else {
      return { success: false, error: 'Failed to add entity to world' };
    }
  } catch (err) {
    console.error(`[importAssetToScene] Error importing asset "${asset.name}":`, err);
    return { success: false, error: String(err) };
  }
}