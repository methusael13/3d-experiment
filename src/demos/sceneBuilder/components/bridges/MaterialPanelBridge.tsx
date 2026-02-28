/**
 * MaterialPanelBridge - Connects MaterialPanel to the store (ECS Step 3)
 * Reads/writes MaterialComponent on selected Entity.
 * Also manages the ProceduralTexturePanel and GPU texture generation.
 */

import { h } from 'preact';
import { useState, useCallback, useRef } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { MaterialPanel } from '../panels';
import { ProceduralTexturePanel } from '../panels/ProceduralTexturePanel/ProceduralTexturePanel';
import type { PBRMaterial } from '@/core/sceneObjects/types';
import { MaterialComponent } from '@/core/ecs/components/MaterialComponent';
import { PrimitiveGeometryComponent } from '@/core/ecs/components/PrimitiveGeometryComponent';
import { MeshComponent } from '@/core/ecs/components/MeshComponent';
import {
  ProceduralTextureGenerator,
  type ProceduralTextureParams,
  type TextureTargetSlot,
} from '@/core/gpu/renderers/ProceduralTextureGenerator';
import type { UnifiedGPUTexture } from '@/core/gpu/GPUTexture';
import type { GPUMaterialTextures } from '@/core/gpu/renderers/ObjectRendererGPU';

// ==================== Texture Cache ====================

const PACKED_MR_KEY = '__packed_mr__';

/**
 * Cache of generated GPU textures per entity+slot.
 * Key: `${entityId}:${slot}` or `${entityId}:__packed_mr__` for the packed MR texture.
 */
const textureCache = new Map<string, UnifiedGPUTexture>();

function cacheKey(entityId: string, slot: string): string {
  return `${entityId}:${slot}`;
}

// ==================== Shared Helper ====================

/**
 * Build GPUMaterialTextures from an entity's procedural texture definitions.
 * Handles packing separate metallic/roughness grayscale textures into a single
 * metallicRoughness GPU texture with correct channel assignment (G=roughness, B=metallic).
 */
function buildTexturesFromSlots(
  entityId: string,
  mat: MaterialComponent,
  generator: ProceduralTextureGenerator,
): GPUMaterialTextures {
  const textures: GPUMaterialTextures = {};

  for (const [slot] of mat.proceduralTextures) {
    const tex = textureCache.get(cacheKey(entityId, slot));
    if (!tex) continue;

    if (slot === 'baseColor') textures.baseColor = tex;
    else if (slot === 'occlusion') textures.occlusion = tex;
    else if (slot === 'emissive') textures.emissive = tex;
    // metallic/roughness handled below
  }

  // Pack metallic + roughness into a single metallicRoughness texture
  const hasMetallic = mat.proceduralTextures.has('metallic');
  const hasRoughness = mat.proceduralTextures.has('roughness');

  if (hasMetallic || hasRoughness) {
    // Remove old packed texture (don't destroy — still referenced by bind groups)
    const pkKey = cacheKey(entityId, PACKED_MR_KEY);
    textureCache.delete(pkKey);

    const metallicTex = textureCache.get(cacheKey(entityId, 'metallic')) ?? null;
    const roughnessTex = textureCache.get(cacheKey(entityId, 'roughness')) ?? null;
    const res = (mat.proceduralTextures.get('metallic') ?? mat.proceduralTextures.get('roughness'))!.resolution;

    const packed = generator.packMetallicRoughness(metallicTex, roughnessTex, res);
    textureCache.set(pkKey, packed);
    textures.metallicRoughness = packed;
  }

  return textures;
}

// ==================== Connected Component ====================

