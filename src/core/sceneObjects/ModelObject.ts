import { RenderableObject } from './RenderableObject';
import type {
  IRenderer,
  SerializedModelObject,
  ObjectWindSettings,
  AABB,
} from './types';

// Import factory function and utilities from existing modules
import { loadGLB, type GLBModel } from '../../loaders';
import { computeBoundsFromGLB } from '../sceneGraph';

// WebGPU imports
import type { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUTexture } from '../gpu/GPUTexture';
import type { GPUMaterialTextures, GPUMaterial } from '../gpu/renderers/ObjectRendererGPU';

// Re-export GLBModel for consumers
export type { GLBModel };

/**
 * A 3D model object loaded from GLB/GLTF file.
 * Wraps the object renderer with class-based management.
 */
export class ModelObject extends RenderableObject {
  /** Path to the model file */
  public readonly modelPath: string;
  
  /** Loaded GLB model data */
  private model: GLBModel | null = null;
  
  /** Wind settings for vegetation animation */
  public windSettings: ObjectWindSettings = {
    enabled: false,
    influence: 1.0,
    stiffness: 0.5,
    anchorHeight: 0,
    leafMaterialIndices: new Set(),
    branchMaterialIndices: new Set(),
    displacement: [0, 0],
  };
  
  // ==================== WebGPU Fields ====================
  
  /** WebGPU mesh IDs (one per GLB mesh) */
  private gpuMeshIds: number[] = [];
  
  /** WebGPU textures (uploaded from GLB image data) */
  private gpuTextures: UnifiedGPUTexture[] = [];
  
  /** WebGPU context reference */
  private gpuContext: GPUContext | null = null;
  
  /**
   * Private constructor - use static create() method instead
   */
  private constructor(
    modelPath: string,
    name: string,
    model: GLBModel,
    bounds: AABB
  ) {
    super(name);
    this.modelPath = modelPath;
    this.model = model;
    this.localBounds = bounds;
  }
  
  /**
   * Object type identifier
   */
  get objectType(): string {
    return 'model';
  }
  
  /**
   * Get the loaded GLB model data
   */
  getModel(): GLBModel | null {
    return this.model;
  }
  
  /**
   * Get material names/indices from the model (for wind settings UI)
   */
  getMaterialInfo(): Array<{ index: number; name: string }> {
    if (!this.model) return [];
    
    return this.model.materials.map((_, index) => ({
      index,
      name: `Material ${index}`,
    }));
  }
  
  /**
   * Set wind settings for vegetation animation
   */
  setWindSettings(settings: Partial<ObjectWindSettings>): void {
    this.windSettings = { ...this.windSettings, ...settings };
  }
  
  /**
   * Enable/disable wind for this model
   */
  setWindEnabled(enabled: boolean): void {
    this.windSettings.enabled = enabled;
  }
  
  /**
   * Add a material index to the leaf materials set
   */
  addLeafMaterial(index: number): void {
    this.windSettings.leafMaterialIndices?.add(index);
  }
  
  /**
   * Remove a material index from the leaf materials set
   */
  removeLeafMaterial(index: number): void {
    this.windSettings.leafMaterialIndices?.delete(index);
  }
  
  /**
   * Add a material index to the branch materials set
   */
  addBranchMaterial(index: number): void {
    this.windSettings.branchMaterialIndices?.add(index);
  }
  
  /**
   * Remove a material index from the branch materials set
   */
  removeBranchMaterial(index: number): void {
    this.windSettings.branchMaterialIndices?.delete(index);
  }
  
