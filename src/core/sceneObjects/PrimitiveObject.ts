import { mat4 } from 'gl-matrix';
import { RenderableObject } from './RenderableObject';
import type {
  PrimitiveConfig,
  PBRMaterial,
  IPrimitiveRenderer,
  SerializedPrimitiveObject,
  GeometryData,
  AABB,
} from './types';
// Use type-only import to avoid circular dependency
// GPUContext is only used as a type parameter, not constructed here
import type { GPUContext } from '../gpu/GPUContext';

// Import the factory function from the existing renderer
// @ts-ignore - JavaScript module
import { createPrimitiveRendererFromGeometry } from '../renderers/PrimitiveRenderer';

/**
 * Default configuration for primitives
 */
const DEFAULT_CONFIG: Required<PrimitiveConfig> = {
  size: 1,
  subdivision: 16,
};

/**
 * Default PBR material
 */
const DEFAULT_MATERIAL: PBRMaterial = {
  albedo: [0.75, 0.75, 0.75],
  metallic: 0,
  roughness: 0.5,
};

/**
 * Abstract base class for all primitive shapes (cube, plane, sphere, etc.)
 * Subclasses implement generateGeometry() to define their specific shape.
 */
export abstract class PrimitiveObject extends RenderableObject {
  /** Current geometry configuration */
  protected _primitiveConfig: Required<PrimitiveConfig>;
  
  /** The typed renderer (more specific than base IRenderer) */
  protected declare renderer: IPrimitiveRenderer | null;
  
  /** WebGL context reference (needed for creating renderer) */
  protected gl: WebGL2RenderingContext | null = null;
  
  /** WebGPU mesh ID (assigned when initWebGPU is called) */
  protected gpuMeshId: number | null = null;
  
  /** WebGPU context reference (for transform/material updates) */
  protected gpuContext: GPUContext | null = null;
  
  constructor(
    gl: WebGL2RenderingContext,
    name?: string,
    config: PrimitiveConfig = {}
  ) {
    super(name ?? 'Primitive');
    
    this._primitiveConfig = { ...DEFAULT_CONFIG, ...config };
    this.gl = gl;
    
    // Generate geometry and create renderer
    this.initializeRenderer();
  }
  
  /**
   * Abstract: Returns the primitive type identifier for serialization
   */
  abstract get primitiveType(): string;
  
  /**
   * Abstract: Generate the geometry data for this primitive
   * Subclasses implement this to define their specific shape
   */
  protected abstract generateGeometry(): GeometryData;
  
  /**
   * Abstract: Compute bounds for this primitive (before transforms)
   */
  protected abstract computeLocalBounds(): AABB;
  
  /**
   * Object type identifier
   */
  get objectType(): string {
    return 'primitive';
  }
  
  /**
   * Get the current primitive configuration
   */
  get primitiveConfig(): Readonly<Required<PrimitiveConfig>> {
    return { ...this._primitiveConfig };
  }
  
  /**
   * Initialize the renderer with generated geometry
   */
  protected initializeRenderer(): void {
    if (!this.gl) return;
    
    const geometry = this.generateGeometry();
    this.renderer = createPrimitiveRendererFromGeometry(this.gl, geometry) as IPrimitiveRenderer;
    this.localBounds = this.computeLocalBounds();
  }
  
  /**
   * Update the primitive geometry configuration
   */
  updateGeometry(config: PrimitiveConfig): void {
    if (!this.gl) return;
    
    this._primitiveConfig = { ...this._primitiveConfig, ...config };
    
    // Regenerate geometry with new config
    const geometry = this.generateGeometry();
    if (this.renderer) {
      this.renderer.updateGeometryData(geometry);
    }
    this.localBounds = this.computeLocalBounds();
    
    // Update GPU buffers if WebGPU is initialized
    if (this.gpuMeshId !== null && this.gpuContext) {
      const material = this.getMaterial();
      
      // Remove old mesh and add new one with updated geometry
      this.gpuContext.objectRenderer.removeMesh(this.gpuMeshId);
      this.gpuMeshId = this.gpuContext.objectRenderer.addMesh({
        positions: geometry.positions,
        normals: geometry.normals,
        uvs: geometry.uvs,
        indices: geometry.indices,
        material: {
          albedo: material.albedo as [number, number, number],
          metallic: material.metallic,
          roughness: material.roughness,
        },
      });
      
      // Re-apply transform
      this.updateGPUTransform();
    }
  }
  
