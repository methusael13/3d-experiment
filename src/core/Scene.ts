/**
 * Scene Manager - OOP implementation with TypeScript
 * Handles objects, selection, and grouping using the new class hierarchy
 */

import { mat4, vec3, quat } from 'gl-matrix';
import { SceneGraph, type SceneNodeOptions } from './sceneGraph';
import {
  type AnySceneObject,
  type AnyPrimitive,
  ModelObject,
  Cube,
  Plane,
  UVSphere,
  TerrainObject,
  createPrimitive,
  createPrimitiveFromSerialized,
  isPrimitiveObject,
  isModelObject,
  isTerrainObject,
  type PrimitiveType,
  type PrimitiveConfig,
  type PBRMaterial,
  type SerializedPrimitiveObject,
  type SerializedModelObject,
  type SerializedTerrainObject,
  type TerrainParams
} from './sceneObjects';
import { getModelUrl } from '../loaders';
import { PrimitiveObject } from './sceneObjects/primitives';

// ============================================================================
// Types
// ============================================================================

/**
 * Group data for organizing objects
 */
export interface GroupData {
  name: string;
  childIds: Set<string>;
  collapsed: boolean;
}

/**
 * Serialized group for save/load
 */
export interface SerializedGroup {
  id: string;
  name: string;
  childIds: string[];
  collapsed: boolean;
}

/**
 * Serialized scene data
 */
export interface SerializedScene {
  objects: Array<SerializedPrimitiveObject | SerializedModelObject | SerializedTerrainObject>;
  groups: SerializedGroup[];
}

/**
 * Gizmo target for transform operations
 */
export interface GizmoTarget {
  position: [number, number, number] | null;
  rotation: [number, number, number] | null;
  rotationQuat: quat | null;
  scale: [number, number, number] | null;
  isMultiSelect: boolean;
}

/**
 * Transform type for applyTransform
 */
export type TransformType = 'position' | 'rotation' | 'scale';

/**
 * Event callbacks for Scene
 */
export interface SceneCallbacks {
  onSelectionChanged?: (selectedIds: Set<string>) => void;
  onObjectAdded?: (obj: AnySceneObject) => void;
  onObjectRemoved?: (id: string) => void;
  onGroupChanged?: () => void;
}

// ============================================================================
// Scene Class
// ============================================================================

/**
 * Scene Manager - handles objects, selection, and grouping
 */
export class Scene {
  private gl: WebGL2RenderingContext;
  private sceneGraph: SceneGraph;
  
  /** Map of object ID -> SceneObject */
  private objects = new Map<string, AnySceneObject>();
  
  /** Set of selected object IDs */
  private selectedIds = new Set<string>();
  
  /** Map of group ID -> GroupData */
  private groups = new Map<string, GroupData>();
  
  private nextObjectId = 1;
  private nextGroupId = 1;
  private expandedGroupInList: string | null = null;
  
  // Previous values for delta calculation in multi-select transforms
  private previousPosition: [number, number, number] | null = null;
  private previousRotation: [number, number, number] | null = null;
  private previousScale: [number, number, number] | null = null;
  
  // Event callbacks
  private callbacks: SceneCallbacks = {};
  
  constructor(gl: WebGL2RenderingContext, sceneGraph?: SceneGraph) {
    this.gl = gl;
    this.sceneGraph = sceneGraph ?? new SceneGraph();
  }
  
  // ==========================================================================
  // Event Callbacks
  // ==========================================================================
  
  set onSelectionChanged(fn: SceneCallbacks['onSelectionChanged']) {
    this.callbacks.onSelectionChanged = fn;
  }
  
  set onObjectAdded(fn: SceneCallbacks['onObjectAdded']) {
    this.callbacks.onObjectAdded = fn;
  }
  
  set onObjectRemoved(fn: SceneCallbacks['onObjectRemoved']) {
    this.callbacks.onObjectRemoved = fn;
  }
  
  set onGroupChanged(fn: SceneCallbacks['onGroupChanged']) {
    this.callbacks.onGroupChanged = fn;
  }
  
  // ==========================================================================
  // Object Management
  // ==========================================================================
  
