/**
 * Panel Context Factory
 * Creates a context object that panels use to interact with scene state
 */

/**
 * @typedef {Object} PanelContext
 * @property {HTMLElement} container - The main container element
 * @property {Object} scene - The scene manager
 * @property {WebGL2RenderingContext} gl - WebGL context
 * @property {Object} windManager - Wind system manager
 * @property {Object} lightingManager - Lighting system manager
 * 
 * @property {Function} getObjectWindSettings - Get wind settings for an object
 * @property {Function} setObjectWindSettings - Set wind settings for an object
 * @property {Function} getObjectTerrainBlend - Get terrain blend settings for an object
 * @property {Function} setObjectTerrainBlend - Set terrain blend settings for an object
 * 
 * @property {Function} onGizmoModeChange - Callback when gizmo mode changes
 * @property {Function} onTransformUpdate - Callback to refresh transform panel/gizmo
 * @property {Function} onObjectListUpdate - Callback to refresh object list
 * @property {Function} setShadowResolution - Set shadow map resolution
 * @property {Function} loadHDRTexture - Load an HDR texture file
 */

/**
 * Creates a panel context object
 * @param {Object} config - Configuration object
 * @returns {PanelContext}
 */
export function createPanelContext(config) {
  const {
    container,
    scene,
    gl,
    windManager,
    lightingManager,
    shadowRenderer,
    cameraController,
    
    // Per-object settings storage (Maps)
    objectWindSettings,
    objectTerrainBlendSettings,
    
    // Callbacks
    onGizmoModeChange,
    onGizmoOrientationChange,
    onTransformUpdate,
    onObjectListUpdate,
    onSelectionChanged,
    setShadowResolution,
    setShowShadowThumbnail,
    setLightMode,
    loadHDRTexture,
    setHDRTexture,
    onWindChanged,
    onLightingChanged,
  } = config;
  
  return {
    // Core references
    container,
    scene,
    gl,
    windManager,
    lightingManager,
    shadowRenderer,
    cameraController,
    
    // Object wind settings accessors
    getObjectWindSettings: (objectId) => {
      if (!objectWindSettings.has(objectId)) {
        objectWindSettings.set(objectId, windManager.createObjectWindSettings());
      }
      return objectWindSettings.get(objectId);
    },
    
    setObjectWindSettings: (objectId, settings) => {
      objectWindSettings.set(objectId, settings);
    },
    
    // Object terrain blend settings accessors
    getObjectTerrainBlend: (objectId) => {
      if (!objectTerrainBlendSettings.has(objectId)) {
        objectTerrainBlendSettings.set(objectId, { enabled: false, blendDistance: 0.5 });
      }
      return objectTerrainBlendSettings.get(objectId);
    },
    
    setObjectTerrainBlend: (objectId, settings) => {
      objectTerrainBlendSettings.set(objectId, settings);
    },
    
    // Callbacks
    onGizmoModeChange: onGizmoModeChange || (() => {}),
    onGizmoOrientationChange: onGizmoOrientationChange || (() => {}),
    onTransformUpdate: onTransformUpdate || (() => {}),
    onObjectListUpdate: onObjectListUpdate || (() => {}),
    onSelectionChanged: onSelectionChanged || (() => {}),
    setShadowResolution: setShadowResolution || (() => {}),
    setShowShadowThumbnail: setShowShadowThumbnail || (() => {}),
    setLightMode: setLightMode || (() => {}),
    loadHDRTexture: loadHDRTexture || (async () => {}),
    setHDRTexture: setHDRTexture || (() => {}),
    onWindChanged: onWindChanged || (() => {}),
    onLightingChanged: onLightingChanged || (() => {}),
  };
}
