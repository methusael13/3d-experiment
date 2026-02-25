/**
 * ObjectRendererGPU - Unified WebGPU renderer for meshes with PBR textures
 * 
 * Handles both primitives (cubes, spheres, planes) and loaded models (GLB/OBJ).
 * Supports full PBR material system with:
 * - Base color texture
 * - Normal map
 * - Metallic-roughness texture
 * - Occlusion texture
 * - Emissive texture
 * - Shadow mapping
 * - Image-Based Lighting (IBL)
 * 
 * Bind Group Layout (4 groups max - WebGPU limit):
 * - Group 0: Global uniforms (camera, light, shadow params)
 * - Group 1: Per-mesh uniforms (model matrix, material)
 * - Group 2: PBR textures (baseColor, normal, metallicRoughness, occlusion, emissive)
 * - Group 3: Environment (shadow map + IBL cubemaps combined)
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { UnifiedGPUTexture } from '../GPUTexture';
import { RenderPipelineWrapper } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';

// Import shaders
import objectShaderDefault from '../shaders/object.wgsl?raw';
import objectShadowShader from '../shaders/object-shadow.wgsl?raw';
import selectionMaskShader from '../shaders/selection-mask.wgsl?raw';

// Import shader manager for live editing
import { registerWGSLShader, getWGSLShaderSource } from '../../../demos/sceneBuilder/shaderManager';

// Import shared environment (provides Group 3 bind group with shadow + IBL)
import { SceneEnvironment, PlaceholderTextures } from './shared';
import { ENVIRONMENT_BINDINGS, ENV_BINDING_MASK } from './shared/types';

// ============ Types ============

/**
 * Texture set for PBR materials
 */
export interface GPUMaterialTextures {
  baseColor?: UnifiedGPUTexture;
  normal?: UnifiedGPUTexture;
  metallicRoughness?: UnifiedGPUTexture;
  occlusion?: UnifiedGPUTexture;
  emissive?: UnifiedGPUTexture;
}

/**
 * Alpha blending modes (glTF spec)
 */
export type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

/**
 * Material properties for rendering
 */
export interface GPUMaterial {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
  normalScale?: number;
  occlusionStrength?: number;
  alphaMode?: AlphaMode;      // glTF alpha mode: OPAQUE, MASK, or BLEND
  alphaCutoff?: number;       // Only used when alphaMode === 'MASK'
  emissive?: [number, number, number];
  doubleSided?: boolean;      // glTF doubleSided: disable backface culling
  textures?: GPUMaterialTextures;
}

/**
 * Mesh data to be uploaded to GPU
 */
export interface GPUMeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  material?: GPUMaterial;
}

/**
 * Internal GPU mesh representation
 */
interface GPUMeshInternal {
  id: number;
  vertexBuffer: UnifiedGPUBuffer;
  indexBuffer: UnifiedGPUBuffer | null;
  indexCount: number;
  vertexCount: number;
  indexFormat: GPUIndexFormat;
  material: GPUMaterial;
  modelMatrix: Float32Array;
  modelBuffer: UnifiedGPUBuffer;
  materialBuffer: UnifiedGPUBuffer;  // Per-mesh material buffer
  modelBindGroup: GPUBindGroup;
  textureBindGroup: GPUBindGroup | null;
  hasTextures: boolean;
  castsShadow: boolean;  // Per-object shadow casting toggle
}

/**
 * Parameters for shadow pass rendering
 */
export interface ShadowPassParams {
  shadowRadius: number;
}

/**
 * Global render parameters
 */
export interface ObjectRenderParams {
  viewProjectionMatrix: mat4 | Float32Array;
  cameraPosition: [number, number, number];
  lightDirection?: [number, number, number];
  lightColor?: [number, number, number];
  ambientIntensity?: number;
  lightSpaceMatrix?: mat4 | Float32Array;  // For shadow mapping
  shadowEnabled?: boolean;
  shadowBias?: number;
  csmEnabled?: boolean;  // Enable Cascaded Shadow Maps (requires CSM resources in SceneEnvironment)
}

/**
 * IBL resources for environment lighting
 */
export interface IBLResources {
  diffuseCubemap: GPUTextureView;
  specularCubemap: GPUTextureView;
  brdfLut: GPUTextureView;
  cubemapSampler?: GPUSampler;
  lutSampler?: GPUSampler;
}

// ============ Default Values ============

const DEFAULT_MATERIAL: GPUMaterial = {
  albedo: [0.7, 0.7, 0.7],
  metallic: 0.0,
  roughness: 0.5,
  normalScale: 1.0,
  occlusionStrength: 1.0,
  alphaMode: 'OPAQUE',  // Default to OPAQUE - no alpha cutoff
  alphaCutoff: 0.5,
  emissive: [0, 0, 0],
};

// ============ ObjectRendererGPU Class ============

/**
 * Unified object renderer for WebGPU with PBR texture support
 */
export class ObjectRendererGPU {
  private ctx: GPUContext;
  
  // Shader source (for hot-reloading)
  private currentShaderSource: string = objectShaderDefault;
  
