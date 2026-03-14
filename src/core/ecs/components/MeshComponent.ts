import { mat4 } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GPUContext } from '../../gpu/GPUContext';
import { UnifiedGPUTexture } from '../../gpu/GPUTexture';
import type { GPUMaterialTextures, GPUMaterial } from '../../gpu/renderers/ObjectRendererGPU';
import { RES } from '../../gpu/shaders/composition/resourceNames';
import type { GLBModel } from '../../../loaders';

// ===================== Shared Texture Cache =====================

/**
 * Reference-counted set of GPU textures, keyed by model path.
 * Multiple MeshComponents that share the same model can reference the
 * same GPU textures instead of re-uploading bitmap data for each clone.
 */
interface SharedTextureEntry {
  textures: UnifiedGPUTexture[];
  textureMap: Map<number, UnifiedGPUTexture>;
  refCount: number;
}

/** Global cache: modelPath → shared textures */
const sharedTextureCache = new Map<string, SharedTextureEntry>();

function acquireSharedTextures(modelPath: string): SharedTextureEntry | undefined {
  const entry = sharedTextureCache.get(modelPath);
  if (entry) {
    entry.refCount++;
    return entry;
  }
  return undefined;
}

function registerSharedTextures(
  modelPath: string,
  textures: UnifiedGPUTexture[],
  textureMap: Map<number, UnifiedGPUTexture>,
): SharedTextureEntry {
  const entry: SharedTextureEntry = { textures, textureMap, refCount: 1 };
  sharedTextureCache.set(modelPath, entry);
  return entry;
}

function releaseSharedTextures(modelPath: string): void {
  const entry = sharedTextureCache.get(modelPath);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    for (const texture of entry.textures) {
      texture.destroy();
    }
    sharedTextureCache.delete(modelPath);
  }
}

// ===================== MeshComponent =====================

/**
 * Mesh component — holds GPU mesh data for model entities.
 *
 * Migrated from ModelObject's WebGPU fields. Manages GPU mesh IDs,
 * textures, and transform updates for the ObjectRendererGPU mesh pool.
 *
 * Components provide data; the MeshRenderSystem determines shader variants
 * based on which components are present.
 *
 * **Texture sharing:** When cloned, the duplicate shares the original's GPU
 * textures via a reference-counted cache keyed by modelPath. Only the vertex
 * buffers (cheap) are re-uploaded for each clone's unique mesh IDs.
 */
export class MeshComponent extends Component {
  readonly type: ComponentType = 'mesh';

  /** Path to the model file (for identification and reloading) */
  modelPath: string = '';

  /** Loaded GLB model data */
  model: GLBModel | null = null;

  /** WebGPU mesh IDs (one per GLB mesh, registered with ObjectRendererGPU) */
  gpuMeshIds: number[] = [];

  /** WebGPU textures (owned or shared via cache) */
  gpuTextures: UnifiedGPUTexture[] = [];

  /** Whether this component's textures are managed by the shared cache */
  private _usesSharedTextures: boolean = false;

  /** WebGPU context reference */
  gpuContext: GPUContext | null = null;

  /**
   * Initialize WebGPU resources for this mesh.
   * Uploads textures (or reuses shared cache) and registers meshes with ObjectRendererGPU.
   *
   * Mirrors ModelObject.initWebGPU() logic.
   */
  async initWebGPU(ctx: GPUContext): Promise<void> {
    if (this.gpuMeshIds.length > 0 || !this.model) {
      return; // Already initialized or no model
    }

    this.gpuContext = ctx;

    // 1. Resolve textures — try shared cache first, upload if needed
    let textureMap: Map<number, UnifiedGPUTexture>;

    const cached = this.modelPath ? acquireSharedTextures(this.modelPath) : undefined;
    if (cached) {
      // Reuse existing GPU textures — no bitmap decode/upload/mipmap needed
      this.gpuTextures = cached.textures;
      textureMap = cached.textureMap;
      this._usesSharedTextures = true;
      console.log(`[MeshComponent] Reusing shared textures for "${this.modelPath}" (refCount=${cached.refCount})`);
    } else {
      // Upload textures from scratch
      textureMap = new Map<number, UnifiedGPUTexture>();

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

      // Register in shared cache for future clones
      if (this.modelPath) {
        registerSharedTextures(this.modelPath, this.gpuTextures, textureMap);
        this._usesSharedTextures = true;
      }
    }

    // 2. Register each mesh with ObjectRendererGPU (new vertex/index/transform buffers per clone)
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

      const meshData = {
        positions: mesh.positions,
        normals: mesh.normals,
        uvs: mesh.uvs ?? undefined,
        indices: mesh.indices ?? undefined,
        material: gpuMaterial,
      };

      // Register with both ObjectRendererGPU and VariantMeshPool via facade
      const meshId = ctx.addMesh(meshData);
      console.log(`[MeshComponent] Mesh data added to ${meshId}:`, meshData);

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
      this.gpuContext.setMeshTransform(meshId, modelMatrix);
    }
  }

  /**
   * Clean up WebGPU resources.
   */
  destroyWebGPU(): void {
    if (this.gpuContext) {
      for (const meshId of this.gpuMeshIds) {
        this.gpuContext.removeMesh(meshId);
      }
    }
    this.gpuMeshIds = [];

    // Release textures via shared cache (refcounted) or destroy directly
    if (this._usesSharedTextures && this.modelPath) {
      releaseSharedTextures(this.modelPath);
    } else {
      for (const texture of this.gpuTextures) {
        texture.destroy();
      }
    }
    this.gpuTextures = [];
    this._usesSharedTextures = false;

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

  /**
   * Clone this component's data for entity duplication.
   * Shares the GLBModel (read-only). GPU textures will be shared
   * via the refcounted texture cache when initWebGPU is called.
   */
  clone(): MeshComponent {
    const c = new MeshComponent();
    c.modelPath = this.modelPath;
    c.model = this.model; // GLBModel is read-only, safe to share
    // gpuMeshIds left empty — new entity registers its own mesh IDs
    // gpuTextures will be resolved from shared cache during initWebGPU
    return c;
  }
}
