/**
 * useFileDrop - Handle file drag-and-drop for model/asset import
 */

import { useEffect, useCallback, useState } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { sceneSerializer } from '../../../../loaders/SceneSerializer';
import { importAssetToScene } from './useAssetImport';
import { ASSET_LIBRARY_MIME_TYPE } from '../panels/AssetLibraryPanel/AssetPreviewGrid';
import type { Asset } from './useAssetLibrary';

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
    
    const scene = store.scene;
    const gl = store.gl;
    
    if (!scene || !gl) {
      setState(s => ({ ...s, isProcessing: false, lastError: 'Scene not initialized' }));
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
          // Import GLB/GLTF model
          const result = await sceneSerializer.importModelFile(file);
          const modelUrl = sceneSerializer.getModelUrl(result.modelPath);
          
          // Add model to scene - use loadModel which exists on Scene
          await scene.addObject(modelUrl, result.displayName);
          console.log(`[FileDrop] Imported model: ${result.displayName}`);
        } else if (ext === 'hdr') {
          // Import HDR for environment lighting
          await handleHDRImport(file, store);
          console.log(`[FileDrop] Imported HDR: ${file.name}`);
        } else if (ext === 'json') {
          // Load scene file
          const text = await file.text();
          const data = JSON.parse(text);
          await scene.deserialize(data);
          console.log(`[FileDrop] Loaded scene: ${file.name}`);
        } else {
          console.warn(`[FileDrop] Unsupported file type: ${ext}`);
        }
      }
      
      store.syncFromScene();
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
  const gl = store.gl;
  const lightingManager = store.lightingManager;
  
  if (!gl || !lightingManager) {
    throw new Error('GL context or lighting manager not initialized');
  }
  
  // Import HDRLoader dynamically
  const { HDRLoader } = await import('../../../../loaders/HDRLoader');
  
  const arrayBuffer = await file.arrayBuffer();
  const hdrData = HDRLoader.parse(arrayBuffer);
  const hdrTexture = HDRLoader.createPrefilteredTexture(gl, hdrData).texture;
  
  // Set HDR texture on lighting manager
  lightingManager.hdrLight.setTexture(hdrTexture);
  lightingManager.hdrLight.filename = file.name;
  
  // Set mode to HDR
  lightingManager.setMode('hdr');
  
  // Update viewport
  const viewport = store.viewport;
  if (viewport) {
    viewport.setHDRTexture(hdrTexture);
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
