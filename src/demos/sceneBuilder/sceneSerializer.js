/**
 * Scene serialization - save/load scenes and manage imported models
 */

// Model storage - maps model filename to blob URL for imported models
const importedModels = new Map();

/**
 * Import a model file and store it in memory
 */
export async function importModelFile(file) {
  const timestamp = Date.now();
  const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
  const modelFilename = `imported_${timestamp}_${cleanName}`;
  const modelPath = `/models/${modelFilename}`;
  
  const arrayBuffer = await file.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const blobUrl = URL.createObjectURL(blob);
  
  importedModels.set(modelPath, {
    blobUrl,
    arrayBuffer,
    originalName: file.name,
  });
  
  console.log(`Model imported: ${modelFilename}`);
  console.log(`To make this scene portable, copy the model to: public/models/${modelFilename}`);
  
  return {
    modelPath,
    displayName: file.name.replace('.glb', '').replace('.gltf', ''),
  };
}

/**
 * Get the URL for a model (handles imported models with blob URLs)
 */
export function getModelUrl(modelPath) {
  const imported = importedModels.get(modelPath);
  if (imported) {
    return imported.blobUrl;
  }
  return modelPath;
}

/**
 * Check if a model path refers to an imported model
 */
export function isImportedModel(modelPath) {
  return importedModels.has(modelPath);
}

/**
 * Save scene to JSON file
 * @param {Array} sceneObjects - Array of scene objects
 * @param {Object} cameraState - Camera state
 * @param {Object} lightingState - Optional lighting state
 * @param {string} filename - Optional filename (without .json extension)
 * @param {Map} groups - Optional groups map (groupId -> { name, childIds: Set })
 * @param {Object} windState - Optional global wind state
 * @param {Object} objectWindSettings - Optional per-object wind settings
 * @param {Array} groupsArray - Optional groups array
 * @returns {string} The filename that was used
 */
export function saveScene(sceneObjects, cameraState, lightingState = null, filename = null, groups = null, windState = null, objectWindSettings = null, groupsArray = null) {
  // Prompt for filename if not provided
  let sceneName = filename;
  if (!sceneName) {
    sceneName = prompt('Enter scene name:', 'Untitled Scene');
    if (!sceneName) return null; // User cancelled
  }
  
  // Ensure filename doesn't have .json extension (we'll add it)
  sceneName = sceneName.replace(/\.json$/i, '');
  
  const importedModelsUsed = [];
  
  const sceneData = {
    name: sceneName,
    objects: sceneObjects.map(obj => {
      if (importedModels.has(obj.modelPath)) {
        importedModelsUsed.push(obj.modelPath);
      }
      return {
        name: obj.name,
        modelPath: obj.modelPath,
        position: [...obj.position],
        rotation: [...obj.rotation],
        scale: [...obj.scale],
        groupId: obj.groupId || null,
      };
    }),
    camera: cameraState,
  };
  
  // Add groups if provided (Map format)
  if (groups && groups.size > 0) {
    sceneData.groups = [];
    for (const [groupId, group] of groups) {
      sceneData.groups.push({
        id: groupId,
        name: group.name,
        childIds: [...group.childIds],
        collapsed: group.collapsed,
      });
    }
  }
  
  // Add groups if provided (Array format from scene.serialize)
  if (groupsArray && groupsArray.length > 0) {
    sceneData.groups = groupsArray;
  }
  
  // Add wind state if provided
  if (windState) {
    sceneData.wind = windState;
  }
  
  // Add per-object wind settings if provided
  if (objectWindSettings) {
    sceneData.objectWindSettings = objectWindSettings;
  }
  
  // Add lighting state if provided
  if (lightingState) {
    sceneData.lighting = {
      mode: lightingState.mode || 'sun',
      sunAzimuth: lightingState.sunAzimuth ?? 45,
      sunElevation: lightingState.sunElevation ?? 45,
      shadowEnabled: lightingState.shadowEnabled ?? true,
      shadowResolution: lightingState.shadowResolution ?? 2048,
      hdrExposure: lightingState.hdrExposure ?? 1.0,
      hdrFilename: lightingState.hdrFilename || null,
    };
  }
  
  // Save the scene JSON
  const blob = new Blob([JSON.stringify(sceneData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sceneName}.json`;
  a.click();
  URL.revokeObjectURL(url);
  
  // Offer to download imported models
  if (importedModelsUsed.length > 0) {
    const downloadModels = confirm(
      `This scene uses ${importedModelsUsed.length} imported model(s).\n\n` +
      `To make the scene portable, copy these to the public/models folder:\n` +
      importedModelsUsed.map(p => p.replace('/models/', '')).join('\n') +
      `\n\nWould you like to download the model files now?`
    );
    
    if (downloadModels) {
      for (const modelPath of importedModelsUsed) {
        const imported = importedModels.get(modelPath);
        if (imported) {
          const modelBlob = new Blob([imported.arrayBuffer], { type: 'model/gltf-binary' });
          const modelUrl = URL.createObjectURL(modelBlob);
          const modelA = document.createElement('a');
          modelA.href = modelUrl;
          modelA.download = modelPath.replace('/models/', '');
          modelA.click();
          URL.revokeObjectURL(modelUrl);
        }
      }
    }
  }
  
  return sceneName;
}

/**
 * Parse scene data and return camera state
 */
export function parseCameraState(sceneData) {
  if (!sceneData.camera) {
    return {
      angleX: 0.5,
      angleY: 0.3,
      distance: 5,
      originX: 0,
      originY: 0,
      originZ: 0,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
    };
  }
  
  return {
    angleX: sceneData.camera.angleX || 0.5,
    angleY: sceneData.camera.angleY || 0.3,
    distance: sceneData.camera.distance || 5,
    originX: sceneData.camera.originX || 0,
    originY: sceneData.camera.originY || 0,
    originZ: sceneData.camera.originZ || 0,
    offsetX: sceneData.camera.offsetX || 0,
    offsetY: sceneData.camera.offsetY || 0,
    offsetZ: sceneData.camera.offsetZ || 0,
  };
}

/**
 * Parse scene data and return lighting state
 */
export function parseLightingState(sceneData) {
  if (!sceneData.lighting) {
    return null; // No lighting data in scene file
  }
  
  return {
    mode: sceneData.lighting.mode || 'sun',
    sunAzimuth: sceneData.lighting.sunAzimuth ?? 45,
    sunElevation: sceneData.lighting.sunElevation ?? 45,
    shadowEnabled: sceneData.lighting.shadowEnabled ?? true,
    shadowResolution: sceneData.lighting.shadowResolution ?? 2048,
    hdrExposure: sceneData.lighting.hdrExposure ?? 1.0,
    hdrFilename: sceneData.lighting.hdrFilename || null,
  };
}

/**
 * Parse scene data and return groups data
 * @returns {Array|null} Array of group objects or null if no groups
 */
export function parseGroupsState(sceneData) {
  if (!sceneData.groups || sceneData.groups.length === 0) {
    return null;
  }
  
  return sceneData.groups.map(g => ({
    id: g.id,
    name: g.name,
    childIds: g.childIds || [],
    collapsed: g.collapsed ?? true,
  }));
}

/**
 * Clear imported models cache (call on scene cleanup)
 */
export function clearImportedModels() {
  for (const [, data] of importedModels) {
    URL.revokeObjectURL(data.blobUrl);
  }
  importedModels.clear();
}
