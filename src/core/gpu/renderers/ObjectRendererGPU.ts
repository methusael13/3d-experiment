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
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { UnifiedGPUTexture } from '../GPUTexture';
import { RenderPipelineWrapper } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import { ShadowReceiverUtils, type ShadowReceiverResources } from './ShadowReceiverUtils';

// Import shaders
import objectShaderDefault from '../shaders/object.wgsl?raw';
import objectShadowShader from '../shaders/object-shadow.wgsl?raw';

// Import shader manager for live editing
import { registerWGSLShader, getWGSLShaderSource } from '../../../demos/sceneBuilder/shaderManager';

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
  
  // Pipelines (with/without textures, with/without IBL)
  private pipelineWithTextures!: RenderPipelineWrapper;
  private pipelineNoTextures!: RenderPipelineWrapper;
  private pipelineWithTexturesIBL!: RenderPipelineWrapper;
  private pipelineNoTexturesIBL!: RenderPipelineWrapper;
  
  // Bind group layouts
  private globalBindGroupLayout!: GPUBindGroupLayout;
  private modelBindGroupLayout!: GPUBindGroupLayout;
  private textureBindGroupLayout!: GPUBindGroupLayout;
  private shadowMapBindGroupLayout!: GPUBindGroupLayout;  // For receiving shadows
  private iblBindGroupLayout!: GPUBindGroupLayout;        // For IBL textures (Group 4)
  
  // Global uniforms
  private globalUniformBuffer!: UnifiedGPUBuffer;
  private globalBindGroup!: GPUBindGroup;
  
  // Default/placeholder textures
  private placeholderTexture!: UnifiedGPUTexture;
  private placeholderNormalTexture!: UnifiedGPUTexture;
  private defaultSampler!: GPUSampler;
  private placeholderTextureBindGroup!: GPUBindGroup;
  
  // Shadow receiving resources (group 3) - using ShadowReceiverUtils
  private shadowReceiverResources!: ShadowReceiverResources;
  
  // Shadow pass resources
  private shadowPipeline: GPURenderPipeline | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowModelBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowUniformBuffer: UnifiedGPUBuffer | null = null;
  private shadowBindGroup: GPUBindGroup | null = null;
  
  // Registered meshes
  private meshes: Map<number, GPUMeshInternal> = new Map();
  private nextMeshId = 1;
  
  // Current material (for batch rendering optimization)
  private currentMaterialId: number = -1;
  
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
    
    // Create shadow receiving resources using shared utilities
    this.shadowReceiverResources = ShadowReceiverUtils.createResources(ctx.device, 'object-shadow');
    
    // Create bind group layouts
    this.globalBindGroupLayout = new BindGroupLayoutBuilder('object-global-layout')
      .uniformBuffer(0, 'all')      // Global uniforms
      .build(ctx);
    
    this.modelBindGroupLayout = new BindGroupLayoutBuilder('object-model-layout')
      .uniformBuffer(0, 'vertex')   // Model matrix
      .uniformBuffer(1, 'fragment') // Material uniforms (per-mesh)
      .build(ctx);
    
    this.textureBindGroupLayout = this.createTextureBindGroupLayout();
    
    // Use shadow receiver layout from shared utils
    this.shadowMapBindGroupLayout = this.shadowReceiverResources.bindGroupLayout;
    
    // Create IBL bind group layout (Group 4)
    this.iblBindGroupLayout = this.createIBLBindGroupLayout();
    
    // Create pipelines (now with 4 bind group layouts to include shadow map)
    this.pipelineWithTextures = this.createPipeline('fs_main', true);
    this.pipelineNoTextures = this.createPipeline('fs_notex', false);
    
    // Create IBL pipelines (5 bind groups: 0-4)
    this.pipelineWithTexturesIBL = this.createPipelineIBL('fs_main_ibl', true);
    this.pipelineNoTexturesIBL = this.createPipelineIBL('fs_notex_ibl', false);
    
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
      this.pipelineWithTextures = this.createPipeline('fs_main', true);
      this.pipelineNoTextures = this.createPipeline('fs_notex', false);
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
   * Create IBL bind group layout (Group 4)
   * Contains diffuse irradiance cubemap, specular prefilter cubemap, and BRDF LUT
   */
  private createIBLBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'object-ibl-layout',
      entries: [
        // Diffuse irradiance cubemap
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        // Specular prefilter cubemap (with mips for roughness levels)
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        // BRDF integration LUT (2D texture)
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // Cubemap sampler (for diffuse and specular)
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // BRDF LUT sampler (clamp to edge)
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
  }
  
  /**
   * Create IBL bind group from IBL textures
   * Call this to create a bind group from DynamicSkyIBL or HDR IBL textures
   */
  createIBLBindGroup(
    diffuseCubemap: GPUTextureView,
    specularCubemap: GPUTextureView,
    brdfLut: GPUTextureView,
    cubemapSampler?: GPUSampler,
    lutSampler?: GPUSampler,
  ): GPUBindGroup {
    // Create samplers if not provided
    const cubeSampler = cubemapSampler ?? this.ctx.device.createSampler({
      label: 'ibl-cubemap-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    
    const brdfSampler = lutSampler ?? this.ctx.device.createSampler({
      label: 'ibl-brdf-lut-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    
    return this.ctx.device.createBindGroup({
      label: 'object-ibl-bindgroup',
      layout: this.iblBindGroupLayout,
      entries: [
        { binding: 0, resource: diffuseCubemap },
        { binding: 1, resource: specularCubemap },
        { binding: 2, resource: brdfLut },
        { binding: 3, resource: cubeSampler },
        { binding: 4, resource: brdfSampler },
      ],
    });
  }
  
  /**
   * Get the IBL bind group layout (for external creation)
   */
  getIBLBindGroupLayout(): GPUBindGroupLayout {
    return this.iblBindGroupLayout;
  }
  
  /**
   * Create render pipeline
   */
  private createPipeline(fragmentEntry: string, withTextures: boolean): RenderPipelineWrapper {
    // All pipelines include all 4 bind group layouts to keep shadow map at group 3
    // Even non-textured pipelines include texture layout for consistent group indices
    const layouts = [
      this.globalBindGroupLayout,      // group 0
      this.modelBindGroupLayout,       // group 1
      this.textureBindGroupLayout,     // group 2 (always present)
      this.shadowMapBindGroupLayout,   // group 3
    ];
    
    return RenderPipelineWrapper.create(this.ctx, {
      label: `object-pipeline-${fragmentEntry}`,
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
      cullMode: 'back',
      depthFormat: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z
      colorFormats: ['rgba16float'], // HDR intermediate
    });
  }
  
  /**
   * Create IBL render pipeline (with 5 bind groups including IBL)
   */
  private createPipelineIBL(fragmentEntry: string, withTextures: boolean): RenderPipelineWrapper {
    // IBL pipelines have 5 bind groups: groups 0-3 same as regular, plus IBL at group 4
    const layouts = [
      this.globalBindGroupLayout,      // group 0
      this.modelBindGroupLayout,       // group 1
      this.textureBindGroupLayout,     // group 2 (always present)
      this.shadowMapBindGroupLayout,   // group 3
      this.iblBindGroupLayout,         // group 4 (IBL textures)
    ];
    
    return RenderPipelineWrapper.create(this.ctx, {
      label: `object-pipeline-ibl-${fragmentEntry}`,
      vertexShader: this.currentShaderSource,
      fragmentShader: this.currentShaderSource,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: fragmentEntry,
      vertexBuffers: [
        {
          arrayStride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
          ],
        },
      ],
      bindGroupLayouts: layouts,
      topology: 'triangle-list',
      cullMode: 'back',
      depthFormat: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'greater',
      colorFormats: ['rgba16float'],
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
  private hasTextures(material: GPUMaterial): boolean {
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
    
    // Create per-mesh material buffer (64 bytes)
    const materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: `object-material-${id}`,
      size: 64,
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
    const hasTextures = this.hasTextures(material);
    
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
    mesh.hasTextures = this.hasTextures(mesh.material);
    
    // Recreate texture bind group
    if (mesh.hasTextures) {
      mesh.textureBindGroup = this.createTextureBindGroup(mesh.material.textures);
    } else {
      mesh.textureBindGroup = null;
    }
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
    data[46] = 0; // pad
    data[47] = 0; // pad
    
    this.globalUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Write material data to a buffer (64 bytes)
   * Layout must match MaterialUniforms in shader
   */
  private writeMaterialToBuffer(buffer: UnifiedGPUBuffer, material: GPUMaterial): void {
    const data = new Float32Array(16); // 64 bytes / 4
    
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
    
    buffer.write(this.ctx, data);
  }
  
  /**
   * Render all meshes with IBL (Image-Based Lighting)
   * Uses IBL pipelines for ambient lighting from environment cubemaps
   */
  renderWithIBL(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams, iblBindGroup: GPUBindGroup): void {
    if (this.meshes.size === 0) {
      return;
    }
    
    // Update global uniforms
    this.updateGlobalUniforms(params);
    
    // Render meshes grouped by pipeline type
    let currentPipeline: RenderPipelineWrapper | null = null;
    
    for (const mesh of this.meshes.values()) {
      // Select IBL pipeline based on whether mesh has textures
      const targetPipeline = mesh.hasTextures 
        ? this.pipelineWithTexturesIBL 
        : this.pipelineNoTexturesIBL;
      
      // Switch pipeline if needed
      if (currentPipeline !== targetPipeline) {
        passEncoder.setPipeline(targetPipeline.pipeline);
        passEncoder.setBindGroup(0, this.globalBindGroup);
        // Shadow map bind group (group 3)
        passEncoder.setBindGroup(3, this.shadowReceiverResources.currentBindGroup);
        // IBL bind group (group 4)
        passEncoder.setBindGroup(4, iblBindGroup);
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
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
      }
    }
  }
  
  /**
   * Render all meshes (standard, no IBL)
   */
  render(passEncoder: GPURenderPassEncoder, params: ObjectRenderParams): void {
    if (this.meshes.size === 0) {
      return;
    }
    
    // Update global uniforms
    this.updateGlobalUniforms(params);
    
    // Render meshes grouped by pipeline type
    let currentPipeline: RenderPipelineWrapper | null = null;
    
    for (const mesh of this.meshes.values()) {
      // Select pipeline based on whether mesh has textures
      const targetPipeline = mesh.hasTextures 
        ? this.pipelineWithTextures 
        : this.pipelineNoTextures;
      
      // Switch pipeline if needed
      if (currentPipeline !== targetPipeline) {
        passEncoder.setPipeline(targetPipeline.pipeline);
        passEncoder.setBindGroup(0, this.globalBindGroup);
        // Shadow map bind group (group 3) - same for all meshes
        passEncoder.setBindGroup(3, this.shadowReceiverResources.currentBindGroup);
        currentPipeline = targetPipeline;
      }
      
      // Set per-mesh bindings (includes model matrix and material)
      passEncoder.setBindGroup(1, mesh.modelBindGroup);
      
      // Set texture bind group (group 2) - always bind for consistent layout
      if (mesh.hasTextures && mesh.textureBindGroup) {
        passEncoder.setBindGroup(2, mesh.textureBindGroup);
      } else {
        // Use placeholder textures for non-textured meshes
        passEncoder.setBindGroup(2, this.placeholderTextureBindGroup);
      }
      
      passEncoder.setVertexBuffer(0, mesh.vertexBuffer.buffer);
      
      if (mesh.indexBuffer) {
        passEncoder.setIndexBuffer(mesh.indexBuffer.buffer, mesh.indexFormat);
        passEncoder.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
      }
    }
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
   * Set shadow map resources for receiving shadows
   * Call this before render() to enable shadow receiving
   * 
   * @param shadowMapView - The depth texture view from the shadow map
   */
  setShadowResources(shadowMapView: GPUTextureView): void {
    // Use ShadowReceiverUtils to update bind group with actual shadow map
    this.shadowReceiverResources.currentBindGroup = ShadowReceiverUtils.updateBindGroup(
      this.ctx.device,
      this.shadowReceiverResources,
      shadowMapView,
      'object-shadow-map-bindgroup'
    );
  }
  
  /**
   * Clear shadow resources back to placeholder
   */
  clearShadowResources(): void {
    // Use ShadowReceiverUtils to reset to placeholder
    this.shadowReceiverResources.currentBindGroup = ShadowReceiverUtils.updateBindGroup(
      this.ctx.device,
      this.shadowReceiverResources,
      null,  // null = use placeholder
      'object-shadow-map-bindgroup-placeholder'
    );
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
   */
  private createShadowPipeline(): void {
    // Shadow uniform buffer (64 bytes for mat4)
    this.shadowUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'object-shadow-uniforms',
      size: 64,
    });
    
    // Bind group layout for shadow pass global uniforms
    this.shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'object-shadow-global-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
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
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',  // Standard depth for shadow map (not reversed-Z)
      },
    });
    
    // Create shadow bind group
    this.shadowBindGroup = this.ctx.device.createBindGroup({
      label: 'object-shadow-bindgroup',
      layout: this.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformBuffer!.buffer } },
      ],
    });
  }
  
  /**
   * Render all objects to shadow map
   * 
   * Filters objects based on:
   * 1. Per-object castsShadow flag (explicit toggle)
   * 2. Optional distance-based culling (shadowParams.shadowRadius)
   * 
   * @param passEncoder - Shadow map render pass encoder
   * @param lightSpaceMatrix - Light's view-projection matrix
   * @param shadowParams - Optional params for distance-based culling
   */
  renderShadowPass(
    passEncoder: GPURenderPassEncoder,
    lightSpaceMatrix: mat4 | Float32Array,
    lightPosition: vec3,
    shadowParams?: ShadowPassParams
  ): void {
    if (!this.shadowPipeline || !this.shadowUniformBuffer || !this.shadowBindGroup ||
        !this.shadowModelBindGroupLayout) {
      return;
    }
    
    if (this.meshes.size === 0) {
      return;
    }
    
    // Update shadow uniform buffer with light space matrix
    this.shadowUniformBuffer.write(this.ctx, lightSpaceMatrix as Float32Array);
    
    // Set pipeline and global bind group
    passEncoder.setPipeline(this.shadowPipeline);
    passEncoder.setBindGroup(0, this.shadowBindGroup);
    
    // Precompute distance culling params
    const useDistanceCulling = shadowParams && shadowParams.shadowRadius > 0;
    const radiusSq = useDistanceCulling ? shadowParams.shadowRadius * shadowParams.shadowRadius : 0;
    
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
      } else {
        passEncoder.draw(mesh.vertexCount, 1, 0, 0);
      }
    }
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
    
    // Destroy shadow resources
    this.shadowUniformBuffer?.destroy();
    this.shadowPipeline = null;
    this.shadowBindGroupLayout = null;
    this.shadowModelBindGroupLayout = null;
    this.shadowBindGroup = null;
  }
}
