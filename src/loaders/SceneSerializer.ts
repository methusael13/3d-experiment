/**
 * SceneSerializer - Save/load scenes and manage imported models
 */

import type { 
  SerializedSceneObject, 
  SerializedPrimitiveObject, 
  SerializedModelObject,
  SerializedTerrainObject,
  PBRMaterial,
  PrimitiveConfig,
  PrimitiveType,
  ObjectWindSettings,
  TerrainBlendParams,
  TerrainParams,
} from '../core/sceneObjects/types';

// ============ Asset Library Reference Types ============

/**
 * Reference to an asset in the asset library
 * When saving a scene, objects linked from the asset library store this reference
 * instead of embedding the asset data directly
 */
export interface AssetLibraryRef {
  /** Asset ID from the asset library database */
  assetId: string;
  /** Asset name at time of import (for display when asset not found) */
  assetName: string;
  /** Asset type from library */
  assetType: string;
  /** Asset subtype from library (e.g., "Birch", "Palm" for trees) */
  assetSubtype?: string;
}

/**
 * Asset resolution result when loading a scene
 */
export interface ResolvedAssetRef {
  /** Whether the asset was found in the library */
  found: boolean;
  /** The file path to load (from library or fallback) */
  filePath: string | null;
  /** Warning message if asset was not found */
  warning?: string;
}

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
 * Serialized model object with asset library reference
 */
export interface SerializedModelObjectWithAssetRef extends SerializedModelObject {
  /** Asset library reference (if imported from asset library) */
  assetRef?: AssetLibraryRef;
}

/**
 * Full serialized scene data structure
 */
export interface SerializedScene {
  name: string;
  objects: (SerializedSceneObject | SerializedPrimitiveObject | SerializedModelObject | SerializedModelObjectWithAssetRef | SerializedTerrainObject)[];
  camera?: Partial<CameraState>;
  lighting?: SerializedLightingState;
  groups?: GroupState[];
  wind?: SerializedWindState;
  objectWindSettings?: Record<string, SerializedObjectWindSettings>;
  objectTerrainBlendSettings?: Record<string, SerializedTerrainBlendSettings>;
  /** Scene version for future compatibility */
  version?: number;
  /** Asset dependencies - list of asset library IDs used in this scene */
  assetDependencies?: string[];
}

/**
 * Scene object interface for saving
 */
export interface SaveableSceneObject {
  name: string;
  /** 'primitive', 'model', or 'terrain' */
  type?: 'primitive' | 'model' | 'terrain';
  /** For primitives */
  primitiveType?: string;
  primitiveConfig?: PrimitiveConfig;
  material?: PBRMaterial;
  /** For models */
  modelPath?: string;
  /** For terrain */
  terrainParams?: TerrainParams;
  position: [number, number, number] | Float32Array;
  rotation: [number, number, number] | Float32Array;
  scale: [number, number, number] | Float32Array;
  groupId?: string | null;
  /** Asset library reference (if imported from asset library) */
  assetRef?: AssetLibraryRef | null;
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
 * Asset resolver function type
 * Used to resolve asset library references when loading scenes
 */
export type AssetResolverFn = (assetId: string) => Promise<ResolvedAssetRef>;

/**
 * SceneSerializer class - manages scene save/load and imported model storage
 */
export class SceneSerializer {
  /** Storage for imported models - maps model path to blob URL and data */
  private importedModels: Map<string, ImportedModelData> = new Map();
  
  /** Asset resolver function - set by the application to resolve asset library refs */
  private assetResolver: AssetResolverFn | null = null;
  
  /** Tracks which assets from the library are used in the current scene */
  private sceneAssetRefs: Map<string, AssetLibraryRef> = new Map();

  /**
   * Set the asset resolver function for resolving asset library references
   * @param resolver - Function that takes an asset ID and returns the resolved asset info
   */
  setAssetResolver(resolver: AssetResolverFn): void {
    this.assetResolver = resolver;
  }

  /**
   * Register an asset reference when an asset is added to the scene from the library
   * @param instanceId - The scene object instance ID
   * @param assetRef - The asset library reference
   */
  registerAssetRef(instanceId: string, assetRef: AssetLibraryRef): void {
    this.sceneAssetRefs.set(instanceId, assetRef);
  }

  /**
   * Unregister an asset reference when an object is removed from the scene
   * @param instanceId - The scene object instance ID
   */
  unregisterAssetRef(instanceId: string): void {
    this.sceneAssetRefs.delete(instanceId);
  }

  /**
   * Get the asset reference for a scene object
   * @param instanceId - The scene object instance ID
   * @returns The asset reference or undefined if not from asset library
   */
  getAssetRef(instanceId: string): AssetLibraryRef | undefined {
    return this.sceneAssetRefs.get(instanceId);
  }

