/**
 * SceneBuilderApp - Root Preact component for Scene Builder
 * Orchestrates the entire UI using signals-based state management
 */

import { useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { render } from 'preact';
import { createSceneGraph, type SceneGraph } from '../../../../core/sceneGraph';
import { createScene, type Scene } from '../../../../core/Scene';
import { GPUTerrainSceneObject } from '../../../../core/sceneObjects';
import { createLightingManager, type LightingManager } from '../../lightingManager';
import { WindManager } from '../../wind';
import { clearImportedModels } from '../../../../loaders';
import { getSceneBuilderStore, resetSceneBuilderStore } from '../state';
import { ViewportContainer } from '../viewport';
import { ObjectsPanel } from '../panels';
import { ConnectedObjectPanel, ConnectedEnvironmentPanel, ConnectedRenderingPanel, ConnectedMaterialPanel, ConnectedTerrainPanel, ConnectedMenuBar, ShaderDebugPanelContainer } from '../bridges';
import { useKeyboardShortcuts } from '../hooks';
import { Viewport } from '../../Viewport';
import styles from './SceneBuilderApp.module.css';

// Import CSS variables
import '../styles/variables.css';


// ==================== Types ====================

export interface SceneBuilderAppProps {
  width?: number;
  height?: number;
  onFps?: (fps: number) => void;
}

// ==================== Component ====================

export function SceneBuilderApp({
  width = 800,
  height = 600,
  onFps,
}: SceneBuilderAppProps) {
  const store = getSceneBuilderStore();
  
  // Track sceneGraph separately for cleanup
  const sceneGraphRef = useRef<SceneGraph | null>(null);
  
  // ==================== Initialize Core Systems ====================
  
  const handleViewportInitialized = useCallback((viewport: Viewport, gl: WebGL2RenderingContext) => {
    // Create core systems
    const sceneGraph = createSceneGraph();
    sceneGraphRef.current = sceneGraph;
    const scene = createScene(gl, sceneGraph);
    const lightingManager = createLightingManager();
    const windManager = new WindManager();
    
    // Store references
    store.scene = scene;
    store.gl = gl;
    store.viewport = viewport;
    store.lightingManager = lightingManager;
    store.windManager = windManager;
    
    // Set viewport scene graph
    viewport.setSceneGraph(sceneGraph);
    
    // Setup scene event listeners
    scene.onSelectionChanged = () => {
      store.syncFromScene();
    };
    
    scene.onObjectAdded = () => {
      store.syncFromScene();
    };
    
    scene.onObjectRemoved = () => {
      store.syncFromScene();
    };
    
    scene.onGroupChanged = () => {
      store.syncFromScene();
    };
    
    // Initial sync
    store.syncFromScene();
    
    // Initial lighting setup
    const lightParams = lightingManager.getLightParams(null);
    viewport.setLightParams(lightParams);
    viewport.setWindParams(windManager.getShaderUniforms());
    
    console.log('[SceneBuilderApp] Initialized');
  }, [store]);
  
  // ==================== Cleanup ====================
  
  useEffect(() => {
    return () => {
      // Cleanup viewport (WebGL context, animation loop)
      if (store.viewport) {
        store.viewport.destroy();
      }
      
      // Cleanup scene (all scene objects)
      if (store.scene) {
        store.scene.destroy();
      }
      
      // Clear scene graph
      if (sceneGraphRef.current) {
        sceneGraphRef.current.clear();
      }
      
      // Clear cached imported models
      clearImportedModels();
      
      // Reset store
      resetSceneBuilderStore();
      
      console.log('[SceneBuilderApp] Destroyed');
    };
  }, []);
  
  // ==================== Keyboard Shortcuts ====================
  
  useKeyboardShortcuts();

  const processWebGPUTestEnabled = useCallback(async () => {
    const success = await store.viewport?.enableWebGPUTest() ?? false;
    if (success && store.scene) {
      // Create GPU based Terrain and add to scene for selection
      store.gpuTerrainObject = new GPUTerrainSceneObject();
      const terrainManager = store.viewport?.getWebGPUTerrainManager() ?? null;
      store.gpuTerrainObject.setTerrainManager(terrainManager);

      // Add to scene so it appears in the ObjectsPanel
      store.scene.addSceneObject(store.gpuTerrainObject);

      // Refresh panels
      store.syncFromScene();
      store.setIsWebGPU(true);

      if (terrainManager) {
        const radius = terrainManager.getApproximateSceneRadius();
        store.viewport?.updateCameraForSceneBounds(radius);
      }
    }
  }, [store]);

  const processWebGPUTestDisabled = useCallback(() => {
    // Remove GPU terrain from scene
    if (store.gpuTerrainObject && store.scene) {
      store.scene.removeObject(store.gpuTerrainObject.id);
      store.gpuTerrainObject = null;
      store.syncFromScene();
    }
    store.setIsWebGPU(false);
    store.viewport?.disableWebGPUTest();
  }, [store]);
  
  const handleWebGPUTestToggle = useCallback((enabled: boolean) => {
    if (enabled) {
      processWebGPUTestEnabled();
    } else {
      processWebGPUTestDisabled();
    }
  }, [processWebGPUTestDisabled, processWebGPUTestEnabled]);

  // ==================== Render ====================
  
  return (
    <div class={styles.container}>
      {/* Menu Bar */}
      <ConnectedMenuBar />
      
      {/* Main Content (sidebars + viewport) */}
      <div class={styles.mainContent}>
        {/* Left Sidebar */}
        <div class={styles.sidebarLeft}>
          <ObjectsPanel
            scene={store.scene!}
            objects={store.objects.value.map(o => ({ id: o.id, name: o.name, groupId: o.groupId }))}
            groups={store.groups.value}
            selectedIds={store.selectedIds.value}
            expandedGroupIds={store.expandedGroupIds.value}
            onSelect={store.select}
            onSelectAll={store.selectAll}
            onClearSelection={store.clearSelection}
            onToggleGroup={store.toggleGroup}
          />
          
          {/* Object Panel - shows when object selected (includes Edit tab for primitives) */}
          <ConnectedObjectPanel />

          {/* Terrain Panel */}
          <ConnectedTerrainPanel />
        </div>
        
        {/* Viewport */}
        <ViewportContainer
          width={width}
          height={height}
          onFps={onFps}
          onInitialized={handleViewportInitialized}
        />
        
        {/* Right Sidebar */}
        <div class={styles.sidebarRight}>
          {/* Environment Panel */}
          <ConnectedEnvironmentPanel />
          
          {/* Rendering Panel */}
          <ConnectedRenderingPanel onToggleWebGPU={handleWebGPUTestToggle} />
          
          {/* Material Panel */}
          <ConnectedMaterialPanel />
        </div>
      </div>
      
      {/* Shader Debug Panel - Floating at root level to avoid viewport clipping */}
      <ShaderDebugPanelContainer />
    </div>
  );
}

// ==================== Mount Function ====================

/**
 * Mount SceneBuilderApp to a container element
 */
export function mountSceneBuilderApp(
  container: HTMLElement,
  props: SceneBuilderAppProps = {}
): () => void {
  render(<SceneBuilderApp {...props} />, container);
  
  return () => {
    render(null, container);
  };
}