  /**
   * Add a primitive shape to the scene
   */
  addPrimitive(
    primitiveType: PrimitiveType | string,
    name?: string | null,
    config: PrimitiveConfig = {}
  ): AnyPrimitive {
    const id = `object-${this.nextObjectId++}`;
    const typeNames: Record<string, string> = { 
      cube: 'Cube', 
      plane: 'Plane', 
      sphere: 'UV Sphere' 
    };
    const displayName = name ?? typeNames[primitiveType] ?? 'Primitive';
    
    const defaultConfig: PrimitiveConfig = {
      size: 1,
      subdivision: 16,
      ...config,
    };
    
    // Create primitive using factory
    const primitive = createPrimitive(this.gl, primitiveType, displayName, defaultConfig);
    
    // Override the auto-generated ID with our sequential ID
    (primitive as any).id = id;
    
    // Add to internal map
    this.objects.set(id, primitive);
    
    // Add to scene graph for spatial queries
    const bounds = primitive.getBounds();
    this.sceneGraph.add(id, {
      position: [primitive.position[0], primitive.position[1], primitive.position[2]],
      rotation: [primitive.rotation[0], primitive.rotation[1], primitive.rotation[2]],
      scale: [primitive.scale[0], primitive.scale[1], primitive.scale[2]],
      localBounds: bounds ?? undefined,
      userData: { name: displayName, primitiveType },
    });
    
    this.callbacks.onObjectAdded?.(primitive);
    
    return primitive;
  }
  
  /**
   * Update primitive config (size, subdivision)
   */
  updatePrimitiveConfig(id: string, newConfig: Partial<PrimitiveConfig>): boolean {
    const obj = this.objects.get(id);
    if (!obj || !isPrimitiveObject(obj)) return false;
    
    // Update config and regenerate geometry - use renderer's updateGeometry method
    const primObj = obj as PrimitiveObject;
    const fullConfig = { ...primObj.primitiveConfig, ...newConfig };
    primObj.updateGeometry(fullConfig);
    
    // Update scene graph bounds
    const bounds = obj.getBounds();
    this.sceneGraph.update(id, {
      position: [obj.position[0], obj.position[1], obj.position[2]],
      rotation: [obj.rotation[0], obj.rotation[1], obj.rotation[2]],
      scale: [obj.scale[0], obj.scale[1], obj.scale[2]],
      localBounds: bounds ?? undefined,
    });
    
    return true;
  }
  
  /**
   * Add a model object to the scene (async)
   */
  async addObject(modelPath: string, name?: string | null): Promise<ModelObject | null> {
    try {
      const id = `object-${this.nextObjectId++}`;
      const displayName = name ?? modelPath
        .split('/')
        .pop()
        ?.replace('.glb', '')
        .replace('.gltf', '') ?? 'Model';
      
      // Create ModelObject using static factory
      const model = await ModelObject.create(
        this.gl,
        modelPath,
        displayName,
        getModelUrl
      );
      
      // Override the auto-generated ID
      (model as any).id = id;
      
      // Add to internal map
      this.objects.set(id, model);
      
      // Add to scene graph
      const bounds = model.getBounds();
      this.sceneGraph.add(id, {
        position: [model.position[0], model.position[1], model.position[2]],
        rotation: [model.rotation[0], model.rotation[1], model.rotation[2]],
        scale: [model.scale[0], model.scale[1], model.scale[2]],
        localBounds: bounds ?? undefined,
        userData: { name: displayName, modelPath },
      });
      
      this.callbacks.onObjectAdded?.(model);
      
      return model;
    } catch (error) {
      console.error('Failed to load model:', error);
      return null;
    }
  }
  
  /**
   * Add a terrain object to the scene (async - generates terrain)
   */
  async addTerrain(name?: string | null, params?: Partial<TerrainParams>): Promise<TerrainObject | null> {
    try {
      const id = `object-${this.nextObjectId++}`;
      const displayName = name ?? 'Terrain';
      
      // Create TerrainObject
      const terrain = new TerrainObject(displayName, params, this.gl);
      
      // Override the auto-generated ID
      (terrain as any).id = id;
      
      // Generate terrain with default params
      await terrain.regenerate((progress) => {
        console.log(`[Terrain] ${progress.message} (${Math.round(progress.progress * 100)}%)`);
      });
      
      // Add to internal map
      this.objects.set(id, terrain);
      
      // Add to scene graph
      const bounds = terrain.getBounds();
      this.sceneGraph.add(id, {
        position: [terrain.position[0], terrain.position[1], terrain.position[2]],
        rotation: [terrain.rotation[0], terrain.rotation[1], terrain.rotation[2]],
        scale: [terrain.scale[0], terrain.scale[1], terrain.scale[2]],
        localBounds: bounds ?? undefined,
        userData: { name: displayName, objectType: 'terrain' },
      });
      
      this.callbacks.onObjectAdded?.(terrain);
      
      return terrain;
    } catch (error) {
      console.error('Failed to create terrain:', error);
      return null;
    }
  }
  
