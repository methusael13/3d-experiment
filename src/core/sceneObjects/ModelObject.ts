import { RenderableObject } from './RenderableObject';
import type {
  IRenderer,
  SerializedModelObject,
  ObjectWindSettings,
  AABB,
} from './types';

// Import factory function and utilities from existing modules
import { createObjectRenderer } from '../renderers';
import { loadGLB, type GLBModel } from '../../loaders';
import { computeBoundsFromGLB } from '../sceneGraph';

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
  
  /**
   * Private constructor - use static create() method instead
   */
  private constructor(
    modelPath: string,
    name: string,
    model: GLBModel,
    renderer: IRenderer,
    bounds: AABB
  ) {
    super(name);
    this.modelPath = modelPath;
    this.model = model;
    this.renderer = renderer;
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
    super.destroy();
    this.model = null;
  }
  
  /**
   * Create a ModelObject by loading from a file path (async)
   */
  static async create(
    gl: WebGL2RenderingContext,
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
    
    // Create renderer (cast via unknown since JS renderer matches IRenderer interface at runtime)
    const renderer = createObjectRenderer(gl, model) as unknown as IRenderer;
    
    // Derive name from path if not provided
    const displayName = name ?? modelPath
      .split('/')
      .pop()
      ?.replace('.glb', '')
      .replace('.gltf', '') ?? 'Model';
    
    return new ModelObject(modelPath, displayName, model, renderer, bounds);
  }
  
  /**
   * Create a duplicate of this model (async - must reload)
   */
  async clone(
    gl: WebGL2RenderingContext,
    getModelUrl?: (path: string) => string
  ): Promise<ModelObject> {
    const cloned = await ModelObject.create(
      gl,
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
    gl: WebGL2RenderingContext,
    data: SerializedModelObject,
    getModelUrl?: (path: string) => string
  ): Promise<ModelObject> {
    const model = await ModelObject.create(
      gl,
      data.modelPath,
      data.name,
      getModelUrl
    );
    
    model.deserialize(data);
    
    return model;
  }
}
