import { createSceneGraph } from '../../core/sceneGraph';
import { sceneBuilderStyles, sceneBuilderTemplate } from './styles';
import { saveScene, parseCameraState, parseLightingState, clearImportedModels } from './sceneSerializer';
import { createShaderDebugPanel } from './shaderDebugPanel';
import { createLightingManager } from './lights';
import { createScene } from './scene';
import { createWindManager, serializeObjectWindSettings, deserializeObjectWindSettings } from './wind';
import { createPanelContext, createObjectsPanel, createObjectPanel, createEnvironmentPanel, createMaterialPanel } from './componentPanels';
import { createViewport } from './viewport';

/**
 * Scene Builder Demo - Controller
 * Orchestrates Model (scene) and View (viewport) with UI panels
 */
export function createSceneBuilderDemo(container, options = {}) {
  const { width: CANVAS_WIDTH = 800, height: CANVAS_HEIGHT = 600, onFps = () => {} } = options;
  
  // Create DOM structure
  container.innerHTML = sceneBuilderTemplate;
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = sceneBuilderStyles;
  container.appendChild(style);
  
  // DOM references
  const canvas = container.querySelector('#canvas');
  const viewportContainer = container.querySelector('.scene-builder-viewport');
  viewportContainer.style.position = 'relative';
  
  // ==================== Model Layer ====================
  
  const sceneGraph = createSceneGraph();
  let scene = null;
  
  // Wind system (part of Model)
  const windManager = createWindManager();
  const objectWindSettings = new Map();
  const objectTerrainBlendSettings = new Map();
  
  // Lighting state (part of Model - controls what View renders)
  const lightingManager = createLightingManager();
  
  // ==================== View Layer ====================
  
  let viewport = null;
  let shaderDebugPanel = null;
  
  // ==================== UI Layer ====================
  
  let objectsPanel = null;
  let objectPanel = null;
  let environmentPanel = null;
  let materialPanel = null;
  let panelContext = null;
  
  // Scene file tracking
  let currentSceneFilename = null;
  let gizmoMode = 'translate';
  let viewportMode = 'solid';
  
  // ==================== Viewport Callbacks ====================
  
  function handleGizmoTransform(type, value) {
    scene.applyTransform(type, value);
    objectPanel?.update();
  }
  
  function handleGizmoDragEnd() {
    scene.resetTransformTracking();
  }
  
  function handleUniformScaleChange(newScale) {
    const obj = scene.getFirstSelected();
    if (obj && scene.getSelectionCount() === 1) {
      obj.scale = newScale;
      scene.updateObjectTransform(obj.id);
      objectPanel?.update();
      updateGizmoTarget();
    }
  }
  
  function handleUniformScaleCommit() {
    // Scale committed, nothing special needed
  }
  
  function handleUniformScaleCancel() {
    // Viewport already returned original scale via cancelUniformScale()
    // We need to restore it
  }
  
  function handleObjectClicked(objectId, shiftKey) {
    scene.select(objectId, { additive: shiftKey });
  }
  
  function handleBackgroundClicked(shiftKey) {
    if (!shiftKey) scene.clearSelection();
  }
  
  // ==================== Model → View Sync ====================
  
  function updateGizmoTarget() {
    const target = scene.getGizmoTarget();
    viewport.setGizmoTarget(target.position, target.rotation, target.scale);
    scene.resetTransformTracking();
  }
  
  function updateRenderData() {
    viewport.setRenderData({
      objects: scene.getAllObjects(),
      objectWindSettings,
      objectTerrainBlendSettings,
      selectedIds: scene.getSelectedIds(),
      getModelMatrix: (obj) => scene.getModelMatrix(obj),
    });
  }
  
  function updateLightingState() {
    viewport.setLightingState({
      mode: lightingManager.activeMode,
      shadowEnabled: lightingManager.shadowEnabled,
      sunAzimuth: lightingManager.sunLight.azimuth,
      sunElevation: lightingManager.sunLight.elevation,
      shadowResolution: lightingManager.sunLight.shadowResolution,
      shadowDebug: lightingManager.shadowDebug,
      hdrExposure: lightingManager.hdrLight.exposure,
      lightColor: lightingManager.sunLight.getSunColor(),
      ambient: lightingManager.sunLight.getAmbient(),
    });
  }
  
  function updateWindParams() {
    // Update wind simulation
    windManager.update(0); // Delta time handled internally
    
    // Update physics for each object with wind settings
    for (const [objId, settings] of objectWindSettings) {
      windManager.updateObjectPhysics(settings, 0);
    }
    
    viewport.setWindParams(windManager.getShaderUniforms());
  }
  
  // ==================== Model Event Handlers ====================
  
  function setupModelEvents() {
    scene.onSelectionChanged = () => {
      objectsPanel?.update();
      objectPanel?.update();
      materialPanel?.update();
      updateGizmoTarget();
      updateRenderData();
    };
    
    scene.onObjectAdded = () => {
      objectsPanel?.update();
      updateRenderData();
    };
    
    scene.onObjectRemoved = () => {
      objectsPanel?.update();
      updateRenderData();
    };
    
    scene.onGroupChanged = () => {
      objectsPanel?.update();
      updateRenderData();
    };
  }
  
  // ==================== Gizmo Mode ====================
  
  function setGizmoMode(mode) {
    gizmoMode = mode;
    viewport.setGizmoMode(mode);
    objectPanel?.setGizmoMode(mode);
  }
  
  // ==================== Uniform Scale ====================
  
  function startUniformScale() {
    if (scene.getSelectionCount() !== 1) return;
    const obj = scene.getFirstSelected();
    if (!obj) return;
    
    const objectScreenPos = viewport.projectObjectToScreen(obj.position);
    const mousePos = viewport.getLastMousePos();
    viewport.startUniformScale([...obj.scale], objectScreenPos, mousePos);
  }
  
  function cancelUniformScale() {
    const obj = scene.getFirstSelected();
    if (obj && scene.getSelectionCount() === 1) {
      const originalScale = viewport.cancelUniformScale();
      obj.scale = [...originalScale];
      scene.updateObjectTransform(obj.id);
      objectPanel?.update();
      updateGizmoTarget();
    } else {
      viewport.cancelUniformScale();
    }
  }
  
  // ==================== Viewport Mode ====================
  
  function setViewportMode(mode) {
    viewportMode = mode;
    viewport.setViewportMode(mode);
    container.querySelector('#viewport-solid-btn').classList.toggle('active', mode === 'solid');
    container.querySelector('#viewport-wireframe-btn').classList.toggle('active', mode === 'wireframe');
  }
  
  // ==================== Lighting ====================
  
  function setLightMode(mode) {
    lightingManager.setMode(mode);
    updateLightingState();
    environmentPanel?.updateLightModeDisplay(mode);
  }
  
  function getLightingState() {
    const state = lightingManager.serialize();
    state.hdr.filename = container.querySelector('#hdr-filename')?.textContent || null;
    return state;
  }
  
  function setLightingStateFromLoad(state) {
    if (!state) return;
    lightingManager.deserialize(state);
    updateLightingState();
    viewport.setShadowResolution(lightingManager.sunLight.shadowResolution);
    setLightMode(lightingManager.activeMode);
    environmentPanel?.update();
    
    if (lightingManager.hdrLight.filename && lightingManager.hdrLight.filename !== 'No HDR loaded') {
      environmentPanel?.setHDRFilename(`${lightingManager.hdrLight.filename} (reload required)`);
    }
  }
  
  // ==================== Menu Bar ====================
  
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
      viewport.resetCameraOrigin();
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
    
    // Grid and axes toggle
    let showGrid = true;
    let showAxes = true;
    
    container.querySelector('#menu-toggle-grid').addEventListener('click', () => {
      showGrid = !showGrid;
      viewport.setShowGrid(showGrid);
      container.querySelector('#menu-toggle-grid').textContent = (showGrid ? '✓ ' : '  ') + 'Show Grid';
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-toggle-axes').addEventListener('click', () => {
      showAxes = !showAxes;
      viewport.setShowAxes(showAxes);
      container.querySelector('#menu-toggle-axes').textContent = (showAxes ? '✓ ' : '  ') + 'Show Axes';
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#viewport-solid-btn').addEventListener('click', () => setViewportMode('solid'));
    container.querySelector('#viewport-wireframe-btn').addEventListener('click', () => setViewportMode('wireframe'));
    
    container.querySelector('#menu-save-scene').addEventListener('click', () => {
      const sceneData = scene.serialize();
      sceneData.wind = windManager.serialize();
      sceneData.objectWindSettings = [];
      sceneData.objectTerrainBlendSettings = [];
      const allObjects = scene.getAllObjects();
      for (let i = 0; i < allObjects.length; i++) {
        const obj = allObjects[i];
        const windSettings = objectWindSettings.get(obj.id);
        sceneData.objectWindSettings.push(windSettings ? serializeObjectWindSettings(windSettings) : null);
        
        const terrainSettings = objectTerrainBlendSettings.get(obj.id);
        sceneData.objectTerrainBlendSettings.push(terrainSettings ? { ...terrainSettings } : null);
      }
      const savedFilename = saveScene(
        sceneData.objects,
        viewport.getCameraState(),
        getLightingState(),
        currentSceneFilename,
        new Map(),
        sceneData.wind,
        sceneData.objectWindSettings,
        sceneData.groups,
        sceneData.objectTerrainBlendSettings
      );
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
      environmentPanel?.openHDRFilePicker();
    });
    
    // Scene > Add > Shapes menu
    container.querySelector('#menu-add-cube')?.addEventListener('click', () => {
      const obj = scene.addPrimitive('cube');
      if (obj) {
        scene.select(obj.id);
        objectsPanel?.update();
        objectPanel?.update();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-add-plane')?.addEventListener('click', () => {
      const obj = scene.addPrimitive('plane');
      if (obj) {
        scene.select(obj.id);
        objectsPanel?.update();
        objectPanel?.update();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    container.querySelector('#menu-add-uvsphere')?.addEventListener('click', () => {
      const obj = scene.addPrimitive('sphere');
      if (obj) {
        scene.select(obj.id);
        objectsPanel?.update();
        objectPanel?.update();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Scene > Group Selection
    container.querySelector('#menu-group')?.addEventListener('click', () => {
      if (scene.getSelectionCount() >= 2) {
        scene.createGroupFromSelection();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Scene > Ungroup
    container.querySelector('#menu-ungroup')?.addEventListener('click', () => {
      if (scene.getSelectionCount() > 0) {
        scene.ungroupSelection();
      }
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
  
  // ==================== Keyboard Shortcuts ====================
  
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      
      if (e.key === 'Escape' && viewport.isUniformScaleActive()) {
        cancelUniformScale();
        return;
      }

      if (e.key === 'a' || e.key === 'A') {
        scene.toggleSelectAllObjects();
        return;
      }

      // Ctrl/Cmd+G - Group selection
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && !e.shiftKey && scene.getSelectionCount() >= 2) {
        e.preventDefault();
        scene.createGroupFromSelection();
        return;
      }
      
      // Ctrl/Cmd+Shift+G - Ungroup selection
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && e.shiftKey && scene.getSelectionCount() > 0) {
        e.preventDefault();
        scene.ungroupSelection();
        return;
      }
      
      if ((e.key === 'Delete' || e.key === 'Backspace') && scene.getSelectionCount() > 0 && !viewport.isUniformScaleActive()) {
        e.preventDefault();
        deleteSelectedObjects();
        return;
      }
      
      if ((e.key === 's' || e.key === 'S') && scene.getSelectionCount() === 1 && !viewport.isGizmoDragging() && !viewport.isUniformScaleActive()) {
        startUniformScale();
        return;
      }
      
      if ((e.key === 'd' || e.key === 'D') && scene.getSelectionCount() > 0 && !viewport.isUniformScaleActive()) {
        duplicateSelectedObject();
        return;
      }
      
      if (!viewport.isUniformScaleActive()) {
        if (e.key === 't' || e.key === 'T') setGizmoMode('translate');
        if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
        if (e.code === 'Numpad0' || e.key === '0') viewport.setCameraView('home');
        if (e.code === 'Numpad1' || e.key === '1') viewport.setCameraView('front');
        if (e.code === 'Numpad2' || e.key === '2') viewport.setCameraView('side');
        if (e.code === 'Numpad3' || e.key === '3') viewport.setCameraView('top');
      }
    });
  }
  
  // ==================== Scene File Handling ====================
  
  function setupSceneFileInput() {
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
  
  async function loadSceneData(sceneData) {
    viewport.setCameraState(parseCameraState(sceneData));
    
    const lightingState = parseLightingState(sceneData);
    if (lightingState) setLightingStateFromLoad(lightingState);
    
    if (sceneData.wind) {
      windManager.deserialize(sceneData.wind);
      viewport.setWindParams(windManager.getShaderUniforms());
    }
    
    await scene.deserialize({ objects: sceneData.objects, groups: sceneData.groups || [] });
    
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
    
    objectTerrainBlendSettings.clear();
    if (sceneData.objectTerrainBlendSettings && Array.isArray(sceneData.objectTerrainBlendSettings)) {
      const allObjects = scene.getAllObjects();
      for (let i = 0; i < allObjects.length && i < sceneData.objectTerrainBlendSettings.length; i++) {
        const settingsData = sceneData.objectTerrainBlendSettings[i];
        if (settingsData) {
          objectTerrainBlendSettings.set(allObjects[i].id, { ...settingsData });
        }
      }
    }
    
    objectsPanel?.update();
    objectPanel?.update();
    environmentPanel?.update();
    updateRenderData();
  }
  
  // ==================== Object Operations ====================
  
  function deleteSelectedObjects() {
    const ids = [...scene.getSelectedIds()];
    
    // Remove objects - callbacks will fire for each, but we also ensure
    // a final sync after all deletions are complete
    for (const id of ids) {
      // Clean up per-object settings before removal
      objectWindSettings.delete(id);
      objectTerrainBlendSettings.delete(id);
      scene.removeObject(id);
    }
    
    scene.clearSelection();
    
    // Ensure render data is synchronized immediately after all deletions
    // This prevents the render loop from accessing stale object references
    updateRenderData();
  }
  
  async function duplicateSelectedObject() {
    const obj = scene.getFirstSelected();
    if (!obj) return;
    
    const newObj = await scene.duplicateObject(obj.id);
    if (newObj) scene.select(newObj.id);
  }
  
  // ==================== Lifecycle ====================
  
  async function init() {
    // Create viewport (View) with callbacks
    viewport = createViewport(canvas, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      onFps,
      onUpdate: (dt) => {
        // Update wind simulation and physics each frame
        windManager.update(dt);
        for (const [objId, settings] of objectWindSettings) {
          windManager.updateObjectPhysics(settings, dt);
        }
        // Sync updated wind params to viewport
        viewport.setWindParams(windManager.getShaderUniforms());
      },
      onGizmoTransform: handleGizmoTransform,
      onGizmoDragEnd: handleGizmoDragEnd,
      onUniformScaleChange: handleUniformScaleChange,
      onUniformScaleCommit: handleUniformScaleCommit,
      onUniformScaleCancel: handleUniformScaleCancel,
      onObjectClicked: handleObjectClicked,
      onBackgroundClicked: handleBackgroundClicked,
    });
    
    if (!viewport.init()) return;
    
    viewport.setOverlayContainer(viewportContainer);
    viewport.setSceneGraph(sceneGraph);
    
    // Create scene (Model)
    const gl = viewport.getGL();
    scene = createScene(gl, sceneGraph);
    setupModelEvents();
    
    // Setup UI (Controller)
    setupMenuBar();
    setupKeyboardShortcuts();
    setupSceneFileInput();
    
    // Create panel context
    panelContext = createPanelContext({
      container,
      scene,
      gl,
      windManager,
      lightingManager,
      shadowRenderer: null, // Viewport manages this now
      cameraController: null, // Viewport manages this now
      objectWindSettings,
      objectTerrainBlendSettings,
      onGizmoModeChange: setGizmoMode,
      onTransformUpdate: updateGizmoTarget,
      onObjectListUpdate: () => objectsPanel?.update(),
      onSelectionChanged: () => {
        objectsPanel?.update();
        objectPanel?.update();
        materialPanel?.update();
        updateGizmoTarget();
        updateRenderData();
      },
      setShadowResolution: (res) => {
        lightingManager.sunLight.shadowResolution = res;
        viewport.setShadowResolution(res);
      },
      setShowShadowThumbnail: (show) => viewport.setShowShadowThumbnail(show),
      setLightMode,
      setHDRTexture: (texture, mipLevels = 6) => {
        lightingManager.hdrLight.texture = texture;
        viewport.setHDRTexture(texture, mipLevels);
      },
      onWindChanged: () => {
        viewport.setWindParams(windManager.getShaderUniforms());
      },
      onLightingChanged: () => {
        updateLightingState();
      },
    });
    
    // Instantiate panels
    objectsPanel = createObjectsPanel(
      container.querySelector('#objects-panel-container'),
      panelContext
    );
    
    objectPanel = createObjectPanel(
      container.querySelector('#object-panel-container'),
      panelContext
    );
    
    environmentPanel = createEnvironmentPanel(
      container.querySelector('#environment-panel-container'),
      panelContext
    );
    
    // Create material panel context with required callbacks
    const materialPanelContext = {
      getSelectedObjects: () => {
        return scene.getSelectedObjects();
      },
      getObjectMaterial: (objId) => {
        const obj = scene.getObject(objId);
        if (obj && obj.type === 'primitive' && obj.renderer) {
          return obj.renderer.getMaterial();
        }
        return null;
      },
      setObjectMaterial: (objId, material) => {
        const obj = scene.getObject(objId);
        if (obj && obj.type === 'primitive' && obj.renderer) {
          obj.renderer.setMaterial(material);
        }
      },
      onMaterialChange: () => {
        // Material changed - could trigger any needed updates
      },
    };
    
    materialPanel = createMaterialPanel(
      container.querySelector('#material-panel-container'),
      materialPanelContext
    );
    
    shaderDebugPanel = createShaderDebugPanel(viewportContainer);
    
    // Initial sync
    updateLightingState();
    viewport.setWindParams(windManager.getShaderUniforms());
    updateRenderData();
  }
  
  function destroy() {
    if (viewport) { viewport.destroy(); viewport = null; }
    if (shaderDebugPanel) { shaderDebugPanel.destroy(); shaderDebugPanel = null; }
    
    if (objectsPanel) { objectsPanel.destroy(); objectsPanel = null; }
    if (objectPanel) { objectPanel.destroy(); objectPanel = null; }
    if (environmentPanel) { environmentPanel.destroy(); environmentPanel = null; }
    if (materialPanel) { materialPanel.destroy(); materialPanel = null; }
    panelContext = null;
    
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