  /**
   * Remove an object from the scene
   */
  removeObject(id: string): boolean {
    const obj = this.objects.get(id);
    if (!obj) return false;
    
    // Remove from group first
    this.removeFromGroup(id);
    
    // Destroy renderer and remove
    obj.destroy();
    this.objects.delete(id);
    this.sceneGraph.remove(id);
    
    // Remove from selection
    this.selectedIds.delete(id);
    
    this.callbacks.onObjectRemoved?.(id);
    
    return true;
  }
  
  /**
   * Get an object by ID
   */
  getObject(id: string): AnySceneObject | null {
    return this.objects.get(id) ?? null;
  }
  
  /**
   * Get all objects as array
   */
  getAllObjects(): AnySceneObject[] {
    return Array.from(this.objects.values());
  }
  
  /**
   * Get count of objects
   */
  getObjectCount(): number {
    return this.objects.size;
  }
  
  /**
   * Get model matrix for an object
   */
  getModelMatrix(obj: AnySceneObject): mat4 {
    return obj.getModelMatrix();
  }
  
  /**
   * Duplicate an object
   */
  async duplicateObject(id: string): Promise<AnySceneObject | null> {
    const obj = this.objects.get(id);
    if (!obj) return null;
    
    let newObj: AnySceneObject | null = null;
    
    if (isPrimitiveObject(obj)) {
      newObj = this.addPrimitive(
        obj.primitiveType,
        `${obj.name} (copy)`,
        obj.primitiveConfig
      );
      // Copy material
      const material = obj.getMaterial();
      if (newObj && isPrimitiveObject(newObj)) {
        newObj.setMaterial(material);
      }
    } else if (isModelObject(obj)) {
      newObj = await this.addObject(obj.modelPath, `${obj.name} (copy)`);
    }
    
    if (newObj) {
      // Copy transform with offset
      newObj.position[0] = obj.position[0] + 0.5;
      newObj.position[1] = obj.position[1];
      newObj.position[2] = obj.position[2] + 0.5;
      newObj.rotation = [obj.rotation[0], obj.rotation[1], obj.rotation[2]];
      newObj.scale = [obj.scale[0], obj.scale[1], obj.scale[2]];
      
      this.updateObjectTransform(newObj.id);
    }
    
    return newObj;
  }
  
  /**
   * Update object transform in scene graph
   */
  updateObjectTransform(id: string): void {
    const obj = this.objects.get(id);
    if (obj) {
      this.sceneGraph.update(id, {
        position: [obj.position[0], obj.position[1], obj.position[2]],
        rotation: [obj.rotation[0], obj.rotation[1], obj.rotation[2]],
        scale: [obj.scale[0], obj.scale[1], obj.scale[2]],
      });
    }
  }
  
  // ==========================================================================
  // Transform Operations
  // ==========================================================================
  
  /**
   * Reset transform tracking state (call when selection changes)
   */
  resetTransformTracking(): void {
    const selected = this.getSelectedObjects();
    if (selected.length === 1) {
      this.previousPosition = null;
      this.previousRotation = null;
      this.previousScale = null;
    } else if (selected.length > 1) {
      const centroid = this.getSelectionCentroid();
      this.previousPosition = [...centroid] as [number, number, number];
      this.previousRotation = [0, 0, 0];
      this.previousScale = [1, 1, 1];
    }
  }
  
  /**
   * Get current gizmo target values based on selection
   */
  getGizmoTarget(): GizmoTarget {
    const selected = this.getSelectedObjects();
    if (selected.length === 0) {
      return { position: null, rotation: null, rotationQuat: null, scale: null, isMultiSelect: false };
    }
    
    if (selected.length === 1) {
      const obj = selected[0];
      return {
        position: [obj.position[0], obj.position[1], obj.position[2]],
        rotation: [obj.rotation[0], obj.rotation[1], obj.rotation[2]],
        rotationQuat: quat.clone(obj.rotationQuat),
        scale: [obj.scale[0], obj.scale[1], obj.scale[2]],
        isMultiSelect: false,
      };
    }
    
    const centroid = this.getSelectionCentroid();
    return {
      position: centroid,
      rotation: [0, 0, 0],
      rotationQuat: quat.create(),
      scale: [1, 1, 1],
      isMultiSelect: true,
    };
  }
  
