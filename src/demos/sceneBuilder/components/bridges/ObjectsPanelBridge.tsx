/**
 * ObjectsPanelBridge - Connects Preact ObjectsPanel to SceneBuilder's Scene model
 * Uses @preact/signals for reactive state management
 */

import { render } from 'preact';
import { signal, effect, Signal } from '@preact/signals';
import { ObjectsPanel } from '../panels';
import type { Scene } from '../../../../core/Scene';

// ==================== Types ====================

interface SceneObject {
  id: string;
  name: string;
  groupId?: string;
}

interface ObjectGroup {
  id: string;
  name: string;
  childIds: string[];
}

export interface ObjectsPanelBridgeOptions {
  container: HTMLElement;
  scene: Scene;
  onSelectionChanged?: () => void;
}

// ==================== Bridge Class ====================

export class ObjectsPanelBridge {
  private container: HTMLElement;
  private scene: Scene;
  private onSelectionChanged?: () => void;
  
  // Signals for reactive state
  private objects: Signal<SceneObject[]>;
  private groups: Signal<Map<string, ObjectGroup>>;
  private selectedIds: Signal<Set<string>>;
  private expandedGroupIds: Signal<Set<string>>;
  
  // Cleanup
  private disposeEffect: (() => void) | null = null;
  
  constructor(options: ObjectsPanelBridgeOptions) {
    this.container = options.container;
    this.scene = options.scene;
    this.onSelectionChanged = options.onSelectionChanged;
    
    // Initialize signals
    this.objects = signal<SceneObject[]>([]);
    this.groups = signal<Map<string, ObjectGroup>>(new Map());
    this.selectedIds = signal<Set<string>>(new Set());
    this.expandedGroupIds = signal<Set<string>>(new Set());
    
    // Initial sync
    this.syncFromScene();
  }
  
  /**
   * Mount the Preact component
   */
  mount(): void {
    // Create wrapper component that reads signals
    const App = () => {
      return (
        <ObjectsPanel
          scene={this.scene}
          objects={this.objects.value}
          groups={this.groups.value}
          selectedIds={this.selectedIds.value}
          expandedGroupIds={this.expandedGroupIds.value}
          onSelect={this.handleSelect}
          onSelectAll={this.handleSelectAll}
          onClearSelection={this.handleClearSelection}
          onToggleGroup={this.handleToggleGroup}
        />
      );
    };
    
    render(<App />, this.container);
  }
  
  /**
   * Sync state from Scene model to signals
   */
  syncFromScene(): void {
    // Get all objects
    const allObjects = this.scene.getAllObjects();
    const sceneObjects: SceneObject[] = allObjects.map((obj: any) => ({
      id: obj.id,
      name: obj.name,
      groupId: obj.groupId,
    }));
    this.objects.value = sceneObjects;
    
    // Get groups - getAllGroups returns Map entries as [id, GroupData]
    const sceneGroups = this.scene.getAllGroups();
    const groupsMap = new Map<string, ObjectGroup>();
    for (const [groupId, groupData] of sceneGroups) {
      groupsMap.set(groupId, {
        id: groupId,
        name: groupData.name,
        childIds: [...groupData.childIds],
      });
    }
    this.groups.value = groupsMap;
    
    // Get selected IDs
    const selectedIdsList = this.scene.getSelectedIds();
    this.selectedIds.value = new Set(selectedIdsList);
  }
  
  /**
   * Update the panel (call after Scene changes)
   */
  update(): void {
    this.syncFromScene();
  }
  
  /**
   * Destroy the bridge and unmount component
   */
  destroy(): void {
    if (this.disposeEffect) {
      this.disposeEffect();
      this.disposeEffect = null;
    }
    render(null, this.container);
  }
  
  // ==================== Callbacks ====================
  
  private handleSelect = (id: string, additive?: boolean, fromExpandedGroup?: boolean): void => {
    this.scene.select(id, { additive });
    this.syncFromScene();
    this.onSelectionChanged?.();
  };
  
  private handleSelectAll = (ids: string[]): void => {
    for (const id of ids) {
      this.scene.select(id, { additive: true });
    }
    this.syncFromScene();
    this.onSelectionChanged?.();
  };
  
  private handleClearSelection = (): void => {
    this.scene.clearSelection();
    this.syncFromScene();
    this.onSelectionChanged?.();
  };
  
  private handleToggleGroup = (groupId: string): void => {
    const current = new Set(this.expandedGroupIds.value);
    if (current.has(groupId)) {
      current.delete(groupId);
    } else {
      current.add(groupId);
    }
    this.expandedGroupIds.value = current;
  };
}

// ==================== Factory Function ====================

/**
 * Creates and mounts an ObjectsPanelBridge
 */
export function createObjectsPanelBridge(options: ObjectsPanelBridgeOptions): ObjectsPanelBridge {
  const bridge = new ObjectsPanelBridge(options);
  bridge.mount();
  return bridge;
}
