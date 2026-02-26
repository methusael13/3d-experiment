/**
 * useFileDrop - Handle file drag-and-drop for model/asset import
 */

import { useEffect, useCallback, useState } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { sceneSerializer } from '../../../../loaders/SceneSerializer';
import { importAssetToScene } from './useAssetImport';
import { ASSET_LIBRARY_MIME_TYPE } from '../panels/AssetLibraryPanel/AssetPreviewGrid';
import type { Asset } from './useAssetLibrary';
import { MeshComponent } from '@/core/ecs';

export interface FileDropState {
  isDragging: boolean;
  isProcessing: boolean;
  lastError: string | null;
}

/**
 * Hook that handles file drag-and-drop for importing models
 */
export function useFileDrop(containerRef: { current: HTMLElement | null }) {
  const store = getSceneBuilderStore();
  const [state, setState] = useState<FileDropState>({
    isDragging: false,
    isProcessing: false,
    lastError: null,
  });
  
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState(s => ({ ...s, isDragging: true }));
  }, []);
  
  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set false if leaving the container
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const x = e.clientX;
      const y = e.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        setState(s => ({ ...s, isDragging: false }));
      }
    }
  }, [containerRef]);
  
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  
  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    setState(s => ({ ...s, isDragging: false, isProcessing: true, lastError: null }));
    
    const world = store.world;
    
    if (!world) {
      setState(s => ({ ...s, isProcessing: false, lastError: 'World not initialized' }));
      return;
    }
    
    // Check for asset library drop (custom MIME type)
    const assetData = e.dataTransfer?.getData(ASSET_LIBRARY_MIME_TYPE);
    if (assetData) {
      try {
        const asset = JSON.parse(assetData) as Asset;
        console.log(`[FileDrop] Asset library drop: ${asset.name}`);
        
        const result = await importAssetToScene(asset);
        if (!result.success) {
          setState(s => ({ ...s, lastError: result.error ?? 'Failed to import asset' }));
        }
      } catch (err) {
        console.error('[FileDrop] Asset import error:', err);
        setState(s => ({ ...s, lastError: String(err) }));
      } finally {
        setState(s => ({ ...s, isProcessing: false }));
      }
      return;
    }
    
    // Handle file drops (from filesystem)
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      setState(s => ({ ...s, isProcessing: false }));
      return;
    }
    
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split('.').pop()?.toLowerCase();
        
        if (ext === 'glb' || ext === 'gltf') {
          // Import GLB/GLTF model via ECS factories
          const result = await sceneSerializer.importModelFile(file);
          const modelUrl = sceneSerializer.getModelUrl(result.modelPath);
          
          const { createModelEntity } = await import('@/core/ecs/factories');
          const { loadGLB } = await import('../../../../loaders');
          
          const model = await loadGLB(modelUrl);
          if (model) {
            const entity = createModelEntity(world, {
              name: result.displayName,
              modelPath: result.modelPath,
            });
            const mesh = entity.getComponent<MeshComponent>('mesh');
            if (mesh) {
              mesh.modelPath = result.modelPath;
              mesh.model = model;
            }
          }
          console.log(`[FileDrop] Imported model: ${result.displayName}`);
        } else if (ext === 'hdr') {
          // Import HDR for environment lighting
          await handleHDRImport(file, store);
          console.log(`[FileDrop] Imported HDR: ${file.name}`);
        } else if (ext === 'json') {
          // TODO: Implement ECS-based scene deserialization
          console.log(`[FileDrop] JSON scene load not yet implemented for ECS`);
        } else {
          console.warn(`[FileDrop] Unsupported file type: ${ext}`);
        }
      }
      
      store.syncFromWorld();
    } catch (err) {
      console.error('[FileDrop] Import error:', err);
      setState(s => ({ ...s, lastError: String(err) }));
    } finally {
      setState(s => ({ ...s, isProcessing: false }));
    }
  }, [store]);
  
  // Attach listeners
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    container.addEventListener('dragenter', handleDragEnter);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);
    
    return () => {
      container.removeEventListener('dragenter', handleDragEnter);
      container.removeEventListener('dragleave', handleDragLeave);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
    };
  }, [containerRef, handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);
  
  return state;
}

/**
 * Handle HDR file import for environment lighting
 */
async function handleHDRImport(file: File, store: ReturnType<typeof getSceneBuilderStore>): Promise<void> {
  const lightingManager = store.lightingManager;
  
  if (!lightingManager) {
    throw new Error('GL context or lighting manager not initialized');
  }
  
  // Import HDRLoader dynamically
  const { HDRLoader } = await import('../../../../loaders/HDRLoader');
  
  const arrayBuffer = await file.arrayBuffer();
  const hdrData = HDRLoader.parse(arrayBuffer);
  // Note: HDRLoader needs to be migrated to create WebGPU textures
  // const hdrTexture = HDRLoader.createPrefilteredTexture(, hdrData).texture;
  
  // Set HDR texture on lighting manager
  // lightingManager.hdrLight.setTexture(hdrTexture);
  lightingManager.hdrLight.filename = file.name;
  
  // Set mode to HDR
  lightingManager.setMode('hdr');
  
  // Update viewport
  const viewport = store.viewport;
  if (viewport) {
    // Todo: viewport.setHDRTexture
  }
}

/**
 * Programmatic file import via file picker
 */
export function openFilePicker(options: {
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList) => void;
}): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = options.accept || '.glb,.gltf,.obj,.hdr,.json';
  input.multiple = options.multiple ?? false;
  
  input.onchange = () => {
    if (input.files && input.files.length > 0) {
      options.onFiles(input.files);
    }
  };
  
  input.click();
}