  // Pipelines (with/without textures, with/without IBL, single/double-sided)
  private pipelineWithTextures!: RenderPipelineWrapper;
  private pipelineNoTextures!: RenderPipelineWrapper;
  private pipelineWithTexturesIBL!: RenderPipelineWrapper;
  private pipelineNoTexturesIBL!: RenderPipelineWrapper;
  // Double-sided variants (cullMode: 'none')
  private pipelineWithTexturesDS!: RenderPipelineWrapper;
  private pipelineNoTexturesDS!: RenderPipelineWrapper;
  private pipelineWithTexturesIBLDS!: RenderPipelineWrapper;
  private pipelineNoTexturesIBLDS!: RenderPipelineWrapper;
  
  // Bind group layouts
  private globalBindGroupLayout!: GPUBindGroupLayout;
  private modelBindGroupLayout!: GPUBindGroupLayout;
  private textureBindGroupLayout!: GPUBindGroupLayout;
  private environmentBindGroupLayout!: GPUBindGroupLayout;  // Combined shadow + IBL (Group 3)
  
  // Global uniforms
  private globalUniformBuffer!: UnifiedGPUBuffer;
  private globalBindGroup!: GPUBindGroup;
  
  // Default/placeholder textures
  private placeholderTexture!: UnifiedGPUTexture;
  private placeholderNormalTexture!: UnifiedGPUTexture;
  private defaultSampler!: GPUSampler;
  private placeholderTextureBindGroup!: GPUBindGroup;
  
  // Default SceneEnvironment for fallback when none provided
  private defaultSceneEnvironment!: SceneEnvironment;
  
  // Shadow pass resources
  private shadowPipeline: GPURenderPipeline | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Selection mask pipeline (renders selected meshes to a flat mask texture)
  private selectionMaskPipeline: GPURenderPipeline | null = null;
  private selectionMaskGlobalBuffer: GPUBuffer | null = null;
  private selectionMaskGlobalBindGroup: GPUBindGroup | null = null;
  private shadowModelBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowUniformBuffer: UnifiedGPUBuffer | null = null;
  private shadowBindGroup: GPUBindGroup | null = null;
  
  // Dynamic uniform buffer for CSM shadow passes
  // Each slot is 256-byte aligned (WebGPU requirement for dynamic offsets)
  // Slot layout: [cascade0, cascade1, cascade2, cascade3, singleMap]
  private static readonly SHADOW_SLOT_SIZE = 256; // Must be 256-byte aligned
  private static readonly MAX_SHADOW_SLOTS = 5;   // 4 cascades + 1 single map
  
  // Registered meshes
  private meshes: Map<number, GPUMeshInternal> = new Map();
  private nextMeshId = 1;
  
