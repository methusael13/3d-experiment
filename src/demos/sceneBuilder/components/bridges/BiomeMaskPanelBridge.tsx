/**
 * BiomeMaskPanelBridge - Connects BiomeMaskContent to TerrainManager via DockableWindow
 * Manages biome mask generation and parameter editing
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { useComputed, useSignal } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { BiomeMaskContent } from '../panels/BiomeMaskPanel';
import { DockableWindow } from '../ui/DockableWindow';
import { isGPUTerrainObject, type GPUTerrainSceneObject } from '../../../../core/sceneObjects';
import { createDefaultBiomeParams, type BiomeParams } from '../../../../core/vegetation';
import { debounce } from '../../../../core/utils/debounce';
import type { TerrainManager } from '../../../../core/terrain';

export interface BiomeMaskPanelBridgeProps {
  /** Window visibility */
  visible: boolean;
  /** Called when window requests close */
  onClose: () => void;
  /** Initial window position */
  defaultPosition?: { x: number; y: number };
}

/**
 * BiomeMask editor in a dockable window
 * Gets terrain from selected GPUTerrainSceneObject and manages biome parameters
 */
export function BiomeMaskPanelBridge({
  visible,
  onClose,
  defaultPosition = { x: 100, y: 100 },
}: BiomeMaskPanelBridgeProps) {
  const store = getSceneBuilderStore();
  
  // Get terrain manager from selected GPU terrain object
  const terrainManager = useComputed<TerrainManager | null>(() => {
    const selectedObj = store.firstSelectedObject.value;
    if (!selectedObj || !store.scene) return null;
    
    const sceneObj = store.scene.getObject(selectedObj.id);
    if (!sceneObj || !isGPUTerrainObject(sceneObj)) return null;
    
    const gpuTerrain = sceneObj as GPUTerrainSceneObject;
    return gpuTerrain.getTerrainManager() ?? null;
  });
  
  // Get GPU device from GPUContext
  const device = useComputed<GPUDevice | null>(() => {
    return store.viewport?.getWebGPUContext()?.device ?? null;
  });
  
  // Local biome parameters state
  const [params, setParams] = useState<BiomeParams>(createDefaultBiomeParams);
  
  // Track whether biome mask exists
  const hasBiomeMask = useSignal(false);
  
  // Preview version for GPUTexturePreview - incremented after each regeneration
  const previewVersion = useSignal(0);
  
  // Ref for debounced regeneration
  const paramsRef = useRef(params);
  paramsRef.current = params;
  
  // Sync local state with terrain manager on mount/selection change
  useEffect(() => {
    const manager = terrainManager.value;
    if (manager) {
      setParams(manager.getBiomeParams());
      hasBiomeMask.value = manager.hasBiomeMask();
    }
  }, [terrainManager.value]);
  
  // Debounced regeneration for live preview
  const debouncedRegenerate = useCallback(
    debounce(() => {
      const manager = terrainManager.value;
      if (manager) {
        manager.regenerateBiomeMask(paramsRef.current);
        hasBiomeMask.value = true;
        // Trigger preview re-render after GPU work completes
        setTimeout(() => { previewVersion.value++; }, 50);
        console.log('[BiomeMaskPanel] Regenerated biome mask');
      }
    }, 150),
    [terrainManager]
  );
  
  // Cleanup debounce on unmount
  useEffect(() => () => debouncedRegenerate.cancel?.(), [debouncedRegenerate]);
  
  // Handle parameter changes - update local state + debounced regeneration
  const handleParamsChange = useCallback((changes: Partial<BiomeParams>) => {
    setParams(prev => {
      const updated = { ...prev, ...changes };
      paramsRef.current = updated;
      
      // Update terrain manager params
      const manager = terrainManager.value;
      if (manager) {
        manager.setBiomeParams(updated);
      }
      
      // Trigger debounced regeneration for live preview
      debouncedRegenerate();
      
      return updated;
    });
  }, [terrainManager, debouncedRegenerate]);
  
  // Handle explicit regeneration request
  const handleRegenerate = useCallback(() => {
    const manager = terrainManager.value;
    if (manager) {
      debouncedRegenerate.cancel?.();
      manager.regenerateBiomeMask(params);
      hasBiomeMask.value = true;
      // Trigger preview re-render after GPU work completes
      setTimeout(() => { previewVersion.value++; }, 50);
      console.log('[BiomeMaskPanel] Generated biome mask');
    }
  }, [terrainManager, params, debouncedRegenerate]);
  
  // Get biome mask texture for preview
  const getBiomeMaskTexture = useCallback(() => {
    return terrainManager.value?.getBiomeMask() ?? null;
  }, [terrainManager]);
  
  // Check if terrain is ready (has heightmap)
  const isTerrainReady = terrainManager.value?.isReady ?? false;
  
  if (!visible) return null;
  
  return (
    <DockableWindow
      id="biome-mask-editor"
      title="Biome Mask Editor"
      icon="🌿"
      defaultPosition={defaultPosition}
      defaultSize={{ width: 400, height: 800 }}
      minSize={{ width: 250, height: 350 }}
      onClose={onClose}
    >
      <BiomeMaskContent
        params={params}
        onParamsChange={handleParamsChange}
        onRegenerate={handleRegenerate}
        hasBiomeMask={hasBiomeMask.value}
        isTerrainReady={isTerrainReady}
        getBiomeMaskTexture={getBiomeMaskTexture}
        device={device.value}
        previewVersion={previewVersion.value}
      />
    </DockableWindow>
  );
}

export default BiomeMaskPanelBridge;