  /**
   * Get the current PBR material
   */
  getMaterial(): PBRMaterial {
    if (!this.renderer) {
      return { ...DEFAULT_MATERIAL };
    }
    return this.renderer.getMaterial();
  }
  
  /**
   * Set PBR material properties
   */
  setMaterial(material: Partial<PBRMaterial>): void {
    if (!this.renderer) return;
    this.renderer.setMaterial(material);
  }
  
  /**
   * Set the albedo (base color)
   */
  setAlbedo(r: number, g: number, b: number): void {
    this.setMaterial({ albedo: [r, g, b] });
  }
  
  /**
   * Set metallic value (0-1)
   */
  setMetallic(value: number): void {
    this.setMaterial({ metallic: Math.max(0, Math.min(1, value)) });
  }
  
  /**
   * Set roughness value (0-1)
   */
  setRoughness(value: number): void {
    this.setMaterial({ roughness: Math.max(0, Math.min(1, value)) });
  }
  
  // ==================== WebGPU Integration ====================
  
  /**
   * Initialize WebGPU resources for this primitive
   * Registers mesh with the centralized ObjectRendererGPU
   */
  initWebGPU(ctx: GPUContext): void {
    // Skip if already initialized
    if (this.gpuMeshId !== null) {
      return;
    }
    
    this.gpuContext = ctx;
    
    // Generate geometry and register with renderer
    const geometry = this.generateGeometry();
    const material = this.getMaterial();
    
    this.gpuMeshId = ctx.objectRenderer.addMesh({
      positions: geometry.positions,
      normals: geometry.normals,
      uvs: geometry.uvs,
      indices: geometry.indices,
      material: {
        albedo: material.albedo as [number, number, number],
        metallic: material.metallic,
        roughness: material.roughness,
      },
    });
    
    // Set initial transform
    this.updateGPUTransform();
  }
  
  /**
   * Check if WebGPU resources are initialized
   */
  get isGPUInitialized(): boolean {
    return this.gpuMeshId !== null;
  }
  
  /**
   * Get the GPU mesh ID (for rendering)
   */
  get meshId(): number | null {
    return this.gpuMeshId;
  }
  
  /**
   * Update the GPU model matrix (call after transform changes)
   */
  updateGPUTransform(): void {
    if (this.gpuMeshId !== null && this.gpuContext) {
      this.gpuContext.objectRenderer.setTransform(this.gpuMeshId, this.getModelMatrix());
    }
  }
  
  /**
   * Update the GPU material (call after material changes)
   */
  updateGPUMaterial(): void {
    if (this.gpuMeshId !== null && this.gpuContext) {
      const material = this.getMaterial();
      this.gpuContext.objectRenderer.setMaterial(this.gpuMeshId, {
        albedo: material.albedo as [number, number, number],
        metallic: material.metallic,
        roughness: material.roughness,
      });
    }
  }
  
  /**
   * Clean up WebGPU resources
   */
  destroyWebGPU(): void {
    if (this.gpuMeshId !== null && this.gpuContext) {
      this.gpuContext.objectRenderer.removeMesh(this.gpuMeshId);
      this.gpuMeshId = null;
      this.gpuContext = null;
    }
  }
  
  /**
   * Render vertex normal lines for debugging
   */
  renderNormals(vpMatrix: mat4): void {
    if (!this.renderer) return;
    const modelMatrix = this.getModelMatrix();
    this.renderer.renderNormals(vpMatrix, modelMatrix);
  }
  
  /**
   * Serialize to plain object for JSON storage
   */
  serialize(): SerializedPrimitiveObject {
    const base = super.serialize();
    const material = this.getMaterial();
    
    return {
      ...base,
      type: 'primitive',
      primitiveType: this.primitiveType as any,
      primitiveConfig: { ...this._primitiveConfig },
      material: {
        albedo: [...material.albedo],
        metallic: material.metallic,
        roughness: material.roughness,
      },
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedPrimitiveObject>): void {
    super.deserialize(data);
    
    if (data.primitiveConfig) {
      this.updateGeometry(data.primitiveConfig);
    }
    
    if (data.material) {
      this.setMaterial(data.material);
    }
  }
  
  /**
   * Override destroy to clean up GPU resources
   */
  destroy(): void {
    this.destroyWebGPU();
    super.destroy();
  }
}
