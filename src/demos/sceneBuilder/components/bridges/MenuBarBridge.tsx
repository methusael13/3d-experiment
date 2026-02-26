/**
 * MenuBarBridge - Connects MenuBar to the store (ECS Step 3)
 * Uses ECS factories for entity creation, World for selection/deletion.
 */

import { useComputed, signal } from '@preact/signals';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { MenuBar, type MenuDefinition, type MenuAction } from '../layout';
import { shaderPanelVisible, toggleShaderPanel } from './ShaderDebugPanelBridge';
import { FPSCameraController } from '../../FPSCameraController';
import { createPrimitiveEntity, createModelEntity, createTerrainEntity, createOceanEntity } from '@/core/ecs/factories';
import { PrimitiveGeometryComponent } from '@/core/ecs/components/PrimitiveGeometryComponent';
import { TransformComponent } from '@/core/ecs/components/TransformComponent';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { TerrainManager } from '@/core/terrain/TerrainManager';
import { OceanManager } from '@/core/ocean/OceanManager';
import { generatePrimitiveGeometry } from '@/core/utils/primitiveGeometry';
import { MeshComponent, BoundsComponent } from '@/core/ecs';

// Signal to track FPS mode state
export const fpsModeActive = signal(false);

// Signal to track Debug Camera mode state
export const debugCameraModeActive = signal(false);

// Signal to track current FPS
export const currentFps = signal<number | undefined>(undefined);

// Signal to track current draw call count
export const currentDrawCalls = signal<number | undefined>(undefined);

// Function to update FPS from external components (ViewportContainer)
export function setCurrentFps(fps: number): void {
  currentFps.value = fps;
}

// Function to update draw call count from external components (ViewportContainer)
export function setCurrentDrawCalls(count: number): void {
  currentDrawCalls.value = count;
}

