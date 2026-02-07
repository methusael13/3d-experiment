/**
 * SceneBuilder State Store
 * Central reactive state management using @preact/signals
 */

import { signal, computed, effect, batch, type Signal } from '@preact/signals';
import type { Scene } from '../../../../core/Scene';
import type { Viewport } from '../../Viewport';
import type { LightingManager } from '../../lightingManager';
import type { WindManager, ObjectWindSettings } from '../../wind';
import type { GizmoMode, GizmoOrientation } from '../../gizmos';
import type { Vec3 } from '../../../../core/types';
import type { TerrainBlendSettings } from '../../componentPanels';
import { AnySceneObject, GPUTerrainSceneObject, TerrainObject } from '../../../../core/sceneObjects';
import { debounce } from '@/core/utils';

// ==================== Types ====================

export interface ObjectGroupData {
  id: string;
  name: string;
  childIds: string[];
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface ViewportState {
  mode: 'solid' | 'wireframe';
  showGrid: boolean;
  showAxes: boolean;
  fpsMode: boolean;
}

// ==================== Store ====================

export interface SceneBuilderStore {
  // Scene state
  objects: Signal<AnySceneObject[]>;
  groups: Signal<Map<string, ObjectGroupData>>;
  selectedIds: Signal<Set<string>>;
  expandedGroupIds: Signal<Set<string>>;
  sceneBoundsVersion: Signal<number>;
  
  // Viewport state
  viewportState: Signal<ViewportState>;
  gizmoMode: Signal<GizmoMode>;
  gizmoOrientation: Signal<GizmoOrientation>;
  
  // Per-object settings
  objectWindSettings: Signal<Map<string, ObjectWindSettings>>;
  objectTerrainBlendSettings: Signal<Map<string, TerrainBlendSettings>>;
  
  // Computed
  selectedObjects: Signal<AnySceneObject[]>;
  firstSelectedObject: Signal<AnySceneObject | null>;
  selectionCount: Signal<number>;
  
  // References (not reactive, just stored)
  scene: Scene | null;
  viewport: Viewport | null;
  lightingManager: LightingManager | null;
  windManager: WindManager | null;
  gl: WebGL2RenderingContext | null;
  
  // Terrain references (WebGL vs WebGPU mode)
  terrainObject: TerrainObject | null;
  isWebGPU: Signal<boolean>;
  
  // Actions
  syncFromScene(): void;
  select(id: string, additive?: boolean): void;
  selectAll(ids: string[]): void;
  clearSelection(): void;
  toggleGroup(groupId: string): void;
  setGizmoMode(mode: GizmoMode): void;
  setGizmoOrientation(orientation: GizmoOrientation): void;
  setViewportMode(mode: 'solid' | 'wireframe'): void;
  setShowGrid(show: boolean): void;
  setShowAxes(show: boolean): void;
  setIsWebGPU(enabled: boolean): void;
  
  // Camera bounds management
  updateCameraFromSceneBounds(): void;
  setupSceneCallbacks(): void;
}

// ==================== Create Store ====================

export function createSceneBuilderStore(): SceneBuilderStore {
  // Core signals
  const objects = signal<AnySceneObject[]>([]);
  const groups = signal<Map<string, ObjectGroupData>>(new Map());
  const selectedIds = signal<Set<string>>(new Set());
  const expandedGroupIds = signal<Set<string>>(new Set());
  
  const viewportState = signal<ViewportState>({
    mode: 'solid',
    showGrid: true,
    showAxes: true,
    fpsMode: false,
  });
  
  const gizmoMode = signal<GizmoMode>('translate');
  const gizmoOrientation = signal<GizmoOrientation>('world');
  
  const objectWindSettings = signal<Map<string, ObjectWindSettings>>(new Map());
  const objectTerrainBlendSettings = signal<Map<string, TerrainBlendSettings>>(new Map());
  const isWebGPU = signal<boolean>(false);
  const sceneBoundsVersion = signal<number>(0);
  
  // Debounced camera bounds update function (100ms delay)
  const debouncedCameraUpdate = debounce(() => {
    if (!scene || !viewport) return;
    
    const bounds = scene.getSceneBounds();
    if (!bounds) return;
    
    // Calculate scene radius from AABB
    const sizeX = bounds.max[0] - bounds.min[0];
    const sizeY = bounds.max[1] - bounds.min[1];
    const sizeZ = bounds.max[2] - bounds.min[2];
    const radius = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) / 2;
    
    // Only update if radius is meaningful
    if (radius > 0.1) {
      viewport.updateCameraForSceneBounds(radius);
      console.log('[SceneBuilderStore] Camera updated for scene bounds, radius:', radius.toFixed(1));
    }
    
    // Increment version to signal bounds changed
    sceneBoundsVersion.value++;
  }, 100);
  
  // Computed values
  const selectedObjects = computed(() => {
    const ids = selectedIds.value;
    return objects.value.filter(obj => ids.has(obj.id));
  });
  
  const firstSelectedObject = computed(() => {
    const selected = selectedObjects.value;
    return selected.length > 0 ? selected[0] : null;
  });
  
  const selectionCount = computed(() => selectedIds.value.size);
  