  // Selection state: set of mesh IDs that are currently selected
  private selectedMeshIds: Set<number> = new Set();
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Create global uniform buffer
    // GlobalUniforms: mat4x4f viewProj (64) + vec3f+pad camera (16) + vec3f+pad lightDir (16) + 
    //                 vec3f+f32 lightColor+ambient (16) + mat4x4f lightSpaceMatrix (64) + 
    //                 vec4f shadowParams (16) = 192 bytes
    this.globalUniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'object-global-uniforms',
      size: 192,
    });
    
    // Create default sampler
    this.defaultSampler = ctx.device.createSampler({
      label: 'object-default-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 4,
    });
    
    // Create placeholder textures
    this.placeholderTexture = this.createPlaceholderTexture([128, 128, 128, 255]);
    this.placeholderNormalTexture = this.createPlaceholderTexture([128, 128, 255, 255]); // neutral normal
    
    
    // Create bind group layouts
    this.globalBindGroupLayout = new BindGroupLayoutBuilder('object-global-layout')
      .uniformBuffer(0, 'all')      // Global uniforms
      .build(ctx);
    
    this.modelBindGroupLayout = new BindGroupLayoutBuilder('object-model-layout')
      .uniformBuffer(0, 'vertex')   // Model matrix
      .uniformBuffer(1, 'fragment') // Material uniforms (per-mesh)
      .build(ctx);
    
    this.textureBindGroupLayout = this.createTextureBindGroupLayout();
    
    // Use same layout as SceneEnvironment for consistency (shadow + IBL combined)
    this.environmentBindGroupLayout = this.createEnvironmentBindGroupLayout();
    
    // Create default SceneEnvironment for fallback when none provided
    this.defaultSceneEnvironment = new SceneEnvironment(this.ctx);
    
    // Create pipelines (4 bind group layouts max)
    // Non-IBL pipelines use fs_main/fs_notex
    this.pipelineWithTextures = this.createPipeline('fs_main', true, false, 'back');
    this.pipelineNoTextures = this.createPipeline('fs_notex', false, false, 'back');
    
    // IBL pipelines use fs_main_ibl/fs_notex_ibl
    this.pipelineWithTexturesIBL = this.createPipeline('fs_main_ibl', true, true, 'back');
    this.pipelineNoTexturesIBL = this.createPipeline('fs_notex_ibl', false, true, 'back');
    
    // Double-sided variants (no backface culling) for foliage/leaves
    this.pipelineWithTexturesDS = this.createPipeline('fs_main', true, false, 'none');
    this.pipelineNoTexturesDS = this.createPipeline('fs_notex', false, false, 'none');
    this.pipelineWithTexturesIBLDS = this.createPipeline('fs_main_ibl', true, true, 'none');
    this.pipelineNoTexturesIBLDS = this.createPipeline('fs_notex_ibl', false, true, 'none');
    
    // Create global bind group
    this.globalBindGroup = new BindGroupBuilder('object-global-bindgroup')
      .buffer(0, this.globalUniformBuffer)
      .build(ctx, this.globalBindGroupLayout);
    
    // Create placeholder texture bind group
    this.placeholderTextureBindGroup = this.createTextureBindGroup(null);
    
    // Create shadow pass resources
    this.createShadowPipeline();
    
    // Register shader for live editing
    registerWGSLShader('Object', {
      device: ctx.device,
      source: objectShaderDefault,
      label: 'object-shader',
      onRecompile: (module) => {
        console.log('[ObjectRendererGPU] Shader recompiled, rebuilding pipelines...');
        // Get the new source from shader manager
        const newSource = getWGSLShaderSource('Object');
        if (newSource) {
          this.currentShaderSource = newSource;
          this.rebuildPipelines();
        }
      },
    });
  }
  
  /**
   * Rebuild render pipelines with current shader source
   * Called when shader is hot-reloaded
   */
  private rebuildPipelines(): void {
    try {
      this.pipelineWithTextures = this.createPipeline('fs_main', true, false, 'back');
      this.pipelineNoTextures = this.createPipeline('fs_notex', false, false, 'back');
      this.pipelineWithTexturesIBL = this.createPipeline('fs_main_ibl', true, true, 'back');
      this.pipelineNoTexturesIBL = this.createPipeline('fs_notex_ibl', false, true, 'back');
      this.pipelineWithTexturesDS = this.createPipeline('fs_main', true, false, 'none');
      this.pipelineNoTexturesDS = this.createPipeline('fs_notex', false, false, 'none');
      this.pipelineWithTexturesIBLDS = this.createPipeline('fs_main_ibl', true, true, 'none');
      this.pipelineNoTexturesIBLDS = this.createPipeline('fs_notex_ibl', false, true, 'none');
      console.log('[ObjectRendererGPU] Pipelines rebuilt successfully');
    } catch (error) {
      console.error('[ObjectRendererGPU] Failed to rebuild pipelines:', error);
    }
  }
  
  /**
   * Create texture bind group layout for PBR textures
   */
  private createTextureBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'object-texture-layout',
      entries: [
        // Base color texture + sampler
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // Normal texture + sampler
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // Metallic-roughness texture + sampler
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // Occlusion texture + sampler
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // Emissive texture + sampler
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
  }
  
  /**
   * Create environment bind group layout for Group 3
   * Must match SceneEnvironment's layout exactly - includes CSM bindings 7-8
   */
  private createEnvironmentBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'object-environment-layout',
      entries: SceneEnvironment.getBindGroupLayoutEntriesForMask(ENV_BINDING_MASK.ALL),
    });
  }
  
  /**
   * Get the environment bind group layout (for external use)
   */
  getEnvironmentBindGroupLayout(): GPUBindGroupLayout {
    return this.environmentBindGroupLayout;
  }
  
  /**
   * Create render pipeline
   * All pipelines use same 4 bind group layouts for consistency
   */
  private createPipeline(fragmentEntry: string, withTextures: boolean, withIBL: boolean, cullMode: GPUCullMode = 'back'): RenderPipelineWrapper {
    const layouts = [
      this.globalBindGroupLayout,      // group 0
      this.modelBindGroupLayout,       // group 1
      this.textureBindGroupLayout,     // group 2
      this.environmentBindGroupLayout, // group 3 (shadow + IBL)
    ];
    
    return RenderPipelineWrapper.create(this.ctx, {
      label: `object-pipeline-${fragmentEntry}-${cullMode}`,
      vertexShader: this.currentShaderSource,
      fragmentShader: this.currentShaderSource,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: fragmentEntry,
      vertexBuffers: [
        {
          // Interleaved: position (3) + normal (3) + uv (2) = 8 floats = 32 bytes
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
            { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
            { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
          ],
        },
      ],
      bindGroupLayouts: layouts,
      topology: 'triangle-list',
      cullMode,
      depthFormat: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z
      colorFormats: ['rgba16float'], // HDR intermediate
    });
  }
  
  /**
   * Create placeholder texture (1x1 solid color)
   */
  private createPlaceholderTexture(color: [number, number, number, number]): UnifiedGPUTexture {
    const texture = this.ctx.device.createTexture({
      label: 'placeholder-texture',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    
    this.ctx.queue.writeTexture(
      { texture },
      new Uint8Array(color),
      { bytesPerRow: 4 },
      { width: 1, height: 1 }
    );
    
    return {
      texture,
      view: texture.createView(),
      format: 'rgba8unorm',
      width: 1,
      height: 1,
      destroy: () => texture.destroy(),
    } as UnifiedGPUTexture;
  }
  
  /**
   * Create texture bind group for a material
   */
  private createTextureBindGroup(textures: GPUMaterialTextures | null | undefined): GPUBindGroup {
    const baseColor = textures?.baseColor ?? this.placeholderTexture;
    const normal = textures?.normal ?? this.placeholderNormalTexture;
    const metallicRoughness = textures?.metallicRoughness ?? this.placeholderTexture;
    const occlusion = textures?.occlusion ?? this.placeholderTexture;
    const emissive = textures?.emissive ?? this.placeholderTexture;
    
    return this.ctx.device.createBindGroup({
      label: 'object-texture-bindgroup',
      layout: this.textureBindGroupLayout,
      entries: [
        { binding: 0, resource: baseColor.view },
        { binding: 1, resource: this.defaultSampler },
        { binding: 2, resource: normal.view },
        { binding: 3, resource: this.defaultSampler },
        { binding: 4, resource: metallicRoughness.view },
        { binding: 5, resource: this.defaultSampler },
        { binding: 6, resource: occlusion.view },
        { binding: 7, resource: this.defaultSampler },
        { binding: 8, resource: emissive.view },
        { binding: 9, resource: this.defaultSampler },
      ],
    });
  }
  
  /**
   * Create interleaved vertex buffer from mesh data
   */
  private createInterleavedBuffer(data: GPUMeshData, id: number): UnifiedGPUBuffer {
    const vertexCount = data.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8);
    
    for (let i = 0; i < vertexCount; i++) {
      const vi = i * 8;
      const pi = i * 3;
      const ui = i * 2;
      
      // Position
      interleavedData[vi + 0] = data.positions[pi + 0];
      interleavedData[vi + 1] = data.positions[pi + 1];
      interleavedData[vi + 2] = data.positions[pi + 2];
      
      // Normal
      interleavedData[vi + 3] = data.normals[pi + 0];
      interleavedData[vi + 4] = data.normals[pi + 1];
      interleavedData[vi + 5] = data.normals[pi + 2];
      
      // UV
      if (data.uvs) {
        interleavedData[vi + 6] = data.uvs[ui + 0];
        interleavedData[vi + 7] = data.uvs[ui + 1];
      } else {
        interleavedData[vi + 6] = 0;
        interleavedData[vi + 7] = 0;
      }
    }
    
    return UnifiedGPUBuffer.createVertex(this.ctx, {
      label: `object-vertex-buffer-${id}`,
      data: interleavedData,
    });
  }
  
  /**
   * Check if material has any textures
   */
  private materialHasTextures(material: GPUMaterial): boolean {
    const tex = material.textures;
    if (!tex) return false;
    return !!(tex.baseColor || tex.normal || tex.metallicRoughness || tex.occlusion || tex.emissive);
  }
  
  /**
   * Add a mesh to the renderer
   * @returns Mesh ID for later reference
   */
  addMesh(data: GPUMeshData): number {
    const id = this.nextMeshId++;
    
    // Create vertex buffer
    const vertexBuffer = this.createInterleavedBuffer(data, id);
    
    // Create index buffer if provided
    let indexBuffer: UnifiedGPUBuffer | null = null;
    let indexCount = 0;
    let indexFormat: GPUIndexFormat = 'uint16';
    
    if (data.indices) {
      indexCount = data.indices.length;
      indexFormat = data.indices instanceof Uint32Array ? 'uint32' : 'uint16';
      
      indexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
        label: `object-index-buffer-${id}`,
        data: data.indices,
      });
    }
    
    // Create model matrix buffer
    const modelBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `object-model-${id}`,
      size: 64, // mat4x4f
    });
    
    // Initialize with identity matrix
    const modelMatrix = new Float32Array(16);
    mat4.identity(modelMatrix as unknown as mat4);
    modelBuffer.write(this.ctx, modelMatrix);
    
    // Create per-mesh material buffer (80 bytes - 5×vec4f)
    const materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `object-material-${id}`,
      size: 80,
    });
    
    // Merge material with defaults
    const material: GPUMaterial = {
      ...DEFAULT_MATERIAL,
      ...data.material,
    };
    
    // Write initial material to buffer
    this.writeMaterialToBuffer(materialBuffer, material);
    
    // Create model bind group (includes both model matrix and material)
    const modelBindGroup = new BindGroupBuilder(`object-model-bindgroup-${id}`)
      .buffer(0, modelBuffer)
      .buffer(1, materialBuffer)
      .build(this.ctx, this.modelBindGroupLayout);
    
    // Check if material has textures
    const hasTextures = this.materialHasTextures(material);
    
    // Create texture bind group if needed
    let textureBindGroup: GPUBindGroup | null = null;
    if (hasTextures) {
      textureBindGroup = this.createTextureBindGroup(material.textures);
    }
    
    const mesh: GPUMeshInternal = {
      id,
      vertexBuffer,
      indexBuffer,
      indexCount,
      vertexCount: data.positions.length / 3,
      indexFormat,
      material,
      modelMatrix,
      modelBuffer,
      materialBuffer,
      modelBindGroup,
      textureBindGroup,
      hasTextures,
      castsShadow: true,  // Default: all meshes cast shadows
    };
    
    this.meshes.set(id, mesh);
    
    return id;
  }
  
  /**
   * Remove a mesh from the renderer
   */
  removeMesh(id: number): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    mesh.vertexBuffer.destroy();
    mesh.indexBuffer?.destroy();
    mesh.modelBuffer.destroy();
    mesh.materialBuffer.destroy();
    // Note: textureBindGroup is not destroyed as it references external textures
    
    this.meshes.delete(id);
  }
  
  /**
   * Update transform for a mesh
   */
  setTransform(id: number, modelMatrix: mat4 | Float32Array): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    mesh.modelMatrix.set(modelMatrix as Float32Array);
    mesh.modelBuffer.write(this.ctx, mesh.modelMatrix);
  }
  
  /**
   * Update material for a mesh (without textures)
   */
  setMaterial(id: number, material: Partial<GPUMaterial>): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    if (material.albedo) mesh.material.albedo = [...material.albedo];
    if (material.metallic !== undefined) mesh.material.metallic = material.metallic;
    if (material.roughness !== undefined) mesh.material.roughness = material.roughness;
    if (material.normalScale !== undefined) mesh.material.normalScale = material.normalScale;
    if (material.occlusionStrength !== undefined) mesh.material.occlusionStrength = material.occlusionStrength;
    if (material.alphaCutoff !== undefined) mesh.material.alphaCutoff = material.alphaCutoff;
    if (material.emissive) mesh.material.emissive = [...material.emissive];
    
    // Write updated material to GPU buffer
    this.writeMaterialToBuffer(mesh.materialBuffer, mesh.material);
  }
  
  /**
   * Update textures for a mesh
   */
  setTextures(id: number, textures: GPUMaterialTextures): void {
    const mesh = this.meshes.get(id);
    if (!mesh) return;
    
    mesh.material.textures = { ...mesh.material.textures, ...textures };
    mesh.hasTextures = this.materialHasTextures(mesh.material);
    
    // Recreate texture bind group
    if (mesh.hasTextures) {
      mesh.textureBindGroup = this.createTextureBindGroup(mesh.material.textures);
    } else {
      mesh.textureBindGroup = null;
    }
  }
  
  /**
   * Write material data to a buffer (80 bytes = 20 floats)
   * Layout must match MaterialUniforms in shader
   */
  private writeMaterialToBuffer(buffer: UnifiedGPUBuffer, material: GPUMaterial): void {
    const data = new Float32Array(20); // 80 bytes / 4
    
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
    // useAlphaCutoff: 1.0 = alphaMode is MASK (apply cutoff), 0.0 = OPAQUE/BLEND (no cutoff)
    data[11] = material.alphaMode === 'MASK' ? 1.0 : 0.0;
    
    // Texture flags
    const tex = material.textures;
    data[12] = tex?.baseColor ? 1.0 : 0.0;
    data[13] = tex?.normal ? 1.0 : 0.0;
    data[14] = tex?.metallicRoughness ? 1.0 : 0.0;
    data[15] = tex?.occlusion ? 1.0 : 0.0;
    
    // Reserved (vec4f) - selection is now handled via separate outline pass
    data[16] = 0.0; // _reserved0
    data[17] = 0.0; // _reserved1
    data[18] = 0.0; // pad
    data[19] = 0.0; // pad
    
    buffer.write(this.ctx, data);
  }
  
  /**
   * Update global uniforms (192 bytes total)
   */
  private updateGlobalUniforms(params: ObjectRenderParams): void {
    const data = new Float32Array(48); // 192 bytes / 4
    
    // ViewProjection matrix (64 bytes) - indices 0-15
    data.set(params.viewProjectionMatrix as Float32Array, 0);
    
    // Camera position (12 bytes) + pad (4 bytes) - indices 16-19
    data[16] = params.cameraPosition[0];
    data[17] = params.cameraPosition[1];
    data[18] = params.cameraPosition[2];
    data[19] = 0; // pad
    
    // Light direction (12 bytes) + pad (4 bytes) - indices 20-23
    const lightDir = params.lightDirection || [0.5, 0.707, 0.5];
    data[20] = lightDir[0];
    data[21] = lightDir[1];
    data[22] = lightDir[2];
    data[23] = 0; // pad
    
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
      // Identity matrix as default
      data[28] = 1; data[29] = 0; data[30] = 0; data[31] = 0;
      data[32] = 0; data[33] = 1; data[34] = 0; data[35] = 0;
      data[36] = 0; data[37] = 0; data[38] = 1; data[39] = 0;
      data[40] = 0; data[41] = 0; data[42] = 0; data[43] = 1;
    }
    
    // Shadow parameters (16 bytes) - indices 44-47
    data[44] = params.shadowEnabled ? 1.0 : 0.0;
    data[45] = params.shadowBias ?? 0.002;
    data[46] = params.csmEnabled ? 1.0 : 0.0;  // CSM enabled flag
    data[47] = 0; // pad
    
    this.globalUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Render all meshes using SceneEnvironment for Group 3 (shadow + IBL)
   * This is the main rendering entry point for unified environment handling
   */
  renderWithSceneEnvironment(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams, sceneEnv: SceneEnvironment | null): number {
    // Use provided SceneEnvironment or fall back to default (with placeholders)
    const environment = sceneEnv ?? this.defaultSceneEnvironment;
    // Check if SceneEnvironment has valid IBL textures (not just placeholders)
    const useIBL = environment.hasIBL();
    return this.renderInternal(passEncoder, params, environment.bindGroup, useIBL);
  }
  
  /**
   * Internal render method with explicit environment bind group
   * @param useIBL - If true, use IBL pipelines; if false, use hemisphere ambient fallback
   */
  private renderInternal(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams, environmentBindGroup: GPUBindGroup, useIBL: boolean): number {
    if (this.meshes.size === 0) {
      return 0;
    }
    
    // Update global uniforms
    this.updateGlobalUniforms(params);
    
    // Render meshes grouped by pipeline type
    let currentPipeline: RenderPipelineWrapper | null = null;

    let drawCalls = 0;
    for (const mesh of this.meshes.values()) {
      // Select pipeline based on:
      // 1. Whether mesh has textures
      // 2. Whether valid IBL is available (not just placeholders)
      // When IBL disabled, use fs_main/fs_notex which have hemisphere ambient fallback
      const doubleSided = mesh.material.doubleSided ?? false;
      let targetPipeline: RenderPipelineWrapper;
      if (useIBL) {
        if (doubleSided) {
          targetPipeline = mesh.hasTextures ? this.pipelineWithTexturesIBLDS : this.pipelineNoTexturesIBLDS;
        } else {
          targetPipeline = mesh.hasTextures ? this.pipelineWithTexturesIBL : this.pipelineNoTexturesIBL;
        }
      } else {
        if (doubleSided) {
          targetPipeline = mesh.hasTextures ? this.pipelineWithTexturesDS : this.pipelineNoTexturesDS;
        } else {
          targetPipeline = mesh.hasTextures ? this.pipelineWithTextures : this.pipelineNoTextures;
        }
      }
      
      // Switch pipeline if needed
      if (currentPipeline !== targetPipeline) {
        passEncoder.setPipeline(targetPipeline.pipeline);
        passEncoder.setBindGroup(0, this.globalBindGroup);
        // Environment bind group (group 3) - from SceneEnvironment
        passEncoder.setBindGroup(3, environmentBindGroup);
        currentPipeline = targetPipeline;
      }
      
      // Set per-mesh bindings (includes model matrix and material)
      passEncoder.setBindGroup(1, mesh.modelBindGroup);
      
      // Set texture bind group (group 2) - always bind for consistent layout
      if (mesh.hasTextures && mesh.textureBindGroup) {
        passEncoder.setBindGroup(2, mesh.textureBindGroup);
      } else {
        passEncoder.setBindGroup(2, this.placeholderTextureBindGroup);
      }
      
      passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
      
      if (mesh.indexBuffer) {
        passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
        passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
        drawCalls++;
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
        drawCalls++;
      }
    }

    return drawCalls;
  }
  
  /**
   * Render all meshes (uses default SceneEnvironment with placeholders)
   * @deprecated Use renderWithSceneEnvironment() for unified environment handling
   */
  render(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams): void {
    this.renderWithSceneEnvironment(passEncoder, params, null);
  }
  
  /**
   * Get number of registered meshes
   */
  get meshCount(): number {
    return this.meshes.size;
  }
  
  /**
   * Check if a mesh exists
   */
  hasMesh(id: number): boolean {
    return this.meshes.has(id);
  }
  
  /**
   * Get mesh material (for UI display)
   */
  getMaterial(id: number): GPUMaterial | null {
    const mesh = this.meshes.get(id);
    return mesh?.material ?? null;
  }
  
  /**
   * Set whether a mesh casts shadows
   */
  setCastsShadow(id: number, castsShadow: boolean): void {
    const mesh = this.meshes.get(id);
    if (mesh) {
      mesh.castsShadow = castsShadow;
    }
  }
  
  /**
   * Get whether a mesh casts shadows
   */
  getCastsShadow(id: number): boolean {
    const mesh = this.meshes.get(id);
    return mesh?.castsShadow ?? false;
  }
  
  /**
   * Update selection state for all meshes.
   * The selection mask pass reads from this set to decide which meshes to render.
   */
  setSelectedMeshIds(selectedIds: Set<number>): void {
    this.selectedMeshIds = new Set(selectedIds);
  }
  
  /**
   * Get world position from model matrix (translation component)
   * Used for distance-based shadow culling
   */
  private getWorldPosition(modelMatrix: Float32Array): [number, number, number] {
    // Translation is in the 4th column (indices 12, 13, 14) of column-major matrix
    return [modelMatrix[12], modelMatrix[13], modelMatrix[14]];
  }
  
  // ============ Shadow Pass ============
  
  /**
   * Create shadow pass pipeline and resources
   * Uses a dynamic uniform buffer with 256-byte aligned slots to support
   * multiple light-space matrices (CSM cascades + single map) without
   * the writeBuffer race condition.
   */
  private createShadowPipeline(): void {
    const slotSize = ObjectRendererGPU.SHADOW_SLOT_SIZE;
    const totalSize = slotSize * ObjectRendererGPU.MAX_SHADOW_SLOTS;
    
    // Shadow uniform buffer: 5 slots × 256 bytes = 1280 bytes
    // Each slot holds one mat4x4f (64 bytes) padded to 256-byte alignment
    this.shadowUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'object-shadow-uniforms-dynamic',
      size: totalSize,
    });
    
    // Bind group layout for shadow pass global uniforms (dynamic offset)
    this.shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'object-shadow-global-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    });
    
    // Bind group layout for per-model uniforms (reuse model matrix from existing layout)
    this.shadowModelBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'object-shadow-model-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    
    // Create pipeline layout
    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'object-shadow-pipeline-layout',
      bindGroupLayouts: [this.shadowBindGroupLayout, this.shadowModelBindGroupLayout],
    });
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'object-shadow-shader',
      code: objectShadowShader,
    });
    
    // Create depth-only render pipeline
    this.shadowPipeline = this.ctx.device.createRenderPipeline({
      label: 'object-shadow-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_shadow',
        buffers: [
          {
            // Same interleaved layout as main shader: position (3) + normal (3) + uv (2)
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
              { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
              { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
            ],
          },
        ],
      },
      // No fragment shader - depth-only rendering
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',  // No culling for shadow maps - ensures shadows cast even when light is inside geometry
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',  // Standard depth for shadow map (not reversed-Z)
      },
    });
    
    // Create shadow bind group with dynamic offset support
    // The size must match what the shader expects (64 bytes for mat4x4f)
    this.shadowBindGroup = this.ctx.device.createBindGroup({
      label: 'object-shadow-bindgroup',
      layout: this.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformBuffer!.buffer, size: 64 } },
      ],
    });
  }
  
  /**
   * Pre-write all shadow matrices to the dynamic uniform buffer.
   * Must be called ONCE before recording any shadow render passes.
   * 
   * @param matrices - Array of light-space matrices to write.
   *   For CSM: [cascade0, cascade1, cascade2, cascade3, singleMap]
   *   For single map only: [singleMap]
   */
  writeShadowMatrices(matrices: (mat4 | Float32Array)[]): void {
    if (!this.shadowUniformBuffer) return;
    
    const slotSize = ObjectRendererGPU.SHADOW_SLOT_SIZE;
    const floatsPerSlot = slotSize / 4; // 64 floats per 256-byte slot
    const totalFloats = floatsPerSlot * matrices.length;
    const data = new Float32Array(totalFloats);
    
    for (let i = 0; i < matrices.length; i++) {
      // Write mat4 (16 floats = 64 bytes) at the start of each 256-byte slot
      data.set(matrices[i] as Float32Array, i * floatsPerSlot);
    }
    
    this.shadowUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Render all objects to shadow map using a pre-written matrix slot.
   * 
   * Call writeShadowMatrices() once before recording render passes,
   * then call this method for each cascade/single-map pass with the
   * appropriate slotIndex to select the correct light-space matrix
   * via dynamic uniform buffer offset.
   * 
   * Filters objects based on:
   * 1. Per-object castsShadow flag (explicit toggle)
   * 2. Optional distance-based culling (shadowParams.shadowRadius)
   * 
   * @param passEncoder - Shadow map render pass encoder
   * @param slotIndex - Index into the pre-written matrix slots (0-4)
   * @param lightPosition - Light position for distance culling
   * @param shadowParams - Optional params for distance-based culling
   */
  renderShadowPass(
    passEncoder: GPURenderPassEncoder,
    slotIndex: number,
    lightPosition: vec3,
    shadowParams?: ShadowPassParams
  ): number {
    if (!this.shadowPipeline || !this.shadowUniformBuffer || !this.shadowBindGroup ||
        !this.shadowModelBindGroupLayout) {
      return 0;
    }
    
    if (this.meshes.size === 0) {
      return 0;
    }
    
    // Calculate dynamic offset for this slot (256-byte aligned)
    const dynamicOffset = slotIndex * ObjectRendererGPU.SHADOW_SLOT_SIZE;
    
    // Set pipeline and global bind group with dynamic offset
    passEncoder.setPipeline(this.shadowPipeline);
    passEncoder.setBindGroup(0, this.shadowBindGroup, [dynamicOffset]);
    
    // Precompute distance culling params
    const useDistanceCulling = shadowParams && shadowParams.shadowRadius > 0;
    const radiusSq = useDistanceCulling ? shadowParams.shadowRadius * shadowParams.shadowRadius : 0;
    
    let drawCalls = 0;
    // Render each mesh that passes culling
    for (const mesh of this.meshes.values()) {
      // Skip if castsShadow is disabled
      if (!mesh.castsShadow) {
        continue;
      }
      
      // Skip if outside shadow radius (distance-based culling)
      if (useDistanceCulling) {
        const worldPos = this.getWorldPosition(mesh.modelMatrix);
        const dx = worldPos[0] - lightPosition[0];
        const dy = worldPos[1] - lightPosition[1];
        const dz = worldPos[2] - lightPosition[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        
        if (distSq > radiusSq) {
          continue;
        }
      }
      
      // Create per-mesh bind group for shadow pass (only model matrix needed)
      // We reuse the existing modelBuffer which already has the model matrix
      const modelBindGroup = this.ctx.device.createBindGroup({
        label: `object-shadow-model-${mesh.id}`,
        layout: this.shadowModelBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: mesh.modelBuffer.buffer } },
        ],
      });
      
      passEncoder.setBindGroup(1, modelBindGroup);
      passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
      
      if (mesh.indexBuffer) {
        passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
        passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
        drawCalls++;
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
        drawCalls++;
      }
    }

    return drawCalls;
  }
  
  // ============ Selection Mask Pass ============
  
  /**
   * Create selection mask pipeline (lazy init on first use)
   * Renders selected meshes as flat white to an r8unorm mask texture.
   * Uses depth-equal test against the main depth buffer so only visible
   * selected pixels are marked.
   */
  private ensureSelectionMaskPipeline(): void {
    if (this.selectionMaskPipeline) return;
    
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'selection-mask-shader',
      code: selectionMaskShader,
    });
    
    // Global bind group layout: viewProjection uniform
    const globalLayout = this.ctx.device.createBindGroupLayout({
      label: 'selection-mask-global-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    
    // Per-model bind group layout: model matrix uniform
    const modelLayout = this.ctx.device.createBindGroupLayout({
      label: 'selection-mask-model-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    
    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'selection-mask-pipeline-layout',
      bindGroupLayouts: [globalLayout, modelLayout],
    });
    
    this.selectionMaskPipeline = this.ctx.device.createRenderPipeline({
      label: 'selection-mask-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'r8unorm' }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,     // Don't write to depth
        depthCompare: 'greater-equal', // Reversed-Z: pass if equal to existing depth
      },
    });
    
    // Create global uniform buffer (80 bytes: mat4x4f + vec3f + pad)
    this.selectionMaskGlobalBuffer = this.ctx.device.createBuffer({
      label: 'selection-mask-global-uniforms',
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Create global bind group
    this.selectionMaskGlobalBindGroup = this.ctx.device.createBindGroup({
      label: 'selection-mask-global-bindgroup',
      layout: globalLayout,
      entries: [
        { binding: 0, resource: { buffer: this.selectionMaskGlobalBuffer } },
      ],
    });
  }
  
  /**
   * Render selected meshes to a selection mask texture.
   * Only meshes in selectedMeshIds are drawn.
   * 
   * @param passEncoder - Render pass targeting an r8unorm texture with depth read
   * @param viewProjectionMatrix - Camera view-projection matrix
   * @param cameraPosition - Camera position for the global uniform
   */
  renderSelectionMask(
    passEncoder: GPURenderPassEncoder,
    viewProjectionMatrix: mat4 | Float32Array,
    cameraPosition: [number, number, number]
  ): number {
    if (this.selectedMeshIds.size === 0) return 0;
    
    this.ensureSelectionMaskPipeline();
    if (!this.selectionMaskPipeline || !this.selectionMaskGlobalBuffer || !this.selectionMaskGlobalBindGroup) return 0;
    
    // Update global uniforms (viewProjection + cameraPosition)
    const data = new Float32Array(20); // 80 bytes
    data.set(viewProjectionMatrix as Float32Array, 0);
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = 0;
    this.ctx.queue.writeBuffer(this.selectionMaskGlobalBuffer, 0, data);
    
    passEncoder.setPipeline(this.selectionMaskPipeline);
    passEncoder.setBindGroup(0, this.selectionMaskGlobalBindGroup);
    
    let drawCalls = 0;
    for (const meshId of this.selectedMeshIds) {
      const mesh = this.meshes.get(meshId);
      if (!mesh) continue;
      
      // Create per-mesh bind group (model matrix only)
      const modelBindGroup = this.ctx.device.createBindGroup({
        label: `selection-mask-model-${mesh.id}`,
        layout: this.selectionMaskPipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: mesh.modelBuffer.buffer } },
        ],
      });
      
      passEncoder.setBindGroup(1, modelBindGroup);
      passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
      
      if (mesh.indexBuffer) {
        passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
        passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
        drawCalls++;
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
        drawCalls++;
      }
    }

    return drawCalls;
  }
  
  /**
   * Check if there are any selected meshes
   */
  hasSelectedMeshes(): boolean {
    return this.selectedMeshIds.size > 0;
  }
  
  // ============ Cleanup ============
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    // Destroy all meshes
    for (const mesh of this.meshes.values()) {
      mesh.vertexBuffer.destroy();
      mesh.indexBuffer?.destroy();
      mesh.modelBuffer.destroy();
      mesh.materialBuffer.destroy();
    }
    this.meshes.clear();
    
    // Destroy shared resources
    this.globalUniformBuffer.destroy();
    this.placeholderTexture.destroy();
    this.placeholderNormalTexture.destroy();
    // defaultSceneEnvironment resources cleaned up when PlaceholderTextures singleton is released
    
    // Destroy shadow resources
    this.shadowUniformBuffer?.destroy();
    this.shadowPipeline = null;
    this.shadowBindGroupLayout = null;
    this.shadowModelBindGroupLayout = null;
    this.shadowBindGroup = null;
    
    // Destroy selection mask resources
    this.selectionMaskGlobalBuffer?.destroy();
    this.selectionMaskPipeline = null;
    this.selectionMaskGlobalBindGroup = null;
  }
}
