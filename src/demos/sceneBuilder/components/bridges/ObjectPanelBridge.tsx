/**
 * ObjectPanelBridge - Connects ObjectPanel to the store (ECS Step 3)
 * Reads from Entity components instead of SceneObject properties.
 */

import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { ObjectPanel, type TransformData, type PrimitiveConfig, type WindSettings, type TerrainBlendSettings, type MaterialInfo } from '../panels';
import type { GizmoMode, GizmoOrientation } from '../../gizmos';
import type { Vec3 } from '../../../../core/types';
import { TransformComponent } from '@/core/ecs/components/TransformComponent';
import { MeshComponent } from '@/core/ecs/components/MeshComponent';
import { PrimitiveGeometryComponent } from '@/core/ecs/components/PrimitiveGeometryComponent';
import { generatePrimitiveGeometry } from '@/core/utils/primitiveGeometry';
import type { ComponentType } from '@/core/ecs/types';

// ==================== Connected Component ====================

export function ConnectedObjectPanel() {
  const store = getSceneBuilderStore();
  
  // Computed values from store
  const visible = useComputed(() => store.selectionCount.value > 0);
  const selectionCount = useComputed(() => store.selectionCount.value);
  const gizmoMode = useComputed(() => store.gizmoMode.value);
  const gizmoOrientation = useComputed(() => store.gizmoOrientation.value);
  
  const selectedEntity = useComputed(() => {
    return store.firstSelectedObject.value;
  });
  
  // Determine object type from entity components
  const objectType = useComputed<string | null>(() => {
    const _ = store.transformVersion.value;
    const entity = selectedEntity.value;
    if (!entity) return null;
    if (entity.hasComponent('mesh')) return 'model';
    if (entity.hasComponent('primitive-geometry')) return 'primitive';
    if (entity.hasComponent('terrain')) return 'terrain';
    if (entity.hasComponent('ocean')) return 'ocean';
    if (entity.hasComponent('light')) return 'light';
    return 'unknown';
  });
  
  const transform = useComputed<TransformData>(() => {
    const _ = store.transformVersion.value;
    const entity = selectedEntity.value;
    if (!entity) {
      return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    }
    const tc = entity.getComponent<TransformComponent>('transform');
    if (!tc) {
      return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    }
    const euler = tc.rotation;
    return {
      position: [tc.position[0], tc.position[1], tc.position[2]] as [number, number, number],
      rotation: [euler[0], euler[1], euler[2]] as [number, number, number],
      scale: [tc.scale[0], tc.scale[1], tc.scale[2]] as [number, number, number],
    };
  });
  
  const windSettings = useComputed<WindSettings>(() => {
    const entity = selectedEntity.value;
    if (!entity) return getDefaultWindSettings();
    const objWindSettings = store.objectWindSettings.value.get(entity.id);
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
  
  const primitiveType = useComputed<'cube' | 'plane' | 'sphere' | undefined>(() => {
    const _ = store.transformVersion.value;
    const entity = selectedEntity.value;
    if (!entity) return undefined;
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (!prim) return undefined;
    return prim.primitiveType as 'cube' | 'plane' | 'sphere';
  });
  
  const primitiveConfig = useComputed<PrimitiveConfig | undefined>(() => {
    const _ = store.transformVersion.value;
    const entity = selectedEntity.value;
    if (!entity) return undefined;
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (!prim) return undefined;
    return { size: 1, subdivision: 16, ...prim.config } as PrimitiveConfig;
  });
  
  const showNormals = useComputed<boolean>(() => {
    return false; // TODO: implement via component
  });
  
  // Callbacks
  const handleNameChange = (name: string) => {
    const entity = selectedEntity.value;
    if (entity) {
      entity.name = name;
      store.syncFromWorld();
    }
  };
  
  const handlePositionChange = (value: [number, number, number]) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    const tc = entity.getComponent<TransformComponent>('transform');
    if (tc) {
      tc.setPosition(value);
      store.syncFromWorld();
    }
  };
  
  const handleRotationChange = (value: [number, number, number]) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    const tc = entity.getComponent<TransformComponent>('transform');
    if (tc) {
      tc.setRotation(value);
      store.syncFromWorld();
    }
  };
  
  const handleScaleChange = (value: [number, number, number]) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    const tc = entity.getComponent<TransformComponent>('transform');
    if (tc) {
      tc.setScale(value);
      store.syncFromWorld();
    }
  };
  
  const handleDelete = () => {
    const world = store.world;
    const selectedIds = store.selectedIds.value;
    if (world && selectedIds.size > 0) {
      for (const id of selectedIds) {
        world.destroyEntity(id);
      }
    }
  };
  
  const handleWindSettingsChange = (settings: Partial<WindSettings>) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    
    const current = store.objectWindSettings.value.get(entity.id) ?? getDefaultObjectWindSettings(entity.id);
    const updated = { ...current, ...settings };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(entity.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  const handlePrimitiveConfigChange = (config: Partial<PrimitiveConfig>) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (!prim) return;
    
    const tc = entity.getComponent<TransformComponent>('transform');
    const newConfig = { ...prim.config, ...config };
    const newGeometry = generatePrimitiveGeometry(prim.primitiveType, newConfig);
    prim.updateGeometry(newConfig, newGeometry, tc ?? undefined);
    store.syncFromWorld();
  };
  
  const handleShowNormalsChange = (_show: boolean) => {
    // TODO: implement via component
  };
  
  const handleToggleLeafMaterial = (index: number) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    
    const current = store.objectWindSettings.value.get(entity.id) ?? getDefaultObjectWindSettings(entity.id);
    const newSet = new Set(current.leafMaterialIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    const updated = { ...current, leafMaterialIndices: newSet };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(entity.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  const handleToggleBranchMaterial = (index: number) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    
    const current = store.objectWindSettings.value.get(entity.id) ?? getDefaultObjectWindSettings(entity.id);
    const newSet = new Set(current.branchMaterialIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    const updated = { ...current, branchMaterialIndices: newSet };
    const newMap = new Map(store.objectWindSettings.value);
    newMap.set(entity.id, updated);
    store.objectWindSettings.value = newMap;
  };
  
  // Get materials from model entities
  const materials = useComputed<MaterialInfo[]>(() => {
    const entity = selectedEntity.value;
    if (!entity) return [];
    
    const mesh = entity.getComponent<MeshComponent>('mesh');
    if (!mesh?.model) return [];
    
    // Build material info from GLBModel materials
    return mesh.model.materials.map((mat, i) => ({
      name: `Material ${i}`,
      index: i,
      albedo: mat.baseColorFactor ? [mat.baseColorFactor[0], mat.baseColorFactor[1], mat.baseColorFactor[2]] as [number, number, number] : [0.7, 0.7, 0.7] as [number, number, number],
    }));
  });
  
  // Components tab data
  const activeComponents = useComputed<ComponentType[]>(() => {
    const _ = store.transformVersion.value; // trigger reactivity on changes
    const entity = selectedEntity.value;
    if (!entity) return [];
    return entity.getComponentTypes();
  });

  const handleComponentsChanged = () => {
    store.syncFromWorld();
  };

  const entity = selectedEntity.value;
  const tc = entity?.getComponent<TransformComponent>('transform');
  
  return (
    <ObjectPanel
      visible={visible.value}
      selectionCount={selectionCount.value}
      objectName={entity?.name ?? ''}
      objectType={objectType.value}
      transform={transform.value}
      primitiveType={primitiveType.value}
      primitiveConfig={primitiveConfig.value}
      showNormals={showNormals.value}
      gizmoMode={gizmoMode.value}
      gizmoOrientation={gizmoOrientation.value}
      windSettings={windSettings.value}
      materials={materials.value}
      onNameChange={handleNameChange}
      onPositionChange={handlePositionChange}
      onRotationChange={handleRotationChange}
      onScaleChange={handleScaleChange}
      onGizmoModeChange={(mode: GizmoMode) => store.setGizmoMode(mode)}
      onGizmoOrientationChange={(orientation: GizmoOrientation) => store.setGizmoOrientation(orientation)}
      originPivot={tc?.originPivot ?? 'center'}
      onOriginPivotChange={(pivot: any) => {
        if (entity && tc) {
          tc.originPivot = pivot;
          tc.dirty = true;
          store.syncFromWorld();
        }
      }}
      onDelete={handleDelete}
      onPrimitiveConfigChange={handlePrimitiveConfigChange}
      onShowNormalsChange={handleShowNormalsChange}
      onWindSettingsChange={handleWindSettingsChange}
      onToggleLeafMaterial={handleToggleLeafMaterial}
      onToggleBranchMaterial={handleToggleBranchMaterial}
      entity={entity ?? null}
      activeComponents={activeComponents.value}
      onComponentsChanged={handleComponentsChanged}
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