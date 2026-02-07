/**
 * WaterPanelBridge - Connects WaterPanel Preact component to the store
 * Shows only when an OceanSceneObject is selected
 */

import { useCallback, useState, useEffect } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { WaterPanel, type WaterParams } from '../panels/WaterPanel';
import { isOceanObject, type OceanSceneObject } from '../../../../core/sceneObjects';
import { createDefaultWaterConfig } from '../../../../core/gpu/renderers';

// ==================== Connected Component ====================

export function ConnectedWaterPanel() {
  const store = getSceneBuilderStore();
  
  // Get ocean reference from selected scene object
  const selectedOcean = useComputed<OceanSceneObject | null>(() => {
    const selectedObj = store.firstSelectedObject.value;
    if (!selectedObj || !store.scene) return null;
    
    const sceneObj = store.scene.getObject(selectedObj.id);
    if (!sceneObj) return null;
    
    // Check for Ocean scene object
    if (isOceanObject(sceneObj)) {
      return sceneObj as OceanSceneObject;
    }
    
    return null;
  });
  
  // Local state for water params - needed for reactivity since manager.getConfig() is not reactive
  const [waterParams, setWaterParams] = useState<WaterParams>(createDefaultWaterConfig);
  
  // Sync local state when selection changes
  useEffect(() => {
    const ocean = selectedOcean.value;
    if (!ocean) {
      setWaterParams(createDefaultWaterConfig());
      return;
    }
    
    const manager = ocean.getOceanManager();
    if (manager) {
      setWaterParams(manager.getConfig());
    }
  }, [selectedOcean.value]);
  
  // Handler for param changes - update both manager AND local state
  const handleParamsChange = useCallback((changes: Partial<WaterParams>) => {
    const ocean = selectedOcean.value;
    if (!ocean) return;
    
    const manager = ocean.getOceanManager();
    if (!manager) return;
    
    // Compute new config
    const currentConfig = manager.getConfig();
    const newConfig = { ...currentConfig, ...changes };
    
    // Update the ocean manager config
    manager.setConfig(newConfig);
    
    // Update local state for UI reactivity
    setWaterParams(newConfig);
    
    // If grid dimensions/position or water level changed, update camera bounds (debounced in store)
    // Water level affects the Y position of the AABB
    const boundsAffectingParams = 'gridCenterX' in changes || 'gridCenterZ' in changes || 
                                  'gridSizeX' in changes || 'gridSizeZ' in changes ||
                                  'waterLevel' in changes;
    if (boundsAffectingParams) {
      store.updateCameraFromSceneBounds();
    }
  }, [selectedOcean, store]);
  
  // Only render if an ocean is selected
  if (!selectedOcean.value) {
    return null;
  }
  
  // Get terrain size for slider ranges (use default if no terrain)
  const terrain = store.scene?.getWebGPUTerrain();
  const terrainSize = terrain?.getWorldSize() ?? 1024;
  
  return (
    <WaterPanel
      params={waterParams}
      onParamsChange={handleParamsChange}
      terrainSize={terrainSize}
    />
  );
}
