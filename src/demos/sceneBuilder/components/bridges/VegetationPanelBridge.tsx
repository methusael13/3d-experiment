/**
 * VegetationPanelBridge - Connects VegetationContent to TerrainManager via DockableWindow
 * Manages plant registry editing
 */

import { useCallback } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { VegetationContent } from '../panels/VegetationPanel';
import { DockableWindow } from '../ui/DockableWindow';
import { isGPUTerrainObject, type GPUTerrainSceneObject } from '../../../../core/sceneObjects';
import type { PlantRegistry } from '../../../../core/vegetation/PlantRegistry';
import { TerrainComponent } from '@/core/ecs';

// ==================== Types ====================

export interface VegetationPanelBridgeProps {
  /** Window visibility */
  visible: boolean;
  /** Called when window requests close */
  onClose: () => void;
  /** Initial window position */
  defaultPosition?: { x: number; y: number };
}

// ==================== Component ====================

/**
 * Vegetation editor in a dockable window
 * Gets plant registry from selected GPUTerrainSceneObject's TerrainManager
 */
export function VegetationPanelBridge({
  visible,
  onClose,
  defaultPosition = { x: 450, y: 100 },
}: VegetationPanelBridgeProps) {
  const store = getSceneBuilderStore();
  
  // Get plant registry from selected GPU terrain object's terrain manager
  const plantRegistry = useComputed<PlantRegistry | null>(() => {
    const selectedObj = store.firstSelectedObject.value;
    if (!selectedObj) return null;
    
    const terrainComp = selectedObj.getComponent?.('terrain') as TerrainComponent;
    if (!terrainComp?.manager) return null;
    
    return terrainComp.manager.getPlantRegistry() ?? null;
  });
  
  if (!visible) return null;
  
  // If no plant registry available, show message
  if (!plantRegistry.value) {
    return (
      <DockableWindow
        id="vegetation-editor"
        title="Vegetation Editor"
        icon="🌿"
        defaultPosition={defaultPosition}
        defaultSize={{ width: 400, height: 600 }}
        minSize={{ width: 320, height: 400 }}
        onClose={onClose}
      >
        <div style={{ padding: '20px', color: '#999', textAlign: 'center' }}>
          <p>No terrain selected.</p>
          <p style={{ fontSize: '12px' }}>Select a GPU terrain object to edit vegetation settings.</p>
        </div>
      </DockableWindow>
    );
  }
  
  return (
    <DockableWindow
      id="vegetation-editor"
      title="Vegetation Editor"
      icon="🌿"
      defaultPosition={defaultPosition}
      defaultSize={{ width: 400, height: 600 }}
      minSize={{ width: 320, height: 400 }}
      onClose={onClose}
    >
      <VegetationContent registry={plantRegistry.value} />
    </DockableWindow>
  );
}

export default VegetationPanelBridge;
