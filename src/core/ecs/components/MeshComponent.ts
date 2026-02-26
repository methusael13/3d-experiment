import { mat4 } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GPUContext } from '../../gpu/GPUContext';
import { UnifiedGPUTexture } from '../../gpu/GPUTexture';
import type { GPUMaterialTextures, GPUMaterial } from '../../gpu/renderers/ObjectRendererGPU';
import type { GLBModel } from '../../../loaders';

/**
 * Mesh component — holds GPU mesh data for model entities.
 *
 * Migrated from ModelObject's WebGPU fields. Manages GPU mesh IDs,
 * textures, and transform updates for the ObjectRendererGPU mesh pool.
 *
 * Components provide data; the MeshRenderSystem determines shader variants
 * based on which components are present.
 */
export class MeshComponent extends Component {
  readonly type: ComponentType = 'mesh';

  /** Path to the model file (for identification and reloading) */
  modelPath: string = '';

  /** Loaded GLB model data */
  model: GLBModel | null = null;

  /** WebGPU mesh IDs (one per GLB mesh, registered with ObjectRendererGPU) */
  gpuMeshIds: number[] = [];

  /** WebGPU textures (uploaded from GLB image data) */
  gpuTextures: UnifiedGPUTexture[] = [];

  /** WebGPU context reference */
  gpuContext: GPUContext | null = null;

  /**
   * Initialize WebGPU resources for this mesh.
   * Uploads textures and registers meshes with ObjectRendererGPU.
   *
   * Mirrors ModelObject.initWebGPU() logic.
   */
  async initWebGPU(ctx: GPUContext): Promise<void> {
    if (this.gpuMeshIds.length > 0 || !this.model) {
      return; // Already initialized or no model
    }

    this.gpuContext = ctx;

    // 1. Upload all textures to GPU
    const textureMap = new Map<number, UnifiedGPUTexture>();

    for (let i = 0; i < this.model.texturesWithType.length; i++) {
      const texInfo = this.model.texturesWithType[i];
      if (!texInfo.image) continue;

      try {
        const bitmap = await createImageBitmap(texInfo.image);

        const gpuTexture = UnifiedGPUTexture.create2D(ctx, {
          label: `mesh-texture-${i}-${texInfo.type}`,
          width: bitmap.width,
          height: bitmap.height,
          format: 'rgba8unorm',
          mipLevelCount: Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1,
          renderTarget: true,
        });

        gpuTexture.uploadImageBitmap(ctx, bitmap);
        gpuTexture.generateMipmaps(ctx);

        this.gpuTextures.push(gpuTexture);
        textureMap.set(i, gpuTexture);

        bitmap.close();
      } catch (error) {
        console.warn(`[MeshComponent] Failed to upload texture ${i}:`, error);
      }
    }

    // 2. Register each mesh with ObjectRendererGPU
    for (const mesh of this.model.meshes) {
      if (!mesh.positions || !mesh.normals) {
        continue;
      }

      const materialIndex = mesh.materialIndex ?? 0;
      const glbMaterial = this.model.materials[materialIndex];

      const gpuMaterial: GPUMaterial = {
        albedo: glbMaterial
          ? [glbMaterial.baseColorFactor[0], glbMaterial.baseColorFactor[1], glbMaterial.baseColorFactor[2]]
          : [0.7, 0.7, 0.7],
        metallic: glbMaterial?.metallicFactor ?? 0.0,
        roughness: glbMaterial?.roughnessFactor ?? 0.5,
        normalScale: glbMaterial?.normalScale ?? 1.0,
        occlusionStrength: glbMaterial?.occlusionStrength ?? 1.0,
        alphaMode: glbMaterial?.alphaMode ?? 'OPAQUE',
        alphaCutoff: glbMaterial?.alphaCutoff ?? 0.5,
        emissive: glbMaterial?.emissiveFactor ?? [0, 0, 0],
        doubleSided: glbMaterial?.doubleSided ?? false,
      };

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

      const meshId = ctx.objectRenderer.addMesh({
        positions: mesh.positions,
        normals: mesh.normals,
        uvs: mesh.uvs ?? undefined,
        indices: mesh.indices ?? undefined,
        material: gpuMaterial,
      });

      this.gpuMeshIds.push(meshId);
    }
  }

  /**
   * Compute local bounds from all GLB mesh positions.
   */
  computeLocalBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!this.model) return null;
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const mesh of this.model.meshes) {
      if (!mesh.positions) continue;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const x = mesh.positions[i];
        const y = mesh.positions[i + 1];
        const z = mesh.positions[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    
    if (minX === Infinity) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  /**
   * Check if WebGPU resources are initialized.
   */
  get isGPUInitialized(): boolean {
    return this.gpuMeshIds.length > 0;
  }

  /**
   * Get the GPU mesh IDs (readonly).
   */
  get meshIds(): readonly number[] {
    return this.gpuMeshIds;
  }

  /**
   * Update the GPU model matrix for all meshes.
   */
  updateGPUTransform(modelMatrix: mat4): void {
    if (!this.gpuContext) return;
    for (const meshId of this.gpuMeshIds) {
      this.gpuContext.objectRenderer.setTransform(meshId, modelMatrix);
    }
  }

  /**
   * Clean up WebGPU resources.
   */
  destroyWebGPU(): void {
    if (this.gpuContext) {
      for (const meshId of this.gpuMeshIds) {
        this.gpuContext.objectRenderer.removeMesh(meshId);
      }
    }
    this.gpuMeshIds = [];

    for (const texture of this.gpuTextures) {
      texture.destroy();
    }
    this.gpuTextures = [];

    this.gpuContext = null;
  }

  /**
   * Expose GPU resources for shader binding via ResourceResolver.
   */
  getGPUResource(name: string): GPUBindingResource | null {
    // Textures are managed through ObjectRendererGPU bind groups,
    // not individually resolved. Return null — ResourceResolver
    // will use the mesh's existing bind group from ObjectRendererGPU.
    return null;
  }

  destroy(): void {
    this.destroyWebGPU();
    this.model = null;
  }
}