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
 */
export function saveScene(sceneObjects, cameraState) {
  const importedModelsUsed = [];
  
  const sceneData = {
    name: 'Untitled Scene',
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
      };
    }),
    camera: cameraState,
  };
  
  // Save the scene JSON
  const blob = new Blob([JSON.stringify(sceneData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'scene.json';
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
 * Clear imported models cache (call on scene cleanup)
 */
export function clearImportedModels() {
  for (const [, data] of importedModels) {
    URL.revokeObjectURL(data.blobUrl);
  }
  importedModels.clear();
}