export function ConnectedMaterialPanel() {
  const store = getSceneBuilderStore();
  
  const [texturePanelSlot, setTexturePanelSlot] = useState<TextureTargetSlot | null>(null);
  const generatorRef = useRef<ProceduralTextureGenerator | null>(null);
  
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
  
  const texturedSlots = useComputed<Set<TextureTargetSlot>>(() => {
    const _ = store.transformVersion.value;
    const entity = selectedEntity.value;
    if (!entity) return new Set();
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return new Set();
    return new Set(mat.proceduralTextures.keys());
  });
  
  const getGPUContext = useCallback(() => {
    const entity = selectedEntity.value;
    if (!entity) return null;
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim?.gpuContext) return prim.gpuContext;
    const mesh = entity.getComponent<MeshComponent>('mesh');
    if (mesh?.gpuContext) return mesh.gpuContext;
    return null;
  }, []);
  
  const getGenerator = useCallback(() => {
    if (generatorRef.current) return generatorRef.current;
    const gpuCtx = getGPUContext();
    if (!gpuCtx) return null;
    generatorRef.current = new ProceduralTextureGenerator(gpuCtx);
    return generatorRef.current;
  }, [getGPUContext]);
  
  const handleMaterialChange = useCallback((changes: Partial<PBRMaterial>) => {
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
    
    const gpuChanges: Record<string, unknown> = {};
    if (changes.albedo) gpuChanges.albedo = changes.albedo;
    if (changes.metallic !== undefined) gpuChanges.metallic = changes.metallic;
    if (changes.roughness !== undefined) gpuChanges.roughness = changes.roughness;
    if (changes.emissive) gpuChanges.emissive = changes.emissive;
    if (changes.ior !== undefined) gpuChanges.ior = changes.ior;
    if (changes.clearcoatFactor !== undefined) gpuChanges.clearcoatFactor = changes.clearcoatFactor;
    if (changes.clearcoatRoughness !== undefined) gpuChanges.clearcoatRoughness = changes.clearcoatRoughness;
    if (changes.unlit !== undefined) gpuChanges.unlit = changes.unlit;
    
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim?.isGPUInitialized && prim.meshId !== null && prim.gpuContext) {
      prim.gpuContext.setMeshMaterial(prim.meshId, gpuChanges);
    }
    const mesh = entity.getComponent<MeshComponent>('mesh');
    if (mesh?.isGPUInitialized && mesh.gpuContext) {
      for (const meshId of mesh.meshIds) {
        mesh.gpuContext.setMeshMaterial(meshId, gpuChanges);
      }
    }
    store.syncFromWorld();
  }, []);
  
  const handleOpenTextureEditor = useCallback((slot: TextureTargetSlot) => {
    setTexturePanelSlot(slot);
  }, []);
  
  const handleCloseTextureEditor = useCallback(() => {
    setTexturePanelSlot(null);
  }, []);
  
  // Apply procedural texture
  const handleApplyTexture = useCallback((slot: TextureTargetSlot, params: ProceduralTextureParams) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return;
    const generator = getGenerator();
    if (!generator) {
      console.error('[MaterialPanelBridge] No GPU context available for texture generation');
      return;
    }
    
    // Remove old cached texture for this slot (don't destroy — still referenced by bind groups
    // until the next render frame recreates them; will be GC'd when entity is removed)
    const key = cacheKey(entity.id, slot);
    textureCache.delete(key);
    
    // Generate new grayscale texture and cache it
    const texture = generator.generate(params);
    textureCache.set(key, texture);
    
    // Store params on MaterialComponent for serialization
    mat.proceduralTextures.set(slot, {
      ...params,
      colorRamp: { ...params.colorRamp },
    });
    mat.updateTextureFlags();
    
    // Build all GPU textures (handles metallic/roughness packing)
    const textures = buildTexturesFromSlots(entity.id, mat, generator);
    
    // Apply to GPU mesh
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim?.isGPUInitialized && prim.meshId !== null && prim.gpuContext) {
      prim.gpuContext.setMeshTextures(prim.meshId, textures);
      prim.gpuContext.setMeshMaterial(prim.meshId, {
        triplanarMode: params.projection === 'triplanar' ? 1.0 : 0.0,
        triplanarScale: params.triplanarScale,
      });
    }
    
    store.syncFromWorld();
  }, [getGenerator]);
  
  // Clear procedural texture
  const handleClearTexture = useCallback((slot: TextureTargetSlot) => {
    const entity = selectedEntity.value;
    if (!entity) return;
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return;
    
    // Remove from cache (defer destroy)
    const key = cacheKey(entity.id, slot);
    const oldTex = textureCache.get(key);
    textureCache.delete(key);
    
    // Remove from MaterialComponent
    mat.proceduralTextures.delete(slot);
    mat.updateTextureFlags();
    
    // Rebuild all GPU textures from remaining procedural textures
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim?.isGPUInitialized && prim.meshId !== null && prim.gpuContext) {
      const generator = getGenerator();
      const textures = generator
        ? buildTexturesFromSlots(entity.id, mat, generator)
        : {};
      
      prim.gpuContext.setMeshTextures(prim.meshId, textures);
      prim.gpuContext.setMeshMaterial(prim.meshId, {
        triplanarMode: 0.0,
      });
    }
    
    
    store.syncFromWorld();
    setTexturePanelSlot(null);
  }, [getGenerator]);
  
  const getInitialParams = useCallback((): ProceduralTextureParams | null => {
    if (!texturePanelSlot) return null;
    const entity = selectedEntity.value;
    if (!entity) return null;
    const mat = entity.getComponent<MaterialComponent>('material');
    if (!mat) return null;
    return mat.proceduralTextures.get(texturePanelSlot) ?? null;
  }, [texturePanelSlot]);
  
  return (
    <>
      <MaterialPanel
        selectedObjectId={selectedObjectId.value}
        objectType={objectType.value}
        material={material.value}
        onMaterialChange={handleMaterialChange}
        texturedSlots={texturedSlots.value}
        onOpenTextureEditor={handleOpenTextureEditor}
      />
      
      {texturePanelSlot && (
        <ProceduralTexturePanel
          targetSlot={texturePanelSlot}
          initialParams={getInitialParams()}
          onApply={handleApplyTexture}
          onClear={handleClearTexture}
          onClose={handleCloseTextureEditor}
        />
      )}
    </>
  );
}