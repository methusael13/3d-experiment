import { createAnimationLoop } from '../../core/animationLoop';
import { 
  createGridRenderer, 
  createOriginMarkerRenderer, 
  createSkyRenderer,
  createShadowRenderer,
  createDepthPrePassRenderer,
} from '../../core/renderers';
import { createTransformGizmo } from './gizmos';
import { createCameraController } from './cameraController';
import { screenToRay, projectToScreen } from '../../core/utils/raycastUtils';

/**
 * Viewport - The View in MVC
 * Handles all WebGL rendering, camera control, and 3D input
 * Communicates with Controller via pure callbacks
 */
export function createViewport(canvasElement, options = {}) {
  const {
    width = 800,
    height = 600,
    // Callbacks - all optional, Controller wires these up
    onFps = () => {},
    onUpdate = (deltaTime) => {},  // Called each frame for wind physics etc.
    onGizmoTransform = (type, value) => {},
    onGizmoDragEnd = () => {},
    onUniformScaleChange = (newScale) => {},
    onUniformScaleCommit = () => {},
    onUniformScaleCancel = () => {},
    onObjectClicked = (objectId, shiftKey) => {},
    onBackgroundClicked = (shiftKey) => {},
  } = options;
  
  // Device pixel ratio for HiDPI displays
  const dpr = window.devicePixelRatio || 1;
  
  // Logical (CSS) dimensions
  const CANVAS_WIDTH = width;
  const CANVAS_HEIGHT = height;
  
  // Physical (rendering) dimensions
  const RENDER_WIDTH = Math.floor(width * dpr);
  const RENDER_HEIGHT = Math.floor(height * dpr);
  
  // WebGL context and renderers
  let gl = null;
  let gridRenderer = null;
  let originMarkerRenderer = null;
  let skyRenderer = null;
  let shadowRenderer = null;
  let depthPrePassRenderer = null;
  let transformGizmo = null;
  let cameraController = null;
  let animationLoop = null;
  
  // Overlay container (for gizmo 2D overlays)
  let overlayContainer = null;
  
  // State provided by Controller
  let sceneGraph = null;  // For raycasting
  let renderData = {
    objects: [],
    objectWindSettings: new Map(),
    objectTerrainBlendSettings: new Map(),
    selectedIds: new Set(),
    getModelMatrix: () => null,
  };
  
  // Lighting params (pre-computed by LightingManager, passed by Controller)
  // This is a SceneLightingParams object with type, direction, effectiveColor, etc.
  let lightParams = null;
  
  // Additional lighting state that viewport manages
  let lightingState = {
    shadowEnabled: true,
    shadowResolution: 2048,
    sunElevation: 45,     // Needed for sky renderer
    hdrTexture: null,
    hdrExposure: 1.0,
    hdrMaxMipLevel: 6.0,
  };
  
  // Wind state (controlled by Controller)
  // Note: direction is a 2D vector [x, z], not degrees
  let windParams = {
    enabled: false,
    direction: [0.707, 0.707],  // 2D normalized vector
    strength: 0.5,
    turbulence: 0.5,
    gustStrength: 0.3,
    time: 0,
    debug: 0,
  };
  
  // Viewport state
  let viewportMode = 'solid';
  let showShadowThumbnail = false;
  let gizmoMode = 'translate';
  let showGrid = true;
  let showAxes = true;
  
  // Mouse tracking for uniform scale
  let lastKnownMousePos = [0, 0];
  
  // ==================== GL Initialization ====================
  
  function initGL() {
    gl = canvasElement.getContext('webgl2', { antialias: true });
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
    shadowRenderer = createShadowRenderer(gl, lightingState.shadowResolution);
    depthPrePassRenderer = createDepthPrePassRenderer(gl, RENDER_WIDTH, RENDER_HEIGHT);
    
    return true;
  }
  
  // ==================== Camera ====================
  
  function initCamera() {
    cameraController = createCameraController({
      canvas: canvasElement,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    });
    
    // Set up input handling with gizmo integration
    cameraController.setupEventListeners({
      onGizmoCheck: () => transformGizmo?.isDragging || transformGizmo?.isUniformScaleActive,
      onGizmoMouseDown: (x, y) => {
        if (transformGizmo?.isUniformScaleActive) {
          commitUniformScale();
          return true;
        }
        return transformGizmo?.handleMouseDown(x, y, CANVAS_WIDTH, CANVAS_HEIGHT);
      },
      onGizmoMouseMove: (x, y) => {
        lastKnownMousePos = [x, y];
        if (transformGizmo?.isUniformScaleActive) {
          handleUniformScaleMove(x, y);
          return;
        }
        transformGizmo?.handleMouseMove(x, y);
      },
      onGizmoMouseUp: () => {
        transformGizmo?.handleMouseUp();
        onGizmoDragEnd();
      },
      onClick: handleCanvasClick,
    });
    
    // Track mouse position for uniform scale
    canvasElement.addEventListener('mousemove', (e) => {
      const rect = canvasElement.getBoundingClientRect();
      lastKnownMousePos = [e.clientX - rect.left, e.clientY - rect.top];
      
      if (transformGizmo?.isUniformScaleActive) {
        handleUniformScaleMove(lastKnownMousePos[0], lastKnownMousePos[1]);
      }
    });
  }
  
  // ==================== Gizmo ====================
  
  function initGizmo() {
    transformGizmo = createTransformGizmo(gl, cameraController.getCamera());
    transformGizmo.setOnChange((type, value) => {
      onGizmoTransform(type, value);
    });
    if (overlayContainer) {
      transformGizmo.setOverlayContainer(overlayContainer);
    }
    transformGizmo.setCanvasSize(CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  
  // ==================== Input Handling ====================
  
  function handleCanvasClick(screenX, screenY, shiftKey = false) {
    if (!sceneGraph || sceneGraph.size === 0) {
      onBackgroundClicked(shiftKey);
      return;
    }
    
    const camera = cameraController.getCamera();
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera, CANVAS_WIDTH, CANVAS_HEIGHT);
    const hit = sceneGraph.castRay(rayOrigin, rayDir);
    
    if (hit) {
      onObjectClicked(hit.node.id, shiftKey);
    } else {
      onBackgroundClicked(shiftKey);
    }
  }
  
  // ==================== Uniform Scale ====================
  
  function handleUniformScaleMove(mouseX, mouseY) {
    if (!transformGizmo?.isUniformScaleActive) return;
    
    const newScale = transformGizmo.updateUniformScale(mouseX, mouseY);
    if (newScale) {
      onUniformScaleChange(newScale);
    }
  }
  
  function commitUniformScale() {
    transformGizmo.commitUniformScale();
    onUniformScaleCommit();
  }
  
  // ==================== Lighting Helpers ====================
  
  /**
   * Get complete light params for rendering.
   * Merges pre-computed lightParams from LightingManager with viewport-managed state.
   */
  function getCompleteLightParams() {
    const cameraPos = cameraController.getCamera().getPosition();
    
    if (!lightParams) {
      // Fallback if no light params set yet
      return {
        type: 'directional',
        direction: [0.5, 0.707, 0.5],
        effectiveColor: [1, 1, 1],
        ambient: 0.3,
        shadowEnabled: lightingState.shadowEnabled,
        lightSpaceMatrix: shadowRenderer ? shadowRenderer.getLightSpaceMatrix() : null,
        shadowMap: shadowRenderer ? shadowRenderer.getTexture() : null,
        cameraPos,
      };
    }
    
    // Merge pre-computed lightParams with shadow renderer state and camera position
    return {
      ...lightParams,
      // Override shadow map/matrix from viewport's shadow renderer
      shadowEnabled: lightParams.shadowEnabled && lightingState.shadowEnabled,
      lightSpaceMatrix: shadowRenderer ? shadowRenderer.getLightSpaceMatrix() : lightParams.lightSpaceMatrix,
      shadowMap: shadowRenderer ? shadowRenderer.getTexture() : lightParams.shadowMap,
      // Override HDR texture from viewport state if in HDR mode
      hdrTexture: lightParams.type === 'hdr' ? lightingState.hdrTexture : null,
      // Add camera position
      cameraPos,
    };
  }
  
  /**
   * Get sun direction from pre-computed lightParams (for shadow pass)
   */
  function getSunDirection() {
    if (lightParams && lightParams.type === 'directional' && lightParams.direction) {
      return [...lightParams.direction];
    }
    // Fallback
    return [0.5, 0.707, 0.5];
  }
  
  // ==================== Render Loop ====================
  
  function startRendering() {
    if (animationLoop) animationLoop.stop();
    
    animationLoop = createAnimationLoop({ onFps });
    
    animationLoop.start((deltaTime) => {
      render(deltaTime);
    });
  }
  
  function render(deltaTime) {
    const dt = deltaTime / 1000;
    
    // Let controller update wind physics
    onUpdate(dt);
    
    // Update wind time
    windParams.time += dt;
    
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    const vpMatrix = cameraController.getViewProjectionMatrix();
    const allObjects = renderData.objects;
    
    // Shadow pass (only for directional light mode with shadows enabled)
    const isDirectionalMode = !lightParams || lightParams.type === 'directional';
    if (isDirectionalMode && lightingState.shadowEnabled && allObjects.length > 0) {
      const sunDir = getSunDirection();
      const shadowCoverage = 5;
      shadowRenderer.beginShadowPass(sunDir, shadowCoverage);
      
      for (const obj of allObjects) {
        // Safety check: ensure renderer has valid gpuMeshes (not destroyed)
        if (obj.renderer && obj.renderer.gpuMeshes && obj.renderer.gpuMeshes.length > 0) {
          const modelMatrix = renderData.getModelMatrix(obj);
          if (modelMatrix) {
            const objWindSettings = renderData.objectWindSettings.get(obj.id) || null;
            shadowRenderer.renderObject(obj.renderer.gpuMeshes, modelMatrix, windParams, objWindSettings);
          }
        }
      }
      
      shadowRenderer.endShadowPass(RENDER_WIDTH, RENDER_HEIGHT);
    }
    
    // Depth pre-pass for terrain blend
    const hasTerrainBlendObjects = Array.from(renderData.objectTerrainBlendSettings.values()).some(s => s.enabled);
    
    if (hasTerrainBlendObjects && allObjects.length > 1) {
      depthPrePassRenderer.beginPass(vpMatrix);
      
      for (const obj of allObjects) {
        // Safety check: ensure renderer has valid gpuMeshes (not destroyed)
        if (obj.renderer && obj.renderer.gpuMeshes && obj.renderer.gpuMeshes.length > 0) {
          const modelMatrix = renderData.getModelMatrix(obj);
          const objWindSettings = renderData.objectWindSettings.get(obj.id) || null;
          const terrainSettings = renderData.objectTerrainBlendSettings.get(obj.id);
          const isTerrainBlendTarget = terrainSettings?.enabled || false;
          
          if (modelMatrix) {
            depthPrePassRenderer.renderObject(
              obj.renderer.gpuMeshes,
              vpMatrix,
              modelMatrix,
              windParams,
              objWindSettings,
              isTerrainBlendTarget
            );
          }
        }
      }
      
      depthPrePassRenderer.endPass(RENDER_WIDTH, RENDER_HEIGHT);
    }
    
    // Sky
    const isHDRMode = lightParams && lightParams.type === 'hdr';
    if (isHDRMode && lightingState.hdrTexture) {
      skyRenderer.renderHDRSky(vpMatrix, lightingState.hdrTexture, lightingState.hdrExposure);
    } else {
      skyRenderer.renderSunSky(lightingState.sunElevation);
    }
    
    // Render grid and axes (combined in gridRenderer)
    if (showGrid || showAxes) {
      gridRenderer.render(vpMatrix, { showGrid, showAxes });
    }
    
    // Origin marker is always shown when axes are visible
    if (showAxes) {
      originMarkerRenderer.render(vpMatrix, cameraController.getOriginPosition());
    }
    
    const isWireframe = viewportMode === 'wireframe';
    const completeLightParams = getCompleteLightParams();
    const camera = cameraController.getCamera();
    
    for (const obj of allObjects) {
      // Safety check: ensure renderer and its GPU meshes still exist
      if (obj.renderer && obj.renderer.gpuMeshes) {
        const objWindSettings = renderData.objectWindSettings.get(obj.id) || null;
        const terrainSettings = renderData.objectTerrainBlendSettings.get(obj.id);
        
        let terrainBlendParams = null;
        if (terrainSettings?.enabled && hasTerrainBlendObjects) {
          terrainBlendParams = {
            enabled: true,
            blendDistance: terrainSettings.blendDistance,
            depthTexture: depthPrePassRenderer.getDepthTexture(),
            screenSize: [RENDER_WIDTH, RENDER_HEIGHT],
            nearPlane: camera.near || 0.1,
            farPlane: camera.far || 100,
          };
        }
        
        const isSelected = renderData.selectedIds.has(obj.id);
        const modelMatrix = renderData.getModelMatrix(obj);
        
        if (modelMatrix) {
          obj.renderer.render(vpMatrix, modelMatrix, isSelected, isWireframe, completeLightParams, windParams, objWindSettings, terrainBlendParams);
          
          // Render normal debug lines if enabled
          if (obj.showNormals && obj.renderer.renderNormals) {
            obj.renderer.renderNormals(vpMatrix, modelMatrix);
          }
        }
      }
    }
    
    transformGizmo.render(vpMatrix);
    
    if (showShadowThumbnail && lightingState.shadowEnabled && isDirectionalMode) {
      shadowRenderer.renderDebugThumbnail(10 * dpr, 10 * dpr, 150 * dpr, RENDER_WIDTH, RENDER_HEIGHT);
    }
  }
  
  // ==================== Public API ====================
  
  function init() {
    // Set physical canvas size (high resolution for HiDPI)
    canvasElement.width = RENDER_WIDTH;
    canvasElement.height = RENDER_HEIGHT;
    
    // Set CSS display size (logical pixels)
    canvasElement.style.width = CANVAS_WIDTH + 'px';
    canvasElement.style.height = CANVAS_HEIGHT + 'px';
    
    if (!initGL()) return false;
    initCamera();
    initGizmo();
    startRendering();
    return true;
  }
  
  function destroy() {
    if (animationLoop) { animationLoop.stop(); animationLoop = null; }
    if (gridRenderer) { gridRenderer.destroy(); gridRenderer = null; }
    if (originMarkerRenderer) { originMarkerRenderer.destroy(); originMarkerRenderer = null; }
    if (transformGizmo) { transformGizmo.destroy(); transformGizmo = null; }
    if (skyRenderer) { skyRenderer.destroy(); skyRenderer = null; }
    if (shadowRenderer) { shadowRenderer.destroy(); shadowRenderer = null; }
    if (depthPrePassRenderer) { depthPrePassRenderer.destroy(); depthPrePassRenderer = null; }
    if (lightingState.hdrTexture) {
      gl.deleteTexture(lightingState.hdrTexture);
      lightingState.hdrTexture = null;
    }
  }
  
  // ==================== State Setters (Controller calls these) ====================
  
  function setOverlayContainer(container) {
    overlayContainer = container;
    if (transformGizmo) {
      transformGizmo.setOverlayContainer(container);
    }
  }
  
  function setSceneGraph(sg) {
    sceneGraph = sg;
  }
  
  function setRenderData(data) {
    renderData = {
      objects: data.objects || [],
      objectWindSettings: data.objectWindSettings || new Map(),
      objectTerrainBlendSettings: data.objectTerrainBlendSettings || new Map(),
      selectedIds: data.selectedIds || new Set(),
      getModelMatrix: data.getModelMatrix || (() => null),
    };
  }
  
  function setGizmoTarget(position, rotation, scale) {
    if (!position) {
      transformGizmo.setEnabled(false);
      return;
    }
    transformGizmo.setEnabled(true);
    transformGizmo.setTarget(position, rotation, scale);
  }
  
  function setGizmoEnabled(enabled) {
    transformGizmo.setEnabled(enabled);
  }
  
  function setGizmoMode(mode) {
    gizmoMode = mode;
    transformGizmo.setMode(mode);
  }
  
  function setViewportMode(mode) {
    viewportMode = mode;
  }
  
  function setLightingState(state) {
    Object.assign(lightingState, state);
    if (state.shadowResolution && shadowRenderer) {
      shadowRenderer.setResolution(state.shadowResolution);
    }
  }
  
  /**
   * Set pre-computed light params from LightingManager.
   * This is the primary way to update lighting - pass the result of lightingManager.getLightParams()
   */
  function setLightParams(params) {
    lightParams = params;
    
    // Also extract values needed for viewport-specific rendering (sky, etc.)
    if (params) {
      if (params.type === 'directional' && params.elevation !== undefined) {
        lightingState.sunElevation = params.elevation;
      }
      if (params.shadowEnabled !== undefined) {
        lightingState.shadowEnabled = params.shadowEnabled;
      }
    }
  }
  
  function setWindParams(params) {
    // Preserve time, merge new params
    const currentTime = windParams.time;
    
    // Merge params, handling direction specially
    if (params) {
      windParams.enabled = params.enabled ?? windParams.enabled;
      windParams.strength = params.strength ?? windParams.strength;
      windParams.turbulence = params.turbulence ?? windParams.turbulence;
      windParams.gustStrength = params.gustStrength ?? windParams.gustStrength;
      windParams.debug = params.debug ?? windParams.debug;
      
      // Direction must be a 2D vector array
      if (Array.isArray(params.direction)) {
        windParams.direction = params.direction;
      }
    }
    
    windParams.time = currentTime;
  }
  
  function setShowShadowThumbnail(show) {
    showShadowThumbnail = show;
  }
  
  function setShowGrid(show) {
    showGrid = show;
  }
  
  function setShowAxes(show) {
    showAxes = show;
  }
  
  function setShadowResolution(res) {
    lightingState.shadowResolution = res;
    shadowRenderer?.setResolution(res);
  }
  
  function setHDRTexture(texture, maxMipLevel = 6) {
    if (lightingState.hdrTexture) {
      gl.deleteTexture(lightingState.hdrTexture);
    }
    lightingState.hdrTexture = texture;
    lightingState.hdrMaxMipLevel = maxMipLevel;
  }
  
  // Uniform scale - Controller initiates this
  function startUniformScale(startScale, objectScreenPos, mousePos) {
    transformGizmo.startUniformScale(startScale, objectScreenPos, mousePos);
  }
  
  function cancelUniformScale() {
    const originalScale = transformGizmo.cancelUniformScale();
    onUniformScaleCancel();
    return originalScale;
  }
  
  // Camera state
  function getCameraState() {
    return cameraController.serialize();
  }
  
  function setCameraState(state) {
    cameraController.deserialize(state);
  }
  
  function resetCameraOrigin() {
    cameraController.resetOrigin();
  }
  
  function setCameraView(view) {
    cameraController.setView(view);
  }
  
  // For uniform scale - project object position to screen
  function projectObjectToScreen(position) {
    return projectToScreen(position, cameraController.getCamera(), CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  
  function getLastMousePos() {
    return [...lastKnownMousePos];
  }
  
  function getGL() {
    return gl;
  }
  
  // Query state
  function isUniformScaleActive() {
    return transformGizmo?.isUniformScaleActive || false;
  }
  
  function isGizmoDragging() {
    return transformGizmo?.isDragging || false;
  }
  
  return {
    // Lifecycle
    init,
    destroy,
    
    // Setup
    setOverlayContainer,
    setSceneGraph,
    
    // Render data (updated each frame by Controller)
    setRenderData,
    
    // Gizmo control
    setGizmoTarget,
    setGizmoEnabled,
    setGizmoMode,
    
    // Viewport settings
    setViewportMode,
    setLightingState,
    setLightParams,
    setWindParams,
    setShowShadowThumbnail,
    setShowGrid,
    setShowAxes,
    setShadowResolution,
    setHDRTexture,
    
    // Uniform scale
    startUniformScale,
    cancelUniformScale,
    isUniformScaleActive,
    isGizmoDragging,
    
    // Camera
    getCameraState,
    setCameraState,
    resetCameraOrigin,
    setCameraView,
    
    // Utilities
    projectObjectToScreen,
    getLastMousePos,
    getGL,
  };
}
