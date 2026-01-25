/**
 * SceneSerializer - Save/load scenes and manage imported models
 */

import type { 
  SerializedSceneObject, 
  SerializedPrimitiveObject, 
  SerializedModelObject,
  PBRMaterial,
  PrimitiveConfig,
  ObjectWindSettings,
  TerrainBlendParams,
} from '../core/sceneObjects/types';

// ============ Types ============

/**
 * Stored data for an imported model
 */
export interface ImportedModelData {
  blobUrl: string;
  /** Original file for efficient streaming (when available) */
  file?: File;
  /** ArrayBuffer for downloaded/save scenarios */
  arrayBuffer?: ArrayBuffer;
  originalName: string;
  /** Additional blob URLs for glTF resources (bin files, textures) */
  resourceBlobUrls?: Map<string, string>;
}

/**
 * Result from importing a model file
 */
export interface ImportResult {
  modelPath: string;
  displayName: string;
}

/**
 * Camera state for serialization
 */
export interface CameraState {
  angleX: number;
  angleY: number;
  distance: number;
  originX: number;
  originY: number;
  originZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

/**
 * Serialized lighting state
 */
export interface SerializedLightingState {
  mode: 'directional' | 'hdr' | 'sun'; // 'sun' for legacy support
  sunAzimuth?: number;
  sunElevation?: number;
  shadowEnabled?: boolean;
  shadowResolution?: number;
  hdrExposure?: number;
  hdrFilename?: string | null;
  ambientIntensity?: number;
  toneMapping?: number;
}

/**
 * Group state for serialization
 */
export interface GroupState {
  id: string;
  name: string;
  childIds: string[];
  collapsed: boolean;
}

/**
 * Wind state for serialization
 */
export interface SerializedWindState {
  enabled: boolean;
  strength: number;
  direction: [number, number];
  turbulence: number;
}

/**
 * Per-object wind settings for serialization (without Set types)
 */
export interface SerializedObjectWindSettings {
  enabled: boolean;
  influence: number;
  stiffness: number;
  anchorHeight: number;
  leafMaterialIndices?: number[];
  branchMaterialIndices?: number[];
}

/**
 * Per-object terrain blend settings for serialization
 */
export interface SerializedTerrainBlendSettings {
  enabled: boolean;
  blendDistance?: number;
}

/**
 * Full serialized scene data structure
 */
export interface SerializedScene {
  name: string;
  objects: (SerializedSceneObject | SerializedPrimitiveObject | SerializedModelObject)[];
  camera?: Partial<CameraState>;
  lighting?: SerializedLightingState;
  groups?: GroupState[];
  wind?: SerializedWindState;
  objectWindSettings?: Record<string, SerializedObjectWindSettings>;
  objectTerrainBlendSettings?: Record<string, SerializedTerrainBlendSettings>;
}

/**
 * Scene object interface for saving (minimal shape expected)
 */
export interface SaveableSceneObject {
  name: string;
  modelPath?: string;
  position: [number, number, number] | Float32Array;
  rotation: [number, number, number] | Float32Array;
  scale: [number, number, number] | Float32Array;
  groupId?: string | null;
}

/**
 * Group interface for saving
 */
export interface SaveableGroup {
  name: string;
  childIds: Set<string> | string[];
  collapsed?: boolean;
}

/**
 * Options for saveScene method
 */
export interface SaveSceneOptions {
  sceneObjects: SaveableSceneObject[];
  cameraState: CameraState;
  lightingState?: SerializedLightingState | null;
  filename?: string | null;
  groups?: Map<string, SaveableGroup> | null;
  windState?: SerializedWindState | null;
  objectWindSettings?: Record<string, SerializedObjectWindSettings> | null;
  groupsArray?: GroupState[] | null;
  objectTerrainBlendSettings?: Record<string, SerializedTerrainBlendSettings> | null;
}

// ============ Default Values ============

const DEFAULT_CAMERA_STATE: CameraState = {
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

// ============ SceneSerializer Class ============

/**
 * SceneSerializer class - manages scene save/load and imported model storage
 */
export class SceneSerializer {
  /** Storage for imported models - maps model path to blob URL and data */
  private importedModels: Map<string, ImportedModelData> = new Map();

  /**
   * Import a model file and store it in memory
   * @param file - The file to import
   * @returns Import result with model path and display name
   */
  async importModelFile(file: File): Promise<ImportResult> {
    const timestamp = Date.now();
    const cleanName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const modelFilename = `imported_${timestamp}_${cleanName}`;
    const modelPath = `/models/${modelFilename}`;
    
    const arrayBuffer = await file.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
    const blobUrl = URL.createObjectURL(blob);
    
    this.importedModels.set(modelPath, {
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
   * @param modelPath - The model path
   * @returns The URL to load the model from
   */
  getModelUrl(modelPath: string): string {
    const imported = this.importedModels.get(modelPath);
    if (imported) {
      return imported.blobUrl;
    }
    return modelPath;
  }

  /**
   * Check if a model path refers to an imported model
   * @param modelPath - The model path to check
   * @returns True if the model was imported
   */
  isImportedModel(modelPath: string): boolean {
    return this.importedModels.has(modelPath);
  }

  /**
   * Clear imported models cache (call on scene cleanup)
   */
  clearImportedModels(): void {
    for (const [, data] of this.importedModels) {
      URL.revokeObjectURL(data.blobUrl);
      // Also revoke resource blob URLs for glTF models
      if (data.resourceBlobUrls) {
        for (const resourceUrl of data.resourceBlobUrls.values()) {
          URL.revokeObjectURL(resourceUrl);
        }
      }
    }
    this.importedModels.clear();
  }

  /**
   * Import a glTF directory (folder containing .gltf, .bin, and texture files)
   * @param files - FileList from a directory input
   * @returns Import result with model path and display name, or null if no .gltf found
   */
  async importGLTFDirectory(files: FileList): Promise<ImportResult | null> {
    // Build a map of relative paths to files
    const fileMap = new Map<string, File>();
    let gltfFile: File | null = null;
    let gltfRelativePath = '';
    
    for (const file of Array.from(files)) {
      // webkitRelativePath gives us "folderName/path/to/file.ext"
      const relativePath = file.webkitRelativePath;
      const pathParts = relativePath.split('/');
      // Remove the top-level folder name to get internal path
      const internalPath = pathParts.slice(1).join('/');
      
      fileMap.set(internalPath, file);
      
      // Find the main .gltf file (usually at root or named scene.gltf)
      if (file.name.endsWith('.gltf')) {
        // Prefer root-level .gltf or first found
        if (!gltfFile || pathParts.length === 2) {
          gltfFile = file;
          gltfRelativePath = internalPath;
        }
      }
    }
    
    if (!gltfFile) {
      console.error('No .gltf file found in the selected directory');
      return null;
    }
    
    // Get the directory containing the .gltf file
    const gltfDir = gltfRelativePath.includes('/') 
      ? gltfRelativePath.substring(0, gltfRelativePath.lastIndexOf('/') + 1)
      : '';
    
    // Read and parse the glTF JSON
    const gltfText = await gltfFile.text();
    let gltfJson: any;
    try {
      gltfJson = JSON.parse(gltfText);
    } catch (e) {
      console.error('Failed to parse glTF JSON:', e);
      return null;
    }
    
    // Create blob URLs for all referenced resources
    const resourceBlobUrls = new Map<string, string>();
    
    // Helper to resolve and create blob URL for a URI
    const resolveBlobUrl = (uri: string): string | null => {
      // Skip data URIs - they're already embedded
      if (uri.startsWith('data:')) {
        return null;
      }
      
      // Decode URI components and resolve relative path
      const decodedUri = decodeURIComponent(uri);
      const resolvedPath = gltfDir + decodedUri;
      
      const file = fileMap.get(resolvedPath) || fileMap.get(decodedUri);
      if (!file) {
        console.warn(`Referenced file not found: ${uri} (resolved: ${resolvedPath})`);
        return null;
      }
      
      // Create blob URL directly from File (efficient - no copying)
      const blobUrl = URL.createObjectURL(file);
      resourceBlobUrls.set(uri, blobUrl);
      return blobUrl;
    };
    
    // Rewrite buffer URIs
    if (gltfJson.buffers) {
      for (const buffer of gltfJson.buffers) {
        if (buffer.uri && !buffer.uri.startsWith('data:')) {
          const blobUrl = resolveBlobUrl(buffer.uri);
          if (blobUrl) {
            buffer.uri = blobUrl;
          }
        }
      }
    }
    
    // Rewrite image URIs
    if (gltfJson.images) {
      for (const image of gltfJson.images) {
        if (image.uri && !image.uri.startsWith('data:')) {
          const blobUrl = resolveBlobUrl(image.uri);
          if (blobUrl) {
            image.uri = blobUrl;
          }
        }
      }
    }
    
    // Create blob URL for the modified glTF JSON
    const modifiedGltfBlob = new Blob([JSON.stringify(gltfJson)], { type: 'model/gltf+json' });
    const gltfBlobUrl = URL.createObjectURL(modifiedGltfBlob);
    
    // Generate unique model path
    const timestamp = Date.now();
    const folderName = gltfFile.webkitRelativePath.split('/')[0];
    const cleanName = folderName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const modelFilename = `imported_${timestamp}_${cleanName}`;
    const modelPath = `/models/${modelFilename}`;
    
    // Store the imported model data
    this.importedModels.set(modelPath, {
      blobUrl: gltfBlobUrl,
      file: gltfFile,
      originalName: folderName,
      resourceBlobUrls,
    });
    
    console.log(`glTF directory imported: ${folderName}`);
    console.log(`  - Main file: ${gltfFile.name}`);
    console.log(`  - Resources: ${resourceBlobUrls.size} blob URLs created`);
    
    return {
      modelPath,
      displayName: cleanName.replace('.gltf', '').replace(/_/g, ' '),
    };
  }

  /**
   * Get all imported model paths
   */
  getImportedModelPaths(): string[] {
    return Array.from(this.importedModels.keys());
  }

  /**
   * Save scene to JSON file
   * @param options - Save options
   * @returns The filename that was used, or null if cancelled
   */
  saveScene(options: SaveSceneOptions): string | null {
    const {
      sceneObjects,
      cameraState,
      lightingState = null,
      filename = null,
      groups = null,
      windState = null,
      objectWindSettings = null,
      groupsArray = null,
      objectTerrainBlendSettings = null,
    } = options;

    // Prompt for filename if not provided
    let sceneName = filename;
    if (!sceneName) {
      sceneName = prompt('Enter scene name:', 'Untitled Scene');
      if (!sceneName) return null; // User cancelled
    }
    
    // Ensure filename doesn't have .json extension (we'll add it)
    sceneName = sceneName.replace(/\.json$/i, '');
    
    const importedModelsUsed: string[] = [];
    
    const sceneData: SerializedScene = {
      name: sceneName,
      objects: sceneObjects.map(obj => {
        if (obj.modelPath && this.importedModels.has(obj.modelPath)) {
          importedModelsUsed.push(obj.modelPath);
        }
        return {
          name: obj.name,
          modelPath: obj.modelPath,
          position: [...obj.position] as [number, number, number],
          rotation: [...obj.rotation] as [number, number, number],
          scale: [...obj.scale] as [number, number, number],
          groupId: obj.groupId || null,
        };
      }),
      camera: cameraState,
    };
    
    // Add groups if provided (Map format)
    if (groups && groups.size > 0) {
      sceneData.groups = [];
      for (const [groupId, group] of groups) {
        const childIds = group.childIds instanceof Set 
          ? Array.from(group.childIds) 
          : group.childIds;
        sceneData.groups.push({
          id: groupId,
          name: group.name,
          childIds,
          collapsed: group.collapsed ?? true,
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
    
    // Add per-object terrain blend settings if provided
    if (objectTerrainBlendSettings) {
      sceneData.objectTerrainBlendSettings = objectTerrainBlendSettings;
    }
    
    // Add lighting state if provided
    if (lightingState) {
      sceneData.lighting = {
        mode: lightingState.mode || 'directional',
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
      this.offerModelDownloads(importedModelsUsed);
    }
    
    return sceneName;
  }

  /**
   * Offer to download imported models used in the scene
   */
  private offerModelDownloads(importedModelsUsed: string[]): void {
    const downloadModels = confirm(
      `This scene uses ${importedModelsUsed.length} imported model(s).\n\n` +
      `To make the scene portable, copy these to the public/models folder:\n` +
      importedModelsUsed.map(p => p.replace('/models/', '')).join('\n') +
      `\n\nWould you like to download the model files now?`
    );
    
    if (downloadModels) {
      for (const modelPath of importedModelsUsed) {
        const imported = this.importedModels.get(modelPath);
        if (imported) {
          // Use file if available (more efficient), otherwise use arrayBuffer
          let modelUrl: string;
          if (imported.file) {
            modelUrl = URL.createObjectURL(imported.file);
          } else if (imported.arrayBuffer) {
            const modelBlob = new Blob([imported.arrayBuffer], { type: 'model/gltf-binary' });
            modelUrl = URL.createObjectURL(modelBlob);
          } else {
            // Already have a blob URL, can't re-download
            console.warn(`Cannot download model ${modelPath}: no file or arrayBuffer available`);
            continue;
          }
          
          const modelA = document.createElement('a');
          modelA.href = modelUrl;
          modelA.download = modelPath.replace('/models/', '');
          modelA.click();
          URL.revokeObjectURL(modelUrl);
        }
      }
    }
  }

  // ============ Static Parse Methods ============

  /**
   * Parse scene data and return camera state
   */
  static parseCameraState(sceneData: Partial<SerializedScene>): CameraState {
    if (!sceneData.camera) {
      return { ...DEFAULT_CAMERA_STATE };
    }
    
    return {
      angleX: sceneData.camera.angleX ?? DEFAULT_CAMERA_STATE.angleX,
      angleY: sceneData.camera.angleY ?? DEFAULT_CAMERA_STATE.angleY,
      distance: sceneData.camera.distance ?? DEFAULT_CAMERA_STATE.distance,
      originX: sceneData.camera.originX ?? DEFAULT_CAMERA_STATE.originX,
      originY: sceneData.camera.originY ?? DEFAULT_CAMERA_STATE.originY,
      originZ: sceneData.camera.originZ ?? DEFAULT_CAMERA_STATE.originZ,
      offsetX: sceneData.camera.offsetX ?? DEFAULT_CAMERA_STATE.offsetX,
      offsetY: sceneData.camera.offsetY ?? DEFAULT_CAMERA_STATE.offsetY,
      offsetZ: sceneData.camera.offsetZ ?? DEFAULT_CAMERA_STATE.offsetZ,
    };
  }

  /**
   * Parse scene data and return lighting state
   */
  static parseLightingState(sceneData: Partial<SerializedScene>): SerializedLightingState | null {
    if (!sceneData.lighting) {
      return null; // No lighting data in scene file
    }
    
    return {
      mode: sceneData.lighting.mode || 'directional',
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
   */
  static parseGroupsState(sceneData: Partial<SerializedScene>): GroupState[] | null {
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
   * Parse wind state from scene data
   */
  static parseWindState(sceneData: Partial<SerializedScene>): SerializedWindState | null {
    if (!sceneData.wind) {
      return null;
    }
    return sceneData.wind;
  }

  /**
   * Parse object wind settings from scene data
   */
  static parseObjectWindSettings(sceneData: Partial<SerializedScene>): Record<string, SerializedObjectWindSettings> | null {
    if (!sceneData.objectWindSettings) {
      return null;
    }
    return sceneData.objectWindSettings;
  }

  /**
   * Parse terrain blend settings from scene data
   */
  static parseTerrainBlendSettings(sceneData: Partial<SerializedScene>): Record<string, SerializedTerrainBlendSettings> | null {
    if (!sceneData.objectTerrainBlendSettings) {
      return null;
    }
    return sceneData.objectTerrainBlendSettings;
  }
}

// ============ Singleton Instance ============

/** Default singleton instance for backward compatibility */
export const sceneSerializer = new SceneSerializer();

// ============ Backward-Compatible Function Exports ============

/**
 * Import a model file and store it in memory
 * @deprecated Use sceneSerializer.importModelFile() instead
 */
export async function importModelFile(file: File): Promise<ImportResult> {
  return sceneSerializer.importModelFile(file);
}

/**
 * Get the URL for a model (handles imported models with blob URLs)
 * @deprecated Use sceneSerializer.getModelUrl() instead
 */
export function getModelUrl(modelPath: string): string {
  return sceneSerializer.getModelUrl(modelPath);
}

/**
 * Check if a model path refers to an imported model
 * @deprecated Use sceneSerializer.isImportedModel() instead
 */
export function isImportedModel(modelPath: string): boolean {
  return sceneSerializer.isImportedModel(modelPath);
}

/**
 * Clear imported models cache
 * @deprecated Use sceneSerializer.clearImportedModels() instead
 */
export function clearImportedModels(): void {
  sceneSerializer.clearImportedModels();
}

/**
 * Import a glTF directory (folder containing .gltf, .bin, and texture files)
 * @deprecated Use sceneSerializer.importGLTFDirectory() instead
 */
export async function importGLTFDirectory(files: FileList): Promise<ImportResult | null> {
  return sceneSerializer.importGLTFDirectory(files);
}

/**
 * Save scene to JSON file
 * @deprecated Use sceneSerializer.saveScene() instead
 */
export function saveScene(
  sceneObjects: SaveableSceneObject[],
  cameraState: CameraState,
  lightingState: SerializedLightingState | null = null,
  filename: string | null = null,
  groups: Map<string, SaveableGroup> | null = null,
  windState: SerializedWindState | null = null,
  objectWindSettings: Record<string, SerializedObjectWindSettings> | null = null,
  groupsArray: GroupState[] | null = null,
  objectTerrainBlendSettings: Record<string, SerializedTerrainBlendSettings> | null = null
): string | null {
  return sceneSerializer.saveScene({
    sceneObjects,
    cameraState,
    lightingState,
    filename,
    groups,
    windState,
    objectWindSettings,
    groupsArray,
    objectTerrainBlendSettings,
  });
}

/**
 * Parse scene data and return camera state
 * @deprecated Use SceneSerializer.parseCameraState() instead
 */
export function parseCameraState(sceneData: Partial<SerializedScene>): CameraState {
  return SceneSerializer.parseCameraState(sceneData);
}

/**
 * Parse scene data and return lighting state
 * @deprecated Use SceneSerializer.parseLightingState() instead
 */
export function parseLightingState(sceneData: Partial<SerializedScene>): SerializedLightingState | null {
  return SceneSerializer.parseLightingState(sceneData);
}

/**
 * Parse scene data and return groups data
 * @deprecated Use SceneSerializer.parseGroupsState() instead
 */
export function parseGroupsState(sceneData: Partial<SerializedScene>): GroupState[] | null {
  return SceneSerializer.parseGroupsState(sceneData);
}
