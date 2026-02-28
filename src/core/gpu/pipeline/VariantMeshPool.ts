/**
 * VariantMeshPool — Composition-native GPU resource manager for the
 * composed shader variant rendering path.
 *
 * Unlike ObjectRendererGPU's hardcoded 10-slot Group 2 bind group layout,
 * VariantMeshPool stores textures by canonical resource name (e.g., RES.BASE_COLOR_TEX)
 * and builds Group 2 bind groups dynamically from ComposedShader.bindingLayout metadata.
 * This eliminates binding order fragility — the ShaderComposer can assign any binding
 * indices in any order, and the bind group will always match because resources are
 * looked up by name.
 *
 * ECS components dual-register with both ObjectRendererGPU (legacy paths: shadow,
 * selection, billboard baking) and VariantMeshPool (composed shader path).
 *
 * Bind Group Layout (mirrors ObjectRendererGPU for compatibility):
 * - Group 0: Global uniforms (camera, light, shadow params) — 192 bytes
 * - Group 1: Per-mesh uniforms (model matrix, material) — model (64B) + material (160B)
 * - Group 2: Dynamic — built from ComposedShader.bindingLayout per variant
 * - Group 3: Environment — owned by SceneEnvironment (unchanged)
 */

import { mat4 } from 'gl-matrix';
import type { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import { PlaceholderTextures } from '../renderers/shared/PlaceholderTextures';
import { RES } from '../shaders/composition/resourceNames';
import type { ComposedShader, ShaderResource } from '../shaders/composition/types';
import type { GPUMaterial, GPUMaterialTextures, GPUMeshData, ObjectRenderParams } from '../renderers/ObjectRendererGPU';

// ============ Types ============

/**
 * Draw parameters for a mesh (exposed to VariantRenderer).
 */
export interface DrawParams {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
}

/**
 * Default material values (same as ObjectRendererGPU).
 */
const DEFAULT_MATERIAL: GPUMaterial = {
  albedo: [0.7, 0.7, 0.7],
  metallic: 0.0,
  roughness: 0.5,
  normalScale: 1.0,
  occlusionStrength: 1.0,
  alphaMode: 'OPAQUE',
  alphaCutoff: 0.5,
  emissive: [0, 0, 0],
};

/**
 * Internal mesh entry in the pool.
 */
interface VariantMeshEntry {
  id: number;
  vertexBuffer: UnifiedGPUBuffer;
  indexBuffer: UnifiedGPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;

  // Group 1 resources
  modelMatrix: Float32Array;
  modelBuffer: UnifiedGPUBuffer;
  materialBuffer: UnifiedGPUBuffer;
  modelBindGroup: GPUBindGroup;

  // Material data (for getMaterial / UI display)
  material: GPUMaterial;

  // Named texture resources — keyed by canonical RES names
  textureResources: Map<string, GPUBindingResource>;

  // Double-sided flag
  doubleSided: boolean;
}

// ============ VariantMeshPool Class ============

export class VariantMeshPool {
  private ctx: GPUContext;

  // Registered meshes
  private meshes: Map<number, VariantMeshEntry> = new Map();
  private nextMeshId = 1;

  // Bind group layouts (same as ObjectRendererGPU for Group 0/1 compatibility)
  private globalBindGroupLayout!: GPUBindGroupLayout;
  private modelBindGroupLayout!: GPUBindGroupLayout;

  // Global uniforms (Group 0)
  private globalUniformBuffer!: UnifiedGPUBuffer;
  private globalBindGroup!: GPUBindGroup;

  // Default sampler for PBR textures
  private defaultSampler!: GPUSampler;

  // Empty bind group for unused slots
  private _emptyBindGroupLayout: GPUBindGroupLayout | null = null;
  private _emptyBindGroup: GPUBindGroup | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    // Create global uniform buffer (192 bytes — same layout as ObjectRendererGPU)
    this.globalUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'variant-pool-global-uniforms',
      size: 192,
    });

    // Create default sampler
    this.defaultSampler = ctx.device.createSampler({
      label: 'variant-pool-default-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 4,
    });

    // Create bind group layouts (must match ObjectRendererGPU exactly)
    this.globalBindGroupLayout = new BindGroupLayoutBuilder('variant-pool-global-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);

    this.modelBindGroupLayout = new BindGroupLayoutBuilder('variant-pool-model-layout')
      .uniformBuffer(0, 'vertex')   // Model matrix
      .uniformBuffer(1, 'all')      // Material uniforms
      .build(ctx);

    // Create global bind group
    this.globalBindGroup = new BindGroupBuilder('variant-pool-global-bindgroup')
      .buffer(0, this.globalUniformBuffer)
      .build(ctx, this.globalBindGroupLayout);
  }

  // ===================== Mesh Lifecycle =====================

  /**
   * Add a mesh to the pool with an explicit ID.
   * The ID should match the ObjectRendererGPU mesh ID for dual-registration.
   * @returns The mesh ID
   */
  addMeshWithId(id: number, data: GPUMeshData): number {
    // Track highest ID so standalone addMesh() doesn't collide
    if (id >= this.nextMeshId) {
      this.nextMeshId = id + 1;
    }

    // Create interleaved vertex buffer
    const vertexBuffer = this.createInterleavedBuffer(data, id);

    // Create index buffer if provided
    let indexBuffer: UnifiedGPUBuffer | null = null;
    let indexCount = 0;
    let indexFormat: GPUIndexFormat = 'uint16';

    if (data.indices) {
      indexCount = data.indices.length;
      indexFormat = data.indices instanceof Uint32Array ? 'uint32' : 'uint16';
      indexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
        label: `variant-pool-index-${id}`,
        data: data.indices,
      });
    }

    // Create model matrix buffer (64 bytes)
    const modelBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `variant-pool-model-${id}`,
      size: 64,
    });

    // Initialize with identity matrix
    const modelMatrix = new Float32Array(16);
    mat4.identity(modelMatrix as unknown as mat4);
    modelBuffer.write(this.ctx, modelMatrix);

    // Create material buffer (160 bytes — matches ObjectRendererGPU)
    const materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `variant-pool-material-${id}`,
      size: 160,
    });

    // Merge material with defaults
    const material: GPUMaterial = {
      ...DEFAULT_MATERIAL,
      ...data.material,
    };

    // Write initial material to buffer
    this.writeMaterialToBuffer(materialBuffer, material);

    // Create model bind group (Group 1)
    const modelBindGroup = new BindGroupBuilder(`variant-pool-model-bg-${id}`)
      .buffer(0, modelBuffer)
      .buffer(1, materialBuffer)
      .build(this.ctx, this.modelBindGroupLayout);

    // Build named texture resources from material textures
    const textureResources = new Map<string, GPUBindingResource>();
    if (material.textures) {
      this.populatePBRTextureResources(textureResources, material.textures);
    }

    const entry: VariantMeshEntry = {
      id,
      vertexBuffer,
      indexBuffer,
      indexCount,
      vertexCount: data.positions.length / 3,
      indexFormat,
      modelMatrix,
      modelBuffer,
      materialBuffer,
      modelBindGroup,
      material,
      textureResources,
      doubleSided: material.doubleSided ?? false,
    };

    this.meshes.set(id, entry);
    return id;
  }

  /**
   * Add a mesh to the pool with an auto-generated ID.
   * Prefer addMeshWithId() for dual-registration with ObjectRendererGPU.
   * @returns Mesh ID for later reference
   */
  addMesh(data: GPUMeshData): number {
    return this.addMeshWithId(this.nextMeshId++, data);
  }

  /**
   * Remove a mesh from the pool.
   */
  removeMesh(id: number): void {
    const entry = this.meshes.get(id);
    if (!entry) return;

    entry.vertexBuffer.destroy();
    entry.indexBuffer?.destroy();
    entry.modelBuffer.destroy();
    entry.materialBuffer.destroy();
    // Note: textureResources references external GPU objects, don't destroy

    this.meshes.delete(id);
  }

  /**
   * Check if a mesh exists.
   */
  hasMesh(id: number): boolean {
    return this.meshes.has(id);
  }

  // ===================== Transform / Material =====================

  /**
   * Update the transform (model matrix) for a mesh.
   */
  setTransform(id: number, modelMatrix: mat4 | Float32Array): void {
    const entry = this.meshes.get(id);
    if (!entry) return;

    entry.modelMatrix.set(modelMatrix as Float32Array);
    entry.modelBuffer.write(this.ctx, entry.modelMatrix);
  }

  /**
   * Update material properties for a mesh.
   */
  setMaterial(id: number, material: Partial<GPUMaterial>): void {
    const entry = this.meshes.get(id);
    if (!entry) return;

    if (material.albedo) entry.material.albedo = [...material.albedo];
    if (material.metallic !== undefined) entry.material.metallic = material.metallic;
    if (material.roughness !== undefined) entry.material.roughness = material.roughness;
    if (material.normalScale !== undefined) entry.material.normalScale = material.normalScale;
    if (material.occlusionStrength !== undefined) entry.material.occlusionStrength = material.occlusionStrength;
    if (material.alphaCutoff !== undefined) entry.material.alphaCutoff = material.alphaCutoff;
    if (material.emissive) entry.material.emissive = [...material.emissive];
    if (material.ior !== undefined) entry.material.ior = material.ior;
    if (material.clearcoatFactor !== undefined) entry.material.clearcoatFactor = material.clearcoatFactor;
    if (material.clearcoatRoughness !== undefined) entry.material.clearcoatRoughness = material.clearcoatRoughness;
    if (material.unlit !== undefined) entry.material.unlit = material.unlit;
    if (material.triplanarMode !== undefined) entry.material.triplanarMode = material.triplanarMode;
    if (material.triplanarScale !== undefined) entry.material.triplanarScale = material.triplanarScale;
    if (material.doubleSided !== undefined) {
      entry.material.doubleSided = material.doubleSided;
      entry.doubleSided = material.doubleSided;
    }

    this.writeMaterialToBuffer(entry.materialBuffer, entry.material);
  }

  /**
   * Write extra uniform data to a mesh's material buffer at a specific byte offset.
   * Used by systems (Wind, Wetness) to write feature-specific data beyond the
   * base 96-byte MaterialUniforms region.
   */
  writeExtraUniforms(id: number, data: Float32Array, byteOffset: number): void {
    const entry = this.meshes.get(id);
    if (!entry) return;
    this.ctx.queue.writeBuffer(
      entry.materialBuffer.buffer,
      byteOffset,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Get mesh material (for UI display).
   */
  getMaterial(id: number): GPUMaterial | null {
    return this.meshes.get(id)?.material ?? null;
  }

  // ===================== Named Texture Resources =====================

  /**
   * Set an individual texture resource by canonical name.
   * Used for per-entity resources like reflection probe cubemap/sampler.
   */
  setTextureResource(meshId: number, name: string, resource: GPUBindingResource): void {
    const entry = this.meshes.get(meshId);
    if (!entry) return;
    entry.textureResources.set(name, resource);
  }

  /**
   * Bulk-set PBR textures (convenience wrapper).
   * Maps GPUMaterialTextures fields to canonical RES names.
   */
  setPBRTextures(meshId: number, textures: GPUMaterialTextures): void {
    const entry = this.meshes.get(meshId);
    if (!entry) return;

    // Replace material textures entirely (not merge) to clear destroyed refs
    entry.material.textures = textures;

    // Repopulate named texture resources (clears stale then adds current)
    this.populatePBRTextureResources(entry.textureResources, textures);

    // Rewrite material buffer (texture flags may have changed)
    this.writeMaterialToBuffer(entry.materialBuffer, entry.material);
  }

  /**
   * Clear a named texture resource.
   */
  clearTextureResource(meshId: number, name: string): void {
    const entry = this.meshes.get(meshId);
    if (!entry) return;
    entry.textureResources.delete(name);
  }

  /**
   * Populate the textureResources map from GPUMaterialTextures.
   */
  /**
   * All canonical PBR texture resource names (textures + samplers).
   * Used by populatePBRTextureResources to clear stale entries.
   */
  private static readonly PBR_RESOURCE_NAMES = [
    RES.BASE_COLOR_TEX, RES.BASE_COLOR_SAMP,
    RES.NORMAL_TEX, RES.NORMAL_SAMP,
    RES.METALLIC_ROUGHNESS_TEX, RES.METALLIC_ROUGHNESS_SAMP,
    RES.OCCLUSION_TEX, RES.OCCLUSION_SAMP,
    RES.EMISSIVE_TEX, RES.EMISSIVE_SAMP,
  ];

  private populatePBRTextureResources(
    resources: Map<string, GPUBindingResource>,
    textures: GPUMaterialTextures,
  ): void {
    // Clear all PBR entries first to remove stale references to destroyed textures
    for (const name of VariantMeshPool.PBR_RESOURCE_NAMES) {
      resources.delete(name);
    }

    // Base color
    if (textures.baseColor) {
      resources.set(RES.BASE_COLOR_TEX, textures.baseColor.view);
      resources.set(RES.BASE_COLOR_SAMP, this.defaultSampler);
    }
    // Normal
    if (textures.normal) {
      resources.set(RES.NORMAL_TEX, textures.normal.view);
      resources.set(RES.NORMAL_SAMP, this.defaultSampler);
    }
    // Metallic-roughness
    if (textures.metallicRoughness) {
      resources.set(RES.METALLIC_ROUGHNESS_TEX, textures.metallicRoughness.view);
      resources.set(RES.METALLIC_ROUGHNESS_SAMP, this.defaultSampler);
    }
    // Occlusion
    if (textures.occlusion) {
      resources.set(RES.OCCLUSION_TEX, textures.occlusion.view);
      resources.set(RES.OCCLUSION_SAMP, this.defaultSampler);
    }
    // Emissive
    if (textures.emissive) {
      resources.set(RES.EMISSIVE_TEX, textures.emissive.view);
      resources.set(RES.EMISSIVE_SAMP, this.defaultSampler);
    }
  }

  // ===================== Bind Group Construction =====================

  /**
   * Build a Group 2 bind group dynamically from the composed shader's bindingLayout.
   * Resources are looked up by canonical name — completely order-independent.
   * Falls back to placeholder textures/samplers for missing resources.
   */
  buildTextureBindGroup(
    meshId: number,
    composedShader: ComposedShader,
    layout: GPUBindGroupLayout,
  ): GPUBindGroup {
    const entry = this.meshes.get(meshId);
    const placeholders = PlaceholderTextures.get(this.ctx);
    const entries: GPUBindGroupEntry[] = [];

    for (const [name, res] of composedShader.bindingLayout) {
      if (res.group !== 'textures') continue;

      // Look up by canonical resource name — order-independent!
      const resource = entry?.textureResources.get(name)
        ?? this.getPlaceholderResource(name, res, placeholders);

      entries.push({ binding: res.bindingIndex, resource });
    }

    return this.ctx.device.createBindGroup({
      label: `variant-pool-tex-bg-mesh${meshId}`,
      layout,
      entries,
    });
  }

  /**
   * Get a placeholder resource for a given shader resource declaration.
   * Maps resource names and kinds to appropriate placeholders.
   */
  private getPlaceholderResource(
    name: string,
    res: ShaderResource & { bindingIndex: number },
    placeholders: PlaceholderTextures,
  ): GPUBindingResource {
    // Samplers
    if (res.kind === 'sampler') {
      if (res.samplerType === 'sampler_comparison') {
        return placeholders.shadowSampler;
      }
      // Cubemap sampler for reflection probe
      if (name === RES.REFLECTION_PROBE_SAMPLER) {
        return placeholders.reflectionProbeSampler;
      }
      return placeholders.linearSampler;
    }

    // Textures — match by canonical resource name
    switch (name) {
      case RES.BASE_COLOR_TEX:
      case RES.METALLIC_ROUGHNESS_TEX:
      case RES.OCCLUSION_TEX:
      case RES.EMISSIVE_TEX:
        return placeholders.whiteView;

      case RES.NORMAL_TEX:
        return placeholders.normalView;

      case RES.REFLECTION_PROBE_CUBEMAP:
        return placeholders.reflectionProbeCubemapView;

      case RES.SSR_PREV_FRAME_TEXTURE:
        return placeholders.ssrTextureView;

      default:
        // Fallback: white for unknown 2d textures, black cubemap for cube textures
        if (res.textureType?.includes('cube')) {
          return placeholders.cubemapView;
        }
        return placeholders.whiteView;
    }
  }

  // ===================== Shared Accessors for VariantRenderer =====================

  /**
   * Get the Group 1 bind group (model matrix + material) for a mesh.
   */
  getModelBindGroup(meshId: number): GPUBindGroup | null {
    return this.meshes.get(meshId)?.modelBindGroup ?? null;
  }

  /**
   * Get the vertex buffer for a mesh.
   */
  getVertexBuffer(meshId: number): GPUBuffer | null {
    return this.meshes.get(meshId)?.vertexBuffer.buffer ?? null;
  }

  /**
   * Get draw parameters for a mesh.
   */
  getDrawParams(meshId: number): DrawParams | null {
    const entry = this.meshes.get(meshId);
    if (!entry) return null;
    return {
      vertexBuffer: entry.vertexBuffer.buffer,
      indexBuffer: entry.indexBuffer?.buffer ?? null,
      indexCount: entry.indexCount,
      vertexCount: entry.vertexCount,
      indexFormat: entry.indexFormat,
    };
  }

  /**
   * Check if a mesh is double-sided.
   */
  isDoubleSided(meshId: number): boolean {
    return this.meshes.get(meshId)?.doubleSided ?? false;
  }

  // ===================== Global Uniforms (Group 0) =====================

  /**
   * Get the global bind group layout (Group 0).
   */
  getGlobalBindGroupLayout(): GPUBindGroupLayout {
    return this.globalBindGroupLayout;
  }

  /**
   * Get the global bind group (Group 0).
   */
  getGlobalBindGroup(): GPUBindGroup {
    return this.globalBindGroup;
  }

  /**
   * Get the model bind group layout (Group 1).
   */
  getModelBindGroupLayout(): GPUBindGroupLayout {
    return this.modelBindGroupLayout;
  }

  /**
   * Write global uniforms (192 bytes — same layout as ObjectRendererGPU).
   */
  writeGlobalUniforms(params: ObjectRenderParams): void {
    const data = new Float32Array(48); // 192 bytes / 4

    // ViewProjection matrix (64 bytes) - indices 0-15
    data.set(params.viewProjectionMatrix as Float32Array, 0);

    // Camera position (12 bytes) + pad (4 bytes) - indices 16-19
    data[16] = params.cameraPosition[0];
    data[17] = params.cameraPosition[1];
    data[18] = params.cameraPosition[2];
    data[19] = 0;

    // Light direction (12 bytes) + pad (4 bytes) - indices 20-23
    const lightDir = params.lightDirection || [0.5, 0.707, 0.5];
    data[20] = lightDir[0];
    data[21] = lightDir[1];
    data[22] = lightDir[2];
    data[23] = 0;

    // Light color (12 bytes) + ambient (4 bytes) - indices 24-27
    const lightColor = params.lightColor || [1, 1, 1];
    data[24] = lightColor[0];
    data[25] = lightColor[1];
    data[26] = lightColor[2];
    data[27] = params.ambientIntensity ?? 0.3;

    // Light space matrix (64 bytes) - indices 28-43
    if (params.lightSpaceMatrix) {
      data.set(params.lightSpaceMatrix as Float32Array, 28);
    } else {
      data[28] = 1; data[33] = 1; data[38] = 1; data[43] = 1;
    }

    // Shadow parameters (16 bytes) - indices 44-47
    data[44] = params.shadowEnabled ? 1.0 : 0.0;
    data[45] = params.shadowBias ?? 0.002;
    data[46] = params.csmEnabled ? 1.0 : 0.0;
    data[47] = 0;

    this.globalUniformBuffer.write(this.ctx, data);
  }

  // ===================== Empty Bind Group =====================

  /**
   * Get an empty bind group (0 entries) for pipeline slots with no bindings.
   */
  getEmptyBindGroup(): { layout: GPUBindGroupLayout; bindGroup: GPUBindGroup } {
    if (!this._emptyBindGroupLayout) {
      this._emptyBindGroupLayout = this.ctx.device.createBindGroupLayout({
        label: 'variant-pool-empty-layout',
        entries: [],
      });
      this._emptyBindGroup = this.ctx.device.createBindGroup({
        label: 'variant-pool-empty-bg',
        layout: this._emptyBindGroupLayout,
        entries: [],
      });
    }
    return { layout: this._emptyBindGroupLayout, bindGroup: this._emptyBindGroup! };
  }

  // ===================== Mesh iteration =====================

  /**
   * Iterate all mesh IDs.
   */
  getAllMeshIds(): IterableIterator<number> {
    return this.meshes.keys();
  }

  /**
   * Get number of registered meshes.
   */
  get meshCount(): number {
    return this.meshes.size;
  }

  // ===================== Internal Helpers =====================

  /**
   * Create interleaved vertex buffer from mesh data.
   * Layout: position (3) + normal (3) + uv (2) = 8 floats = 32 bytes per vertex.
   */
  private createInterleavedBuffer(data: GPUMeshData, id: number): UnifiedGPUBuffer {
    const vertexCount = data.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8);

    for (let i = 0; i < vertexCount; i++) {
      const vi = i * 8;
      const pi = i * 3;
      const ui = i * 2;

      interleavedData[vi + 0] = data.positions[pi + 0];
      interleavedData[vi + 1] = data.positions[pi + 1];
      interleavedData[vi + 2] = data.positions[pi + 2];

      interleavedData[vi + 3] = data.normals[pi + 0];
      interleavedData[vi + 4] = data.normals[pi + 1];
      interleavedData[vi + 5] = data.normals[pi + 2];

      if (data.uvs) {
        interleavedData[vi + 6] = data.uvs[ui + 0];
        interleavedData[vi + 7] = data.uvs[ui + 1];
      }
    }

    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: `variant-pool-vertex-${id}`,
      data: interleavedData,
    });
  }

  /**
   * Write material data to a buffer (96 bytes = 24 floats).
   * Layout must match MaterialUniforms in shader template (same as ObjectRendererGPU).
   */
  private writeMaterialToBuffer(buffer: UnifiedGPUBuffer, material: GPUMaterial): void {
    const data = new Float32Array(24); // 96 bytes / 4

    // albedo (vec3f) + metallic (f32)
    data[0] = material.albedo[0];
    data[1] = material.albedo[1];
    data[2] = material.albedo[2];
    data[3] = material.metallic;

    // roughness + normalScale + occlusionStrength + alphaCutoff
    data[4] = material.roughness;
    data[5] = material.normalScale ?? 1.0;
    data[6] = material.occlusionStrength ?? 1.0;
    data[7] = material.alphaCutoff ?? 0.5;

    // emissiveFactor (vec3f) + useAlphaCutoff flag
    data[8] = material.emissive?.[0] ?? 0;
    data[9] = material.emissive?.[1] ?? 0;
    data[10] = material.emissive?.[2] ?? 0;
    data[11] = material.alphaMode === 'MASK' ? 1.0 : 0.0;

    // Texture flags
    const tex = material.textures;
    data[12] = tex?.baseColor ? 1.0 : 0.0;
    data[13] = tex?.normal ? 1.0 : 0.0;
    data[14] = tex?.metallicRoughness ? 1.0 : 0.0;
    data[15] = tex?.occlusion ? 1.0 : 0.0;

    // IOR / unlit + clearcoat + emissive flag
    data[16] = material.unlit ? -1.0 : (material.ior ?? 1.5);
    data[17] = material.clearcoatFactor ?? 0.0;
    data[18] = material.clearcoatRoughness ?? 0.0;
    data[19] = tex?.emissive ? 1.0 : 0.0;

    // Triplanar mapping
    data[20] = material.triplanarMode ?? 0.0;
    data[21] = material.triplanarScale ?? 1.0;
    data[22] = 0;
    data[23] = 0;

    buffer.write(this.ctx, data);
  }

  // ===================== Cleanup =====================

  /**
   * Destroy all resources.
   */
  destroy(): void {
    for (const entry of this.meshes.values()) {
      entry.vertexBuffer.destroy();
      entry.indexBuffer?.destroy();
      entry.modelBuffer.destroy();
      entry.materialBuffer.destroy();
    }
    this.meshes.clear();

    this.globalUniformBuffer.destroy();
  }
}