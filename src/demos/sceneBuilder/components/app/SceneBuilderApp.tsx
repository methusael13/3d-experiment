/**
 * SceneBuilderApp - Root Preact component for Scene Builder
 * Orchestrates the entire UI using signals-based state management
 */

import { useEffect, useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import { createSceneGraph, type SceneGraph } from '../../../../core/sceneGraph';
import { createScene, type Scene } from '../../../../core/Scene';
import { createLightingManager, type LightingManager } from '../../lightingManager';
import { WindManager } from '../../wind';
import { clearImportedModels, sceneSerializer } from '../../../../loaders';
import type { Asset } from '../hooks/useAssetLibrary';
import { useAssetImport } from '../hooks';
import { getSceneBuilderStore, resetSceneBuilderStore } from '../state';
import { ViewportContainer } from '../viewport';
import { ObjectsPanel } from '../panels';
import { AssetLibraryPanel } from '../panels/AssetLibraryPanel';
import { ConnectedObjectPanel, ConnectedEnvironmentPanel, ConnectedRenderingPanel, ConnectedMaterialPanel, ConnectedTerrainPanel, ConnectedWaterPanel, ConnectedMenuBar, ShaderDebugPanelContainer } from '../bridges';
import { useKeyboardShortcuts } from '../hooks';
import { DockingManagerProvider } from '../ui';
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
    
    // Set viewport scene graph and scene reference
    viewport.setSceneGraph(sceneGraph);
    viewport.setScene(scene);
    
    
    store.setupSceneCallbacks();
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
  
  // ==================== Asset Library State ====================
  
  const [assetLibraryVisible, setAssetLibraryVisible] = useState(true);
  
  const handleToggleAssetLibrary = useCallback(() => {
    setAssetLibraryVisible(prev => !prev);
  }, []);

  // ==================== Asset Import ====================
  
  const { importAsset } = useAssetImport();
  
  /**
   * Handle adding an asset from the library to the scene
   * Called when user double-clicks an asset in the Asset Library
   */
  const handleAddAssetToScene = useCallback(async (asset: Asset) => {
    await importAsset(asset);
  }, [importAsset]);

  const processWebGPUTestEnabled = useCallback(async () => {
    const success = await store.viewport?.enableWebGPUTest() ?? false;
    if (success && store.scene && store.viewport) {
      store.setIsWebGPU(true);
      // Refresh panels
      store.syncFromScene();
      console.log('[SceneBuilderApp] WebGPU mode enabled. Use Add > Terrain to add terrain.');
    }
  }, [store]);

  const processWebGPUTestDisabled = useCallback(() => {
    // Remove GPU terrain and ocean from scene when disabling WebGPU
    if (store.scene) {
      if (store.scene.hasWebGPUTerrain()) {
        store.scene.removeWebGPUTerrain();
      }
      if (store.scene.hasOcean()) {
        store.scene.removeOcean();
      }
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
    <DockingManagerProvider>
      <div class={styles.container}>
        {/* Menu Bar */}
        <ConnectedMenuBar />
      
      {/* Main Area (sidebars + viewport + bottom panel) */}
      <div class={styles.mainArea}>
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
          
          {/* Water Panel - shows when ocean object selected */}
          <ConnectedWaterPanel />
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
        
        {/* Bottom Panel - Asset Library */}
        <div class={styles.bottomPanel}>
          <AssetLibraryPanel
            isVisible={assetLibraryVisible}
            onToggleVisibility={handleToggleAssetLibrary}
            onAddAssetToScene={handleAddAssetToScene}
          />
        </div>
      </div>
      
        {/* Shader Debug Panel - Floating at root level to avoid viewport clipping */}
        <ShaderDebugPanelContainer />
      </div>
    </DockingManagerProvider>
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
