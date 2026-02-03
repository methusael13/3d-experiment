/**
 * MaterialPanelBridge - Connects MaterialPanel Preact component to the store
 */

import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { MaterialPanel } from '../panels';
import type { PBRMaterial } from '../../../../core/sceneObjects';

// ==================== Connected Component ====================

export function ConnectedMaterialPanel() {
  const store = getSceneBuilderStore();
  
  // Get selected object info
  const selectedObject = useComputed(() => store.firstSelectedObject.value);
  
  const selectedObjectId = useComputed(() => {
    return selectedObject.value?.id ?? null;
  });
  
  const objectType = useComputed(() => {
    return selectedObject.value?.objectType ?? null;
  });
  
  // Get material from scene object
  const material = useComputed<PBRMaterial | null>(() => {
    const obj = selectedObject.value;
    if (!obj || !store.scene) return null;
    
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj) return null;
    
    // Check if object has material property
    if ('material' in sceneObj && sceneObj.material) {
      const mat = sceneObj.material as any;
      return {
        albedo: mat.albedo ?? mat.baseColorFactor?.slice(0, 3) ?? [0.75, 0.75, 0.75],
        metallic: mat.metallic ?? mat.metallicFactor ?? 0,
        roughness: mat.roughness ?? mat.roughnessFactor ?? 0.5,
      };
    }
    
    return null;
  });
  
  // Handle material change
  const handleMaterialChange = (changes: Partial<PBRMaterial>) => {
    const obj = selectedObject.value;
    if (!obj || !store.scene) return;
    
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj || !('material' in sceneObj)) return;
    
    // Update material on scene object
    const currentMat = (sceneObj as any).material ?? {};
    const updatedMat = { ...currentMat, ...changes };
    (sceneObj as any).material = updatedMat;
    
    // Sync state (animation loop handles re-rendering)
    store.syncFromScene();
  };
  
  return (
    <MaterialPanel
      selectedObjectId={selectedObjectId.value}
      objectType={objectType.value}
      material={material.value}
      onMaterialChange={handleMaterialChange}
    />
  );
}
