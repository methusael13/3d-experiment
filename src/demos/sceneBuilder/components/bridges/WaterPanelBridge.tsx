/**
 * WaterPanelBridge - Connects WaterPanel to the store (ECS Step 3)
 * Shows only when an entity with OceanComponent is selected
 */

import { useCallback, useState, useEffect } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { WaterPanel, type WaterParams } from '../panels/WaterPanel';
import { OceanComponent } from '@/core/ecs/components/OceanComponent';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { createDefaultWaterConfig } from '../../../../core/gpu/renderers';
import type { OceanManager } from '@/core/ocean/OceanManager';
import { BoundsComponent } from '@/core/ecs';

// ==================== Connected Component ====================

export function ConnectedWaterPanel() {
  const store = getSceneBuilderStore();
  
  // Get ocean manager from selected entity's OceanComponent
  const selectedOceanManager = useComputed<OceanManager | null>(() => {
    const entity = store.firstSelectedObject.value;
    if (!entity) return null;
    
    const oceanComp = entity.getComponent<OceanComponent>('ocean');
    if (oceanComp) {
      return oceanComp.manager;
    }
    
    return null;
  });
  
  // Local state for water params
  const [waterParams, setWaterParams] = useState<WaterParams>(createDefaultWaterConfig);
  
  // Sync local state when selection changes
  useEffect(() => {
    const manager = selectedOceanManager.value;
    if (!manager) {
      setWaterParams(createDefaultWaterConfig());
      return;
    }
    
    setWaterParams(manager.getConfig());
  }, [selectedOceanManager.value]);
  
  // Handler for param changes
  const handleParamsChange = useCallback((changes: Partial<WaterParams>) => {
    const manager = selectedOceanManager.value;
    if (!manager) return;
    
    const currentConfig = manager.getConfig();
    const newConfig = { ...currentConfig, ...changes };
    
    manager.setConfig(newConfig);
    setWaterParams(newConfig);
    
    // Recompute ocean worldBounds when grid dimensions change
    const boundsAffectingParams = 'gridCenterX' in changes || 'gridCenterZ' in changes || 
                                  'gridSizeX' in changes || 'gridSizeZ' in changes ||
                                  'waterLevel' in changes;
    if (boundsAffectingParams) {
      const entity = store.firstSelectedObject.value;
      if (entity) {
        const oceanComp = entity.getComponent?.('ocean') as OceanComponent;
        const boundsComp = entity.getComponent?.('bounds') as BoundsComponent;
        if (oceanComp?.computeWorldBounds && boundsComp) {
          boundsComp.worldBounds = oceanComp.computeWorldBounds();
          boundsComp.dirty = false;
        }
      }
      // BoundsSystem callback will trigger camera update automatically
    }
  }, [selectedOceanManager, store]);
  
  // Only render if an ocean is selected
  if (!selectedOceanManager.value) {
    return null;
  }
  
  // Get terrain size from World (query for terrain entity)
  const world = store.world;
  let terrainSize = 1024;
  if (world) {
    const terrainEntity = world.queryFirst('terrain');
    if (terrainEntity) {
      const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
      terrainSize = tc?.manager?.getConfig()?.worldSize ?? 1024;
    }
  }
  
  return (
    <WaterPanel
      params={waterParams}
      onParamsChange={handleParamsChange}
      terrainSize={terrainSize}
    />
  );
}