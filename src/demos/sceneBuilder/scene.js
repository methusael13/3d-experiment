import { mat4 } from 'gl-matrix';
import { loadGLB } from '../../loaders';
import { computeBoundsFromGLB } from '../../core/sceneGraph';
import { createObjectRenderer } from './objectRenderer';
import { createPrimitiveRenderer } from './primitiveRenderer';
import { computeBounds } from './primitiveGeometry';
import { getModelUrl } from './sceneSerializer';

/**
 * Scene Manager - handles objects, selection, and grouping
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {Object} sceneGraph - Scene graph for spatial queries
 */
export function createScene(gl, sceneGraph) {
  // Internal state
  const objects = []; // Array of scene objects
  const selectedIds = new Set();
  const groups = new Map(); // groupId -> { name, childIds: Set, collapsed: bool }
  
  let nextObjectId = 1;
  let nextGroupId = 1;
  let expandedGroupInList = null;
  
  // Event callbacks
  let onSelectionChanged = null;
  let onObjectAdded = null;
  let onObjectRemoved = null;
  let onGroupChanged = null;
  
  // ==================== Object Management ====================
  
  /**
   * Add a primitive shape to the scene
   * @param {string} primitiveType - 'cube' | 'plane' | 'sphere'
   * @param {string} name - Display name (optional)
   * @param {object} config - { size, subdivision }
   */
  function addPrimitive(primitiveType, name = null, config = {}) {
    const id = `object-${nextObjectId++}`;
    const typeNames = { cube: 'Cube', plane: 'Plane', sphere: 'UV Sphere' };
    const displayName = name || typeNames[primitiveType] || 'Primitive';
    
    const defaultConfig = {
      size: 1,
      subdivision: 16,
      ...config,
    };
    
    const renderer = createPrimitiveRenderer(gl, primitiveType, defaultConfig);
    const bounds = renderer.getBounds();
    
    const sceneObject = {
      id,
      name: displayName,
      type: 'primitive',
      primitiveType,
      primitiveConfig: { ...defaultConfig },
      model: null,
      modelPath: null,
      renderer,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      groupId: null,
    };
    
    objects.push(sceneObject);
    
    sceneGraph.addNode(id, {
      position: sceneObject.position,
      rotation: sceneObject.rotation,
      scale: sceneObject.scale,
      localBounds: bounds,
      userData: { name: displayName, primitiveType },
    });
    
    if (onObjectAdded) onObjectAdded(sceneObject);
    
    return sceneObject;
  }
  
  /**
   * Update primitive config (size, subdivision)
   */
  function updatePrimitiveConfig(id, newConfig) {
    const obj = getObject(id);
    if (!obj || obj.type !== 'primitive') return false;
    
    obj.primitiveConfig = { ...obj.primitiveConfig, ...newConfig };
    obj.renderer.updateGeometry(obj.primitiveConfig);
    
    // Update scene graph bounds
    const bounds = obj.renderer.getBounds();
    sceneGraph.updateNode(id, {
      position: obj.position,
      rotation: obj.rotation,
      scale: obj.scale,
      localBounds: bounds,
    });
    
    return true;
  }
  
  /**
   * Add an object to the scene
   */
  async function addObject(modelPath, name = null) {
    try {
      const url = getModelUrl(modelPath);
      const glbModel = await loadGLB(url);
      
      const id = `object-${nextObjectId++}`;
      const displayName = name || modelPath.split('/').pop().replace('.glb', '').replace('.gltf', '');
      
      const localBounds = computeBoundsFromGLB(glbModel);
      
      const sceneObject = {
        id,
        name: displayName,
        modelPath,
        model: glbModel,
        renderer: createObjectRenderer(gl, glbModel),
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        groupId: null,
      };
      
      objects.push(sceneObject);
      
      sceneGraph.addNode(id, {
        position: sceneObject.position,
        rotation: sceneObject.rotation,
        scale: sceneObject.scale,
        localBounds,
        userData: { name: displayName, modelPath },
      });
      
      if (onObjectAdded) onObjectAdded(sceneObject);
      
      return sceneObject;
    } catch (error) {
      console.error('Failed to load model:', error);
      return null;
    }
  }
  
  /**
   * Remove an object from the scene
   */
  function removeObject(id) {
    const index = objects.findIndex(o => o.id === id);
    if (index < 0) return false;
    
    // Remove from group first
    removeFromGroup(id);
    
    // Destroy renderer and remove
    objects[index].renderer?.destroy();
    objects.splice(index, 1);
    sceneGraph.removeNode(id);
    
    // Remove from selection
    selectedIds.delete(id);
    
    if (onObjectRemoved) onObjectRemoved(id);
    
    return true;
  }
  
  /**
   * Get an object by ID
   */
  function getObject(id) {
    return objects.find(o => o.id === id) || null;
  }
  
  /**
   * Get all objects
   */
  function getAllObjects() {
    return [...objects];
  }
  
  /**
   * Get count of objects
   */
  function getObjectCount() {
    return objects.length;
  }
  
  /**
   * Compute model matrix for an object
   */
  function getModelMatrix(obj) {
    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, obj.position);
    mat4.rotateX(modelMatrix, modelMatrix, obj.rotation[0] * Math.PI / 180);
    mat4.rotateY(modelMatrix, modelMatrix, obj.rotation[1] * Math.PI / 180);
    mat4.rotateZ(modelMatrix, modelMatrix, obj.rotation[2] * Math.PI / 180);
    mat4.scale(modelMatrix, modelMatrix, obj.scale);
    return modelMatrix;
  }
  
  /**
   * Duplicate an object
   */
  async function duplicateObject(id) {
    const obj = getObject(id);
    if (!obj) return null;
    
    const newObj = await addObject(obj.modelPath, `${obj.name} (copy)`);
    if (newObj) {
      newObj.position = [obj.position[0] + 0.5, obj.position[1], obj.position[2] + 0.5];
      newObj.rotation = [...obj.rotation];
      newObj.scale = [...obj.scale];
      
      sceneGraph.updateNode(newObj.id, {
        position: newObj.position,
        rotation: newObj.rotation,
        scale: newObj.scale,
      });
    }
    return newObj;
  }
  
  /**
   * Update object transform in scene graph
   */
  function updateObjectTransform(id) {
    const obj = getObject(id);
    if (obj) {
      sceneGraph.updateNode(id, {
        position: obj.position,
        rotation: obj.rotation,
        scale: obj.scale,
      });
    }
  }
  
  // ==================== Transform Operations ====================
  
  // Previous values for delta calculation (used by applyTransform)
  let previousPosition = null;
  let previousRotation = null;
  let previousScale = null;
  
  /**
   * Reset transform tracking state (call when selection changes)
   */
  function resetTransformTracking() {
    const selected = getSelectedObjects();
    if (selected.length === 1) {
      previousPosition = null;
      previousRotation = null;
      previousScale = null;
    } else if (selected.length > 1) {
      const centroid = getSelectionCentroid();
      previousPosition = [...centroid];
      previousRotation = [0, 0, 0];
      previousScale = [1, 1, 1];
    }
  }
  
  /**
   * Get current gizmo target values based on selection
   * Returns { position, rotation, scale, isMultiSelect }
   */
  function getGizmoTarget() {
    const selected = getSelectedObjects();
    if (selected.length === 0) {
      return { position: null, rotation: null, scale: null, isMultiSelect: false };
    }
    
    if (selected.length === 1) {
      const obj = selected[0];
      return {
        position: obj.position,
        rotation: obj.rotation,
        scale: obj.scale,
        isMultiSelect: false,
      };
    }
    
    const centroid = getSelectionCentroid();
    return {
      position: centroid,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      isMultiSelect: true,
    };
  }
  
  /**
   * Apply transform value from gizmo
   * Handles both single and multi-select with proper centroid transformations
   * @param {string} type - 'position' | 'rotation' | 'scale'
   * @param {number[]} value - The new value from the gizmo
   */
  function applyTransform(type, value) {
    const selected = getSelectedObjects();
    if (selected.length === 0) return;
    
    if (selected.length === 1) {
      // Single selection: apply value directly
      const obj = selected[0];
      if (type === 'position') obj.position = [...value];
      else if (type === 'rotation') obj.rotation = [...value];
      else if (type === 'scale') obj.scale = [...value];
      updateObjectTransform(obj.id);
    } else {
      // Multi-selection: apply delta-based transformations
      const centroid = getSelectionCentroid();
      
      if (type === 'position' && previousPosition) {
        const delta = [
          value[0] - previousPosition[0],
          value[1] - previousPosition[1],
          value[2] - previousPosition[2],
        ];
        for (const obj of selected) {
          obj.position[0] += delta[0];
          obj.position[1] += delta[1];
          obj.position[2] += delta[2];
          updateObjectTransform(obj.id);
        }
        previousPosition = [...value];
        
      } else if (type === 'rotation' && previousRotation) {
        // Calculate rotation deltas (in degrees)
        const deltaX = value[0] - previousRotation[0];
        const deltaY = value[1] - previousRotation[1];
        const deltaZ = value[2] - previousRotation[2];
        
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
          // Negate radY to match the gizmo direction
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
          
          updateObjectTransform(obj.id);
        }
        previousRotation = [...value];
      }
      // Scale for multi-select not yet implemented
    }
  }
  
  // ==================== Selection ====================
  
  /**
   * Get selected object IDs
   */
  function getSelectedIds() {
    return new Set(selectedIds);
  }
  
  /**
   * Get all selected objects
   */
  function getSelectedObjects() {
    return objects.filter(o => selectedIds.has(o.id));
  }
  
  /**
   * Get first selected object (for single-selection compatibility)
   */
  function getFirstSelected() {
    if (selectedIds.size === 0) return null;
    const firstId = selectedIds.values().next().value;
    return objects.find(o => o.id === firstId) || null;
  }
  
  /**
   * Check if an object is selected
   */
  function isSelected(id) {
    return selectedIds.has(id);
  }
  
  /**
   * Get selection count
   */
  function getSelectionCount() {
    return selectedIds.size;
  }
  
  /**
   * Calculate centroid of selected objects
   */
  function getSelectionCentroid() {
    const selected = getSelectedObjects();
    if (selected.length === 0) return [0, 0, 0];
    
    const sum = [0, 0, 0];
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
   * @param {string} id - Object ID
   * @param {Object} options - { additive, fromExpandedGroup }
   */
  function select(id, options = {}) {
    const { additive = false, fromExpandedGroup = false } = options;
    
    const obj = objects.find(o => o.id === id);
    if (!obj) {
      if (!additive) clearSelection();
      return;
    }
    
    // Determine what IDs to select
    let idsToSelect = [id];
    
    // If in a group and not from expanded list, select all group members
    if (obj.groupId && !fromExpandedGroup) {
      const group = groups.get(obj.groupId);
      if (group) {
        idsToSelect = [...group.childIds];
      }
    }
    
    if (additive) {
      // Toggle: if all are selected, deselect; else select
      const allSelected = idsToSelect.every(i => selectedIds.has(i));
      if (allSelected) {
        idsToSelect.forEach(i => selectedIds.delete(i));
      } else {
        idsToSelect.forEach(i => selectedIds.add(i));
      }
    } else {
      selectedIds.clear();
      idsToSelect.forEach(i => selectedIds.add(i));
    }
    
    if (onSelectionChanged) onSelectionChanged(selectedIds);
  }
  
  /**
   * Select multiple objects by IDs
   */
  function selectAll(ids) {
    selectedIds.clear();
    for (const id of ids) {
      if (objects.some(o => o.id === id)) {
        selectedIds.add(id);
      }
    }
    if (onSelectionChanged) onSelectionChanged(selectedIds);
  }

  /**
   * Select all objects in the scene
   */
  function selectAllObjects() {
    objects.forEach(o => {
      if (!selectedIds.has(o.id)) {
        selectedIds.add(o.id);
      }
    });

    if (onSelectionChanged) onSelectionChanged(selectedIds);
  }

  /**
   * Clear all selections
   */
  function clearSelection() {
    selectedIds.clear();

    if (onSelectionChanged) onSelectionChanged(selectedIds);
  }

  /**
   * Toggle selection of all scene objects
   */
  function toggleSelectAllObjects() {
    if (selectedIds.size === objects.length) {
      clearSelection();
    } else {
      selectAllObjects();
    }
  }
  
  // ==================== Groups ====================
  
  /**
   * Create a group from selected objects
   */
  function createGroupFromSelection() {
    if (selectedIds.size < 2) return null;
    
    const selected = getSelectedObjects();
    
    // Check if all selected are already in the same group
    const existingGroupId = selected[0].groupId;
    if (existingGroupId) {
      const group = groups.get(existingGroupId);
      if (group && group.childIds.size === selectedIds.size) {
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
        removeFromGroup(obj.id);
      }
    }
    
    // Create new group
    const groupId = `group-${nextGroupId++}`;
    const group = {
      name: `Group ${nextGroupId - 1}`,
      childIds: new Set(selectedIds),
      collapsed: true,
    };
    groups.set(groupId, group);
    
    // Assign group to objects
    for (const obj of selected) {
      obj.groupId = groupId;
    }
    
    if (onGroupChanged) onGroupChanged();
    
    return groupId;
  }
  
  /**
   * Dissolve a group (ungroup all members)
   */
  function dissolveGroup(groupId) {
    const group = groups.get(groupId);
    if (!group) return false;
    
    for (const childId of group.childIds) {
      const obj = objects.find(o => o.id === childId);
      if (obj) obj.groupId = null;
    }
    
    groups.delete(groupId);
    if (onGroupChanged) onGroupChanged();
    return true;
  }
  
  /**
   * Ungroup all groups that have members in the current selection
   */
  function ungroupSelection() {
    if (selectedIds.size === 0) return false;
    
    // Find all unique group IDs from selected objects
    const groupsToDissolve = new Set();
    for (const id of selectedIds) {
      const obj = objects.find(o => o.id === id);
      if (obj && obj.groupId) {
        groupsToDissolve.add(obj.groupId);
      }
    }
    
    if (groupsToDissolve.size === 0) return false;
    
    // Dissolve each group
    for (const groupId of groupsToDissolve) {
      const group = groups.get(groupId);
      if (group) {
        for (const childId of group.childIds) {
          const obj = objects.find(o => o.id === childId);
          if (obj) obj.groupId = null;
        }
        groups.delete(groupId);
      }
    }
    
    if (onGroupChanged) onGroupChanged();
    return true;
  }
  
  /**
   * Rename a group
   */
  function renameGroup(groupId, name) {
    const group = groups.get(groupId);
    if (group) {
      group.name = name;
      if (onGroupChanged) onGroupChanged();
      return true;
    }
    return false;
  }
  
  /**
   * Get a group by ID
   */
  function getGroup(groupId) {
    return groups.get(groupId) || null;
  }
  
  /**
   * Get all groups
   */
  function getAllGroups() {
    return new Map(groups);
  }
  
  /**
   * Remove an object from its group
   */
  function removeFromGroup(objectId) {
    const obj = objects.find(o => o.id === objectId);
    if (!obj || !obj.groupId) return;
    
    const group = groups.get(obj.groupId);
    if (group) {
      group.childIds.delete(objectId);
      
      // Dissolve if 0 or 1 members
      if (group.childIds.size <= 1) {
        for (const remainingId of group.childIds) {
          const remainingObj = objects.find(o => o.id === remainingId);
          if (remainingObj) remainingObj.groupId = null;
        }
        groups.delete(obj.groupId);
      }
    }
    
    obj.groupId = null;
    if (onGroupChanged) onGroupChanged();
  }
  
  /**
   * Toggle group expanded state (for UI)
   */
  function toggleGroupExpanded(groupId) {
    expandedGroupInList = expandedGroupInList === groupId ? null : groupId;
    return expandedGroupInList;
  }
  
  /**
   * Check if a group is expanded
   */
  function isGroupExpanded(groupId) {
    return expandedGroupInList === groupId;
  }
  
  /**
   * Get the currently expanded group ID
   */
  function getExpandedGroup() {
    return expandedGroupInList;
  }
  
  // ==================== Serialization ====================
  
  /**
   * Serialize scene data for saving
   */
  function serialize() {
    const serializedObjects = objects.map(obj => {
      const base = {
        name: obj.name,
        position: [...obj.position],
        rotation: [...obj.rotation],
        scale: [...obj.scale],
        groupId: obj.groupId || null,
      };
      
      if (obj.type === 'primitive') {
        // Get material from renderer
        const material = obj.renderer?.getMaterial?.() || { albedo: [0.75, 0.75, 0.75], metallic: 0, roughness: 0.5 };
        return {
          ...base,
          type: 'primitive',
          primitiveType: obj.primitiveType,
          primitiveConfig: { ...obj.primitiveConfig },
          material: {
            albedo: [...material.albedo],
            metallic: material.metallic,
            roughness: material.roughness,
          },
        };
      } else {
        return {
          ...base,
          modelPath: obj.modelPath,
        };
      }
    });
    
    const serializedGroups = [];
    for (const [groupId, group] of groups) {
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
  async function deserialize(data) {
    // Clear current state
    clear();
    
    if (!data) return;
    
    // Load objects
    for (const objData of data.objects) {
      let obj = null;
      
      if (objData.type === 'primitive') {
        // Create primitive shape
        obj = addPrimitive(objData.primitiveType, objData.name, objData.primitiveConfig || {});
        // Restore material if present
        if (obj && objData.material) {
          obj.renderer?.setMaterial?.(objData.material);
        }
      } else {
        // Load GLB model
        obj = await addObject(objData.modelPath, objData.name);
      }
      
      if (obj) {
        obj.position = [...objData.position];
        obj.rotation = [...objData.rotation];
        obj.scale = [...objData.scale];
        updateObjectTransform(obj.id);
      }
    }
    
    // Restore groups
    if (data.groups && data.groups.length > 0) {
      const groupIdMapping = new Map();
      
      for (const savedGroup of data.groups) {
        const groupId = `group-${nextGroupId++}`;
        const group = {
          name: savedGroup.name,
          childIds: new Set(),
          collapsed: savedGroup.collapsed ?? true,
        };
        groups.set(groupId, group);
        groupIdMapping.set(savedGroup.id, groupId);
      }
      
      // Assign objects to groups by matching names
      for (const objData of data.objects) {
        if (objData.groupId) {
          const newGroupId = groupIdMapping.get(objData.groupId);
          if (newGroupId) {
            const group = groups.get(newGroupId);
            const obj = objects.find(o => o.name === objData.name);
            if (obj && group) {
              obj.groupId = newGroupId;
              group.childIds.add(obj.id);
            }
          }
        }
      }
    }
    
    if (onGroupChanged) onGroupChanged();
  }
  
  /**
   * Clear all scene data
   */
  function clear() {
    objects.forEach(obj => obj.renderer?.destroy());
    objects.length = 0;
    selectedIds.clear();
    groups.clear();
    sceneGraph.clear();
    nextGroupId = 1;
    expandedGroupInList = null;
    
    if (onSelectionChanged) onSelectionChanged(selectedIds);
    if (onGroupChanged) onGroupChanged();
  }
  
  /**
   * Destroy and cleanup
   */
  function destroy() {
    clear();
    onSelectionChanged = null;
    onObjectAdded = null;
    onObjectRemoved = null;
    onGroupChanged = null;
  }
  
    // Return public interface
  return {
    // Object management
    addObject,
    addPrimitive,
    updatePrimitiveConfig,
    removeObject,
    getObject,
    getAllObjects,
    getObjectCount,
    getModelMatrix,
    duplicateObject,
    updateObjectTransform,
    
    // Transform operations
    applyTransform,
    resetTransformTracking,
    getGizmoTarget,
    
    // Selection
    getSelectedIds,
    getSelectedObjects,
    getFirstSelected,
    isSelected,
    getSelectionCount,
    getSelectionCentroid,
    select,
    selectAll,
    selectAllObjects,
    clearSelection,
    toggleSelectAllObjects,
    
    // Groups
    createGroupFromSelection,
    ungroupSelection,
    dissolveGroup,
    renameGroup,
    getGroup,
    getAllGroups,
    removeFromGroup,
    toggleGroupExpanded,
    isGroupExpanded,
    getExpandedGroup,
    
    // Serialization
    serialize,
    deserialize,
    clear,
    destroy,
    
    // Event callback setters
    set onSelectionChanged(fn) { onSelectionChanged = fn; },
    set onObjectAdded(fn) { onObjectAdded = fn; },
    set onObjectRemoved(fn) { onObjectRemoved = fn; },
    set onGroupChanged(fn) { onGroupChanged = fn; },
  };
}
