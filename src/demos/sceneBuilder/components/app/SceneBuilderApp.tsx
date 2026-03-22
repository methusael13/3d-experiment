/**
 * SceneBuilderApp - Root Preact component for Scene Builder
 * Orchestrates the entire UI using signals-based state management
 * 
 * ECS Step 3: No Scene — World is the authority for all objects.
 */

import { useEffect, useCallback, useState } from 'preact/hooks';
import { render } from 'preact';
import { clearImportedModels } from '../../../../loaders';
import type { Asset } from '../hooks/useAssetLibrary';
import { useAssetImport } from '../hooks';
import { getSceneBuilderStore, resetSceneBuilderStore } from '../state';
import { ViewportContainer } from '../viewport';
import { ObjectsPanel } from '../panels';
import { AssetLibraryPanel } from '../panels/AssetLibraryPanel';
import { ConnectedObjectPanel, ConnectedEnvironmentPanel, ConnectedRenderingPanel, ConnectedMaterialPanel, ConnectedTerrainPanel, ConnectedWaterPanel, ConnectedMenuBar, ShaderDebugPanelContainer } from '../bridges';
import { activeAppTab } from '../bridges/MenuBarBridge';
import { MaterialEditorView } from '../panels/MaterialEditorPanel/MaterialEditorView';
import { useKeyboardShortcuts } from '../hooks';
import { DockingManagerProvider } from '../ui';
import { ImportModeDialog } from '../ui/ImportModeDialog/ImportModeDialog';
import { Viewport } from '../../Viewport';
import type { Entity } from '@/core/ecs/Entity';
import type { GroupComponent } from '@/core/ecs/components/GroupComponent';
import styles from './SceneBuilderApp.module.css';

// Import CSS variables
import '../styles/variables.css';
import { Logger, LogLevel } from '@/core/utils/logger';


// ==================== Types ====================

Logger.setGlobalLevel(LogLevel.LOG);

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
  
  // ==================== Initialize Core Systems ====================
  
  const handleViewportInitialized = useCallback((viewport: Viewport) => {
    // Store references
    store.viewport = viewport;
    
    // Set viewport scene graph to World's internal sceneGraph
    viewport.setSceneGraph(viewport.world.sceneGraph);
    
    // Setup World callbacks (entity add/remove → sync store)
    store.setupWorldCallbacks();
    
    // Initial sync
    store.syncFromWorld();
    
    store.setViewportInitialized();

    console.log('[SceneBuilderApp] Initialized (ECS World-based)');
  }, [store]);
  
  // ==================== Cleanup ====================
  
  useEffect(() => {
    return () => {
      // Cleanup viewport (WebGPU context, animation loop, World)
      if (store.viewport) {
        store.viewport.destroy();
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
  
  const handleAddAssetToScene = useCallback(async (asset: Asset) => {
    await importAsset(asset);
  }, [importAsset]);

  // ==================== Render ====================
  
  // Map entities to ObjectsPanel-compatible format
  // Helper: get entity icon based on component types
  const getEntityIcon = (e: Entity): string | undefined => {
    const lc = e.getComponent<any>('light');
    if (lc) {
      const lt = lc.lightType;
      if (lt === 'directional') return '☀️';
      if (lt === 'point') return '💡';
      if (lt === 'spot') return '🔦';
      return '💡';
    }
    if (e.hasComponent('terrain')) return '⛰️';
    if (e.hasComponent('ocean')) return '🌊';
    if (e.hasComponent('mesh')) return '📦';
    if (e.hasComponent('primitive-geometry')) return '🧊';
    return undefined;
  };

  const objectsForPanel = store.objects.value.map((e: Entity) => {
    const group = e.getComponent<GroupComponent>('group');
    return { id: e.id, name: e.name, groupId: group?.groupId, icon: getEntityIcon(e), parentId: e.parentId, childIds: e.childIds };
  });
  
  const currentTab = activeAppTab.value;
  
  // Pause/resume rendering when switching tabs to save GPU resources
  useEffect(() => {
    const viewport = store.viewport;
    if (viewport?.engineAnimationLoop) {
      viewport.engineAnimationLoop.setPaused(currentTab !== 'editor');
    }
  }, [currentTab, store.viewport]);
  
  return (
    <DockingManagerProvider>
      <div class={styles.container}>
        {/* Menu Bar */}
        <ConnectedMenuBar />
      
      {/* Editor Tab — always mounted (WebGPU context), hidden when inactive */}
        <div class={styles.mainArea} style={{ display: currentTab === 'editor' ? 'flex' : 'none' }}>
          {/* Main Content (sidebars + viewport) */}
          <div class={styles.mainContent}>
          {/* Left Sidebar */}
          <div class={styles.sidebarLeft}>
            <ObjectsPanel
              objects={objectsForPanel}
              groups={store.groups.value}
              selectedIds={store.selectedIds.value}
              expandedGroupIds={store.expandedGroupIds.value}
              onSelect={store.select}
              onSelectAll={store.selectAll}
              onClearSelection={store.clearSelection}
              onToggleGroup={store.toggleGroup}
              onSetParent={(childId: string, parentId: string | null) => {
                store.world?.setParent(childId, parentId, true);
                store.syncFromWorld();
              }}
            />
            
            {/* Object Panel - shows when object selected */}
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
            <ConnectedRenderingPanel />
            
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

        {/* Materials Tab — destroyed/recreated on switch, reloads from registry */}
        {currentTab === 'materials' && (
          <div class={styles.mainArea}>
            <MaterialEditorView />
          </div>
        )}
      
        {/* Shader Debug Panel - Floating at root level */}
        <ShaderDebugPanelContainer />
        
        {/* Import mode dialog */}
        <ImportModeDialog />
      </div>
    </DockingManagerProvider>
  );
}

// ==================== Mount Function ====================

export function mountSceneBuilderApp(
  container: HTMLElement,
  props: SceneBuilderAppProps = {}
): () => void {
  render(<SceneBuilderApp {...props} />, container);
  
  return () => {
    render(null, container);
  };
}