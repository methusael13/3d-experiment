import { mat4 } from 'gl-matrix';
import { loadGLB } from '../../loaders';
import { createAnimationLoop } from '../../core/animationLoop';
import { createCamera } from '../../core/camera';
import { createSceneGraph, computeBoundsFromGLB } from '../../core/sceneGraph';
import { createGridRenderer } from './gridRenderer';
import { createObjectRenderer } from './objectRenderer';
import { createTransformGizmo } from './transformGizmo';
import { createOriginMarkerRenderer } from './originMarkerRenderer';
import { sceneBuilderStyles, sceneBuilderTemplate } from './styles';
import { screenToRay, projectToScreen, raycastToGround } from './raycastUtils';
import { 
  importModelFile, getModelUrl, saveScene, parseCameraState, parseLightingState, clearImportedModels 
} from './sceneSerializer';
import { createSkyRenderer } from './skyRenderer';
import { loadHDR, createHDRTexture, parseHDR } from './hdrLoader';
import { createShadowRenderer } from './shadowRenderer';
import { createShaderDebugPanel } from './shaderDebugPanel';
import { createLightingManager } from './lights';

/**
 * Scene Builder Demo
 * Import and position 3D models to create composite scenes
 */
export function createSceneBuilderDemo(container, options = {}) {
  const { width: CANVAS_WIDTH = 800, height: CANVAS_HEIGHT = 600, onFps = () => {} } = options;
  
  // Create DOM structure
  container.innerHTML = sceneBuilderTemplate;
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = sceneBuilderStyles;
  container.appendChild(style);
  
  // Canvas setup
  const canvas = container.querySelector('#canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  
  // Overlay canvas for 2D drawing
  const viewport = container.querySelector('.scene-builder-viewport');
  viewport.style.position = 'relative';
  let overlayCanvas = document.createElement('canvas');
  overlayCanvas.width = CANVAS_WIDTH;
  overlayCanvas.height = CANVAS_HEIGHT;
  overlayCanvas.style.cssText = 'position: absolute; pointer-events: none; top: 0; left: 0; background: transparent;';
  let overlayCtx = overlayCanvas.getContext('2d');
  
  // Scene state
  const sceneObjects = []; // For rendering data (model, renderer)
  const sceneGraph = createSceneGraph(); // For spatial queries
  let nextObjectId = 1;
  
  // Multi-select and grouping
  const selectedObjectIds = new Set(); // Multiple selection support
  const groups = new Map(); // groupId -> { name, childIds: Set, collapsed: bool }
  let nextGroupId = 1;
  let expandedGroupInList = null; // Track which group is expanded in object list for child-level selection
  
  // Camera state
  let cameraAngleX = 0.5;
  let cameraAngleY = 0.3;
  let cameraDistance = 5;
  let cameraOffsetX = 0;
  let cameraOffsetY = 0;
  let cameraOffsetZ = 0;
  let originMarkerPos = [0, 0, 0];
  const GRID_BOUNDS = 10;
  
  // Active components
  let animationLoop = null;
  let camera = null;
  let gl = null;
  let gridRenderer = null;
  let transformGizmo = null;
  let originMarkerRenderer = null;
  let gizmoMode = 'translate';
  let viewportMode = 'solid'; // 'solid' or 'wireframe'
  
  // Lighting (OOP-based)
  const lightingManager = createLightingManager();
  let skyRenderer = null;
  let shadowRenderer = null;
  let showShadowThumbnail = false;
  let shaderDebugPanel = null;
  
  // Camera view shortcuts state
  let savedHomeState = null; // Last free camera state
  let currentViewMode = 'free'; // 'free' | 'front' | 'side' | 'top'
  
  // Uniform scale mode state
  let uniformScaleActive = false;
  let uniformScaleStartScale = [1, 1, 1];
  let uniformScaleStartDistance = 0;
  let uniformScaleMousePos = [0, 0];
  let uniformScaleObjectScreenPos = [0, 0];
  let uniformScaleStartMousePos = [0, 0];
  let lastKnownMousePos = [0, 0];
  
  // Scene file tracking
  let currentSceneFilename = null; // Track loaded/saved scene filename
  
  // ==================== GL Initialization ====================
  
  function initGL() {
    gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('WebGL 2 not supported');
      return false;
    }
    
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.15, 0.17, 0.22, 1.0);
    
    gridRenderer = createGridRenderer(gl);
    originMarkerRenderer = createOriginMarkerRenderer(gl);
    skyRenderer = createSkyRenderer(gl);
    shadowRenderer = createShadowRenderer(gl, lightingManager.sunLight.shadowResolution);
    
    return true;
  }
  
  // ==================== Gizmo ====================
  
  function initGizmo() {
    transformGizmo = createTransformGizmo(gl, camera);
    transformGizmo.setOnChange((type, value) => {
      // For multi-select, apply delta transforms to all selected objects
      const selected = getSelectedObjects();
      if (selected.length === 0) return;
      
      if (selected.length === 1) {
        // Single selection: apply value directly
        const obj = selected[0];
        if (type === 'position') {
          obj.position = value;
          sceneGraph.updateNode(obj.id, { position: value });
        } else if (type === 'rotation') {
          obj.rotation = value;
          sceneGraph.updateNode(obj.id, { rotation: value });
        } else if (type === 'scale') {
          obj.scale = value;
          sceneGraph.updateNode(obj.id, { scale: value });
        }
      } else {
        // Multi-selection: value is delta, apply to all
        // For now, just apply to first object (TODO: proper multi-transform)
        const obj = selected[0];
        if (type === 'position') {
          obj.position = value;
          sceneGraph.updateNode(obj.id, { position: value });
        } else if (type === 'rotation') {
          obj.rotation = value;
          sceneGraph.updateNode(obj.id, { rotation: value });
        } else if (type === 'scale') {
          obj.scale = value;
          sceneGraph.updateNode(obj.id, { scale: value });
        }
      }
      
      updateTransformPanel();
    });
  }
  
  function updateGizmoTarget() {
    const selected = getSelectedObjects();
    if (selected.length === 0) {
      transformGizmo.setEnabled(false);
      return;
    }
    
    if (selected.length === 1) {
      // Single selection: target that object
      const obj = selected[0];
      transformGizmo.setEnabled(true);
      transformGizmo.setTarget(obj.position, obj.rotation, obj.scale);
    } else {
      // Multi-selection: target centroid with neutral rotation/scale
      const centroid = getSelectionCentroid();
      transformGizmo.setEnabled(true);
      transformGizmo.setTarget(centroid, [0, 0, 0], [1, 1, 1]);
    }
  }
  
  function setGizmoMode(mode) {
    gizmoMode = mode;
    transformGizmo.setMode(mode);
    container.querySelectorAll('.gizmo-btn').forEach(btn => btn.classList.remove('active'));
    container.querySelector(`#gizmo-${mode}`).classList.add('active');
  }
  
  // ==================== Camera ====================
  
  function initCamera() {
    camera = createCamera({
      aspectRatio: CANVAS_WIDTH / CANVAS_HEIGHT,
      fov: 45,
      near: 0.1,
      far: 100,
    });
    updateCameraPosition();
  }
  
  function updateCameraPosition() {
    const targetX = originMarkerPos[0] + cameraOffsetX;
    const targetY = originMarkerPos[1] + cameraOffsetY;
    const targetZ = originMarkerPos[2] + cameraOffsetZ;
    
    const x = Math.sin(cameraAngleX) * Math.cos(cameraAngleY) * cameraDistance;
    const y = Math.sin(cameraAngleY) * cameraDistance;
    const z = Math.cos(cameraAngleX) * Math.cos(cameraAngleY) * cameraDistance;
    
    camera.setPosition(x + targetX, y + targetY, z + targetZ);
    camera.setTarget(targetX, targetY, targetZ);
  }
  
  function panCamera(dx, dy) {
    const rightX = Math.cos(cameraAngleX);
    const rightZ = -Math.sin(cameraAngleX);
    const upX = -Math.sin(cameraAngleX) * Math.sin(cameraAngleY);
    const upY = Math.cos(cameraAngleY);
    const upZ = -Math.cos(cameraAngleX) * Math.sin(cameraAngleY);
    
    const panSpeed = 0.01 * cameraDistance * 0.5;
    cameraOffsetX -= (dx * rightX - dy * upX) * panSpeed;
    cameraOffsetY += dy * upY * panSpeed;
    cameraOffsetZ -= (dx * rightZ - dy * upZ) * panSpeed;
    
    updateCameraPosition();
  }
  
  function setOriginFromScreenPos(screenX, screenY) {
    const hit = raycastToGround(screenX, screenY, camera, CANVAS_WIDTH, CANVAS_HEIGHT, GRID_BOUNDS);
    if (hit) {
      // Get current camera position (stays fixed)
      const camPos = camera.getPosition();
      
      // Set new origin (this is where camera will orbit around)
      const newOrigin = [hit[0], 0, hit[1]];
      
      // Calculate vector from new origin to camera
      const dx = camPos[0] - newOrigin[0];
      const dy = camPos[1] - newOrigin[1];
      const dz = camPos[2] - newOrigin[2];
      
      // Calculate new distance from camera to new origin
      const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      // Calculate new angles from spherical coordinates
      // Camera rotates to look at new origin
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const newAngleY = Math.atan2(dy, horizontalDist);
      const newAngleX = Math.atan2(dx, dz);
      
      // Update state - camera pivots around new origin with no offset
      originMarkerPos = newOrigin;
      cameraAngleX = newAngleX;
      cameraAngleY = newAngleY;
      cameraDistance = newDistance;
      cameraOffsetX = 0;
      cameraOffsetY = 0;
      cameraOffsetZ = 0;
      
      updateCameraPosition();
    }
  }
  
  function getCameraState() {
    return {
      angleX: cameraAngleX,
      angleY: cameraAngleY,
      distance: cameraDistance,
      originX: originMarkerPos[0],
      originY: originMarkerPos[1],
      originZ: originMarkerPos[2],
      offsetX: cameraOffsetX,
      offsetY: cameraOffsetY,
      offsetZ: cameraOffsetZ,
    };
  }
  
  function getLightingState() {
    // Serialize using lightingManager
    const state = lightingManager.serialize();
    // Add HDR filename from UI (texture cannot be serialized)
    state.hdr.filename = container.querySelector('#hdr-filename')?.textContent || null;
    return state;
  }
  
  function setLightingState(state) {
    if (!state) return;
    
    // Deserialize using lightingManager
    lightingManager.deserialize(state);
    
    // Update UI mode
    setLightMode(lightingManager.activeMode);
    
    // Update sun sliders
    const azimuthSlider = container.querySelector('#sun-azimuth');
    const azimuthValue = container.querySelector('#sun-azimuth-value');
    if (azimuthSlider) {
      azimuthSlider.value = lightingManager.sunLight.azimuth;
      azimuthValue.textContent = `${lightingManager.sunLight.azimuth}°`;
    }
    
    const elevationSlider = container.querySelector('#sun-elevation');
    const elevationValue = container.querySelector('#sun-elevation-value');
    if (elevationSlider) {
      elevationSlider.value = lightingManager.sunLight.elevation;
      elevationValue.textContent = `${lightingManager.sunLight.elevation}°`;
    }
    
    // Update shadow controls
    const shadowCheckbox = container.querySelector('#shadow-enabled');
    if (shadowCheckbox) shadowCheckbox.checked = lightingManager.shadowEnabled;
    
    shadowRenderer?.setResolution(lightingManager.sunLight.shadowResolution);
    container.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
    const activeQualityBtn = container.querySelector(`#shadow-${lightingManager.sunLight.shadowResolution}`);
    if (activeQualityBtn) activeQualityBtn.classList.add('active');
    
    // Update HDR exposure slider
    const exposureSlider = container.querySelector('#hdr-exposure');
    const exposureValue = container.querySelector('#hdr-exposure-value');
    if (exposureSlider) {
      exposureSlider.value = lightingManager.hdrLight.exposure;
      exposureValue.textContent = lightingManager.hdrLight.exposure.toFixed(1);
    }
    
    // Note: HDR texture filename is stored but the texture itself cannot be restored
    if (lightingManager.hdrLight.filename && lightingManager.hdrLight.filename !== 'No HDR loaded') {
      container.querySelector('#hdr-filename').textContent = `${lightingManager.hdrLight.filename} (reload required)`;
    }
  }
  
  function setCameraState(state) {
    cameraAngleX = state.angleX;
    cameraAngleY = state.angleY;
    cameraDistance = state.distance;
    originMarkerPos = [state.originX, state.originY, state.originZ];
    cameraOffsetX = state.offsetX;
    cameraOffsetY = state.offsetY;
    cameraOffsetZ = state.offsetZ;
    updateCameraPosition();
  }
  
  // ==================== Input Handling ====================
  
  function setupCameraControls() {
    let isDragging = false;
    let isPanning = false;
    let lastX = 0;
    let lastY = 0;
    let mouseDownX = 0;
    let mouseDownY = 0;
    let hasMoved = false;
    
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (uniformScaleActive && e.button === 0) {
        commitUniformScale();
        return;
      }
      
      if (e.button === 0 && transformGizmo.handleMouseDown(x, y, CANVAS_WIDTH, CANVAS_HEIGHT)) {
        return;
      }
      
      if (e.button === 0) isDragging = true;
      else if (e.button === 2) isPanning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
      hasMoved = false;
    });
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      lastKnownMousePos = [x, y];
      
      if (uniformScaleActive) {
        uniformScaleMousePos = [x, y];
        updateUniformScale(x, y);
        return;
      }
      
      if (transformGizmo.isDragging) {
        transformGizmo.handleMouseMove(x, y);
        return;
      }
      
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      
      if (Math.abs(e.clientX - mouseDownX) > 3 || Math.abs(e.clientY - mouseDownY) > 3) {
        hasMoved = true;
      }
      
      if (isDragging && hasMoved) {
        // Exit orthogonal view on orbit
        if (currentViewMode !== 'free') {
          saveHomeState();
          currentViewMode = 'free';
        }
        cameraAngleX -= dx * 0.01;
        cameraAngleY += dy * 0.01;
        cameraAngleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, cameraAngleY));
        updateCameraPosition();
        // Update home state while in free mode
        saveHomeState();
      } else if (isPanning) {
        // Exit orthogonal view on pan
        if (currentViewMode !== 'free') {
          saveHomeState();
          currentViewMode = 'free';
        }
        panCamera(dx, dy);
        // Update home state while in free mode
        saveHomeState();
      }
    });
    
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      setOriginFromScreenPos(e.clientX - rect.left, e.clientY - rect.top);
    });
    
    canvas.addEventListener('mouseup', (e) => {
      if (transformGizmo.isDragging) {
        transformGizmo.handleMouseUp();
        return;
      }
      
      if (e.button === 0 && !hasMoved) {
        const rect = canvas.getBoundingClientRect();
        handleCanvasClick(e.clientX - rect.left, e.clientY - rect.top);
      }
      isDragging = false;
      isPanning = false;
    });
    
    canvas.addEventListener('mouseleave', () => { isDragging = false; isPanning = false; });
    
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // Exit orthogonal view on zoom
      if (currentViewMode !== 'free') {
        saveHomeState();
        currentViewMode = 'free';
      }
      cameraDistance += e.deltaY * 0.01;
      cameraDistance = Math.max(1, Math.min(20, cameraDistance));
      updateCameraPosition();
      saveHomeState();
    });
    
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  
  function handleCanvasClick(screenX, screenY) {
    if (sceneGraph.size() === 0) return;
    
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Use scene graph BVH for efficient ray casting
    const hit = sceneGraph.castRay(rayOrigin, rayDir);
    
    if (hit) {
      selectObject(hit.node.id);
    } else {
      selectedObjectId = null;
      updateObjectList();
      updateGizmoTarget();
      container.querySelector('#transform-panel').style.display = 'none';
    }
  }
  
  // ==================== Scene Objects ====================
  
  async function addObject(modelPath, name = null) {
    try {
      const url = getModelUrl(modelPath);
      const glbModel = await loadGLB(url);
      
      const id = `object-${nextObjectId++}`;
      const displayName = name || modelPath.split('/').pop().replace('.glb', '').replace('.gltf', '');
      
      // Compute bounding box from model
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
        groupId: null, // Group membership (null = ungrouped)
      };
      
      sceneObjects.push(sceneObject);
      
      // Add to scene graph with bounding box
      sceneGraph.addNode(id, {
        position: sceneObject.position,
        rotation: sceneObject.rotation,
        scale: sceneObject.scale,
        localBounds,
        userData: { name: displayName, modelPath },
      });
      
      updateObjectList();
      selectObject(id);
      
      return sceneObject;
    } catch (error) {
      console.error('Failed to load model:', error);
      return null;
    }
  }
  
  function getModelMatrix(obj) {
    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, obj.position);
    mat4.rotateX(modelMatrix, modelMatrix, obj.rotation[0] * Math.PI / 180);
    mat4.rotateY(modelMatrix, modelMatrix, obj.rotation[1] * Math.PI / 180);
    mat4.rotateZ(modelMatrix, modelMatrix, obj.rotation[2] * Math.PI / 180);
    mat4.scale(modelMatrix, modelMatrix, obj.scale);
    return modelMatrix;
  }
  
  async function duplicateSelectedObject() {
    const obj = sceneObjects.find(o => o.id === selectedObjectId);
    if (!obj) return;
    
    try {
      const newObj = await addObject(obj.modelPath, `${obj.name} (copy)`);
      if (newObj) {
        newObj.position = [obj.position[0] + 0.5, obj.position[1], obj.position[2] + 0.5];
        newObj.rotation = [...obj.rotation];
        newObj.scale = [...obj.scale];
        // Update scene graph with duplicated transforms
        sceneGraph.updateNode(newObj.id, {
          position: newObj.position,
          rotation: newObj.rotation,
          scale: newObj.scale,
        });
        selectObject(newObj.id);
      }
    } catch (error) {
      console.error('Failed to duplicate object:', error);
    }
  }
  
  // ==================== Selection & Grouping ====================
  
  /**
   * Get the first selected object (for single-selection compatibility)
   */
  function getFirstSelectedObject() {
    if (selectedObjectIds.size === 0) return null;
    const firstId = selectedObjectIds.values().next().value;
    return sceneObjects.find(o => o.id === firstId) || null;
  }
  
  /**
   * Get all selected objects
   */
  function getSelectedObjects() {
    return sceneObjects.filter(o => selectedObjectIds.has(o.id));
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
    return [sum[0] / selected.length, sum[1] / selected.length, sum[2] / selected.length];
  }
  
  /**
   * Clear selection
   */
  function clearSelection() {
    selectedObjectIds.clear();
    updateObjectList();
    updateGizmoTarget();
    container.querySelector('#transform-panel').style.display = 'none';
  }
  
  /**
   * Select a single object (or its group members)
   * @param {string} id - Object ID
   * @param {boolean} additive - If true, add to selection (shift+click)
   * @param {boolean} fromExpandedGroup - If true, select only this object even if in group
   */
  function selectObject(id, additive = false, fromExpandedGroup = false) {
    const obj = sceneObjects.find(o => o.id === id);
    if (!obj) {
      if (!additive) clearSelection();
      return;
    }
    
    // Determine what IDs to select
    let idsToSelect = [id];
    
    // If object is in a group and we're not selecting from an expanded group list,
    // select all objects in the group
    if (obj.groupId && !fromExpandedGroup) {
      const group = groups.get(obj.groupId);
      if (group) {
        idsToSelect = [...group.childIds];
      }
    }
    
    if (additive) {
      // Toggle: if all idsToSelect are already selected, deselect them
      const allSelected = idsToSelect.every(i => selectedObjectIds.has(i));
      if (allSelected) {
        idsToSelect.forEach(i => selectedObjectIds.delete(i));
      } else {
        idsToSelect.forEach(i => selectedObjectIds.add(i));
      }
    } else {
      // Clear and select new
      selectedObjectIds.clear();
      idsToSelect.forEach(i => selectedObjectIds.add(i));
    }
    
    updateObjectList();
    updateGizmoTarget();
    updateTransformPanel();
  }
  
  /**
   * Update the transform panel based on selection
   */
  function updateTransformPanel() {
    const transformPanel = container.querySelector('#transform-panel');
    
    if (selectedObjectIds.size === 0) {
      transformPanel.style.display = 'none';
      return;
    }
    
    transformPanel.style.display = 'block';
    
    if (selectedObjectIds.size === 1) {
      // Single selection: show exact values
      const obj = getFirstSelectedObject();
      if (obj) {
        container.querySelector('#object-name').value = obj.name;
        container.querySelector('#object-name').disabled = false;
        container.querySelector('#pos-x').value = obj.position[0].toFixed(2);
        container.querySelector('#pos-y').value = obj.position[1].toFixed(2);
        container.querySelector('#pos-z').value = obj.position[2].toFixed(2);
        container.querySelector('#rot-x').value = obj.rotation[0].toFixed(1);
        container.querySelector('#rot-y').value = obj.rotation[1].toFixed(1);
        container.querySelector('#rot-z').value = obj.rotation[2].toFixed(1);
        container.querySelector('#scale-x').value = obj.scale[0].toFixed(2);
        container.querySelector('#scale-y').value = obj.scale[1].toFixed(2);
        container.querySelector('#scale-z').value = obj.scale[2].toFixed(2);
      }
    } else {
      // Multi-selection: show centroid for position, disable name
      const centroid = getSelectionCentroid();
      container.querySelector('#object-name').value = `${selectedObjectIds.size} objects`;
      container.querySelector('#object-name').disabled = true;
      container.querySelector('#pos-x').value = centroid[0].toFixed(2);
      container.querySelector('#pos-y').value = centroid[1].toFixed(2);
      container.querySelector('#pos-z').value = centroid[2].toFixed(2);
      // Clear rotation/scale (can't show meaningful values for multi-select)
      container.querySelector('#rot-x').value = '-';
      container.querySelector('#rot-y').value = '-';
      container.querySelector('#rot-z').value = '-';
      container.querySelector('#scale-x').value = '-';
      container.querySelector('#scale-y').value = '-';
      container.querySelector('#scale-z').value = '-';
    }
  }
  
  /**
   * Create a group from selected objects
   */
  function createGroupFromSelection() {
    if (selectedObjectIds.size < 2) return null;
    
    // Check if all selected are already in the same group
    const selected = getSelectedObjects();
    const existingGroupId = selected[0].groupId;
    if (existingGroupId) {
      const group = groups.get(existingGroupId);
      if (group && group.childIds.size === selectedObjectIds.size) {
        // All members of this group are selected - no-op
        const allSameGroup = selected.every(o => o.groupId === existingGroupId);
        if (allSameGroup) {
          console.log('All selected objects are already in the same group');
          return null;
        }
      }
    }
    
    // Remove selected objects from any existing groups
    for (const obj of selected) {
      if (obj.groupId) {
        removeObjectFromGroup(obj.id);
      }
    }
    
    // Create new group
    const groupId = `group-${nextGroupId++}`;
    const group = {
      name: `Group ${nextGroupId - 1}`,
      childIds: new Set(selectedObjectIds),
      collapsed: true,
    };
    groups.set(groupId, group);
    
    // Assign group to objects
    for (const obj of selected) {
      obj.groupId = groupId;
    }
    
    updateObjectList();
    return groupId;
  }
  
  /**
   * Remove an object from its group
   */
  function removeObjectFromGroup(objectId) {
    const obj = sceneObjects.find(o => o.id === objectId);
    if (!obj || !obj.groupId) return;
    
    const group = groups.get(obj.groupId);
    if (group) {
      group.childIds.delete(objectId);
      
      // If group has 0 or 1 members, dissolve it
      if (group.childIds.size <= 1) {
        // Remove groupId from remaining member
        for (const remainingId of group.childIds) {
          const remainingObj = sceneObjects.find(o => o.id === remainingId);
          if (remainingObj) remainingObj.groupId = null;
        }
        groups.delete(obj.groupId);
      }
    }
    
    obj.groupId = null;
  }
  
  // ==================== UI ====================
  
  function updateObjectList() {
    const list = container.querySelector('#object-list');
    
    // Build hierarchical list with groups
    const ungrouped = sceneObjects.filter(o => !o.groupId);
    const groupedByGroupId = new Map();
    
    for (const obj of sceneObjects) {
      if (obj.groupId) {
        if (!groupedByGroupId.has(obj.groupId)) {
          groupedByGroupId.set(obj.groupId, []);
        }
        groupedByGroupId.get(obj.groupId).push(obj);
      }
    }
    
    let html = '';
    
    // Render groups first
    for (const [groupId, groupObjects] of groupedByGroupId) {
      const group = groups.get(groupId);
      if (!group) continue;
      
      const isExpanded = expandedGroupInList === groupId;
      const allSelected = groupObjects.every(o => selectedObjectIds.has(o.id));
      
      html += `
        <li class="group-header ${allSelected ? 'selected' : ''}" data-group-id="${groupId}">
          <span class="group-toggle">${isExpanded ? '▼' : '▶'}</span>
          <span class="group-name">${group.name}</span>
          <span class="group-count">(${groupObjects.length})</span>
        </li>
      `;
      
      if (isExpanded) {
        for (const obj of groupObjects) {
          html += `
            <li class="group-child ${selectedObjectIds.has(obj.id) ? 'selected' : ''}" data-id="${obj.id}" data-in-expanded-group="true">
              <span class="child-indent">└─</span>
              <span>${obj.name}</span>
            </li>
          `;
        }
      }
    }
    
    // Render ungrouped objects
    for (const obj of ungrouped) {
      html += `
        <li data-id="${obj.id}" class="${selectedObjectIds.has(obj.id) ? 'selected' : ''}">
          <span>${obj.name}</span>
        </li>
      `;
    }
    
    list.innerHTML = html;
    
    // Attach event handlers
    list.querySelectorAll('li[data-id]').forEach(li => {
      li.addEventListener('click', (e) => {
        const inExpandedGroup = li.dataset.inExpandedGroup === 'true';
        selectObject(li.dataset.id, e.shiftKey, inExpandedGroup);
      });
    });
    
    list.querySelectorAll('.group-header').forEach(li => {
      li.addEventListener('click', (e) => {
        const groupId = li.dataset.groupId;
        if (e.target.classList.contains('group-toggle')) {
          // Toggle expand/collapse
          expandedGroupInList = expandedGroupInList === groupId ? null : groupId;
          updateObjectList();
        } else {
          // Select all group members
          const group = groups.get(groupId);
          if (group) {
            if (!e.shiftKey) selectedObjectIds.clear();
            group.childIds.forEach(id => selectedObjectIds.add(id));
            updateObjectList();
            updateGizmoTarget();
            updateTransformPanel();
          }
        }
      });
    });
  }
  
  function setupMenuBar() {
    // Menu toggle behavior
    const menuItems = container.querySelectorAll('.menu-item');
    
    menuItems.forEach(item => {
      const btn = item.querySelector(':scope > button');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close other menus
        menuItems.forEach(other => {
          if (other !== item) other.classList.remove('open');
        });
        // Toggle this menu
        item.classList.toggle('open');
      });
    });
    
    // Close menus when clicking outside
    document.addEventListener('click', () => {
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Reset origin action
    container.querySelector('#menu-reset-origin').addEventListener('click', () => {
      resetOrigin();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Viewport mode actions
    container.querySelector('#menu-wireframe-view').addEventListener('click', () => {
      setViewportMode('wireframe');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-solid-view').addEventListener('click', () => {
      setViewportMode('solid');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Viewport toolbar buttons
    container.querySelector('#viewport-solid-btn').addEventListener('click', () => setViewportMode('solid'));
    container.querySelector('#viewport-wireframe-btn').addEventListener('click', () => setViewportMode('wireframe'));
    
    // File menu actions
    container.querySelector('#menu-save-scene').addEventListener('click', () => {
      // Pass current filename if we have one (to reuse the same name)
      const savedFilename = saveScene(sceneObjects, getCameraState(), getLightingState(), currentSceneFilename);
      if (savedFilename) {
        currentSceneFilename = savedFilename;
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-load-scene').addEventListener('click', () => {
      container.querySelector('#scene-file').click();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Lighting menu actions
    container.querySelector('#menu-sun-mode').addEventListener('click', () => {
      setLightMode('sun');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-hdr-mode').addEventListener('click', () => {
      setLightMode('hdr');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-load-hdr').addEventListener('click', () => {
      container.querySelector('#hdr-file').click();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Shader editor toggle (View menu)
    const shaderEditorBtn = container.querySelector('#menu-shader-editor');
    if (shaderEditorBtn) {
      shaderEditorBtn.addEventListener('click', () => {
        if (shaderDebugPanel) {
          shaderDebugPanel.toggle();
        }
        menuItems.forEach(item => item.classList.remove('open'));
      });
    }
  }
  
  function setViewportMode(mode) {
    viewportMode = mode;
    // Update toolbar button states
    container.querySelector('#viewport-solid-btn').classList.toggle('active', mode === 'solid');
    container.querySelector('#viewport-wireframe-btn').classList.toggle('active', mode === 'wireframe');
  }
  
  // ==================== Lighting ====================
  
  function setLightMode(mode) {
    lightingManager.setMode(mode);
    container.querySelector('#current-light-mode').textContent = mode === 'sun' ? 'Sun Mode' : 'HDR Mode';
    container.querySelector('#sun-controls').style.display = mode === 'sun' ? 'block' : 'none';
    container.querySelector('#hdr-controls').style.display = mode === 'hdr' ? 'block' : 'none';
  }
  
  function getLightParams() {
    // Get params from lightingManager with shadow renderer
    return lightingManager.getLightParams(shadowRenderer);
  }
  
  function setupCollapsiblePanels() {
    container.querySelectorAll('.sidebar-section h3').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('collapsed');
      });
    });
  }
  
  function setupLightingControls() {
    // Sun azimuth slider
    const azimuthSlider = container.querySelector('#sun-azimuth');
    const azimuthValue = container.querySelector('#sun-azimuth-value');
    azimuthSlider.addEventListener('input', (e) => {
      lightingManager.sunLight.azimuth = parseFloat(e.target.value);
      azimuthValue.textContent = `${lightingManager.sunLight.azimuth}°`;
    });
    
    // Sun elevation slider
    const elevationSlider = container.querySelector('#sun-elevation');
    const elevationValue = container.querySelector('#sun-elevation-value');
    elevationSlider.addEventListener('input', (e) => {
      lightingManager.sunLight.elevation = parseFloat(e.target.value);
      elevationValue.textContent = `${lightingManager.sunLight.elevation}°`;
    });
    
    // HDR exposure slider
    const exposureSlider = container.querySelector('#hdr-exposure');
    const exposureValue = container.querySelector('#hdr-exposure-value');
    exposureSlider.addEventListener('input', (e) => {
      lightingManager.hdrLight.exposure = parseFloat(e.target.value);
      exposureValue.textContent = lightingManager.hdrLight.exposure.toFixed(1);
    });
    
    // Shadow controls
    const shadowCheckbox = container.querySelector('#shadow-enabled');
    shadowCheckbox.addEventListener('change', (e) => {
      lightingManager.shadowEnabled = e.target.checked;
    });
    
    // Shadow quality buttons
    [1024, 2048, 4096].forEach(res => {
      container.querySelector(`#shadow-${res}`).addEventListener('click', () => {
        lightingManager.sunLight.shadowResolution = res;
        shadowRenderer?.setResolution(res);
        container.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
        container.querySelector(`#shadow-${res}`).classList.add('active');
      });
    });
    
    // Shadow debug dropdown
    container.querySelector('#shadow-debug').addEventListener('change', (e) => {
      lightingManager.shadowDebug = parseInt(e.target.value, 10);
    });
    
    // Shadow thumbnail checkbox
    const shadowThumbnailCheckbox = container.querySelector('#shadow-thumbnail');
    if (shadowThumbnailCheckbox) {
      shadowThumbnailCheckbox.addEventListener('change', (e) => {
        showShadowThumbnail = e.target.checked;
      });
    }
    
    // HDR file input
    const hdrFile = container.querySelector('#hdr-file');
    hdrFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          const buffer = await file.arrayBuffer();
          const hdrData = parseHDR(buffer);
          
          // Delete old texture if exists
          if (lightingManager.hdrLight.texture) {
            gl.deleteTexture(lightingManager.hdrLight.texture);
          }
          
          const texture = createHDRTexture(gl, hdrData);
          lightingManager.hdrLight.setTexture(texture, file.name);
          container.querySelector('#hdr-filename').textContent = file.name;
          
          // Auto-switch to HDR mode
          setLightMode('hdr');
        } catch (err) {
          console.error('Failed to load HDR:', err);
          container.querySelector('#hdr-filename').textContent = 'Error loading HDR';
        }
      }
    });
  }
  
  // ==================== Camera View Shortcuts ====================
  
  function saveHomeState() {
    savedHomeState = {
      angleX: cameraAngleX,
      angleY: cameraAngleY,
      distance: cameraDistance,
      offsetX: cameraOffsetX,
      offsetY: cameraOffsetY,
      offsetZ: cameraOffsetZ,
    };
  }
  
  function setCameraView(view) {
    if (view === 'home') {
      // Restore home state
      if (savedHomeState) {
        cameraAngleX = savedHomeState.angleX;
        cameraAngleY = savedHomeState.angleY;
        cameraDistance = savedHomeState.distance;
        cameraOffsetX = savedHomeState.offsetX;
        cameraOffsetY = savedHomeState.offsetY;
        cameraOffsetZ = savedHomeState.offsetZ;
        currentViewMode = 'free';
        updateCameraPosition();
      }
      return;
    }
    
    // Save current state as home if we're in free mode
    if (currentViewMode === 'free') {
      saveHomeState();
    }
    
    // Orthogonal views: reset offset to center on origin, keep distance
    cameraOffsetX = 0;
    cameraOffsetY = 0;
    cameraOffsetZ = 0;
    
    switch (view) {
      case 'front': // Looking at -Z (from +Z towards origin)
        cameraAngleX = 0;
        cameraAngleY = 0;
        break;
      case 'side': // Looking at -X (from +X towards origin)
        cameraAngleX = Math.PI / 2;
        cameraAngleY = 0;
        break;
      case 'top': // Looking at -Y (from +Y towards origin)
        cameraAngleX = 0;
        cameraAngleY = Math.PI / 2 - 0.001; // Slight offset to avoid gimbal issues
        break;
    }
    
    currentViewMode = view;
    updateCameraPosition();
  }
  
  function resetOrigin() {
    // Get current camera position (stays fixed)
    const camPos = camera.getPosition();
    
    // New origin is center of scene
    const newOrigin = [0, 0, 0];
    
    // Calculate vector from new origin to camera
    const dx = camPos[0] - newOrigin[0];
    const dy = camPos[1] - newOrigin[1];
    const dz = camPos[2] - newOrigin[2];
    
    // Calculate new distance from camera to new origin
    const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Calculate new angles from spherical coordinates
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const newAngleY = Math.atan2(dy, horizontalDist);
    const newAngleX = Math.atan2(dx, dz);
    
    // Update state
    originMarkerPos = newOrigin;
    cameraAngleX = newAngleX;
    cameraAngleY = newAngleY;
    cameraDistance = newDistance;
    cameraOffsetX = 0;
    cameraOffsetY = 0;
    cameraOffsetZ = 0;
    
    updateCameraPosition();
  }
  
  function setupUI() {
    // Import button
    const importBtn = container.querySelector('#import-btn');
    const modelFile = container.querySelector('#model-file');
    importBtn.addEventListener('click', () => modelFile.click());
    modelFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        const { modelPath, displayName } = await importModelFile(file);
        await addObject(modelPath, displayName);
      }
    });
    
    // Preset models
    container.querySelector('#preset-models').addEventListener('change', async (e) => {
      if (e.target.value) {
        await addObject(`/models/${e.target.value}`);
        e.target.value = '';
      }
    });
    
    // Object name input
    container.querySelector('#object-name').addEventListener('input', (e) => {
      const obj = sceneObjects.find(o => o.id === selectedObjectId);
      if (obj) {
        obj.name = e.target.value || 'Unnamed';
        updateObjectList();
      }
    });
    
    // Gizmo mode buttons
    container.querySelector('#gizmo-translate').addEventListener('click', () => setGizmoMode('translate'));
    container.querySelector('#gizmo-rotate').addEventListener('click', () => setGizmoMode('rotate'));
    container.querySelector('#gizmo-scale').addEventListener('click', () => setGizmoMode('scale'));
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      
      if (e.key === 'Escape' && uniformScaleActive) {
        cancelUniformScale();
        return;
      }
      
      if ((e.key === 's' || e.key === 'S') && selectedObjectId && !transformGizmo.isDragging && !uniformScaleActive) {
        startUniformScale();
        return;
      }
      
      if ((e.key === 'd' || e.key === 'D') && selectedObjectId && !uniformScaleActive) {
        duplicateSelectedObject();
        return;
      }
      
      if (!uniformScaleActive) {
        if (e.key === 't' || e.key === 'T') setGizmoMode('translate');
        if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
        
        // Camera view shortcuts (numpad + number row)
        if (e.code === 'Numpad0' || e.key === '0') setCameraView('home');
        if (e.code === 'Numpad1' || e.key === '1') setCameraView('front');
        if (e.code === 'Numpad2' || e.key === '2') setCameraView('side');
        if (e.code === 'Numpad3' || e.key === '3') setCameraView('top');
      }
    });
    
    // Transform inputs
    ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-x', 'scale-y', 'scale-z'].forEach(inputId => {
      container.querySelector(`#${inputId}`).addEventListener('input', (e) => {
        const obj = sceneObjects.find(o => o.id === selectedObjectId);
        if (!obj) return;
        
        const value = parseFloat(e.target.value) || 0;
        const [type, axis] = inputId.split('-');
        const axisIndex = { x: 0, y: 1, z: 2 }[axis];
        
        if (type === 'pos') obj.position[axisIndex] = value;
        else if (type === 'rot') obj.rotation[axisIndex] = value;
        else if (type === 'scale') obj.scale[axisIndex] = Math.max(0.01, value);
        
        // Update scene graph
        sceneGraph.updateNode(obj.id, {
          position: obj.position,
          rotation: obj.rotation,
          scale: obj.scale,
        });
        
        updateGizmoTarget();
      });
    });
    
    // Reset buttons
    container.querySelector('#reset-position').addEventListener('click', () => {
      const obj = sceneObjects.find(o => o.id === selectedObjectId);
      if (!obj) return;
      obj.position = [0, 0, 0];
      ['pos-x', 'pos-y', 'pos-z'].forEach(id => container.querySelector(`#${id}`).value = 0);
      sceneGraph.updateNode(obj.id, { position: obj.position });
      updateGizmoTarget();
    });
    
    container.querySelector('#reset-rotation').addEventListener('click', () => {
      const obj = sceneObjects.find(o => o.id === selectedObjectId);
      if (!obj) return;
      obj.rotation = [0, 0, 0];
      ['rot-x', 'rot-y', 'rot-z'].forEach(id => container.querySelector(`#${id}`).value = 0);
      sceneGraph.updateNode(obj.id, { rotation: obj.rotation });
      updateGizmoTarget();
    });
    
    container.querySelector('#reset-scale').addEventListener('click', () => {
      const obj = sceneObjects.find(o => o.id === selectedObjectId);
      if (!obj) return;
      obj.scale = [1, 1, 1];
      ['scale-x', 'scale-y', 'scale-z'].forEach(id => container.querySelector(`#${id}`).value = 1);
      sceneGraph.updateNode(obj.id, { scale: obj.scale });
      updateGizmoTarget();
    });
    
    // Delete object
    container.querySelector('#delete-object').addEventListener('click', () => {
      const index = sceneObjects.findIndex(o => o.id === selectedObjectId);
      if (index >= 0) {
        const id = sceneObjects[index].id;
        sceneObjects[index].renderer?.destroy();
        sceneObjects.splice(index, 1);
        sceneGraph.removeNode(id);
        selectedObjectId = null;
        updateObjectList();
        updateGizmoTarget();
        container.querySelector('#transform-panel').style.display = 'none';
      }
    });
    
    // Scene file input handler
    const sceneFile = container.querySelector('#scene-file');
    sceneFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        // Extract filename without .json extension
        currentSceneFilename = file.name.replace(/\.json$/i, '');
        
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const sceneData = JSON.parse(event.target.result);
            await loadSceneData(sceneData);
          } catch (err) {
            console.error('Failed to load scene:', err);
            currentSceneFilename = null; // Reset on error
          }
        };
        reader.readAsText(file);
      }
    });
  }
  
  async function loadSceneData(sceneData) {
    sceneObjects.forEach(obj => obj.renderer?.destroy());
    sceneObjects.length = 0;
    sceneGraph.clear();
    selectedObjectId = null;
    
    setCameraState(parseCameraState(sceneData));
    
    // Restore lighting state if present
    const lightingState = parseLightingState(sceneData);
    if (lightingState) {
      setLightingState(lightingState);
    }
    
    for (const objData of sceneData.objects) {
      const obj = await addObject(objData.modelPath, objData.name);
      if (obj) {
        obj.position = [...objData.position];
        obj.rotation = [...objData.rotation];
        obj.scale = [...objData.scale];
        // Update scene graph with loaded transforms
        sceneGraph.updateNode(obj.id, {
          position: obj.position,
          rotation: obj.rotation,
          scale: obj.scale,
        });
      }
    }
    
    updateObjectList();
  }
  
  // ==================== Uniform Scale Mode ====================
  
  function startUniformScale() {
    const obj = sceneObjects.find(o => o.id === selectedObjectId);
    if (!obj) return;
    
    if (!overlayCanvas.parentNode) viewport.appendChild(overlayCanvas);
    
    uniformScaleActive = true;
    uniformScaleStartScale = [...obj.scale];
    uniformScaleObjectScreenPos = projectToScreen(obj.position, camera, CANVAS_WIDTH, CANVAS_HEIGHT);
    uniformScaleStartMousePos = [...lastKnownMousePos];
    uniformScaleMousePos = [...lastKnownMousePos];
    
    const dx = uniformScaleStartMousePos[0] - uniformScaleObjectScreenPos[0];
    const dy = uniformScaleStartMousePos[1] - uniformScaleObjectScreenPos[1];
    uniformScaleStartDistance = Math.sqrt(dx * dx + dy * dy);
    if (uniformScaleStartDistance < 10) uniformScaleStartDistance = 100;
    
    canvas.style.cursor = 'nwse-resize';
    drawUniformScaleOverlay();
  }
  
  function updateUniformScale(mouseX, mouseY) {
    const obj = sceneObjects.find(o => o.id === selectedObjectId);
    if (!obj || !uniformScaleActive) return;
    
    const dx = mouseX - uniformScaleObjectScreenPos[0];
    const dy = mouseY - uniformScaleObjectScreenPos[1];
    const scaleFactor = Math.sqrt(dx * dx + dy * dy) / uniformScaleStartDistance;
    
    obj.scale = uniformScaleStartScale.map(s => Math.max(0.01, s * scaleFactor));
    sceneGraph.updateNode(obj.id, { scale: obj.scale });
    
    container.querySelector('#scale-x').value = obj.scale[0].toFixed(2);
    container.querySelector('#scale-y').value = obj.scale[1].toFixed(2);
    container.querySelector('#scale-z').value = obj.scale[2].toFixed(2);
    
    updateGizmoTarget();
    drawUniformScaleOverlay();
  }
  
  function drawUniformScaleOverlay() {
    overlayCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (!uniformScaleActive) return;
    
    overlayCtx.save();
    overlayCtx.strokeStyle = '#ffff00';
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([8, 8]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(uniformScaleObjectScreenPos[0], uniformScaleObjectScreenPos[1]);
    overlayCtx.lineTo(uniformScaleMousePos[0], uniformScaleMousePos[1]);
    overlayCtx.stroke();
    
    overlayCtx.fillStyle = '#ffff00';
    overlayCtx.beginPath();
    overlayCtx.arc(uniformScaleObjectScreenPos[0], uniformScaleObjectScreenPos[1], 6, 0, Math.PI * 2);
    overlayCtx.fill();
    
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.font = '12px monospace';
    overlayCtx.fillText('Uniform Scale - Click to commit, Esc to cancel', 10, 20);
    overlayCtx.restore();
  }
  
  function commitUniformScale() {
    uniformScaleActive = false;
    canvas.style.cursor = 'default';
    overlayCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (overlayCanvas.parentNode) overlayCanvas.parentNode.removeChild(overlayCanvas);
  }
  
  function cancelUniformScale() {
    const obj = sceneObjects.find(o => o.id === selectedObjectId);
    if (obj) {
      obj.scale = [...uniformScaleStartScale];
      sceneGraph.updateNode(obj.id, { scale: obj.scale });
      container.querySelector('#scale-x').value = obj.scale[0].toFixed(2);
      container.querySelector('#scale-y').value = obj.scale[1].toFixed(2);
      container.querySelector('#scale-z').value = obj.scale[2].toFixed(2);
      updateGizmoTarget();
    }
    commitUniformScale();
  }
  
  // ==================== Render Loop ====================
  
  function startRendering() {
    if (animationLoop) animationLoop.stop();
    
    animationLoop = createAnimationLoop({ onFps });
    
    animationLoop.start(() => {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      const vpMatrix = camera.getViewProjectionMatrix();
      const mode = lightingManager.activeMode;
      
      // Shadow pass (sun mode only)
      if (mode === 'sun' && lightingManager.shadowEnabled && sceneObjects.length > 0) {
        const sunDir = lightingManager.sunLight.getDirection();
        // Use larger coverage for shadow map to handle larger scenes
        const shadowCoverage = 5;
        shadowRenderer.beginShadowPass(sunDir, shadowCoverage);
        
        for (const obj of sceneObjects) {
          if (obj.renderer && obj.renderer.gpuMeshes) {
            const modelMatrix = getModelMatrix(obj);
            shadowRenderer.renderObject(obj.renderer.gpuMeshes, modelMatrix);
          }
        }
        
        shadowRenderer.endShadowPass(CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      
      // Render sky background first
      if (mode === 'hdr' && lightingManager.hdrLight.texture) {
        skyRenderer.renderHDRSky(vpMatrix, lightingManager.hdrLight.texture, lightingManager.hdrLight.exposure);
      } else {
        skyRenderer.renderSunSky(lightingManager.sunLight.elevation);
      }
      
      gridRenderer.render(vpMatrix);
      originMarkerRenderer.render(vpMatrix, originMarkerPos);
      
      const isWireframe = viewportMode === 'wireframe';
      const lightParams = getLightParams();
      
      for (const obj of sceneObjects) {
        if (obj.renderer) {
          obj.renderer.render(vpMatrix, getModelMatrix(obj), obj.id === selectedObjectId, isWireframe, lightParams);
        }
      }
      
      transformGizmo.render(vpMatrix);
      
      // Shadow map debug thumbnail (after scene, before UI)
      if (showShadowThumbnail && lightingManager.shadowEnabled && mode === 'sun') {
        const thumbSize = 150;
        const margin = 10;
        shadowRenderer.renderDebugThumbnail(margin, margin, thumbSize, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    });
  }
  
  // ==================== Lifecycle ====================
  
  async function init() {
    if (!initGL()) return;
    initCamera();
    initGizmo();
    setupCameraControls();
    setupMenuBar();
    setupUI();
    setupLightingControls();
    setupCollapsiblePanels();
    
    // Create shader debug panel
    shaderDebugPanel = createShaderDebugPanel(viewport);
    
    startRendering();
  }
  
  function destroy() {
    if (animationLoop) { animationLoop.stop(); animationLoop = null; }
    if (gridRenderer) { gridRenderer.destroy(); gridRenderer = null; }
    if (originMarkerRenderer) { originMarkerRenderer.destroy(); originMarkerRenderer = null; }
    if (transformGizmo) { transformGizmo.destroy(); transformGizmo = null; }
    if (skyRenderer) { skyRenderer.destroy(); skyRenderer = null; }
    if (shadowRenderer) { shadowRenderer.destroy(); shadowRenderer = null; }
    if (shaderDebugPanel) { shaderDebugPanel.destroy(); shaderDebugPanel = null; }
    // Clean up HDR texture via lightingManager
    if (lightingManager.hdrLight.texture) {
      gl.deleteTexture(lightingManager.hdrLight.texture);
      lightingManager.hdrLight.texture = null;
    }
    sceneObjects.forEach(obj => obj.renderer?.destroy());
    sceneObjects.length = 0;
    sceneGraph.clear();
    clearImportedModels();
    container.innerHTML = '';
  }
  
  return {
    init,
    destroy,
    name: 'Scene Builder',
    description: 'Import and position 3D models to create composite scenes',
  };
}
