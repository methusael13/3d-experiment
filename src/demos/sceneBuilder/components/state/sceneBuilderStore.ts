/**
 * SceneBuilder State Store — Entity/World-based (ECS Step 3)
 * Central reactive state management using @preact/signals
 * 
 * All object state is read from World/Entity, not Scene/SceneObject.
 */

import { signal, computed, batch, type Signal } from '@preact/signals';
import type { Viewport } from '../../Viewport';
import type { LightingManager } from '../../lightingManager';
import type { World } from '@/core/ecs/World';
import type { Entity } from '@/core/ecs/Entity';
import type { GizmoMode, GizmoOrientation } from '../../gizmos';
import type { Vec3 } from '../../../../core/types';
import type { ObjectWindSettings } from '../../wind';
import type { MeshComponent } from '@/core/ecs/components/MeshComponent';
import type { PrimitiveGeometryComponent } from '@/core/ecs/components/PrimitiveGeometryComponent';
import { debounce } from '@/core/utils';
import { sceneSerializer } from '../../../../loaders';

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
  // Scene state — Entity-based
  objects: Signal<Entity[]>;
  groups: Signal<Map<string, ObjectGroupData>>;
  selectedIds: Signal<Set<string>>;
  expandedGroupIds: Signal<Set<string>>;
  sceneBoundsVersion: Signal<number>;
  transformVersion: Signal<number>;
  
  // Viewport state
  viewportInitialized: Signal<boolean>;
  viewportState: Signal<ViewportState>;
  gizmoMode: Signal<GizmoMode>;
  gizmoOrientation: Signal<GizmoOrientation>;
  
  // Per-object settings
  objectWindSettings: Signal<Map<string, ObjectWindSettings>>;
  
  // Computed
  selectedObjects: Signal<Entity[]>;
  firstSelectedObject: Signal<Entity | null>;
  selectionCount: Signal<number>;
  
  // References (not reactive, just stored)
  viewport: Viewport | null;
  lightingManager: LightingManager | null;
  
  /** ECS World — accessed via viewport.world. Available after viewport init. */
  readonly world: World | null;
  
  // WebGPU mode (always true now)
  isWebGPU: Signal<boolean>;
  
  // Actions
  syncFromWorld(): void;
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
  setViewportInitialized(): void;
  
  // Camera bounds management
  updateCameraFromSceneBounds(): void;
  setupWorldCallbacks(): void;
  
  // Entity GPU initialization
  initEntityWebGPU(entity: Entity): void;
}

// ==================== Create Store ====================

