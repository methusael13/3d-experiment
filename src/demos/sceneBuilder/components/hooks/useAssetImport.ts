/**
 * useAssetImport - Hook for importing assets to the scene
 * Used by both double-click (AssetLibraryPanel) and drag-drop (useFileDrop)
 */

import { useCallback } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { sceneSerializer } from '../../../../loaders/SceneSerializer';
import type { Asset } from './useAssetLibrary';
import type { SceneObject } from '../../../../core/sceneObjects/SceneObject';

export interface AssetImportResult {
  success: boolean;
  object?: SceneObject;
  error?: string;
}

/**
 * Hook that provides asset import functionality
 * Encapsulates the logic for importing assets from the asset library to the scene
 */
export function useAssetImport() {
  const store = getSceneBuilderStore();
  
  /**
   * Import an asset to the scene
   * @param asset The asset to import
   * @returns Result object with success status and created object
   */
  const importAsset = useCallback(async (asset: Asset): Promise<AssetImportResult> => {
    if (!store.scene) {
      console.warn('[useAssetImport] Cannot add asset: scene not initialized');
      return { success: false, error: 'Scene not initialized' };
    }
    
    // Only handle model types for now (includes vegetation which is type='model' with category='vegetation')
    if (asset.type !== 'model') {
      console.log(`[useAssetImport] Asset type "${asset.type}" not yet supported for scene import`);
      return { success: false, error: `Asset type "${asset.type}" not supported` };
    }
    
    try {
      // Find the main model file for this asset
      // First try by fileType, then fallback to extension matching
      let modelFile = asset.files.find(f => f.fileType === 'model' && (f.lodLevel === null || f.lodLevel === 0));
      
      // Fallback: find .gltf or .glb file by extension if fileType wasn't set
      if (!modelFile) {
        modelFile = asset.files.find(f => 
          f.path.endsWith('.gltf') || f.path.endsWith('.glb')
        );
      }
      
      const filePath = modelFile?.path ?? asset.path;
      
      // Normalize path to include leading slash for Vite to serve from public/
      const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
      
      // Add object to scene
      const obj = await store.scene.addObject(normalizedPath, asset.name);
      
      if (obj) {
        // Register the asset reference for save/load tracking
        sceneSerializer.registerAssetRef(obj.id, {
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
          assetSubtype: asset.subtype ?? undefined,
        });
        
        // Select the newly added object
        store.scene.select(obj.id);
        store.syncFromScene();
        
        console.log(`[useAssetImport] Added asset "${asset.name}" to scene (id: ${obj.id})`);
        return { success: true, object: obj };
      } else {
        console.error(`[useAssetImport] Failed to add asset "${asset.name}" to scene`);
        return { success: false, error: 'Failed to add object to scene' };
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
 * Useful for contexts where hooks cannot be used
 */
export async function importAssetToScene(asset: Asset): Promise<AssetImportResult> {
  const store = getSceneBuilderStore();
  
  if (!store.scene) {
    console.warn('[importAssetToScene] Cannot add asset: scene not initialized');
    return { success: false, error: 'Scene not initialized' };
  }
  
  // Only handle model types for now
  if (asset.type !== 'model') {
    console.log(`[importAssetToScene] Asset type "${asset.type}" not yet supported for scene import`);
    return { success: false, error: `Asset type "${asset.type}" not supported` };
  }
  
  try {
    // Find the main model file for this asset
    let modelFile = asset.files.find(f => f.fileType === 'model' && (f.lodLevel === null || f.lodLevel === 0));
    
    // Fallback: find .gltf or .glb file by extension if fileType wasn't set
    if (!modelFile) {
      modelFile = asset.files.find(f => 
        f.path.endsWith('.gltf') || f.path.endsWith('.glb')
      );
    }
    
    const filePath = modelFile?.path ?? asset.path;
    
    // Normalize path to include leading slash for Vite to serve from public/
    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    
    // Add object to scene
    const obj = await store.scene.addObject(normalizedPath, asset.name);
    
    if (obj) {
      // Register the asset reference for save/load tracking
      sceneSerializer.registerAssetRef(obj.id, {
        assetId: asset.id,
        assetName: asset.name,
        assetType: asset.type,
        assetSubtype: asset.subtype ?? undefined,
      });
      
      // Select the newly added object
      store.scene.select(obj.id);
      store.syncFromScene();
      
      console.log(`[importAssetToScene] Added asset "${asset.name}" to scene (id: ${obj.id})`);
      return { success: true, object: obj };
    } else {
      console.error(`[importAssetToScene] Failed to add asset "${asset.name}" to scene`);
      return { success: false, error: 'Failed to add object to scene' };
    }
  } catch (err) {
    console.error(`[importAssetToScene] Error importing asset "${asset.name}":`, err);
    return { success: false, error: String(err) };
  }
}