export function ConnectedMenuBar() {
  const store = getSceneBuilderStore();
  
  // Reactive state for menu items
  const hasSelection = useComputed(() => store.selectionCount.value > 0);
  const multiSelection = useComputed(() => store.selectionCount.value > 1);
  const viewportState = useComputed(() => store.viewportState.value);
  
  // ==================== File Menu Actions ====================
  
  const handleSaveScene = useCallback(() => {
    const world = store.world;
    if (!world) return;
    
    // Serialize all entities
    const serializedEntities: any[] = [];
    for (const entity of world.getAllEntities()) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
      const mesh = entity.getComponent<MeshComponent>('mesh');
      const group = entity.getComponent<any>('group');
      
      const entry: any = {
        id: entity.id,
        name: entity.name,
        transform: transform?.serialize(),
        groupId: group?.groupId,
      };
      
      if (mesh) {
        entry.type = 'model';
        entry.modelPath = mesh.modelPath;
      } else if (prim) {
        entry.type = 'primitive';
        entry.primitiveType = prim.primitiveType;
        entry.primitiveConfig = { ...prim.config };
      } else if (entity.hasComponent('terrain')) {
        entry.type = 'terrain';
      } else if (entity.hasComponent('ocean')) {
        entry.type = 'ocean';
      }
      
      serializedEntities.push(entry);
    }
    
    // Serialize groups
    const serializedGroups: any[] = [];
    for (const [id, group] of world.getAllGroups()) {
      serializedGroups.push({ id, name: group.name, childIds: Array.from(group.childIds) });
    }
    
    const sceneData = {
      version: 2,
      entities: serializedEntities,
      groups: serializedGroups,
      camera: store.viewport?.getCameraState(),
    };
    
    // Download as JSON
    const json = JSON.stringify(sceneData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scene-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    console.log('[MenuBar] Scene saved');
  }, [store]);
  
  const handleLoadScene = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      const world = store.world;
      if (!world) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Clear existing entities
        for (const entity of world.getAllEntities()) {
          world.destroyEntity(entity.id);
        }
        
        // Load entities
        if (data.entities) {
          for (const entry of data.entities) {
            if (entry.type === 'primitive') {
              const entity = createPrimitiveEntity(world, {
                primitiveType: entry.primitiveType,
                name: entry.name,
                config: entry.primitiveConfig,
              });
              const newPrim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
              if (newPrim) {
                newPrim.geometryData = generatePrimitiveGeometry(entry.primitiveType, entry.primitiveConfig ?? {});
              }
              if (entry.transform) {
                entity.getComponent<TransformComponent>('transform')?.deserialize(entry.transform);
              }
            } else if (entry.type === 'model' && entry.modelPath) {
              const { loadGLB, getModelUrl } = await import('../../../../loaders');
              const url = getModelUrl(entry.modelPath);
              const model = await loadGLB(url);
              if (model) {
                const entity = createModelEntity(world, {
                  name: entry.name,
                  modelPath: entry.modelPath,
                });
                const newMesh = entity.getComponent<MeshComponent>('mesh');
                if (newMesh) {
                  newMesh.modelPath = entry.modelPath;
                  newMesh.model = model;
                }
                if (entry.transform) {
                  entity.getComponent<TransformComponent>('transform')?.deserialize(entry.transform);
                }
              }
            }
            // terrain and ocean need their managers, skip for now
          }
        }
        
        // Load camera
        if (data.camera) {
          store.viewport?.setCameraState(data.camera);
        }
        
        store.syncFromWorld();
        console.log('[MenuBar] Scene loaded');
      } catch (err) {
        console.error('[MenuBar] Failed to load scene:', err);
      }
    };
    input.click();
  }, [store]);
  
  // ==================== Edit Menu Actions ====================
  
  const handleGroupSelection = useCallback(() => {
    const world = store.world;
    if (!world || store.selectionCount.value < 2) return;
    world.createGroupFromSelection();
    store.syncFromWorld();
  }, [store]);
  
  const handleUngroup = useCallback(() => {
    const world = store.world;
    if (!world || store.selectionCount.value === 0) return;
    world.ungroupSelection();
    store.syncFromWorld();
  }, [store]);
  
  const handleDeleteSelected = useCallback(() => {
    const world = store.world;
    if (!world) return;
    const selectedIds = new Set(world.getSelectedIds());
    for (const id of selectedIds) {
      world.destroyEntity(id);
    }
    // syncFromWorld is called automatically via world.onEntityRemoved callback
  }, [store]);
  
  const handleDuplicate = useCallback(() => {
    const world = store.world;
    if (!world) return;
    
    const selected = world.getSelectedEntities();
    const newIds: string[] = [];
    
    for (const entity of selected) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
      const mesh = entity.getComponent<MeshComponent>('mesh');
      
      if (prim && transform) {
        // Duplicate primitive entity
        const newEntity = createPrimitiveEntity(world, {
          primitiveType: prim.primitiveType,
          name: entity.name + ' Copy',
          config: { ...prim.config },
        });
        
        const newTransform = newEntity.getComponent<TransformComponent>('transform');
        if (newTransform) {
          newTransform.setPosition([transform.position[0] + 1, transform.position[1], transform.position[2]]);
          newTransform.setRotationQuat(transform.rotationQuat);
          newTransform.setScale(transform.scale);
        }
        
        const newPrim = newEntity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
        if (newPrim) {
          newPrim.geometryData = generatePrimitiveGeometry(prim.primitiveType, prim.config);
        }
        
        newIds.push(newEntity.id);
      } else if (mesh && transform) {
        // Duplicate model entity — share the same GLBModel data, get new GPU meshes
        const newEntity = createModelEntity(world, {
          name: entity.name + ' Copy',
          modelPath: mesh.modelPath,
        });
        
        const newTransform = newEntity.getComponent<TransformComponent>('transform');
        if (newTransform) {
          newTransform.setPosition([transform.position[0] + 1, transform.position[1], transform.position[2]]);
          newTransform.setRotationQuat(transform.rotationQuat);
          newTransform.setScale(transform.scale);
        }
        
        // Share model data (GLBModel is read-only, safe to share)
        const newMesh = newEntity.getComponent<MeshComponent>('mesh');
        if (newMesh && mesh.model) {
          newMesh.modelPath = mesh.modelPath;
          newMesh.model = mesh.model;
          // GPU init happens via onEntityAdded callback
        }
        
        newIds.push(newEntity.id);
      }
    }
    
    if (newIds.length > 0) {
      world.selectAll(newIds);
    }
  }, [store]);
  
  const handleSelectAll = useCallback(() => {
    const world = store.world;
    if (!world) return;
    const allEntities = world.getAllEntities();
    world.selectAll(allEntities.map(e => e.id));
  }, [store]);
  
  // ==================== View Menu Actions ====================
  
  const handleSetViewportMode = useCallback((mode: 'solid' | 'wireframe') => {
    store.setViewportMode(mode);
  }, [store]);
  
  const handleToggleGrid = useCallback(() => {
    store.setShowGrid(!store.viewportState.value.showGrid);
  }, [store]);
  
  const handleToggleAxes = useCallback(() => {
    store.setShowAxes(!store.viewportState.value.showAxes);
  }, [store]);
  
  const handleExpandView = useCallback(() => {
    console.log('[MenuBar] Expand View - TODO');
  }, []);
  
  // FPS camera controller ref
  const fpsControllerRef = useRef<FPSCameraController | null>(null);
  
  const handleFPSCamera = useCallback(() => {
    const viewport = store.viewport;
    const world = store.world;
    if (!viewport || !world) {
      console.warn('[MenuBar] FPS Camera - viewport or world not available');
      return;
    }
    
    // If already in FPS mode, exit
    if (fpsModeActive.value) {
      if (fpsControllerRef.current) {
        fpsControllerRef.current.exit();
      }
      return;
    }
    
    // Get terrain entity and its manager
    const terrainEntity = world.queryFirst('terrain');
    if (!terrainEntity) {
      console.warn('[MenuBar] FPS Camera - no terrain entity in world');
      return;
    }
    
    const terrainComp = terrainEntity.getComponent<TerrainComponent>('terrain');
    const terrainManager = terrainComp?.manager;
    if (!terrainManager) {
      console.warn('[MenuBar] FPS Camera - no TerrainManager available');
      return;
    }
    
    if (!terrainManager.hasCPUHeightfield()) {
      console.warn('[MenuBar] FPS Camera - terrain CPU heightfield not ready');
      return;
    }
    
    if (!fpsControllerRef.current) {
      fpsControllerRef.current = new FPSCameraController();
    }
    
    const inputManager = viewport.getInputManager();
    if (!inputManager) {
      console.warn('[MenuBar] FPS Camera - InputManager not available');
      return;
    }
    
    const canvas = (viewport as any).canvas;
    if (!canvas) {
      console.warn('[MenuBar] FPS Camera - canvas not available');
      return;
    }
    
    const activated = fpsControllerRef.current.activate(
      canvas,
      terrainManager,
      inputManager,
      {
        onExit: () => {
          fpsModeActive.value = false;
          viewport.setFPSMode(false, null);
          console.log('[MenuBar] FPS Camera mode exited');
        },
      }
    );
    
    if (activated) {
      fpsModeActive.value = true;
      viewport.setFPSMode(true, fpsControllerRef.current);
      console.log('[MenuBar] FPS Camera mode activated');
    }
  }, [store]);
  
  const handleToggleDebugCamera = useCallback(() => {
    const viewport = store.viewport;
    if (!viewport) return;
    
    const newState = !debugCameraModeActive.value;
    if (newState && fpsModeActive.value) {
      fpsModeActive.value = false;
    }
    
    viewport.setDebugCameraMode(newState);
    debugCameraModeActive.value = newState;
  }, [store]);
  
  const handleToggleShaderEditor = useCallback(() => {
    toggleShaderPanel();
  }, []);
  
  const handleCameraPreset = useCallback((preset: number) => {
    const viewport = store.viewport;
    if (!viewport) return;
    
    const controller = (viewport as any).cameraController;
    if (!controller || typeof controller.setAngles !== 'function') return;
    
    switch (preset) {
      case 0: controller.setAngles(0.5, 0.3); break;
      case 1: controller.setAngles(0, 0); break;
      case 2: controller.setAngles(0, Math.PI / 2); break;
      case 3: controller.setAngles(Math.PI / 2, 0); break;
    }
  }, [store]);
  
  // ==================== Add Menu Actions ====================
  
  const handleAddPrimitive = useCallback((type: 'cube' | 'plane' | 'sphere') => {
    const world = store.world;
    if (!world) return;
    
    const entity = createPrimitiveEntity(world, { primitiveType: type });
    
    // Generate geometry data, compute bounds, then init GPU
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim) {
      prim.geometryData = generatePrimitiveGeometry(type, prim.config);
      
      // Each component computes its own bounds
      const boundsComp = entity.getComponent<BoundsComponent>('bounds');
      if (boundsComp) {
        boundsComp.localBounds = prim.computeLocalBounds();
        boundsComp.dirty = true;
      }
    }
    
    // Explicitly init GPU resources (onEntityAdded fires before geometryData is set)
    store.initEntityWebGPU(entity);
    world.select(entity.id);
  }, [store]);
  
  const handleAddTerrain = useCallback(async () => {
    const world = store.world;
    const gpuContext = store.viewport?.getWebGPUContext();
    if (!world || !gpuContext) {
      console.warn('[MenuBar] Cannot add terrain - world or GPU context not available');
      return;
    }
    
    // Check if terrain already exists
    if (world.queryFirst('terrain')) {
      console.warn('[MenuBar] Terrain already exists in world');
      return;
    }
    
    // Create TerrainManager, initialize and generate
    const terrainManager = new TerrainManager(gpuContext, {
      worldSize: 400,
      heightScale: 136,
    });
    await terrainManager.initialize();
    await terrainManager.generate((stage, progress) => {
      console.log(`[MenuBar] Terrain ${stage}: ${progress.toFixed(0)}%`);
    });
    console.log('[MenuBar] Terrain generation complete');
    
    // Create terrain entity
    const entity = createTerrainEntity(world, terrainManager);
    
    // Terrain sets its own worldBounds (no transform)
    const terrainComp = entity.getComponent<TerrainComponent>('terrain');
    const boundsComp = entity.getComponent<BoundsComponent>('bounds');
    if (terrainComp && boundsComp) {
      boundsComp.worldBounds = terrainComp.computeWorldBounds();
      boundsComp.dirty = false;
    }
    
    world.select(entity.id);
  }, [store]);
  
  const handleAddWater = useCallback(async () => {
    const world = store.world;
    const gpuContext = store.viewport?.getWebGPUContext();
    if (!world || !gpuContext) {
      console.warn('[MenuBar] Cannot add water - world or GPU context not available');
      return;
    }
    
    // Check if ocean already exists
    if (world.queryFirst('ocean')) {
      console.warn('[MenuBar] Water already exists in world');
      return;
    }
    
    // Create OceanManager and initialize
    const oceanManager = new OceanManager(gpuContext);
    await oceanManager.initialize();
    
    // Create ocean entity
    const entity = createOceanEntity(world, oceanManager);
    
    // Ocean sets its own worldBounds (no transform)
    const oceanComp = entity.getComponent<any>('ocean');
    const oceanBounds = entity.getComponent<BoundsComponent>('bounds');
    if (oceanComp?.computeWorldBounds && oceanBounds) {
      oceanBounds.worldBounds = oceanComp.computeWorldBounds();
      oceanBounds.dirty = false;
    }
    
    world.select(entity.id);
  }, [store]);
  
  // ==================== Menu Definitions ====================
  
  const menus = useMemo<MenuDefinition[]>(() => [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'save', label: 'Save Scene', shortcut: 'Ctrl+S', onClick: handleSaveScene },
        { id: 'load', label: 'Load Scene', shortcut: 'Ctrl+O', onClick: handleLoadScene },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { id: 'selectAll', label: 'Select All', shortcut: 'A', onClick: handleSelectAll },
        { id: 'duplicate', label: 'Duplicate', shortcut: 'D', onClick: handleDuplicate, disabled: !hasSelection.value },
        { id: 'delete', label: 'Delete', shortcut: 'Del', onClick: handleDeleteSelected, disabled: !hasSelection.value },
        { separator: true, id: 'sep1', label: '' },
        { id: 'group', label: 'Group Selection', shortcut: 'Ctrl+G', onClick: handleGroupSelection, disabled: !multiSelection.value },
        { id: 'ungroup', label: 'Ungroup', shortcut: 'Ctrl+Shift+G', onClick: handleUngroup, disabled: !hasSelection.value },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'solid', label: 'Solid', checked: viewportState.value.mode === 'solid', onClick: () => handleSetViewportMode('solid') },
        { id: 'wireframe', label: 'Wireframe', checked: viewportState.value.mode === 'wireframe', onClick: () => handleSetViewportMode('wireframe') },
        { separator: true, id: 'sep1', label: '' },
        { id: 'grid', label: 'Show Grid', checked: viewportState.value.showGrid, onClick: handleToggleGrid },
        { id: 'axes', label: 'Show Axes', checked: viewportState.value.showAxes, onClick: handleToggleAxes },
        { separator: true, id: 'sep2', label: '' },
        { id: 'expand', label: 'Expand View', onClick: handleExpandView },
        { id: 'fps', label: 'FPS Camera', checked: fpsModeActive.value, onClick: handleFPSCamera },
        { id: 'debugCamera', label: 'Debug Camera', checked: debugCameraModeActive.value, onClick: handleToggleDebugCamera },
        { separator: true, id: 'sep3', label: '' },
        { id: 'shaderEditor', label: 'Shader Editor', checked: shaderPanelVisible.value, onClick: handleToggleShaderEditor },
        { separator: true, id: 'sep4', label: '' },
        {
          id: 'camera',
          label: 'Camera Presets',
          submenu: [
            { id: 'cam0', label: 'Perspective', shortcut: '0', onClick: () => handleCameraPreset(0) },
            { id: 'cam1', label: 'Front', shortcut: '1', onClick: () => handleCameraPreset(1) },
            { id: 'cam2', label: 'Top', shortcut: '2', onClick: () => handleCameraPreset(2) },
            { id: 'cam3', label: 'Side', shortcut: '3', onClick: () => handleCameraPreset(3) },
          ],
        },
      ],
    },
    {
      id: 'add',
      label: 'Add',
      items: [
        { id: 'cube', label: 'Cube', onClick: () => handleAddPrimitive('cube') },
        { id: 'plane', label: 'Plane', onClick: () => handleAddPrimitive('plane') },
        { id: 'sphere', label: 'UV Sphere', onClick: () => handleAddPrimitive('sphere') },
        { separator: true, id: 'sep1', label: '' },
        { id: 'terrain', label: 'Terrain', onClick: handleAddTerrain },
        { id: 'water', label: 'Water', onClick: handleAddWater },
      ],
    },
  ], [
    handleSaveScene, handleLoadScene,
    handleSelectAll, handleDuplicate, handleDeleteSelected, handleGroupSelection, handleUngroup,
    handleSetViewportMode, handleToggleGrid, handleToggleAxes, handleExpandView, handleFPSCamera, handleCameraPreset,
    handleToggleShaderEditor, handleToggleDebugCamera,
    handleAddPrimitive, handleAddTerrain, handleAddWater,
    hasSelection.value, multiSelection.value, viewportState.value, shaderPanelVisible.value, fpsModeActive.value, debugCameraModeActive.value,
  ]);
  
  return <MenuBar menus={menus} fps={currentFps.value} drawCalls={currentDrawCalls.value} />;
}