  /**
   * Apply transform value from gizmo.
   * For rotation, pass a quat instead of Euler values.
   */
  applyTransform(type: TransformType, value: [number, number, number] | quat): void {
    const selected = this.getSelectedObjects();
    if (selected.length === 0) return;
    
    if (selected.length === 1) {
      // Single selection: apply value directly
      const obj = selected[0];
      if (type === 'position') {
        const pos = value as [number, number, number];
        obj.position[0] = pos[0];
        obj.position[1] = pos[1];
        obj.position[2] = pos[2];
      } else if (type === 'rotation') {
        // Rotation is now passed as quaternion
        quat.copy(obj.rotationQuat, value as quat);
      } else if (type === 'scale') {
        const scl = value as [number, number, number];
        obj.scale[0] = scl[0];
        obj.scale[1] = scl[1];
        obj.scale[2] = scl[2];
      }
      this.updateObjectTransform(obj.id);
    } else {
      // Multi-selection: apply delta-based transformations
      const centroid = this.getSelectionCentroid();
      
      if (type === 'position' && this.previousPosition) {
        const delta: [number, number, number] = [
          value[0] - this.previousPosition[0],
          value[1] - this.previousPosition[1],
          value[2] - this.previousPosition[2],
        ];
        for (const obj of selected) {
          obj.position[0] += delta[0];
          obj.position[1] += delta[1];
          obj.position[2] += delta[2];
          this.updateObjectTransform(obj.id);
        }
        this.previousPosition = [...value] as [number, number, number];
      } else if (type === 'rotation' && this.previousRotation) {
        // Calculate rotation deltas (in degrees)
        const deltaX = value[0] - this.previousRotation[0];
        const deltaY = value[1] - this.previousRotation[1];
        const deltaZ = value[2] - this.previousRotation[2];
        
        // Convert to radians for position orbit calculation
        const radX = deltaX * Math.PI / 180;
        const radY = deltaY * Math.PI / 180;
        const radZ = deltaZ * Math.PI / 180;
        
        for (const obj of selected) {
          // Orbit position around centroid
          const offsetX = obj.position[0] - centroid[0];
          const offsetY = obj.position[1] - centroid[1];
          const offsetZ = obj.position[2] - centroid[2];
          
          // Apply Y rotation (most common - rotate around vertical axis)
          if (Math.abs(deltaY) > 0.001) {
            const cosY = Math.cos(-radY);
            const sinY = Math.sin(-radY);
            const newX = offsetX * cosY - offsetZ * sinY;
            const newZ = offsetX * sinY + offsetZ * cosY;
            obj.position[0] = centroid[0] + newX;
            obj.position[2] = centroid[2] + newZ;
          }
          
          // Apply X rotation (tilt forward/back)
          if (Math.abs(deltaX) > 0.001) {
            const cosX = Math.cos(radX);
            const sinX = Math.sin(radX);
            const currentOffsetY = obj.position[1] - centroid[1];
            const currentOffsetZ = obj.position[2] - centroid[2];
            const newY = currentOffsetY * cosX - currentOffsetZ * sinX;
            const newZ = currentOffsetY * sinX + currentOffsetZ * cosX;
            obj.position[1] = centroid[1] + newY;
            obj.position[2] = centroid[2] + newZ;
          }
          
          // Apply Z rotation (tilt left/right)
          if (Math.abs(deltaZ) > 0.001) {
            const cosZ = Math.cos(radZ);
            const sinZ = Math.sin(radZ);
            const currentOffsetX = obj.position[0] - centroid[0];
            const currentOffsetY = obj.position[1] - centroid[1];
            const newX = currentOffsetX * cosZ - currentOffsetY * sinZ;
            const newY = currentOffsetX * sinZ + currentOffsetY * cosZ;
            obj.position[0] = centroid[0] + newX;
            obj.position[1] = centroid[1] + newY;
          }
          
          // Add rotation delta to object's own rotation
          obj.rotation[0] += deltaX;
          obj.rotation[1] += deltaY;
          obj.rotation[2] += deltaZ;
          
          this.updateObjectTransform(obj.id);
        }
        this.previousRotation = [...value] as [number, number, number];
      }
      // Scale for multi-select not yet implemented
    }
  }
  
