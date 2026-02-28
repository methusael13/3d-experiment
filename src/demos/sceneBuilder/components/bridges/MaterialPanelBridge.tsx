/**
 * MaterialPanelBridge - Connects MaterialPanel to the store (ECS Step 3)
 * Reads/writes MaterialComponent on selected Entity.
 */

import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { MaterialPanel } from '../panels';
import type { PBRMaterial } from '../../../../core/sceneObjects/types';
import { MaterialComponent } from '@/core/ecs/components/MaterialComponent';
import { PrimitiveGeometryComponent } from '@/core/ecs/components/PrimitiveGeometryComponent';
import { MeshComponent } from '@/core/ecs/components/MeshComponent';

// ==================== Connected Component ====================

export function ConnectedMaterialPanel() {
  const store = getSceneBuilderStore();
  
  const selectedEntity = useComputed(() => store.firstSelectedObject.value);
  
  const selectedObjectId = useComputed(() => {
    return selectedEntity.value?.id ?? null;
  });
  
  const objectType = useComputed<string | null>(() => {
    const entity = selectedEntity.value;
    if (!entity) return null;
    if (entity.hasComponent('mesh')) return 'model';
    if (entity.hasComponent('primitive-geometry')) return 'primitive';
    if (entity.hasComponent('terrain')) return 'terrain';
    if (entity.hasComponent('ocean')) return 'ocean';
    return null;
  });
  
  // Get material from MaterialComponent
  const material = useComputed<PBRMaterial | null>(() => {
    const _ = store.transformVersion.value;
    
    const entity = selectedEntity.value;
    if (!entity) return null;
    
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return null;
    
    return {
      albedo: [...mat.albedo] as [number, number, number],
      metallic: mat.metallic,
      roughness: mat.roughness,
      emissive: [...mat.emissive] as [number, number, number],
      ior: mat.ior,
      clearcoatFactor: mat.clearcoatFactor,
      clearcoatRoughness: mat.clearcoatRoughness,
      unlit: mat.unlit,
    };
  });
  
  // Handle material change
  const handleMaterialChange = (changes: Partial<PBRMaterial>) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return;
    
    if (changes.albedo) mat.albedo = changes.albedo;
    if (changes.metallic !== undefined) mat.metallic = changes.metallic;
    if (changes.roughness !== undefined) mat.roughness = changes.roughness;
    if (changes.emissive) mat.emissive = changes.emissive;
    if (changes.ior !== undefined) mat.ior = changes.ior;
    if (changes.clearcoatFactor !== undefined) mat.clearcoatFactor = changes.clearcoatFactor;
    if (changes.clearcoatRoughness !== undefined) mat.clearcoatRoughness = changes.clearcoatRoughness;
    if (changes.unlit !== undefined) mat.unlit = changes.unlit;
    
    // Sync GPU material buffer via ObjectRendererGPU
    const gpuChanges: Record<string, unknown> = {};
    if (changes.albedo) gpuChanges.albedo = changes.albedo;
    if (changes.metallic !== undefined) gpuChanges.metallic = changes.metallic;
    if (changes.roughness !== undefined) gpuChanges.roughness = changes.roughness;
    if (changes.emissive) gpuChanges.emissive = changes.emissive;
    if (changes.ior !== undefined) gpuChanges.ior = changes.ior;
    if (changes.clearcoatFactor !== undefined) gpuChanges.clearcoatFactor = changes.clearcoatFactor;
    if (changes.clearcoatRoughness !== undefined) gpuChanges.clearcoatRoughness = changes.clearcoatRoughness;
    if (changes.unlit !== undefined) gpuChanges.unlit = changes.unlit;
    
    // Update primitive geometry meshes
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim?.isGPUInitialized && prim.meshId !== null && prim.gpuContext) {
      prim.gpuContext.objectRenderer.setMaterial(prim.meshId, gpuChanges);
    }
    
    // Update model meshes
    const mesh = entity.getComponent<MeshComponent>('mesh');
    if (mesh?.isGPUInitialized && mesh.gpuContext) {
      for (const meshId of mesh.meshIds) {
        mesh.gpuContext.objectRenderer.setMaterial(meshId, gpuChanges);
      }
    }
    
    store.syncFromWorld();
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