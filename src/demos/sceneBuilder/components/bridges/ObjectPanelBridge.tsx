/**
 * ObjectPanelBridge - Connects ObjectPanel Preact component to the store
 */

import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { ObjectPanel, type TransformData, type PrimitiveConfig, type WindSettings, type TerrainBlendSettings, type MaterialInfo } from '../panels';
import type { GizmoMode, GizmoOrientation } from '../../gizmos';
import type { Vec3 } from '../../../../core/types';
import { isPrimitiveObject, ModelObject } from '../../../../core/sceneObjects';

// ==================== Connected Component ====================

export function ConnectedObjectPanel() {
  const store = getSceneBuilderStore();
  
  // Computed values from store
  const visible = useComputed(() => store.selectionCount.value > 0);
  const selectionCount = useComputed(() => store.selectionCount.value);
  const gizmoMode = useComputed(() => store.gizmoMode.value);
  const gizmoOrientation = useComputed(() => store.gizmoOrientation.value);
  
  const selectedObject = useComputed(() => {
    const first = store.firstSelectedObject.value;
    if (!first) return null;
    return first;
  });
  
  const transform = useComputed<TransformData>(() => {
    const obj = selectedObject.value;
    if (!obj) {
      return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    }
    return {
      position: obj.position as [number, number, number],
      rotation: obj.rotation as [number, number, number],
      scale: obj.scale as [number, number, number],
    };
  });
  
  const windSettings = useComputed<WindSettings>(() => {
    const obj = selectedObject.value;
    if (!obj) return getDefaultWindSettings();
    const objWindSettings = store.objectWindSettings.value.get(obj.id);
    if (!objWindSettings) return getDefaultWindSettings();
    return {
      enabled: objWindSettings.enabled,
      influence: objWindSettings.influence,
      stiffness: objWindSettings.stiffness,
      anchorHeight: objWindSettings.anchorHeight,
      leafMaterialIndices: objWindSettings.leafMaterialIndices,
      branchMaterialIndices: objWindSettings.branchMaterialIndices,
    };
  });
  
  const terrainBlendSettings = useComputed<TerrainBlendSettings>(() => {
    const obj = selectedObject.value;
    if (!obj) return getDefaultTerrainBlendSettings();
    const settings = store.objectTerrainBlendSettings.value.get(obj.id);
    return settings ?? getDefaultTerrainBlendSettings();
  });
  
  // Primitive-specific computed values (for Edit tab)
  const primitiveType = useComputed<'cube' | 'plane' | 'sphere' | undefined>(() => {
    const obj = selectedObject.value;
    if (!obj || obj.objectType !== 'primitive' || !store.scene) return undefined;
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj || !isPrimitiveObject(sceneObj)) return undefined;
    return sceneObj.primitiveType as 'cube' | 'plane' | 'sphere';
  });
  
  const primitiveConfig = useComputed<PrimitiveConfig | undefined>(() => {
    const obj = selectedObject.value;
    if (!obj || obj.objectType !== 'primitive' || !store.scene) return undefined;
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj || !isPrimitiveObject(sceneObj)) return undefined;
    return sceneObj.primitiveConfig ?? { size: 1, subdivision: 16 };
  });
  
  const showNormals = useComputed<boolean>(() => {
    const obj = selectedObject.value;
    if (!obj || obj.objectType !== 'primitive' || !store.scene) return false;
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj) return false;
    return (sceneObj as any).showNormals ?? false;
  });
  
  // Callbacks
  const handleNameChange = (name: string) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (scene && obj) {
      const sceneObj = scene.getObject(obj.id);
      if (sceneObj) {
        sceneObj.name = name;
      }
      store.syncFromScene();
    }
  };
  
  const handlePositionChange = (value: [number, number, number]) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (scene && obj) {
      const sceneObj = scene.getObject(obj.id);
      if (sceneObj) {
        sceneObj.position = value as Vec3;
        scene.updateObjectTransform(obj.id);
      }
      store.syncFromScene();
    }
  };
  
  const handleRotationChange = (value: [number, number, number]) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (scene && obj) {
      const sceneObj = scene.getObject(obj.id);
      if (sceneObj) {
        sceneObj.rotation = value as Vec3;
        scene.updateObjectTransform(obj.id);
      }
      store.syncFromScene();
    }
  };
  
  const handleScaleChange = (value: [number, number, number]) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (scene && obj) {
      const sceneObj = scene.getObject(obj.id);
      if (sceneObj) {
        sceneObj.scale = value as Vec3;
        scene.updateObjectTransform(obj.id);
      }
      store.syncFromScene();
    }
  };
  
  const handleDelete = () => {
    const scene = store.scene;
    const selectedIds = store.selectedIds.value;
    if (scene && selectedIds.size > 0) {
      for (const id of selectedIds) {
        scene.removeObject(id);
      }
      store.syncFromScene();
    }
  };
  
  const handleWindSettingsChange = (settings: Partial<WindSettings>) => {
    const obj = selectedObject.value;
    if (!obj) return;
    
    const current = store.objectWindSettings.value.get(obj.id) ?? getDefaultObjectWindSettings(obj.id);
    const updated = { ...current, ...settings };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(obj.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  const handleTerrainBlendChange = (settings: Partial<TerrainBlendSettings>) => {
    const obj = selectedObject.value;
    if (!obj) return;
    
    const current = store.objectTerrainBlendSettings.value.get(obj.id) ?? getDefaultTerrainBlendSettings();
    const updated = { ...current, ...settings };
    const newMap = new Map(store.objectTerrainBlendSettings.value);
    newMap.set(obj.id, updated);
    store.objectTerrainBlendSettings.value = newMap;
  };
  
  const handlePrimitiveConfigChange = (config: Partial<PrimitiveConfig>) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (!scene || !obj) return;
    
    scene.updatePrimitiveConfig(obj.id, config);
    store.syncFromScene();
  };
  
  const handleShowNormalsChange = (show: boolean) => {
    const scene = store.scene;
    const obj = selectedObject.value;
    if (!scene || !obj) return;
    
    const sceneObj = scene.getObject(obj.id);
    if (sceneObj) {
      (sceneObj as any).showNormals = show;
    }
  };
  
  const handleToggleLeafMaterial = (index: number) => {
    const obj = selectedObject.value;
    if (!obj) return;
    
    const current = store.objectWindSettings.value.get(obj.id) ?? getDefaultObjectWindSettings(obj.id);
    const newSet = new Set(current.leafMaterialIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    const updated = { ...current, leafMaterialIndices: newSet };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(obj.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  const handleToggleBranchMaterial = (index: number) => {
    const obj = selectedObject.value;
    if (!obj) return;
    
    const current = store.objectWindSettings.value.get(obj.id) ?? getDefaultObjectWindSettings(obj.id);
    const newSet = new Set(current.branchMaterialIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    const updated = { ...current, branchMaterialIndices: newSet };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(obj.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  // Get materials from model objects
  const materials = useComputed<MaterialInfo[]>(() => {
    const obj = selectedObject.value;
    if (!obj || obj.objectType !== 'model' || !store.scene) return [];
    
    const sceneObj = store.scene.getObject(obj.id);
    if (!sceneObj || !(sceneObj instanceof ModelObject)) return [];
    
    // Get materials from model
    return sceneObj.getMaterialInfo?.() ?? [];
  });
  
  const obj = selectedObject.value;
  
  return (
    <ObjectPanel
      visible={visible.value}
      selectionCount={selectionCount.value}
      objectName={obj?.name ?? ''}
      objectType={obj?.objectType ?? null}
      transform={transform.value}
      primitiveType={primitiveType.value}
      primitiveConfig={primitiveConfig.value}
      showNormals={showNormals.value}
      gizmoMode={gizmoMode.value}
      gizmoOrientation={gizmoOrientation.value}
      windSettings={windSettings.value}
      terrainBlendSettings={terrainBlendSettings.value}
      materials={materials.value}
      onNameChange={handleNameChange}
      onPositionChange={handlePositionChange}
      onRotationChange={handleRotationChange}
      onScaleChange={handleScaleChange}
      onGizmoModeChange={(mode: GizmoMode) => store.setGizmoMode(mode)}
      onGizmoOrientationChange={(orientation: GizmoOrientation) => store.setGizmoOrientation(orientation)}
      onDelete={handleDelete}
      onPrimitiveConfigChange={handlePrimitiveConfigChange}
      onShowNormalsChange={handleShowNormalsChange}
      onWindSettingsChange={handleWindSettingsChange}
      onTerrainBlendChange={handleTerrainBlendChange}
      onToggleLeafMaterial={handleToggleLeafMaterial}
      onToggleBranchMaterial={handleToggleBranchMaterial}
    />
  );
}

// ==================== Helpers ====================

function getDefaultWindSettings(): WindSettings {
  return {
    enabled: false,
    influence: 1.0,
    stiffness: 0.5,
    anchorHeight: 0,
    leafMaterialIndices: new Set(),
    branchMaterialIndices: new Set(),
  };
}

function getDefaultObjectWindSettings(id: string) {
  return {
    id,
    enabled: false,
    influence: 1.0,
    stiffness: 0.5,
    anchorHeight: 0,
    leafMaterialIndices: new Set<number>(),
    branchMaterialIndices: new Set<number>(),
    displacement: [0, 0] as [number, number],
    velocity: [0, 0] as [number, number],
  };
}

function getDefaultTerrainBlendSettings(): TerrainBlendSettings {
  return {
    enabled: false,
    blendDistance: 0.5,
  };
}
