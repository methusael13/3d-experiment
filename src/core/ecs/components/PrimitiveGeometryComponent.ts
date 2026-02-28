import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GPUContext } from '../../gpu/GPUContext';
import { computeBounds } from '../../utils/primitiveGeometry';
import type { TransformComponent } from './TransformComponent';
import type {
  PrimitiveType,
  PrimitiveConfig,
  GeometryData,
  AABB,
} from '../../sceneObjects/types';

/**
 * Primitive geometry component — holds geometry data for cube/plane/sphere entities.
 *
 * Migrated from PrimitiveObject. Manages a single GPU mesh ID in
 * ObjectRendererGPU and supports geometry regeneration when config changes.
 */
export class PrimitiveGeometryComponent extends Component {
  readonly type: ComponentType = 'primitive-geometry';

  primitiveType: PrimitiveType;
  config: PrimitiveConfig;
  geometryData: GeometryData | null = null;

  /** GPU mesh ID in ObjectRendererGPU (-1 = not initialized) */
  gpuMeshId: number = -1;

  /** WebGPU context reference */
  gpuContext: GPUContext | null = null;

  constructor(primitiveType: PrimitiveType, config?: PrimitiveConfig) {
    super();
    this.primitiveType = primitiveType;
    this.config = config ?? { size: 1, subdivision: 16 };
  }

  /**
   * Check if WebGPU resources are initialized.
   */
  get isGPUInitialized(): boolean {
    return this.gpuMeshId >= 0;
  }

  /**
   * Get the GPU mesh ID (or null if not initialized).
   */
  get meshId(): number | null {
    return this.gpuMeshId >= 0 ? this.gpuMeshId : null;
  }

  /**
   * Compute local bounds from geometry data.
   * Call this after setting geometryData to update sibling BoundsComponent.
   */
  computeLocalBounds(): AABB | null {
    if (!this.geometryData) return null;
    return computeBounds(this.geometryData.positions);
  }

  /**
   * Initialize WebGPU resources for this primitive.
   * Registers the geometry with ObjectRendererGPU.
   */
  initWebGPU(ctx: GPUContext): void {
    if (this.gpuMeshId >= 0 || !this.geometryData) return;

    this.gpuContext = ctx;

    const meshData = {
      positions: this.geometryData.positions,
      normals: this.geometryData.normals,
      uvs: this.geometryData.uvs,
      indices: this.geometryData.indices,
      material: {
        albedo: [0.7, 0.7, 0.7] as [number, number, number],
        metallic: 0.0,
        roughness: 0.5,
      },
    };

    // Register with both ObjectRendererGPU and VariantMeshPool via facade
    this.gpuMeshId = ctx.addMesh(meshData);
  }

  /**
   * Update geometry when config changes (size, subdivision).
   * Requires the caller to regenerate geometryData first.
   * Preserves the entity's current transform on the new GPU mesh.
   */
  updateGeometry(newConfig: PrimitiveConfig, newGeometry: GeometryData, transform?: TransformComponent): void {
    this.config = { ...this.config, ...newConfig };
    this.geometryData = newGeometry;

    // If GPU-initialized, update the mesh in both ObjectRendererGPU and VariantMeshPool
    if (this.gpuContext && this.gpuMeshId >= 0) {
      // Preserve material from old mesh before removing
      const oldMaterial = this.gpuContext.objectRenderer.getMaterial(this.gpuMeshId);
      
      // Remove from both pools via facade
      this.gpuContext.removeMesh(this.gpuMeshId);

      const meshData = {
        positions: newGeometry.positions,
        normals: newGeometry.normals,
        uvs: newGeometry.uvs,
        indices: newGeometry.indices,
        material: oldMaterial ?? {
          albedo: [0.7, 0.7, 0.7] as [number, number, number],
          metallic: 0.0,
          roughness: 0.5,
        },
      };

      // Re-register with both pools via facade
      this.gpuMeshId = this.gpuContext.addMesh(meshData);
      
      // Re-apply the entity's current transform to the new mesh
      if (transform) {
        this.gpuContext.setMeshTransform(this.gpuMeshId, transform.modelMatrix);
      }
    }
  }

  /**
   * Clean up WebGPU resources.
   */
  destroyWebGPU(): void {
    if (this.gpuContext && this.gpuMeshId >= 0) {
      this.gpuContext.removeMesh(this.gpuMeshId);
    }
    this.gpuMeshId = -1;
    this.gpuContext = null;
  }

  destroy(): void {
    this.destroyWebGPU();
    this.geometryData = null;
  }

  serialize(): Record<string, unknown> {
    return {
      primitiveType: this.primitiveType,
      config: { ...this.config },
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.primitiveType)
      this.primitiveType = data.primitiveType as PrimitiveType;
    if (data.config) this.config = data.config as PrimitiveConfig;
  }
}