  // References (not signals)
  let scene: Scene | null = null;
  let viewport: Viewport | null = null;
  let lightingManager: LightingManager | null = null;
  let windManager: WindManager | null = null;
  let gl: WebGL2RenderingContext | null = null;
  let terrainObject: TerrainObject | null = null;
  let gpuTerrainObject: GPUTerrainSceneObject | null = null;
  
  // ==================== Actions ====================
  
  function syncFromScene(): void {
    const currentScene = scene;
    if (!currentScene) return;
    
    batch(() => {
      // Sync objects
      const allObjects = currentScene.getAllObjects();
      objects.value = allObjects;
      
      // Sync groups
      const sceneGroups = currentScene.getAllGroups();
      const groupsMap = new Map<string, ObjectGroupData>();
      for (const [groupId, groupData] of sceneGroups) {
        groupsMap.set(groupId, {
          id: groupId,
          name: groupData.name,
          childIds: [...groupData.childIds],
        });
      }
      groups.value = groupsMap;
      
      // Sync selection
      const selectedIdsList = currentScene.getSelectedIds();
      selectedIds.value = new Set(selectedIdsList);

      viewport?.setRenderData({
        objects: allObjects as any,
        objectWindSettings: objectWindSettings.value,
        objectTerrainBlendSettings: objectTerrainBlendSettings.value,
        selectedIds: selectedIdsList,
        getModelMatrix: (obj: any) => scene!.getModelMatrix(obj)
      });
    });
  }

  function select(id: string, additive = false): void {
    if (!scene) return;
    scene.select(id, { additive });
    syncFromScene();
  }
  
  function selectAll(ids: string[]): void {
    if (!scene) return;
    for (const id of ids) {
      scene.select(id, { additive: true });
    }
    syncFromScene();
  }
  
  function clearSelection(): void {
    if (!scene) return;
    scene.clearSelection();
    syncFromScene();
  }
  
  function toggleGroup(groupId: string): void {
    const current = new Set(expandedGroupIds.value);
    if (current.has(groupId)) {
      current.delete(groupId);
    } else {
      current.add(groupId);
    }
    expandedGroupIds.value = current;
  }
  
  function setGizmoMode(mode: GizmoMode): void {
    gizmoMode.value = mode;
    viewport?.setGizmoMode(mode);
  }
  
  function setGizmoOrientation(orientation: GizmoOrientation): void {
    gizmoOrientation.value = orientation;
    viewport?.setGizmoOrientation(orientation);
  }
  
  function setViewportMode(mode: 'solid' | 'wireframe'): void {
    viewportState.value = { ...viewportState.value, mode };
    viewport?.setViewportMode(mode);
  }
  
  function setShowGrid(show: boolean): void {
    viewportState.value = { ...viewportState.value, showGrid: show };
    viewport?.setShowGrid(show);
  }
  
  function setShowAxes(show: boolean): void {
    viewportState.value = { ...viewportState.value, showAxes: show };
    viewport?.setShowAxes(show);
  }

  function setIsWebGPU(enabled: boolean): void {
    isWebGPU.value = enabled;
  }
  
  /**
   * Update camera clip planes based on current scene bounds.
   * Debounced to prevent excessive updates during rapid changes.
   */
  function updateCameraFromSceneBounds(): void {
    debouncedCameraUpdate();
  }
  
  /**
   * Setup scene callbacks for automatic camera bounds updates.
   * Should be called after scene is assigned.
   */
  function setupSceneCallbacks(): void {
    if (!scene) return;
    
    // Hook into object added callback
    scene.onObjectAdded = (obj) => {
      updateCameraFromSceneBounds();
    };
    
    // Hook into object removed callback
    scene.onObjectRemoved = (id) => {
      updateCameraFromSceneBounds();
    };
    
    console.log('[SceneBuilderStore] Scene callbacks setup for auto camera bounds update');
  }
  
  return {
    // Signals
    objects,
    groups,
    selectedIds,
    expandedGroupIds,
    viewportState,
    gizmoMode,
    gizmoOrientation,
    objectWindSettings,
    objectTerrainBlendSettings,
    isWebGPU,
    sceneBoundsVersion,
    
    // Computed
    selectedObjects,
    firstSelectedObject,
    selectionCount,
    
    // References (using getters to allow mutation)
    get scene() { return scene; },
    set scene(s) { scene = s; },
    get viewport() { return viewport; },
    set viewport(v) { viewport = v; },
    get lightingManager() { return lightingManager; },
    set lightingManager(l) { lightingManager = l; },
    get windManager() { return windManager; },
    set windManager(w) { windManager = w; },
    get gl() { return gl; },
    set gl(g) { gl = g; },
    get terrainObject() { return terrainObject; },
    set terrainObject(t) { terrainObject = t; },
    
    // Actions
    syncFromScene,
    select,
    selectAll,
    clearSelection,
    toggleGroup,
    setGizmoMode,
    setGizmoOrientation,
    setViewportMode,
    setShowGrid,
    setShowAxes,
    setIsWebGPU,
    updateCameraFromSceneBounds,
    setupSceneCallbacks
  };
}

// ==================== Context ====================

// Singleton store instance for the app
let globalStore: SceneBuilderStore | null = null;

export function getSceneBuilderStore(): SceneBuilderStore {
  if (!globalStore) {
    globalStore = createSceneBuilderStore();
  }
  return globalStore;
}

export function resetSceneBuilderStore(): void {
  globalStore = null;
}