  /**
   * Get all asset dependencies used in the current scene
   * @returns Array of unique asset IDs
   */
  getSceneAssetDependencies(): string[] {
    const assetIds = new Set<string>();
    for (const ref of this.sceneAssetRefs.values()) {
      assetIds.add(ref.assetId);
    }
    return Array.from(assetIds);
  }

  /**
   * Clear all scene asset references (call when clearing the scene)
   */
  clearSceneAssetRefs(): void {
    this.sceneAssetRefs.clear();
  }

  /**
   * Resolve an asset library reference to get the file path
   * @param assetRef - The asset library reference
   * @returns The resolved asset info
   */
  async resolveAssetRef(assetRef: AssetLibraryRef): Promise<ResolvedAssetRef> {
    if (!this.assetResolver) {
      return {
        found: false,
        filePath: null,
        warning: `No asset resolver configured. Cannot resolve asset: ${assetRef.assetName}`,
      };
    }
    return this.assetResolver(assetRef.assetId);
  }

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
   * Clear all imported model data
   */
  clearImportedModels(): void {
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
    const assetDependencies = new Set<string>();
    
    const sceneData: SerializedScene = {
      name: sceneName,
      version: 2, // Version 2 includes asset library references
      objects: sceneObjects.map(obj => {
        if (obj.modelPath && this.importedModels.has(obj.modelPath)) {
          importedModelsUsed.push(obj.modelPath);
        }
        
        // Base object data
        const baseData = {
          name: obj.name,
          position: [...obj.position] as [number, number, number],
          rotation: [...obj.rotation] as [number, number, number],
          scale: [...obj.scale] as [number, number, number],
          groupId: obj.groupId || null,
        };
        
        // Add type-specific data
        if (obj.type === 'primitive') {
          return {
            ...baseData,
            type: 'primitive' as const,
            primitiveType: obj.primitiveType as PrimitiveType,
            primitiveConfig: obj.primitiveConfig!,
            material: obj.material!,
          } satisfies SerializedPrimitiveObject;
        } else if (obj.type === 'terrain') {
          return {
            ...baseData,
            type: 'terrain' as const,
            terrainParams: obj.terrainParams!,
          } satisfies SerializedTerrainObject;
        } else if (obj.modelPath) {
          return {
            ...baseData,
            type: 'model' as const,
            modelPath: obj.modelPath,
          } satisfies SerializedModelObject;
        }
        
        // Fallback for legacy/unknown objects - try to guess type
        if (obj.primitiveType) {
          return {
            ...baseData,
            type: 'primitive' as const,
            primitiveType: obj.primitiveType as PrimitiveType,
            primitiveConfig: obj.primitiveConfig ?? { size: 1, subdivision: 16 },
            material: obj.material ?? { albedo: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.5 },
          } satisfies SerializedPrimitiveObject;
        }
        
        // Include asset reference if present
        if (obj.assetRef) {
          assetDependencies.add(obj.assetRef.assetId);
          return {
            ...baseData,
            type: 'model' as const,
            modelPath: obj.modelPath || '',
            assetRef: obj.assetRef,
          } satisfies SerializedModelObjectWithAssetRef;
        }
        
        // Default to model type for backward compatibility
        return {
          ...baseData,
          type: 'model' as const,
          modelPath: '',
        } satisfies SerializedModelObject;
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
    
    // Add asset dependencies
    if (assetDependencies.size > 0) {
      sceneData.assetDependencies = Array.from(assetDependencies);
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

  /**
   * Parse asset dependencies from scene data
   * @returns Array of asset IDs used by the scene
   */
  static parseAssetDependencies(sceneData: Partial<SerializedScene>): string[] {
    return sceneData.assetDependencies || [];
  }

  /**
   * Check if scene data contains asset library references
   * @param sceneData - The scene data to check
   * @returns True if the scene uses asset library references
   */
  static hasAssetReferences(sceneData: Partial<SerializedScene>): boolean {
    return (sceneData.version ?? 1) >= 2 && 
           (sceneData.assetDependencies?.length ?? 0) > 0;
  }

  /**
   * Extract all asset references from scene objects
   * @param sceneData - The scene data
   * @returns Map of object names to their asset references
   */
  static extractAssetRefs(sceneData: Partial<SerializedScene>): Map<string, AssetLibraryRef> {
    const refs = new Map<string, AssetLibraryRef>();
    if (!sceneData.objects) return refs;
    
    for (const obj of sceneData.objects) {
      const modelObj = obj as SerializedModelObjectWithAssetRef;
      if (modelObj.assetRef) {
        refs.set(obj.name, modelObj.assetRef);
      }
    }
    return refs;
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