export function createSceneBuilderStore(): SceneBuilderStore {
  // Core signals
  const objects = signal<Entity[]>([]);
  const groups = signal<Map<string, ObjectGroupData>>(new Map());
  const selectedIds = signal<Set<string>>(new Set());
  const expandedGroupIds = signal<Set<string>>(new Set());
  
  const viewportInitialized = signal<boolean>(false);
  const viewportState = signal<ViewportState>({
    mode: 'solid',
    showGrid: true,
    showAxes: true,
    fpsMode: false,
  });
  
  const gizmoMode = signal<GizmoMode>('translate');
  const gizmoOrientation = signal<GizmoOrientation>('world');
  
  const objectWindSettings = signal<Map<string, ObjectWindSettings>>(new Map());
  const isWebGPU = signal<boolean>(true);
  const sceneBoundsVersion = signal<number>(0);
  const transformVersion = signal<number>(0);
  
  // Debounced camera bounds update function (100ms delay)
  const debouncedCameraUpdate = debounce(() => {
    const w = viewport?.world;
    if (!w || !viewport) return;
    
    // Calculate bounds from all entities with bounds components
    const entities = w.getAllEntities();
    if (entities.length === 0) return;
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasBounds = false;
    
    for (const entity of entities) {
      const bounds = entity.getComponent<any>('bounds');
      if (bounds?.worldBounds) {
        const b = bounds.worldBounds;
        minX = Math.min(minX, b.min[0]);
        minY = Math.min(minY, b.min[1]);
        minZ = Math.min(minZ, b.min[2]);
        maxX = Math.max(maxX, b.max[0]);
        maxY = Math.max(maxY, b.max[1]);
        maxZ = Math.max(maxZ, b.max[2]);
        hasBounds = true;
      }
    }
    
    if (!hasBounds) return;
    
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const radius = Math.max(10, Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) / 2);

    if (radius > 0.1) {
      viewport.updateCameraForSceneBounds(radius);
      console.log('[SceneBuilderStore] Camera updated for scene bounds, radius:', radius.toFixed(1));
    }
    
    sceneBoundsVersion.value++;
  }, 100);
  
  // Computed values
  const selectedObjects = computed(() => {
    const ids = selectedIds.value;
    return objects.value.filter(entity => ids.has(entity.id));
  });
  
  const firstSelectedObject = computed(() => {
    const selected = selectedObjects.value;
    return selected.length > 0 ? selected[0] : null;
  });
  
  const selectionCount = computed(() => selectedIds.value.size);
  
  // References (not signals)
  let viewport: Viewport | null = null;
  let lightingManager: LightingManager | null = null;
  
  // ==================== Actions ====================
  
  function syncFromWorld(): void {
    const world = viewport?.world;
    if (!world) return;
    
    batch(() => {
      // Sync objects from World entities
      objects.value = world.getAllEntities();
      
      // Sync selection from World
      selectedIds.value = new Set(world.getSelectedIds());
      
      // Sync groups from World
      const worldGroups = world.getAllGroups();
      const groupsMap = new Map<string, ObjectGroupData>();
      for (const [groupId, groupData] of worldGroups) {
        groupsMap.set(groupId, {
          id: groupId,
          name: groupData.name,
          childIds: Array.from(groupData.childIds),
        });
      }
      groups.value = groupsMap;
      
      // Increment transform version to force computed values to re-run
      transformVersion.value++;
    });
  }

  function select(id: string, additive = false): void {
    const world = viewport?.world;
    if (!world) return;
    world.select(id, { additive });
    syncFromWorld();
  }
  
  function selectAll(ids: string[]): void {
    const world = viewport?.world;
    if (!world) return;
    world.selectAll(ids);
    syncFromWorld();
  }
  
  function clearSelection(): void {
    const world = viewport?.world;
    if (!world) return;
    world.clearSelection();
    syncFromWorld();
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
  
  function setViewportInitialized() {
    viewportInitialized.value = true;
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
    
    if (enabled) {
      setTimeout(() => initAllEntitiesWebGPU(), 100);
    }
  }
  
  function updateCameraFromSceneBounds(): void {
    debouncedCameraUpdate();
  }
  
  /**
   * Setup World callbacks for automatic sync on entity add/remove.
   */
  function setupWorldCallbacks(): void {
    const world = viewport?.world;
    if (!world) return;
    
    world.onEntityAdded = (entity) => {
      syncFromWorld();
      initEntityWebGPU(entity);
    };
    
    world.onEntityRemoved = (id) => {
      sceneSerializer.unregisterAssetRef(id);
      syncFromWorld();
    };

    world.onSelectionChanged = () => {
      syncFromWorld();
    };
    
    // Hook BoundsSystem callback for automatic camera plane updates
    const boundsSystem = world.getSystem<any>('bounds');
    if (boundsSystem) {
      boundsSystem.onSceneBoundsChanged = (_sceneBounds: any) => {
        updateCameraFromSceneBounds();
      };
    }
    
    console.log('[SceneBuilderStore] World callbacks setup');
  }
  
  /**
   * Initialize WebGPU resources for an entity.
   */
  function initEntityWebGPU(entity: Entity): void {
    if (!isWebGPU.value) return;
    
    const gpuContext = viewport?.getWebGPUContext();
    if (!gpuContext) return;
    
    // Handle MeshComponent (model entities) - initWebGPU is async
    const mesh = entity.getComponent<MeshComponent>('mesh');
    if (mesh && !mesh.isGPUInitialized) {
      console.log(`[SceneBuilderStore] Calling initWebGPU on mesh entity: ${entity.name}`);
      mesh.initWebGPU(gpuContext).then(() => {
        console.log('[SceneBuilderStore] meshIds after init:', mesh.meshIds);
        // Mark transform dirty so MeshRenderSystem uploads the GPU transform next frame
        const tc = entity.getComponent<any>('transform');
        if (tc) tc.dirty = true;
      });
      return;
    }
    
    // Handle PrimitiveGeometryComponent (primitive entities) - initWebGPU is sync
    const prim = entity.getComponent<PrimitiveGeometryComponent>('primitive-geometry');
    if (prim && !prim.isGPUInitialized) {
      console.log(`[SceneBuilderStore] Calling initWebGPU on primitive entity: ${entity.name}`);
      prim.initWebGPU(gpuContext);
      console.log('[SceneBuilderStore] meshId after init:', prim.meshId);
      // Mark transform dirty so MeshRenderSystem uploads the GPU transform next frame
      const tc = entity.getComponent<any>('transform');
      if (tc) tc.dirty = true;
      return;
    }
  }
  
  /**
   * Initialize WebGPU resources for all existing entities.
   */
  function initAllEntitiesWebGPU(): void {
    if (!isWebGPU.value) return;
    
    const gpuContext = viewport?.getWebGPUContext();
    if (!gpuContext) return;
    
    const world = viewport?.world;
    if (!world) return;
    
    for (const entity of world.getAllEntities()) {
      initEntityWebGPU(entity);
    }
  }
  
  return {
    // Signals
    objects,
    groups,
    selectedIds,
    expandedGroupIds,
    viewportInitialized,
    viewportState,
    gizmoMode,
    gizmoOrientation,
    objectWindSettings,
    isWebGPU,
    sceneBoundsVersion,
    transformVersion,
    
    // Computed
    selectedObjects,
    firstSelectedObject,
    selectionCount,
    
    // References (using getters to allow mutation)
    get viewport() { return viewport; },
    set viewport(v) { viewport = v; },
    get lightingManager() { return lightingManager; },
    set lightingManager(l) { lightingManager = l; },
    
    // ECS World — delegates to viewport (single source of truth)
    get world() { return viewport?.world ?? null; },
    
    // Actions
    syncFromWorld,
    select,
    selectAll,
    clearSelection,
    toggleGroup,
    setGizmoMode,
    setGizmoOrientation,
    setViewportInitialized,
    setViewportMode,
    setShowGrid,
    setShowAxes,
    setIsWebGPU,
    updateCameraFromSceneBounds,
    setupWorldCallbacks,
    initEntityWebGPU,
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