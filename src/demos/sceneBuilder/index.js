import { createAnimationLoop } from '../../core/animationLoop';
import { createSceneGraph } from '../../core/sceneGraph';
import { createGridRenderer } from './gridRenderer';
import { createTransformGizmo } from './transformGizmo';
import { createOriginMarkerRenderer } from './originMarkerRenderer';
import { sceneBuilderStyles, sceneBuilderTemplate } from './styles';
import { screenToRay, projectToScreen } from './raycastUtils';
import { importModelFile, saveScene, parseCameraState, parseLightingState, clearImportedModels } from './sceneSerializer';
import { createSkyRenderer } from './skyRenderer';
import { parseHDR, createHDRTexture } from './hdrLoader';
import { createShadowRenderer } from './shadowRenderer';
import { createDepthPrePassRenderer } from './depthPrePassRenderer';
import { createShaderDebugPanel } from './shaderDebugPanel';
import { createLightingManager } from './lights';
import { createScene } from './scene';
import { createCameraController } from './cameraController';
import { createWindManager, serializeObjectWindSettings, deserializeObjectWindSettings } from './wind';

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
  const sceneGraph = createSceneGraph();
  let scene = null;
  
  // Active components
  let animationLoop = null;
  let cameraController = null;
  let gl = null;
  let gridRenderer = null;
  let transformGizmo = null;
  let originMarkerRenderer = null;
  let gizmoMode = 'translate';
  let viewportMode = 'solid';
  
  // Lighting
  const lightingManager = createLightingManager();
  let skyRenderer = null;
  let shadowRenderer = null;
  let showShadowThumbnail = false;
  let shaderDebugPanel = null;
  
  // Uniform scale mode state
  let uniformScaleActive = false;
  let uniformScaleStartScale = [1, 1, 1];
  let uniformScaleStartDistance = 0;
  let uniformScaleMousePos = [0, 0];
  let uniformScaleObjectScreenPos = [0, 0];
  let uniformScaleStartMousePos = [0, 0];
  let lastKnownMousePos = [0, 0];
  
  // Scene file tracking
  let currentSceneFilename = null;
  
  // Wind system
  const windManager = createWindManager();
  const objectWindSettings = new Map(); // objectId -> wind settings
  
  // Terrain blend settings
  const objectTerrainBlendSettings = new Map(); // objectId -> { enabled, blendDistance }
  let depthPrePassRenderer = null;
  
  
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
    depthPrePassRenderer = createDepthPrePassRenderer(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Initialize scene after GL context is ready
    scene = createScene(gl, sceneGraph);
    
    // Wire up scene event callbacks
    scene.onSelectionChanged = () => {
      updateObjectList();
      updateGizmoTarget();
      updateTransformPanel();
      updateWindObjectPanel();
    };
    
    scene.onObjectAdded = () => {
      updateObjectList();
    };
    
    scene.onObjectRemoved = () => {
      updateObjectList();
    };
    
    scene.onGroupChanged = () => {
      updateObjectList();
    };
    
    return true;
  }
  
  // ==================== Camera ====================
  
  function initCamera() {
    cameraController = createCameraController({
      canvas,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });
    
    // Set up input handling with gizmo integration
    cameraController.setupEventListeners({
      onGizmoCheck: () => transformGizmo?.isDragging,
      onGizmoMouseDown: (x, y) => {
        if (uniformScaleActive) {
          commitUniformScale();
          return true;
        }
        return transformGizmo?.handleMouseDown(x, y, CANVAS_WIDTH, CANVAS_HEIGHT);
      },
      onGizmoMouseMove: (x, y) => {
        lastKnownMousePos = [x, y];
        if (uniformScaleActive) {
          uniformScaleMousePos = [x, y];
          updateUniformScale(x, y);
          return;
        }
        transformGizmo?.handleMouseMove(x, y);
      },
      onGizmoMouseUp: () => {
        transformGizmo?.handleMouseUp();
      },
      onClick: handleCanvasClick,
    });
    
    // Track mouse position for uniform scale
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      lastKnownMousePos = [e.clientX - rect.left, e.clientY - rect.top];
      
      // Update uniform scale if active (this handles non-drag mouse movement)
      if (uniformScaleActive) {
        uniformScaleMousePos = [...lastKnownMousePos];
        updateUniformScale(lastKnownMousePos[0], lastKnownMousePos[1]);
      }
    });
  }
  
  // ==================== Gizmo ====================
  
  function initGizmo() {
    transformGizmo = createTransformGizmo(gl, cameraController.getCamera());
    transformGizmo.setOnChange((type, value) => {
      scene.applyTransform(type, value);
      updateTransformPanel();
    });
  }
  
  function updateGizmoTarget() {
    const target = scene.getGizmoTarget();
    
    if (!target.position) {
      transformGizmo.setEnabled(false);
      return;
    }
    
    transformGizmo.setEnabled(true);
    transformGizmo.setTarget(target.position, target.rotation, target.scale);
    scene.resetTransformTracking();
  }
  
  function setGizmoMode(mode) {
    gizmoMode = mode;
    transformGizmo.setMode(mode);
    container.querySelectorAll('.gizmo-btn').forEach(btn => btn.classList.remove('active'));
    container.querySelector(`#gizmo-${mode}`).classList.add('active');
  }
  
  // ==================== Input Handling ====================
  
  function handleCanvasClick(screenX, screenY, shiftKey = false) {
    if (sceneGraph.size() === 0) {
      if (!shiftKey) scene.clearSelection();
      return;
    }
    
    const camera = cameraController.getCamera();
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera, CANVAS_WIDTH, CANVAS_HEIGHT);
    const hit = sceneGraph.castRay(rayOrigin, rayDir);
    
    if (hit) {
      scene.select(hit.node.id, { additive: shiftKey });
    } else {
      if (!shiftKey) scene.clearSelection();
    }
  }
  
  // ==================== Lighting State ====================
  
  function getLightingState() {
    const state = lightingManager.serialize();
    state.hdr.filename = container.querySelector('#hdr-filename')?.textContent || null;
    return state;
  }
  
  function setLightingState(state) {
    if (!state) return;
    lightingManager.deserialize(state);
    setLightMode(lightingManager.activeMode);
    
    const azimuthSlider = container.querySelector('#sun-azimuth');
    if (azimuthSlider) {
      azimuthSlider.value = lightingManager.sunLight.azimuth;
      container.querySelector('#sun-azimuth-value').textContent = `${lightingManager.sunLight.azimuth}°`;
    }
    
    const elevationSlider = container.querySelector('#sun-elevation');
    if (elevationSlider) {
      elevationSlider.value = lightingManager.sunLight.elevation;
      container.querySelector('#sun-elevation-value').textContent = `${lightingManager.sunLight.elevation}°`;
    }
    
    const shadowCheckbox = container.querySelector('#shadow-enabled');
    if (shadowCheckbox) shadowCheckbox.checked = lightingManager.shadowEnabled;
    
    shadowRenderer?.setResolution(lightingManager.sunLight.shadowResolution);
    container.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
    container.querySelector(`#shadow-${lightingManager.sunLight.shadowResolution}`)?.classList.add('active');
    
    const exposureSlider = container.querySelector('#hdr-exposure');
    if (exposureSlider) {
      exposureSlider.value = lightingManager.hdrLight.exposure;
      container.querySelector('#hdr-exposure-value').textContent = lightingManager.hdrLight.exposure.toFixed(1);
    }
    
    if (lightingManager.hdrLight.filename && lightingManager.hdrLight.filename !== 'No HDR loaded') {
      container.querySelector('#hdr-filename').textContent = `${lightingManager.hdrLight.filename} (reload required)`;
    }
  }
  
  // ==================== UI ====================
  
  function updateObjectList() {
    const list = container.querySelector('#object-list');
    const allObjects = scene.getAllObjects();
    const groups = scene.getAllGroups();
    
    // Build hierarchical list
    const ungrouped = allObjects.filter(o => !o.groupId);
    const groupedByGroupId = new Map();
    
    for (const obj of allObjects) {
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
      
      const isExpanded = scene.isGroupExpanded(groupId);
      const allSelected = groupObjects.every(o => scene.isSelected(o.id));
      
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
            <li class="group-child ${scene.isSelected(obj.id) ? 'selected' : ''}" data-id="${obj.id}" data-in-expanded-group="true">
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
        <li data-id="${obj.id}" class="${scene.isSelected(obj.id) ? 'selected' : ''}">
          <span>${obj.name}</span>
        </li>
      `;
    }
    
    list.innerHTML = html;
    
    // Attach event handlers
    list.querySelectorAll('li[data-id]').forEach(li => {
      li.addEventListener('click', (e) => {
        const inExpandedGroup = li.dataset.inExpandedGroup === 'true';
        scene.select(li.dataset.id, { additive: e.shiftKey, fromExpandedGroup: inExpandedGroup });
      });
    });
    
    list.querySelectorAll('.group-header').forEach(li => {
      li.addEventListener('click', (e) => {
        const groupId = li.dataset.groupId;
        if (e.target.classList.contains('group-toggle')) {
          scene.toggleGroupExpanded(groupId);
          updateObjectList();
        } else {
          // Select all group members
          const group = scene.getGroup(groupId);
          if (group) {
            if (!e.shiftKey) scene.clearSelection();
            scene.selectAll([...group.childIds]);
          }
        }
      });
    });
  }
  
  function updateTransformPanel() {
    const objectPanel = container.querySelector('#object-panel');
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount === 0) {
      objectPanel.style.display = 'none';
      return;
    }
    
    objectPanel.style.display = 'block';
    
    if (selectionCount === 1) {
      const obj = scene.getFirstSelected();
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
      const centroid = scene.getSelectionCentroid();
      container.querySelector('#object-name').value = `${selectionCount} objects`;
      container.querySelector('#object-name').disabled = true;
      container.querySelector('#pos-x').value = centroid[0].toFixed(2);
      container.querySelector('#pos-y').value = centroid[1].toFixed(2);
      container.querySelector('#pos-z').value = centroid[2].toFixed(2);
      container.querySelector('#rot-x').value = '-';
      container.querySelector('#rot-y').value = '-';
      container.querySelector('#rot-z').value = '-';
      container.querySelector('#scale-x').value = '-';
      container.querySelector('#scale-y').value = '-';
      container.querySelector('#scale-z').value = '-';
    }
  }
  
  function setupMenuBar() {
    const menuItems = container.querySelectorAll('.menu-item');
    
    menuItems.forEach(item => {
      const btn = item.querySelector(':scope > button');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menuItems.forEach(other => {
          if (other !== item) other.classList.remove('open');
        });
        item.classList.toggle('open');
      });
    });
    
    document.addEventListener('click', () => {
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-reset-origin').addEventListener('click', () => {
      cameraController.resetOrigin();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-wireframe-view').addEventListener('click', () => {
      setViewportMode('wireframe');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-solid-view').addEventListener('click', () => {
      setViewportMode('solid');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#viewport-solid-btn').addEventListener('click', () => setViewportMode('solid'));
    container.querySelector('#viewport-wireframe-btn').addEventListener('click', () => setViewportMode('wireframe'));
    
    container.querySelector('#menu-save-scene').addEventListener('click', () => {
      const sceneData = scene.serialize();
      // Add wind settings to scene data - key by object index for reliable matching on reload
      sceneData.wind = windManager.serialize();
      sceneData.objectWindSettings = [];
      const allObjects = scene.getAllObjects();
      for (let i = 0; i < allObjects.length; i++) {
        const obj = allObjects[i];
        const settings = objectWindSettings.get(obj.id);
        sceneData.objectWindSettings.push(settings ? serializeObjectWindSettings(settings) : null);
      }
      const savedFilename = saveScene(sceneData.objects, cameraController.serialize(), getLightingState(), currentSceneFilename, new Map(), sceneData.wind, sceneData.objectWindSettings, sceneData.groups);
      if (savedFilename) {
        currentSceneFilename = savedFilename;
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-load-scene').addEventListener('click', () => {
      container.querySelector('#scene-file').click();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
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
    
    const shaderEditorBtn = container.querySelector('#menu-shader-editor');
    if (shaderEditorBtn) {
      shaderEditorBtn.addEventListener('click', () => {
        if (shaderDebugPanel) shaderDebugPanel.toggle();
        menuItems.forEach(item => item.classList.remove('open'));
      });
    }
  }
  
  function setViewportMode(mode) {
    viewportMode = mode;
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
    return lightingManager.getLightParams(shadowRenderer);
  }
  
  function setupCollapsiblePanels() {
    container.querySelectorAll('.sidebar-section h3').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('collapsed');
      });
    });
  }
  
  function setupEnvironmentTabs() {
    // Environment panel tabs (Lighting/Wind)
    const envPanel = container.querySelector('#environment-panel');
    if (envPanel) {
      const envTabs = envPanel.querySelectorAll('.env-tab');
      envTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          envTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          
          const tabName = tab.dataset.tab;
          envPanel.querySelectorAll('.env-tab-content').forEach(content => {
            content.classList.remove('active');
          });
          envPanel.querySelector(`#env-${tabName}-tab`).classList.add('active');
        });
      });
    }
    
    // Object panel tabs (Transform/Modifiers)
    const objPanel = container.querySelector('#object-panel');
    if (objPanel) {
      const objTabs = objPanel.querySelectorAll('.env-tab');
      objTabs.forEach(tab => {
        tab.addEventListener('click', () => {
          objTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          
          const tabName = tab.dataset.tab;
          objPanel.querySelectorAll('.env-tab-content').forEach(content => {
            content.classList.remove('active');
          });
          objPanel.querySelector(`#obj-${tabName}-tab`).classList.add('active');
        });
      });
    }
  }
  
  // ==================== Wind Controls ====================
  
  function getOrCreateWindSettings(objectId) {
    if (!objectWindSettings.has(objectId)) {
      objectWindSettings.set(objectId, windManager.createObjectWindSettings());
    }
    return objectWindSettings.get(objectId);
  }
  
  function getOrCreateTerrainBlendSettings(objectId) {
    if (!objectTerrainBlendSettings.has(objectId)) {
      objectTerrainBlendSettings.set(objectId, { enabled: false, blendDistance: 0.5 });
    }
    return objectTerrainBlendSettings.get(objectId);
  }
  
  function updateWindDirectionArrow() {
    const arrow = container.querySelector('#wind-direction-arrow');
    if (arrow) {
      arrow.style.transform = `translateY(-50%) rotate(${windManager.direction}deg)`;
    }
  }
  
  function updateWindEnabledIndicator() {
    const indicator = container.querySelector('#wind-enabled-indicator');
    if (indicator) {
      indicator.classList.toggle('active', windManager.enabled);
    }
  }
  
  function updateWindObjectPanel() {
    const selectionCount = scene.getSelectionCount();
    const windModifierSettings = container.querySelector('#wind-modifier-settings');
    
    if (selectionCount !== 1) {
      // Disable wind settings when no single object selected
      windModifierSettings?.classList.add('disabled');
      return;
    }
    
    const obj = scene.getFirstSelected();
    if (!obj) {
      windModifierSettings?.classList.add('disabled');
      return;
    }
    
    const settings = getOrCreateWindSettings(obj.id);
    
    // Update UI with current settings
    container.querySelector('#object-wind-enabled').checked = settings.enabled;
    container.querySelector('#object-wind-influence').value = settings.influence;
    container.querySelector('#object-wind-influence-value').textContent = settings.influence.toFixed(1);
    container.querySelector('#object-wind-stiffness').value = settings.stiffness;
    container.querySelector('#object-wind-stiffness-value').textContent = settings.stiffness.toFixed(1);
    container.querySelector('#object-wind-anchor').value = settings.anchorHeight;
    container.querySelector('#object-wind-anchor-value').textContent = settings.anchorHeight.toFixed(1);
    
    // Enable/disable wind settings based on checkbox
    updateWindModifierSettingsState(settings.enabled);
    
    // Populate material lists
    updateMaterialLists(obj, settings);
    
    // Update terrain blend UI
    updateTerrainBlendPanel(obj);
  }
  
  function updateTerrainBlendPanel(obj) {
    if (!obj) return;
    
    const terrainSettings = getOrCreateTerrainBlendSettings(obj.id);
    container.querySelector('#object-terrain-blend-enabled').checked = terrainSettings.enabled;
    container.querySelector('#terrain-blend-distance').value = terrainSettings.blendDistance;
    container.querySelector('#terrain-blend-distance-value').textContent = terrainSettings.blendDistance.toFixed(1);
    
    // Enable/disable settings based on checkbox
    const settingsDiv = container.querySelector('#terrain-blend-settings');
    if (settingsDiv) {
      settingsDiv.classList.toggle('disabled', !terrainSettings.enabled);
    }
  }
  
  function updateWindModifierSettingsState(enabled) {
    const windModifierSettings = container.querySelector('#wind-modifier-settings');
    if (windModifierSettings) {
      windModifierSettings.classList.toggle('disabled', !enabled);
    }
  }
  
  function updateMaterialLists(obj, settings) {
    const leafList = container.querySelector('#leaf-material-list');
    const branchList = container.querySelector('#branch-material-list');
    
    if (!obj.model || !obj.model.materials) {
      leafList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      branchList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      return;
    }
    
    const materials = obj.model.materials;
    
    // Build leaf material list
    let leafHtml = '';
    materials.forEach((mat, idx) => {
      const isLeaf = settings.leafMaterialIndices.has(idx);
      const color = mat.baseColorFactor || [0.8, 0.8, 0.8, 1];
      const colorStr = `rgb(${Math.round(color[0]*255)}, ${Math.round(color[1]*255)}, ${Math.round(color[2]*255)})`;
      const name = mat.name || `Material ${idx}`;
      leafHtml += `
        <div class="material-item" data-material-idx="${idx}" data-type="leaf">
          <input type="checkbox" ${isLeaf ? 'checked' : ''}>
          <div class="material-color-swatch" style="background: ${colorStr}"></div>
          <span class="material-name">${name}</span>
          ${isLeaf ? '<span class="wind-type-badge leaf">Leaf</span>' : ''}
        </div>
      `;
    });
    leafList.innerHTML = leafHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
    // Build branch material list
    let branchHtml = '';
    materials.forEach((mat, idx) => {
      const isBranch = settings.branchMaterialIndices?.has(idx);
      const color = mat.baseColorFactor || [0.8, 0.8, 0.8, 1];
      const colorStr = `rgb(${Math.round(color[0]*255)}, ${Math.round(color[1]*255)}, ${Math.round(color[2]*255)})`;
      const name = mat.name || `Material ${idx}`;
      branchHtml += `
        <div class="material-item" data-material-idx="${idx}" data-type="branch">
          <input type="checkbox" ${isBranch ? 'checked' : ''}>
          <div class="material-color-swatch" style="background: ${colorStr}"></div>
          <span class="material-name">${name}</span>
          ${isBranch ? '<span class="wind-type-badge branch">Branch</span>' : ''}
        </div>
      `;
    });
    branchList.innerHTML = branchHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
    // Attach click handlers
    leafList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(item.dataset.materialIdx, 10);
        if (checkbox.checked) {
          settings.leafMaterialIndices.add(idx);
          // Remove from branch if present
          settings.branchMaterialIndices?.delete(idx);
        } else {
          settings.leafMaterialIndices.delete(idx);
        }
        updateMaterialLists(obj, settings);
      });
    });
    
    branchList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(item.dataset.materialIdx, 10);
        if (!settings.branchMaterialIndices) settings.branchMaterialIndices = new Set();
        
        if (checkbox.checked) {
          settings.branchMaterialIndices.add(idx);
          // Remove from leaf if present
          settings.leafMaterialIndices.delete(idx);
        } else {
          settings.branchMaterialIndices.delete(idx);
        }
        updateMaterialLists(obj, settings);
      });
    });
  }
  
  function setupWindControls() {
    // Global wind enabled
    container.querySelector('#wind-enabled').addEventListener('change', (e) => {
      windManager.enabled = e.target.checked;
      updateWindEnabledIndicator();
    });
    
    // Wind direction
    const dirSlider = container.querySelector('#wind-direction');
    const dirValue = container.querySelector('#wind-direction-value');
    dirSlider.addEventListener('input', (e) => {
      windManager.direction = parseFloat(e.target.value);
      dirValue.textContent = `${windManager.direction}°`;
      updateWindDirectionArrow();
    });
    
    // Wind strength
    const strengthSlider = container.querySelector('#wind-strength');
    const strengthValue = container.querySelector('#wind-strength-value');
    strengthSlider.addEventListener('input', (e) => {
      windManager.strength = parseFloat(e.target.value);
      strengthValue.textContent = windManager.strength.toFixed(1);
    });
    
    // Turbulence
    const turbSlider = container.querySelector('#wind-turbulence');
    const turbValue = container.querySelector('#wind-turbulence-value');
    turbSlider.addEventListener('input', (e) => {
      windManager.turbulence = parseFloat(e.target.value);
      turbValue.textContent = windManager.turbulence.toFixed(1);
    });
    
    // Gust strength
    const gustSlider = container.querySelector('#wind-gust-strength');
    const gustValue = container.querySelector('#wind-gust-strength-value');
    gustSlider.addEventListener('input', (e) => {
      windManager.gustStrength = parseFloat(e.target.value);
      gustValue.textContent = windManager.gustStrength.toFixed(1);
    });
    
    // Object wind enabled
    container.querySelector('#object-wind-enabled').addEventListener('change', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateWindSettings(obj.id);
        settings.enabled = e.target.checked;
        updateWindModifierSettingsState(settings.enabled);
      }
    });
    
    // Object influence
    const infSlider = container.querySelector('#object-wind-influence');
    const infValue = container.querySelector('#object-wind-influence-value');
    infSlider.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateWindSettings(obj.id);
        settings.influence = parseFloat(e.target.value);
        infValue.textContent = settings.influence.toFixed(1);
      }
    });
    
    // Object stiffness
    const stiffSlider = container.querySelector('#object-wind-stiffness');
    const stiffValue = container.querySelector('#object-wind-stiffness-value');
    stiffSlider.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateWindSettings(obj.id);
        settings.stiffness = parseFloat(e.target.value);
        stiffValue.textContent = settings.stiffness.toFixed(1);
      }
    });
    
    // Object anchor height
    const anchorSlider = container.querySelector('#object-wind-anchor');
    const anchorValue = container.querySelector('#object-wind-anchor-value');
    anchorSlider.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateWindSettings(obj.id);
        settings.anchorHeight = parseFloat(e.target.value);
        anchorValue.textContent = settings.anchorHeight.toFixed(1);
      }
    });
    
    // Wind debug dropdown
    container.querySelector('#wind-debug').addEventListener('change', (e) => {
      windManager.debug = parseInt(e.target.value, 10);
    });
    
    // Initial UI update
    updateWindDirectionArrow();
    updateWindEnabledIndicator();
    
    // Terrain blend controls
    container.querySelector('#object-terrain-blend-enabled').addEventListener('change', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateTerrainBlendSettings(obj.id);
        settings.enabled = e.target.checked;
        const settingsDiv = container.querySelector('#terrain-blend-settings');
        if (settingsDiv) {
          settingsDiv.classList.toggle('disabled', !settings.enabled);
        }
      }
    });
    
    const blendDistSlider = container.querySelector('#terrain-blend-distance');
    const blendDistValue = container.querySelector('#terrain-blend-distance-value');
    blendDistSlider.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getOrCreateTerrainBlendSettings(obj.id);
        settings.blendDistance = parseFloat(e.target.value);
        blendDistValue.textContent = settings.blendDistance.toFixed(1);
      }
    });
  }
  
  function setupLightingControls() {
    const azimuthSlider = container.querySelector('#sun-azimuth');
    const azimuthValue = container.querySelector('#sun-azimuth-value');
    azimuthSlider.addEventListener('input', (e) => {
      lightingManager.sunLight.azimuth = parseFloat(e.target.value);
      azimuthValue.textContent = `${lightingManager.sunLight.azimuth}°`;
    });
    
    const elevationSlider = container.querySelector('#sun-elevation');
    const elevationValue = container.querySelector('#sun-elevation-value');
    elevationSlider.addEventListener('input', (e) => {
      lightingManager.sunLight.elevation = parseFloat(e.target.value);
      elevationValue.textContent = `${lightingManager.sunLight.elevation}°`;
    });
    
    const exposureSlider = container.querySelector('#hdr-exposure');
    const exposureValue = container.querySelector('#hdr-exposure-value');
    exposureSlider.addEventListener('input', (e) => {
      lightingManager.hdrLight.exposure = parseFloat(e.target.value);
      exposureValue.textContent = lightingManager.hdrLight.exposure.toFixed(1);
    });
    
    const shadowCheckbox = container.querySelector('#shadow-enabled');
    shadowCheckbox.addEventListener('change', (e) => {
      lightingManager.shadowEnabled = e.target.checked;
    });
    
    [1024, 2048, 4096].forEach(res => {
      container.querySelector(`#shadow-${res}`).addEventListener('click', () => {
        lightingManager.sunLight.shadowResolution = res;
        shadowRenderer?.setResolution(res);
        container.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
        container.querySelector(`#shadow-${res}`).classList.add('active');
      });
    });
    
    container.querySelector('#shadow-debug').addEventListener('change', (e) => {
      lightingManager.shadowDebug = parseInt(e.target.value, 10);
    });
    
    const shadowThumbnailCheckbox = container.querySelector('#shadow-thumbnail');
    if (shadowThumbnailCheckbox) {
      shadowThumbnailCheckbox.addEventListener('change', (e) => {
        showShadowThumbnail = e.target.checked;
      });
    }
    
    const hdrFile = container.querySelector('#hdr-file');
    hdrFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          const buffer = await file.arrayBuffer();
          const hdrData = parseHDR(buffer);
          
          if (lightingManager.hdrLight.texture) {
            gl.deleteTexture(lightingManager.hdrLight.texture);
          }
          
          const texture = createHDRTexture(gl, hdrData);
          lightingManager.hdrLight.setTexture(texture, file.name);
          container.querySelector('#hdr-filename').textContent = file.name;
          setLightMode('hdr');
        } catch (err) {
          console.error('Failed to load HDR:', err);
          container.querySelector('#hdr-filename').textContent = 'Error loading HDR';
        }
      }
    });
  }
  
  function setupUI() {
    const importBtn = container.querySelector('#import-btn');
    const modelFile = container.querySelector('#model-file');
    importBtn.addEventListener('click', () => modelFile.click());
    modelFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        const { modelPath, displayName } = await importModelFile(file);
        const obj = await scene.addObject(modelPath, displayName);
        if (obj) scene.select(obj.id);
      }
    });
    
    container.querySelector('#preset-models').addEventListener('change', async (e) => {
      if (e.target.value) {
        const obj = await scene.addObject(`/models/${e.target.value}`);
        if (obj) scene.select(obj.id);
        e.target.value = '';
      }
    });
    
    container.querySelector('#object-name').addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj && scene.getSelectionCount() === 1) {
        obj.name = e.target.value || 'Unnamed';
        updateObjectList();
      }
    });
    
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
      
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && scene.getSelectionCount() >= 2) {
        e.preventDefault();
        scene.createGroupFromSelection();
        return;
      }
      
      if ((e.key === 'Delete' || e.key === 'Backspace') && scene.getSelectionCount() > 0 && !uniformScaleActive) {
        e.preventDefault();
        deleteSelectedObjects();
        return;
      }
      
      if ((e.key === 's' || e.key === 'S') && scene.getSelectionCount() === 1 && !transformGizmo.isDragging && !uniformScaleActive) {
        startUniformScale();
        return;
      }
      
      if ((e.key === 'd' || e.key === 'D') && scene.getSelectionCount() > 0 && !uniformScaleActive) {
        duplicateSelectedObject();
        return;
      }
      
      if (!uniformScaleActive) {
        if (e.key === 't' || e.key === 'T') setGizmoMode('translate');
        if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
        if (e.code === 'Numpad0' || e.key === '0') cameraController.setView('home');
        if (e.code === 'Numpad1' || e.key === '1') cameraController.setView('front');
        if (e.code === 'Numpad2' || e.key === '2') cameraController.setView('side');
        if (e.code === 'Numpad3' || e.key === '3') cameraController.setView('top');
      }
    });
    
    // Transform inputs
    ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-x', 'scale-y', 'scale-z'].forEach(inputId => {
      container.querySelector(`#${inputId}`).addEventListener('input', (e) => {
        if (scene.getSelectionCount() !== 1) return;
        const obj = scene.getFirstSelected();
        if (!obj) return;
        
        const value = parseFloat(e.target.value) || 0;
        const [type, axis] = inputId.split('-');
        const axisIndex = { x: 0, y: 1, z: 2 }[axis];
        
        if (type === 'pos') obj.position[axisIndex] = value;
        else if (type === 'rot') obj.rotation[axisIndex] = value;
        else if (type === 'scale') obj.scale[axisIndex] = Math.max(0.01, value);
        
        scene.updateObjectTransform(obj.id);
        updateGizmoTarget();
      });
    });
    
    // Reset buttons
    container.querySelector('#reset-position').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.position = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      updateTransformPanel();
      updateGizmoTarget();
    });
    
    container.querySelector('#reset-rotation').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.rotation = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      updateTransformPanel();
      updateGizmoTarget();
    });
    
    container.querySelector('#reset-scale').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.scale = [1, 1, 1];
        scene.updateObjectTransform(obj.id);
      }
      updateTransformPanel();
      updateGizmoTarget();
    });
    
    container.querySelector('#delete-object').addEventListener('click', deleteSelectedObjects);
    
    // Scene file input handler
    const sceneFile = container.querySelector('#scene-file');
    sceneFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        currentSceneFilename = file.name.replace(/\.json$/i, '');
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const sceneData = JSON.parse(event.target.result);
            await loadSceneData(sceneData);
          } catch (err) {
            console.error('Failed to load scene:', err);
            currentSceneFilename = null;
          }
        };
        reader.readAsText(file);
      }
    });
  }
  
  function deleteSelectedObjects() {
    const ids = [...scene.getSelectedIds()];
    for (const id of ids) {
      scene.removeObject(id);
    }
    scene.clearSelection();
  }
  
  async function duplicateSelectedObject() {
    const obj = scene.getFirstSelected();
    if (!obj) return;
    
    const newObj = await scene.duplicateObject(obj.id);
    if (newObj) scene.select(newObj.id);
  }
  
  async function loadSceneData(sceneData) {
    cameraController.deserialize(parseCameraState(sceneData));
    
    const lightingState = parseLightingState(sceneData);
    if (lightingState) setLightingState(lightingState);
    
    // Load wind settings
    if (sceneData.wind) {
      windManager.deserialize(sceneData.wind);
      // Update UI
      container.querySelector('#wind-enabled').checked = windManager.enabled;
      container.querySelector('#wind-direction').value = windManager.direction;
      container.querySelector('#wind-direction-value').textContent = `${windManager.direction}°`;
      container.querySelector('#wind-strength').value = windManager.strength;
      container.querySelector('#wind-strength-value').textContent = windManager.strength.toFixed(1);
      container.querySelector('#wind-turbulence').value = windManager.turbulence;
      container.querySelector('#wind-turbulence-value').textContent = windManager.turbulence.toFixed(1);
      container.querySelector('#wind-gust-strength').value = windManager.gustStrength;
      container.querySelector('#wind-gust-strength-value').textContent = windManager.gustStrength.toFixed(1);
      updateWindDirectionArrow();
      updateWindEnabledIndicator();
    }
    
    await scene.deserialize({ objects: sceneData.objects, groups: sceneData.groups || [] });
    
    // Load per-object wind settings - array indexed by object order
    objectWindSettings.clear();
    if (sceneData.objectWindSettings && Array.isArray(sceneData.objectWindSettings)) {
      const allObjects = scene.getAllObjects();
      for (let i = 0; i < allObjects.length && i < sceneData.objectWindSettings.length; i++) {
        const settingsData = sceneData.objectWindSettings[i];
        if (settingsData) {
          const settings = deserializeObjectWindSettings(settingsData);
          if (settings) objectWindSettings.set(allObjects[i].id, settings);
        }
      }
    }
    
    updateObjectList();
  }
  
  // ==================== Uniform Scale Mode ====================
  
  function startUniformScale() {
    if (scene.getSelectionCount() !== 1) return;
    const obj = scene.getFirstSelected();
    if (!obj) return;
    
    if (!overlayCanvas.parentNode) viewport.appendChild(overlayCanvas);
    
    uniformScaleActive = true;
    uniformScaleStartScale = [...obj.scale];
    uniformScaleObjectScreenPos = projectToScreen(obj.position, cameraController.getCamera(), CANVAS_WIDTH, CANVAS_HEIGHT);
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
    const obj = scene.getFirstSelected();
    if (!obj || !uniformScaleActive || scene.getSelectionCount() !== 1) return;
    
    const dx = mouseX - uniformScaleObjectScreenPos[0];
    const dy = mouseY - uniformScaleObjectScreenPos[1];
    const scaleFactor = Math.sqrt(dx * dx + dy * dy) / uniformScaleStartDistance;
    
    obj.scale = uniformScaleStartScale.map(s => Math.max(0.01, s * scaleFactor));
    scene.updateObjectTransform(obj.id);
    
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
    const obj = scene.getFirstSelected();
    if (obj && scene.getSelectionCount() === 1) {
      obj.scale = [...uniformScaleStartScale];
      scene.updateObjectTransform(obj.id);
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
    
    animationLoop.start((deltaTime) => {
      const dt = deltaTime / 1000; // Convert to seconds
      
      // Update wind simulation
      windManager.update(dt);
      
      // Update physics for each object with wind settings
      for (const [objId, settings] of objectWindSettings) {
        windManager.updateObjectPhysics(settings, dt);
      }
      
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      const vpMatrix = cameraController.getViewProjectionMatrix();
      const mode = lightingManager.activeMode;
      const allObjects = scene.getAllObjects();
      
      // Shadow pass
      if (mode === 'sun' && lightingManager.shadowEnabled && allObjects.length > 0) {
        const sunDir = lightingManager.sunLight.getDirection();
        const shadowCoverage = 5;
        shadowRenderer.beginShadowPass(sunDir, shadowCoverage);
        
        // Get global wind params for shadow pass
        const windParams = windManager.getShaderUniforms();
        
        for (const obj of allObjects) {
          if (obj.renderer && obj.renderer.gpuMeshes) {
            const modelMatrix = scene.getModelMatrix(obj);
            const objWindSettings = objectWindSettings.get(obj.id) || null;
            shadowRenderer.renderObject(obj.renderer.gpuMeshes, modelMatrix, windParams, objWindSettings);
          }
        }
        
        shadowRenderer.endShadowPass(CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      
      // Depth pre-pass for terrain blend
      // Render all objects except those with terrain blend enabled
      const hasTerrainBlendObjects = Array.from(objectTerrainBlendSettings.values()).some(s => s.enabled);
      const windParamsForPrePass = windManager.getShaderUniforms();
      
      if (hasTerrainBlendObjects && allObjects.length > 1) {
        depthPrePassRenderer.beginPass(vpMatrix);
        
        for (const obj of allObjects) {
          if (obj.renderer && obj.renderer.gpuMeshes) {
            const modelMatrix = scene.getModelMatrix(obj);
            const objWindSettings = objectWindSettings.get(obj.id) || null;
            const terrainSettings = objectTerrainBlendSettings.get(obj.id);
            const isTerrainBlendTarget = terrainSettings?.enabled || false;
            
            depthPrePassRenderer.renderObject(
              obj.renderer.gpuMeshes,
              vpMatrix,
              modelMatrix,
              windParamsForPrePass,
              objWindSettings,
              isTerrainBlendTarget
            );
          }
        }
        
        depthPrePassRenderer.endPass(CANVAS_WIDTH, CANVAS_HEIGHT);
      }
      
      // Sky
      if (mode === 'hdr' && lightingManager.hdrLight.texture) {
        skyRenderer.renderHDRSky(vpMatrix, lightingManager.hdrLight.texture, lightingManager.hdrLight.exposure);
      } else {
        skyRenderer.renderSunSky(lightingManager.sunLight.elevation);
      }
      
      gridRenderer.render(vpMatrix);
      originMarkerRenderer.render(vpMatrix, cameraController.getOriginPosition());
      
      const isWireframe = viewportMode === 'wireframe';
      const lightParams = getLightParams();
      const windParams = windManager.getShaderUniforms();
      
      // Get camera near/far for terrain blend
      const camera = cameraController.getCamera();
      
      for (const obj of allObjects) {
        if (obj.renderer) {
          const objWindSettings = objectWindSettings.get(obj.id) || null;
          const terrainSettings = objectTerrainBlendSettings.get(obj.id);
          
          // Build terrain blend params if enabled for this object
          let terrainBlendParams = null;
          if (terrainSettings?.enabled && hasTerrainBlendObjects) {
            terrainBlendParams = {
              enabled: true,
              blendDistance: terrainSettings.blendDistance,
              depthTexture: depthPrePassRenderer.getDepthTexture(),
              screenSize: [CANVAS_WIDTH, CANVAS_HEIGHT],
              nearPlane: camera.near || 0.1,
              farPlane: camera.far || 100,
            };
          }
          
          obj.renderer.render(vpMatrix, scene.getModelMatrix(obj), scene.isSelected(obj.id), isWireframe, lightParams, windParams, objWindSettings, terrainBlendParams);
        }
      }
      
      transformGizmo.render(vpMatrix);
      
      if (showShadowThumbnail && lightingManager.shadowEnabled && mode === 'sun') {
        shadowRenderer.renderDebugThumbnail(10, 10, 150, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    });
  }
  
  // ==================== Lifecycle ====================
  
  async function init() {
    if (!initGL()) return;
    initCamera();
    initGizmo();
    setupMenuBar();
    setupUI();
    setupLightingControls();
    setupWindControls();
    setupCollapsiblePanels();
    setupEnvironmentTabs();
    
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
    if (depthPrePassRenderer) { depthPrePassRenderer.destroy(); depthPrePassRenderer = null; }
    if (shaderDebugPanel) { shaderDebugPanel.destroy(); shaderDebugPanel = null; }
    if (lightingManager.hdrLight.texture) {
      gl.deleteTexture(lightingManager.hdrLight.texture);
      lightingManager.hdrLight.texture = null;
    }
    if (scene) { scene.destroy(); scene = null; }
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