  /**
   * Serialize to plain object for JSON storage
   */
  serialize(): SerializedModelObject {
    const base = super.serialize();
    
    return {
      ...base,
      type: 'model',
      modelPath: this.modelPath,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedModelObject>): void {
    super.deserialize(data);
    // Model-specific data is mostly immutable (modelPath set at construction)
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.destroyWebGPU();
    super.destroy();
    this.model = null;
  }
  
  // ==================== WebGPU Integration ====================

  /**
   * Initialize WebGPU resources for this model
   * Uploads textures and registers meshes with ObjectRendererGPU
   */
  async initWebGPU(ctx: GPUContext): Promise<void> {
    // Skip if already initialized or no model
    if (this.gpuMeshIds.length > 0 || !this.model) {
      console.log('[ModelObject] GPU resources already initialized - skipping');
      return;
    }

    this.gpuContext = ctx;
    
    // 1. Upload all textures to GPU
    const textureMap = new Map<number, UnifiedGPUTexture>();
    
    for (let i = 0; i < this.model.texturesWithType.length; i++) {
      const texInfo = this.model.texturesWithType[i];
      if (!texInfo.image) continue;
      
      try {
        // Convert ImageData to ImageBitmap
        const bitmap = await createImageBitmap(texInfo.image);
        
        // Create GPU texture (renderTarget required for copyExternalImageToTexture)
        const gpuTexture = UnifiedGPUTexture.create2D(ctx, {
          label: `${this.name}-texture-${i}-${texInfo.type}`,
          width: bitmap.width,
          height: bitmap.height,
          format: 'rgba8unorm',
          mipLevelCount: Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1,
          renderTarget: true,
        });
        
        // Upload image data
        gpuTexture.uploadImageBitmap(ctx, bitmap);
        // Generate mipmaps (texture was created with mipLevelCount > 1)
        gpuTexture.generateMipmaps(ctx);
        
        this.gpuTextures.push(gpuTexture);
        textureMap.set(i, gpuTexture);
        
        bitmap.close();
      } catch (error) {
        console.warn(`[ModelObject] Failed to upload texture ${i}:`, error);
      }
    }
    
    // 2. Register each mesh with ObjectRendererGPU
    for (const mesh of this.model.meshes) {
      if (!mesh.positions || !mesh.normals) {
        console.warn('[ModelObject] Mesh missing positions or normals, skipping');
        continue;
      }
      
      // Get material for this mesh
      const materialIndex = mesh.materialIndex ?? 0;
      const glbMaterial = this.model.materials[materialIndex];
      
      // Build GPU material with texture references
      const gpuMaterial: GPUMaterial = {
        albedo: glbMaterial 
          ? [glbMaterial.baseColorFactor[0], glbMaterial.baseColorFactor[1], glbMaterial.baseColorFactor[2]]
          : [0.7, 0.7, 0.7],
        metallic: glbMaterial?.metallicFactor ?? 0.0,
        roughness: glbMaterial?.roughnessFactor ?? 0.5,
        normalScale: glbMaterial?.normalScale ?? 1.0,
        occlusionStrength: glbMaterial?.occlusionStrength ?? 1.0,
        alphaMode: glbMaterial?.alphaMode ?? 'OPAQUE',  // glTF alpha mode (OPAQUE, MASK, BLEND)
        alphaCutoff: glbMaterial?.alphaCutoff ?? 0.5,   // Only used when alphaMode === 'MASK'
        emissive: glbMaterial?.emissiveFactor ?? [0, 0, 0],
      };
      
      // Map texture indices to GPU textures
      if (glbMaterial) {
        const textures: GPUMaterialTextures = {};
        
        if (glbMaterial.baseColorTextureIndex !== undefined) {
          textures.baseColor = textureMap.get(glbMaterial.baseColorTextureIndex);
        }
        if (glbMaterial.normalTextureIndex !== undefined) {
          textures.normal = textureMap.get(glbMaterial.normalTextureIndex);
        }
        if (glbMaterial.metallicRoughnessTextureIndex !== undefined) {
          textures.metallicRoughness = textureMap.get(glbMaterial.metallicRoughnessTextureIndex);
        }
        if (glbMaterial.occlusionTextureIndex !== undefined) {
          textures.occlusion = textureMap.get(glbMaterial.occlusionTextureIndex);
        }
        if (glbMaterial.emissiveTextureIndex !== undefined) {
          textures.emissive = textureMap.get(glbMaterial.emissiveTextureIndex);
        }
        
        gpuMaterial.textures = textures;
      }
      
      // Register mesh with ObjectRendererGPU
      const meshId = ctx.objectRenderer.addMesh({
        positions: mesh.positions,
        normals: mesh.normals,
        uvs: mesh.uvs ?? undefined,
        indices: mesh.indices ?? undefined,
        material: gpuMaterial,
      });
      
      this.gpuMeshIds.push(meshId);
    }
    
    // 3. Set initial transform for all meshes
    this.updateGPUTransform();
    
    console.log(`[ModelObject] Initialized WebGPU: ${this.gpuMeshIds.length} meshes, ${this.gpuTextures.length} textures`);
  }
  
  /**
   * Check if WebGPU resources are initialized
   */
  get isGPUInitialized(): boolean {
    return this.gpuMeshIds.length > 0;
  }
  
  /**
   * Get the GPU mesh IDs
   */
  get meshIds(): readonly number[] {
    return this.gpuMeshIds;
  }
  
  /**
   * Update the GPU model matrix for all meshes
   */
  updateGPUTransform(): void {
    if (!this.gpuContext) return;
    
    const modelMatrix = this.getModelMatrix();
    for (const meshId of this.gpuMeshIds) {
      this.gpuContext.objectRenderer.setTransform(meshId, modelMatrix);
    }
  }
  
  /**
   * Clean up WebGPU resources
   */
  destroyWebGPU(): void {
    if (this.gpuContext) {
      // Remove meshes from ObjectRendererGPU
      for (const meshId of this.gpuMeshIds) {
        this.gpuContext.objectRenderer.removeMesh(meshId);
      }
    }
    this.gpuMeshIds = [];
    
    // Destroy textures
    for (const texture of this.gpuTextures) {
      texture.destroy();
    }
    this.gpuTextures = [];
    
    this.gpuContext = null;
  }
  
  /**
   * Create a ModelObject by loading from a file path (async)
   */
  static async create(
    modelPath: string,
    name?: string,
    getModelUrl?: (path: string) => string
  ): Promise<ModelObject> {
    // Resolve the URL
    const url = getModelUrl ? getModelUrl(modelPath) : modelPath;
    
    // Load the GLB model
    const model = await loadGLB(url) as GLBModel;
    
    // Compute bounding box
    const bounds = computeBoundsFromGLB(model) as AABB;
    
    // Derive name from path if not provided
    const displayName = name ?? modelPath
      .split('/')
      .pop()
      ?.replace('.glb', '')
      .replace('.gltf', '') ?? 'Model';
    
    return new ModelObject(modelPath, displayName, model, bounds);
  }
  
  /**
   * Create a duplicate of this model (async - must reload)
   */
  async clone(
    getModelUrl?: (path: string) => string
  ): Promise<ModelObject> {
    const cloned = await ModelObject.create(
      this.modelPath,
      `${this.name} (copy)`,
      getModelUrl
    );
    
    // Copy transform
    cloned.copyTransformFrom(this);
    
    // Copy wind settings
    cloned.windSettings = {
      ...this.windSettings,
      leafMaterialIndices: new Set(this.windSettings.leafMaterialIndices),
      branchMaterialIndices: new Set(this.windSettings.branchMaterialIndices),
    };
    
    // Offset position slightly
    cloned.position[0] += 0.5;
    cloned.position[2] += 0.5;
    
    return cloned;
  }
  
  /**
   * Create a ModelObject from serialized data (async)
   */
  static async fromSerialized(
    data: SerializedModelObject,
    getModelUrl?: (path: string) => string
  ): Promise<ModelObject> {
    const model = await ModelObject.create(
      data.modelPath,
      data.name,
      getModelUrl
    );
    
    model.deserialize(data);
    
    return model;
  }
}