  // ==========================================================================
  // Selection
  // ==========================================================================
  
  /**
   * Get selected object IDs
   */
  getSelectedIds(): Set<string> {
    return new Set(this.selectedIds);
  }
  
  /**
   * Get all selected objects
   */
  getSelectedObjects(): AnySceneObject[] {
    return Array.from(this.selectedIds)
      .map(id => this.objects.get(id))
      .filter((obj): obj is AnySceneObject => obj !== undefined);
  }
  
  /**
   * Get first selected object
   */
  getFirstSelected(): AnySceneObject | null {
    if (this.selectedIds.size === 0) return null;
    const firstId = this.selectedIds.values().next().value;
    if (!firstId) return null;
    return this.objects.get(firstId) ?? null;
  }
  
  /**
   * Check if an object is selected
   */
  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }
  
  /**
   * Get selection count
   */
  getSelectionCount(): number {
    return this.selectedIds.size;
  }
  
  /**
   * Calculate centroid of selected objects
   */
  getSelectionCentroid(): [number, number, number] {
    const selected = this.getSelectedObjects();
    if (selected.length === 0) return [0, 0, 0];
    
    const sum: [number, number, number] = [0, 0, 0];
    for (const obj of selected) {
      sum[0] += obj.position[0];
      sum[1] += obj.position[1];
      sum[2] += obj.position[2];
    }
    return [
      sum[0] / selected.length,
      sum[1] / selected.length,
      sum[2] / selected.length,
    ];
  }
  
  /**
   * Select an object (or its group members)
   */
  select(id: string, options: { additive?: boolean; fromExpandedGroup?: boolean } = {}): void {
    const { additive = false, fromExpandedGroup = false } = options;
    
    const obj = this.objects.get(id);
    if (!obj) {
      if (!additive) this.clearSelection();
      return;
    }
    
    // Determine what IDs to select
    let idsToSelect = [id];
    
    // If in a group and not from expanded list, select all group members
    if (obj.groupId && !fromExpandedGroup) {
      const group = this.groups.get(obj.groupId);
      if (group) {
        idsToSelect = [...group.childIds];
      }
    }
    
    if (additive) {
      // Toggle: if all are selected, deselect; else select
      const allSelected = idsToSelect.every(i => this.selectedIds.has(i));
      if (allSelected) {
        idsToSelect.forEach(i => this.selectedIds.delete(i));
      } else {
        idsToSelect.forEach(i => this.selectedIds.add(i));
      }
    } else {
      this.selectedIds.clear();
      idsToSelect.forEach(i => this.selectedIds.add(i));
    }
    
    this.callbacks.onSelectionChanged?.(this.selectedIds);
  }
  
  /**
   * Select multiple objects by IDs
   */
  selectAll(ids: string[]): void {
    this.selectedIds.clear();
    for (const id of ids) {
      if (this.objects.has(id)) {
        this.selectedIds.add(id);
      }
    }
    this.callbacks.onSelectionChanged?.(this.selectedIds);
  }
  
  /**
   * Select all objects in the scene
   */
  selectAllObjects(): void {
    for (const id of this.objects.keys()) {
      this.selectedIds.add(id);
    }
    this.callbacks.onSelectionChanged?.(this.selectedIds);
  }
  
  /**
   * Clear all selections
   */
  clearSelection(): void {
    this.selectedIds.clear();
    this.callbacks.onSelectionChanged?.(this.selectedIds);
  }
  
  /**
   * Toggle selection of all scene objects
   */
  toggleSelectAllObjects(): void {
    if (this.selectedIds.size === this.objects.size) {
      this.clearSelection();
    } else {
      this.selectAllObjects();
    }
  }
  
  // ==========================================================================
  // Groups
  // ==========================================================================
  
  /**
   * Create a group from selected objects
   */
  createGroupFromSelection(): string | null {
    if (this.selectedIds.size < 2) return null;
    
    const selected = this.getSelectedObjects();
    
    // Check if all selected are already in the same group
    const existingGroupId = selected[0].groupId;
    if (existingGroupId) {
      const group = this.groups.get(existingGroupId);
      if (group && group.childIds.size === this.selectedIds.size) {
        const allSameGroup = selected.every(o => o.groupId === existingGroupId);
        if (allSameGroup) {
          console.log('All selected objects are already in the same group');
          return null;
        }
      }
    }
    
    // Remove from existing groups
    for (const obj of selected) {
      if (obj.groupId) {
        this.removeFromGroup(obj.id);
      }
    }
    
    // Create new group
    const groupId = `group-${this.nextGroupId++}`;
    const group: GroupData = {
      name: `Group ${this.nextGroupId - 1}`,
      childIds: new Set(this.selectedIds),
      collapsed: true,
    };
    this.groups.set(groupId, group);
    
    // Assign group to objects
    for (const obj of selected) {
      obj.groupId = groupId;
    }
    
    this.callbacks.onGroupChanged?.();
    
    return groupId;
  }
  
  /**
   * Dissolve a group (ungroup all members)
   */
  dissolveGroup(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    
    for (const childId of group.childIds) {
      const obj = this.objects.get(childId);
      if (obj) obj.groupId = null;
    }
    
    this.groups.delete(groupId);
    this.callbacks.onGroupChanged?.();
    return true;
  }
  
  /**
   * Ungroup all groups that have members in the current selection
   */
  ungroupSelection(): boolean {
    if (this.selectedIds.size === 0) return false;
    
    // Find all unique group IDs from selected objects
    const groupsToDissolve = new Set<string>();
    for (const id of this.selectedIds) {
      const obj = this.objects.get(id);
      if (obj?.groupId) {
        groupsToDissolve.add(obj.groupId);
      }
    }
    
    if (groupsToDissolve.size === 0) return false;
    
    // Dissolve each group
    for (const groupId of groupsToDissolve) {
      const group = this.groups.get(groupId);
      if (group) {
        for (const childId of group.childIds) {
          const obj = this.objects.get(childId);
          if (obj) obj.groupId = null;
        }
        this.groups.delete(groupId);
      }
    }
    
    this.callbacks.onGroupChanged?.();
    return true;
  }
  
  /**
   * Rename a group
   */
  renameGroup(groupId: string, name: string): boolean {
    const group = this.groups.get(groupId);
    if (group) {
      group.name = name;
      this.callbacks.onGroupChanged?.();
      return true;
    }
    return false;
  }
  
  /**
   * Get a group by ID
   */
  getGroup(groupId: string): GroupData | null {
    return this.groups.get(groupId) ?? null;
  }
  
  /**
   * Get all groups
   */
  getAllGroups(): Map<string, GroupData> {
    return new Map(this.groups);
  }
  
  /**
   * Remove an object from its group
   */
  removeFromGroup(objectId: string): void {
    const obj = this.objects.get(objectId);
    if (!obj?.groupId) return;
    
    const group = this.groups.get(obj.groupId);
    if (group) {
      group.childIds.delete(objectId);
      
      // Dissolve if 0 or 1 members
      if (group.childIds.size <= 1) {
        for (const remainingId of group.childIds) {
          const remainingObj = this.objects.get(remainingId);
          if (remainingObj) remainingObj.groupId = null;
        }
        this.groups.delete(obj.groupId);
      }
    }
    
    obj.groupId = null;
    this.callbacks.onGroupChanged?.();
  }
  
  /**
   * Toggle group expanded state (for UI)
   */
  toggleGroupExpanded(groupId: string): string | null {
    this.expandedGroupInList = this.expandedGroupInList === groupId ? null : groupId;
    return this.expandedGroupInList;
  }
  
  /**
   * Check if a group is expanded
   */
  isGroupExpanded(groupId: string): boolean {
    return this.expandedGroupInList === groupId;
  }
  
  /**
   * Get the currently expanded group ID
   */
  getExpandedGroup(): string | null {
    return this.expandedGroupInList;
  }
  
  // ==========================================================================
  // Serialization
  // ==========================================================================
  
  /**
   * Serialize scene data for saving
   */
  serialize(): SerializedScene {
    const serializedObjects: Array<SerializedPrimitiveObject | SerializedModelObject | SerializedTerrainObject> = [];
    
    for (const obj of this.objects.values()) {
      const base = {
        name: obj.name,
        position: [obj.position[0], obj.position[1], obj.position[2]] as [number, number, number],
        rotation: [obj.rotation[0], obj.rotation[1], obj.rotation[2]] as [number, number, number],
        scale: [obj.scale[0], obj.scale[1], obj.scale[2]] as [number, number, number],
        groupId: obj.groupId ?? null,
      };
      
      if (isPrimitiveObject(obj)) {
        const material = obj.getMaterial();
        serializedObjects.push({
          ...base,
          type: 'primitive',
          primitiveType: obj.primitiveType as PrimitiveType,
          primitiveConfig: { ...obj.primitiveConfig },
          material: {
            albedo: [material.albedo[0], material.albedo[1], material.albedo[2]] as [number, number, number],
            metallic: material.metallic,
            roughness: material.roughness,
          },
        });
      } else if (isTerrainObject(obj)) {
        // Use terrain's built-in serialize method
        const terrainData = obj.serialize();
        serializedObjects.push({
          ...base,
          ...terrainData,
        });
      } else if (isModelObject(obj)) {
        serializedObjects.push({
          ...base,
          type: 'model',
          modelPath: obj.modelPath,
        });
      }
    }
    
    const serializedGroups: SerializedGroup[] = [];
    for (const [groupId, group] of this.groups) {
      serializedGroups.push({
        id: groupId,
        name: group.name,
        childIds: [...group.childIds],
        collapsed: group.collapsed,
      });
    }
    
    return {
      objects: serializedObjects,
      groups: serializedGroups,
    };
  }
  
  /**
   * Deserialize and restore scene state
   */
  async deserialize(data: SerializedScene | null): Promise<void> {
    // Clear current state
    this.clear();
    
    if (!data) return;
    
    // Load objects
    for (const objData of data.objects) {
      let obj: AnySceneObject | null = null;
      
      if (objData.type === 'primitive') {
        const primData = objData as SerializedPrimitiveObject;
        obj = this.addPrimitive(
          primData.primitiveType,
          primData.name,
          primData.primitiveConfig ?? {}
        );
        // Restore material if present
        if (obj && isPrimitiveObject(obj) && primData.material) {
          obj.setMaterial(primData.material);
        }
      } else if (objData.type === 'terrain') {
        // Load terrain object
        const terrainData = objData as SerializedTerrainObject;
        obj = await this.addTerrain(terrainData.name, terrainData.terrainParams);
      } else {
        const modelData = objData as SerializedModelObject;
        obj = await this.addObject(modelData.modelPath, modelData.name);
      }
      
      if (obj) {
        obj.position[0] = objData.position[0];
        obj.position[1] = objData.position[1];
        obj.position[2] = objData.position[2];
        obj.rotation = [objData.rotation[0], objData.rotation[1], objData.rotation[2]];
        obj.scale = [objData.scale[0], objData.scale[1], objData.scale[2]];
        this.updateObjectTransform(obj.id);
      }
    }
    
    // Restore groups
    if (data.groups && data.groups.length > 0) {
      const groupIdMapping = new Map<string, string>();
      
      for (const savedGroup of data.groups) {
        const groupId = `group-${this.nextGroupId++}`;
        const group: GroupData = {
          name: savedGroup.name,
          childIds: new Set(),
          collapsed: savedGroup.collapsed ?? true,
        };
        this.groups.set(groupId, group);
        groupIdMapping.set(savedGroup.id, groupId);
      }
      
      // Assign objects to groups by matching names
      for (const objData of data.objects) {
        if (objData.groupId) {
          const newGroupId = groupIdMapping.get(objData.groupId);
          if (newGroupId) {
            const group = this.groups.get(newGroupId);
            // Find object by name since IDs are regenerated
            for (const [objId, obj] of this.objects) {
              if (obj.name === objData.name) {
                obj.groupId = newGroupId;
                group?.childIds.add(objId);
                break;
              }
            }
          }
        }
      }
    }
    
    this.callbacks.onGroupChanged?.();
  }
  
  /**
   * Clear all scene data
   */
  clear(): void {
    // Destroy all objects
    for (const obj of this.objects.values()) {
      obj.destroy();
    }
    this.objects.clear();
    this.selectedIds.clear();
    this.groups.clear();
    this.sceneGraph.clear();
    this.nextGroupId = 1;
    this.expandedGroupInList = null;
    
    this.callbacks.onSelectionChanged?.(this.selectedIds);
    this.callbacks.onGroupChanged?.();
  }
  
  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this.clear();
    this.callbacks = {};
  }
}

// ============================================================================
// Factory function for backward compatibility
// ============================================================================

/**
 * Create a Scene instance (backward-compatible factory)
 * @deprecated Use `new Scene(gl, sceneGraph)` instead
 */
export function createScene(gl: WebGL2RenderingContext, sceneGraph?: SceneGraph): Scene {
  return new Scene(gl, sceneGraph);
}
