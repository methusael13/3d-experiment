/**
 * MenuBarBridge - Connects MenuBar to the store
 */

import { useComputed, signal } from '@preact/signals';
import { useCallback, useMemo, useRef } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { MenuBar, type MenuDefinition, type MenuAction } from '../layout';
import { shaderPanelVisible, toggleShaderPanel } from './ShaderDebugPanelBridge';
import { FPSCameraController } from '../../FPSCameraController';

// Signal to track FPS mode state
export const fpsModeActive = signal(false);

// Signal to track current FPS
export const currentFps = signal<number | undefined>(undefined);

// Function to update FPS from external components (ViewportContainer)
export function setCurrentFps(fps: number): void {
  currentFps.value = fps;
}

export function ConnectedMenuBar() {
  const store = getSceneBuilderStore();
  
  // Reactive state for menu items
  const hasSelection = useComputed(() => store.selectionCount.value > 0);
  const multiSelection = useComputed(() => store.selectionCount.value > 1);
  const viewportState = useComputed(() => store.viewportState.value);
  
  // ==================== File Menu Actions ====================
  
  const handleSaveScene = useCallback(() => {
    const scene = store.scene;
    if (!scene) return;
    
    // Use scene's serialize method which returns the data we need
    const sceneData = scene.serialize();
    
    import('../../../../loaders/SceneSerializer').then(({ SceneSerializer }) => {
      const serializer = new SceneSerializer();
      // Get camera state from viewport if available
      const cameraState = {
        angleX: 0.5,
        angleY: 0.3,
        distance: 5,
        originX: 0,
        originY: 0,
        originZ: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0,
      };
      
      serializer.saveScene({
        sceneObjects: sceneData.objects,
        cameraState: store.viewport?.getCameraState() ?? cameraState,
        groupsArray: sceneData.groups,
      });
    });
  }, [store]);
  
  const handleLoadScene = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !store.scene || !store.gl) return;
      
      const text = await file.text();
      const data = JSON.parse(text);
      
      // Use scene's deserialize method
      await store.scene.deserialize(data);
      store.syncFromScene();
    };
    input.click();
  }, [store]);
  
  // ==================== Edit Menu Actions ====================
  
  const handleGroupSelection = useCallback(() => {
    const scene = store.scene;
    if (!scene || store.selectionCount.value < 2) return;
    scene.createGroupFromSelection();
    store.syncFromScene();
  }, [store]);
  
  const handleUngroup = useCallback(() => {
    const scene = store.scene;
    if (!scene || store.selectionCount.value === 0) return;
    scene.ungroupSelection();
    store.syncFromScene();
  }, [store]);
  
  const handleDeleteSelected = useCallback(() => {
    const scene = store.scene;
    if (!scene) return;
    const selectedIds = store.selectedIds.value;
    for (const id of selectedIds) {
      scene.removeObject(id);
    }
    store.syncFromScene();
  }, [store]);
  
  const handleDuplicate = useCallback(() => {
    const scene = store.scene;
    if (!scene) return;
    const selectedIds = store.selectedIds.value;
    for (const id of selectedIds) {
      scene.duplicateObject(id);
    }
    store.syncFromScene();
  }, [store]);
  
  const handleSelectAll = useCallback(() => {
    const scene = store.scene;
    if (!scene) return;
    // Select all objects by iterating through them
    const allObjects = scene.getAllObjects();
    for (const obj of allObjects) {
      scene.select(obj.id, { additive: true });
    }
    store.syncFromScene();
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
    // TODO: Implement fullscreen
    console.log('[MenuBar] Expand View - TODO');
  }, []);
  
  // FPS camera controller ref (persists across renders)
  const fpsControllerRef = useRef<FPSCameraController | null>(null);
  
  const handleFPSCamera = useCallback(() => {
    const viewport = store.viewport;
    const scene = store.scene;
    if (!viewport || !scene) {
      console.warn('[MenuBar] FPS Camera - viewport or scene not available');
      return;
    }
    
    // If already in FPS mode, exit
    if (fpsModeActive.value) {
      if (fpsControllerRef.current) {
        fpsControllerRef.current.exit();
      }
      return;
    }
    
    // Get terrain from scene
    const gpuTerrain = scene.getWebGPUTerrain();
    if (!gpuTerrain) {
      console.warn('[MenuBar] FPS Camera - no terrain in scene');
      return;
    }
    
    const terrainManager = gpuTerrain.getTerrainManager();
    if (!terrainManager) {
      console.warn('[MenuBar] FPS Camera - no TerrainManager available');
      return;
    }
    
    if (!terrainManager.hasCPUHeightfield()) {
      console.warn('[MenuBar] FPS Camera - terrain CPU heightfield not ready (terrain may still be generating)');
      return;
    }
    
    // Create FPS controller if needed
    if (!fpsControllerRef.current) {
      fpsControllerRef.current = new FPSCameraController();
    }
    
    const inputManager = viewport.getInputManager();
    if (!inputManager) {
      console.warn('[MenuBar] FPS Camera - InputManager not available');
      return;
    }
    
    // Get WebGPU canvas (or fall back to main canvas)
    const canvas = (viewport as any).webgpuCanvas || (viewport as any).canvas;
    if (!canvas) {
      console.warn('[MenuBar] FPS Camera - canvas not available');
      return;
    }
    
    // Activate FPS mode
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
    } else {
      console.warn('[MenuBar] FPS Camera - failed to activate');
    }
  }, [store]);
  
  const handleToggleShaderEditor = useCallback(() => {
    toggleShaderPanel();
  }, []);
  
  const handleCameraPreset = useCallback((preset: number) => {
    const viewport = store.viewport;
    if (!viewport) return;
    
    // Camera presets: 0=perspective, 1=front, 2=top, 3=side
    // Access camera controller via viewport's public property
    const controller = (viewport as any).cameraController;
    if (!controller || typeof controller.setAngles !== 'function') {
      console.log('[MenuBar] Camera preset - controller not available');
      return;
    }
    
    switch (preset) {
      case 0: // Perspective
        controller.setAngles(0.5, 0.3);
        break;
      case 1: // Front
        controller.setAngles(0, 0);
        break;
      case 2: // Top
        controller.setAngles(0, Math.PI / 2);
        break;
      case 3: // Side
        controller.setAngles(Math.PI / 2, 0);
        break;
    }
  }, [store]);
  
  // ==================== Add Menu Actions ====================
  
  const handleAddPrimitive = useCallback((type: 'cube' | 'plane' | 'sphere') => {
    const scene = store.scene;
    if (!scene) return;
    scene.addPrimitive(type);
    store.syncFromScene();
  }, [store]);
  
  const handleAddTerrain = useCallback(async () => {
    const scene = store.scene;
    const gpuContext = store.viewport?.getWebGPUContext();
    if (!scene || !gpuContext) {
      console.warn('[MenuBar] Cannot add terrain - scene or GPU context not available. Enable WebGPU mode first.');
      return;
    }

    if (!store.viewport?.isWebGPUTestMode()) {
      console.warn('[MenuBar] Cannot add terrain when not in WebGPU mode');
      return;
    }
    
    // Check if terrain already exists
    if (scene.getWebGPUTerrain()) {
      console.warn('[MenuBar] Terrain already exists in scene');
      return;
    }
    
    // Add terrain to scene
    const terrainObj = await scene.addWebGPUTerrain(gpuContext, {
      worldSize: 1024,
      heightScale: 100
    });
    
    if (terrainObj) {
      // Select the new terrain object
      scene.select(terrainObj.id);
      store.syncFromScene();
      // Camera bounds updated automatically via scene.onObjectAdded callback
    }
  }, [store]);
  
  const handleAddWater = useCallback(async () => {
    const scene = store.scene;
    const gpuContext = store.viewport?.getWebGPUContext();
    if (!scene || !gpuContext) {
      console.warn('[MenuBar] Cannot add water - scene or GPU context not available');
      return;
    }

    if (!store.viewport?.isWebGPUTestMode()) {
      console.warn('[MenuBar] Cannot add water when not in WebGPU mode');
      return;
    }
    
    // Check if water already exists
    if (scene.hasOcean()) {
      console.warn('[MenuBar] Water already exists in scene');
      return;
    }
    
    // Add ocean to scene
    const oceanObj = await scene.addOcean(gpuContext);
    if (oceanObj) {
      // Select the new ocean object
      scene.select(oceanObj.id);
      store.syncFromScene();
    }
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
    handleToggleShaderEditor,
    handleAddPrimitive, handleAddTerrain, handleAddWater,
    hasSelection.value, multiSelection.value, viewportState.value, shaderPanelVisible.value, fpsModeActive.value,
  ]);
  
  return <MenuBar menus={menus} fps={currentFps.value} />;
}
