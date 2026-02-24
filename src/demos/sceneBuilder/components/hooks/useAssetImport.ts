/**
 * useAssetImport - Hook for importing assets to the scene
 * Used by both double-click (AssetLibraryPanel) and drag-drop (useFileDrop)
 */

import { useCallback } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { sceneSerializer } from '../../../../loaders/SceneSerializer';
import { loadGLBNodes, getModelUrl } from '../../../../loaders';
import { promptImportMode } from '../ui/ImportModeDialog/ImportModeDialog';
import type { Asset } from './useAssetLibrary';
import type { SceneObject } from '../../../../core/sceneObjects/SceneObject';

export interface AssetImportResult {
  success: boolean;
  object?: SceneObject;
  /** All created objects (for multi-node imports) */
  objects?: SceneObject[];
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
      
      // Probe the file for multi-node content
      const resolvedUrl = getModelUrl(normalizedPath);
      const nodeModels = await loadGLBNodes(resolvedUrl);
      
      // Determine import mode
      let importAsSeparate = false;
      
      if (nodeModels.length > 1) {
        // Show dialog and wait for user choice
        const nodeNames = nodeModels.map(n => n.name);
        const mode = await promptImportMode(asset.name, nodeNames);
        
        if (mode === 'cancel') {
          return { success: false, error: 'Import cancelled by user' };
        }
        
        importAsSeparate = (mode === 'separate');
      }
      
      // Perform the actual import based on user choice
      let objects: SceneObject[];
      
      if (importAsSeparate) {
        // Split into separate objects per node
        objects = await store.scene.addObjects(normalizedPath, asset.name);
      } else {
        // Import as single combined object (original behavior)
        const obj = await store.scene.addObject(normalizedPath, asset.name);
        objects = obj ? [obj] : [];
      }
      
      if (objects.length > 0) {
        // Register asset references for all created objects
        for (const obj of objects) {
          sceneSerializer.registerAssetRef(obj.id, {
            assetId: asset.id,
            assetName: asset.name,
            assetType: asset.type,
            assetSubtype: asset.subtype ?? undefined,
          });
        }
        
        // Select the first object (or all if multi-node)
        if (objects.length === 1) {
          store.scene.select(objects[0].id);
        } else {
          store.scene.selectAll(objects.map(o => o.id));
        }
        store.syncFromScene();
        
        console.log(`[useAssetImport] Added asset "${asset.name}" to scene (${objects.length} object(s))`);
        return { success: true, object: objects[0], objects };
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
    
    // Probe the file for multi-node content
    const resolvedUrl = getModelUrl(normalizedPath);
    const nodeModels = await loadGLBNodes(resolvedUrl);
    
    // Determine import mode
    let importAsSeparate = false;
    
    if (nodeModels.length > 1) {
      const nodeNames = nodeModels.map(n => n.name);
      const mode = await promptImportMode(asset.name, nodeNames);
      
      if (mode === 'cancel') {
        return { success: false, error: 'Import cancelled by user' };
      }
      
      importAsSeparate = (mode === 'separate');
    }
    
    // Perform the actual import based on user choice
    let objects: SceneObject[];
    
    if (importAsSeparate) {
      objects = await store.scene.addObjects(normalizedPath, asset.name);
    } else {
      const obj = await store.scene.addObject(normalizedPath, asset.name);
      objects = obj ? [obj] : [];
    }
    
    if (objects.length > 0) {
      // Register asset references for all created objects
      for (const obj of objects) {
        sceneSerializer.registerAssetRef(obj.id, {
          assetId: asset.id,
          assetName: asset.name,
          assetType: asset.type,
          assetSubtype: asset.subtype ?? undefined,
        });
      }
      
      // Select the first object (or all if multi-node)
      if (objects.length === 1) {
        store.scene.select(objects[0].id);
      } else {
        store.scene.selectAll(objects.map(o => o.id));
      }
      store.syncFromScene();
      
      console.log(`[importAssetToScene] Added asset "${asset.name}" to scene (${objects.length} object(s))`);
      return { success: true, object: objects[0], objects };
    } else {
      console.error(`[importAssetToScene] Failed to add asset "${asset.name}" to scene`);
      return { success: false, error: 'Failed to add object to scene' };
    }
  } catch (err) {
    console.error(`[importAssetToScene] Error importing asset "${asset.name}":`, err);
    return { success: false, error: String(err) };
  }
}
