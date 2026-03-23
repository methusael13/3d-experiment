/**
 * VegetationBillboardRenderer
 * 
 * Renders vegetation instances as camera-facing billboard quads.
 * Uses the shared instance buffer from VegetationSpawner.
 * Only draws instances where renderFlag = 0 (billboard mode).
 * 
 * Uses dynamic uniform buffer offsets so each draw call (per plant type)
 * gets its own uniform data within the same render pass.
 * 
 * Supports full environment lighting matching the grass-blade renderer:
 * - CSM shadow receiving
 * - Vegetation shadow map receiving
 * - Cloud shadow receiving
 * - Multi-light (point + spot with spot shadows)
 * - Normal map support (tangent-space → world-space)
 * - Translucency / subsurface scattering
 * - Hemisphere ambient lighting
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  RenderPipelineWrapper,
  CommonBlendStates,
  SamplerFactory,
} from '../gpu';
import type { WindParams, VegetationLightParams } from './types';
import { DEFAULT_VEGETATION_LIGHT } from './types';
import { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';
import { ENV_BINDING_MASK } from '../gpu/renderers/shared/types';

// Import shader source
import billboardShader from '../gpu/shaders/vegetation/billboard.wgsl?raw';

// ==================== Constants ====================

/**
 * Uniforms struct size:
 * mat4x4f(64) + vec3f+f32(16) + 4xf32(16) + vec3f+f32(16) + vec4f(16) +
 * vec3f+f32(16) + vec3f+f32(16) + vec3f+f32(16) + vec3f+f32(16) = 192 bytes
 */
const UNIFORMS_SIZE = 192;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame (each uses one slot) — must accommodate CDLOD tiles × plant types */
const MAX_DRAW_SLOTS = 512;

/** WindParams struct size: vec2f(8) + f32(4) + f32(4) + f32(4) + f32(4) + vec2f(8) = 32 bytes */
const WIND_PARAMS_SIZE = 32;

/** Vertices per cross-billboard (2 quads at 90° = 4 triangles = 12 vertices) */
const VERTICES_PER_QUAD = 12;

/** Bitmask for billboard environment bindings: CSM shadow + multi-light + spot shadow + cloud shadow */
const BILLBOARD_ENV_MASK = ENV_BINDING_MASK.CSM_SHADOW | ENV_BINDING_MASK.MULTI_LIGHT | ENV_BINDING_MASK.SPOT_SHADOW
  | ENV_BINDING_MASK.CLOUD_SHADOW | ENV_BINDING_MASK.IBL_CUBE_SAMPLER;

// ==================== VegetationBillboardRenderer ====================

export class VegetationBillboardRenderer {
  private ctx: GPUContext;
  
  // Pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Dynamic uniform buffer (holds multiple slots for per-draw-call data)
  private uniformsBuffer: GPUBuffer | null = null;
  private windBuffer: UnifiedGPUBuffer | null = null;
  
  // Current slot index within the dynamic buffer (reset each frame)
  private currentSlot = 0;
  
  // Default placeholder textures
  private defaultTexture: UnifiedGPUTexture | null = null;
  private defaultNormalTexture: UnifiedGPUTexture | null = null;
  private defaultTranslucencyTexture: UnifiedGPUTexture | null = null;
  private sampler: GPUSampler | null = null;
  
  // Scene environment for shadow/light receiving
  private sceneEnvironment: SceneEnvironment | null = null;
  
  // Vegetation shadow map bind group (Group 2) resources
  private _vegShadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private _vegShadowPlaceholderTexture: GPUTexture | null = null;
  private _vegShadowPlaceholderView: GPUTextureView | null = null;
  private _vegShadowComparisonSampler: GPUSampler | null = null;
  private _vegShadowPlaceholderUniform: GPUBuffer | null = null;
  
  private initialized = false;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  // ==================== Initialization ====================
  
  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;
    
    // Group 0: Per-draw uniforms + instance buffer + textures (albedo, normal, translucency)
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-billboard-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORMS_SIZE },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
      ],
    });
    
    // Group 1: Environment shadow (CSM) — uses SceneEnvironment masked layout
    const envLayout = SceneEnvironment.getBindGroupLayoutEntriesForMask(BILLBOARD_ENV_MASK);
    const envBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-billboard-env-layout-g1',
      entries: envLayout,
    });
    
    // Group 2: Vegetation shadow map (depth texture + comparison sampler + uniforms)
    this._vegShadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-billboard-veg-shadow-layout-g2',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    
    // Create placeholder resources for when no veg shadow map is active
    this._vegShadowPlaceholderTexture = this.ctx.device.createTexture({
      label: 'billboard-veg-shadow-placeholder',
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._vegShadowPlaceholderView = this._vegShadowPlaceholderTexture.createView();
    this._vegShadowComparisonSampler = this.ctx.device.createSampler({
      label: 'billboard-veg-shadow-comparison-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    // Placeholder uniform buffer (96 bytes, all zeros = enabled=0 → disabled)
    this._vegShadowPlaceholderUniform = this.ctx.device.createBuffer({
      label: 'billboard-veg-shadow-placeholder-uniform',
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Render pipeline
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-billboard-pipeline',
      vertexShader: billboardShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout, envBindGroupLayout, this._vegShadowBindGroupLayout],
      vertexBuffers: [], // No vertex buffers — all data from storage buffer
      colorFormats: [colorFormat, colorFormat],
      blendStates: [CommonBlendStates.alpha(), CommonBlendStates.alpha()],
      depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z depth buffer
      topology: 'triangle-list',
      cullMode: 'none', // Billboards visible from both sides
    });
    
    // Dynamic uniform buffer — one 256-byte aligned slot per draw call
    this.uniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-billboard-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    this.windBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-billboard-wind',
      size: WIND_PARAMS_SIZE,
    });
    
    // Default 1x1 white texture (albedo placeholder)
    this.defaultTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-default-texture',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      sampled: true,
    });
    this.ctx.queue.writeTexture(
      { texture: this.defaultTexture.texture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    
    // Default 1x1 flat normal texture (0.5, 0.5, 1.0 = tangent-space up)
    this.defaultNormalTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-default-normal',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      sampled: true,
    });
    this.ctx.queue.writeTexture(
      { texture: this.defaultNormalTexture.texture },
      new Uint8Array([128, 128, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    
    // Default 1x1 black translucency texture (no translucency)
    this.defaultTranslucencyTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'vegetation-default-translucency',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      sampled: true,
    });
    this.ctx.queue.writeTexture(
      { texture: this.defaultTranslucencyTexture.texture },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    
    // Sampler with linear filtering
    this.sampler = SamplerFactory.linear(this.ctx, 'vegetation-billboard-sampler');
    
    this.initialized = true;
  }
  
  // ==================== Frame Management ====================
  
  /**
   * Reset the dynamic buffer slot counter. Call once at the start of each frame.
   */
  resetFrame(): void {
    this.currentSlot = 0;
  }
  
  /**
   * Set the scene environment for shadow/light receiving.
   */
  setSceneEnvironment(env: SceneEnvironment | null): void {
    this.sceneEnvironment = env;
  }
  
  /**
   * Set environment bind group (group 1) on the pass encoder.
   */
  private _setEnvBindGroup(passEncoder: GPURenderPassEncoder): void {
    if (this.sceneEnvironment) {
      const envBindGroup = this.sceneEnvironment.getBindGroupForMask(BILLBOARD_ENV_MASK);
      passEncoder.setBindGroup(1, envBindGroup);
    }
  }
  
  /**
   * Set vegetation shadow bind group (group 2) on the pass encoder.
   */
  private _setVegShadowBindGroup(passEncoder: GPURenderPassEncoder): void {
    if (!this._vegShadowBindGroupLayout || !this._vegShadowComparisonSampler) return;

    const vegView = this.sceneEnvironment?.getVegetationShadowView() ?? null;
    const vegUniform = this.sceneEnvironment?.getVegetationShadowUniformBuffer() ?? null;

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'billboard-veg-shadow-bg',
      layout: this._vegShadowBindGroupLayout,
      entries: [
        { binding: 0, resource: vegView ?? this._vegShadowPlaceholderView! },
        { binding: 1, resource: this._vegShadowComparisonSampler },
        { binding: 2, resource: { buffer: vegUniform ?? this._vegShadowPlaceholderUniform! } },
      ],
    });

    passEncoder.setBindGroup(2, bindGroup);
  }
  
  // ==================== Rendering ====================
  
  /**
   * Render billboard vegetation instances.
   * Each call writes to a unique slot in the dynamic uniform buffer,
   * ensuring per-draw-call uniform data within the same render pass.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    instanceBuffer: UnifiedGPUBuffer,
    instanceCount: number,
    texture: UnifiedGPUTexture | null,
    normalTexture: UnifiedGPUTexture | null,
    translucencyTexture: UnifiedGPUTexture | null,
    fallbackColor: [number, number, number],
    atlasRegion: [number, number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    light?: VegetationLightParams,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (instanceCount === 0) return;
    if (this.currentSlot >= MAX_DRAW_SLOTS) {
      console.warn('[VegetationBillboardRenderer] Max draw slots exceeded, skipping draw');
      return;
    }
    
    const hasRealTexture = texture !== null;
    const hasNormalMap = normalTexture !== null;
    const hasTranslucencyMap = translucencyTexture !== null;
    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, hasRealTexture, atlasRegion, slotOffset, 0, light, hasNormalMap, hasTranslucencyMap);
    this.writeWindParams(wind);
    
    const plantTexture = texture ?? this.defaultTexture!;
    const plantNormal = normalTexture ?? this.defaultNormalTexture!;
    const plantTranslucency = translucencyTexture ?? this.defaultTranslucencyTexture!;
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-billboard-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: instanceBuffer.buffer } },
        { binding: 3, resource: plantTexture.view },
        { binding: 4, resource: this.sampler! },
        { binding: 5, resource: plantNormal.view },
        { binding: 6, resource: plantTranslucency.view },
      ],
    });
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    this._setEnvBindGroup(passEncoder);
    this._setVegShadowBindGroup(passEncoder);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.draw(VERTICES_PER_QUAD, instanceCount);
    
    this.currentSlot++;
  }
  
  /**
   * Render billboard vegetation using GPU indirect draw.
   * Uses pre-culled instance buffer and indirect draw args from VegetationCullingPipeline.
   * 
   * drawArgsBuffer layout at offset 0:
   *   [0] vertexCount (12), [1] instanceCount, [2] firstVertex (0), [3] firstInstance (0)
   */
  renderIndirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    texture: UnifiedGPUTexture | null,
    normalTexture: UnifiedGPUTexture | null,
    translucencyTexture: UnifiedGPUTexture | null,
    fallbackColor: [number, number, number],
    atlasRegion: [number, number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    lodLevel: number = 0,
    light?: VegetationLightParams,
  ): number {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return 0;
    if (this.currentSlot >= MAX_DRAW_SLOTS) {
      console.warn('[VegetationBillboardRenderer] Max draw slots exceeded, skipping indirect draw');
      return 0;
    }
    
    const hasRealTexture = texture !== null;
    const hasNormalMap = normalTexture !== null;
    const hasTranslucencyMap = translucencyTexture !== null;
    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, hasRealTexture, atlasRegion, slotOffset, lodLevel, light, hasNormalMap, hasTranslucencyMap);
    this.writeWindParams(wind);
    
    const plantTexture = texture ?? this.defaultTexture!;
    const plantNormal = normalTexture ?? this.defaultNormalTexture!;
    const plantTranslucency = translucencyTexture ?? this.defaultTranslucencyTexture!;
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-billboard-indirect-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: culledInstanceBuffer } },
        { binding: 3, resource: plantTexture.view },
        { binding: 4, resource: this.sampler! },
        { binding: 5, resource: plantNormal.view },
        { binding: 6, resource: plantTranslucency.view },
      ],
    });
    
    passEncoder.setPipeline(this.pipeline.pipeline);
    this._setEnvBindGroup(passEncoder);
    this._setVegShadowBindGroup(passEncoder);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.drawIndirect(drawArgsBuffer, 0); // Billboard draw args at offset 0
    
    this.currentSlot++;
    return 1;
  }
  
  // ==================== Uniform Writing ====================
  
  private writeUniformsAtOffset(
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    time: number,
    maxDistance: number,
    fallbackColor: [number, number, number],
    useTexture: boolean,
    atlasRegion: [number, number, number, number],
    bufferOffset: number,
    lodLevel: number = 0,
    light?: VegetationLightParams,
    useNormalMap: boolean = false,
    useTranslucencyMap: boolean = false,
  ): void {
    const l = light ?? DEFAULT_VEGETATION_LIGHT;
    const data = new Float32Array(UNIFORMS_SIZE / 4);
    
    // viewProjection mat4x4f (offset 0-15)
    data.set(viewProjection, 0);
    
    // cameraPosition vec3f + time f32 (offset 16-19)
    data[16] = cameraPosition[0];
    data[17] = cameraPosition[1];
    data[18] = cameraPosition[2];
    data[19] = time;
    
    // maxFadeDistance, fadeStartRatio, lodLevel, maxLodLevels (offset 20-23)
    data[20] = maxDistance;
    data[21] = 0.75; // Start fading at 75% of max distance
    data[22] = lodLevel; // CDLOD LOD level (0=root/coarsest, N=leaf/finest)
    data[23] = 10; // maxLodLevels
    
    // fallbackColor vec3f + useTexture f32 (offset 24-27)
    data[24] = fallbackColor[0];
    data[25] = fallbackColor[1];
    data[26] = fallbackColor[2];
    data[27] = useTexture ? 1.0 : 0.0;
    
    // atlasRegion vec4f (offset 28-31): xy = UV offset, zw = UV size
    data[28] = atlasRegion[0];
    data[29] = atlasRegion[1];
    data[30] = atlasRegion[2];
    data[31] = atlasRegion[3];
    
    // sunDirection vec3f + sunIntensityFactor f32 (offset 32-35)
    data[32] = l.sunDirection[0];
    data[33] = l.sunDirection[1];
    data[34] = l.sunDirection[2];
    data[35] = l.sunIntensityFactor;
    
    // sunColor vec3f + useNormalMap f32 (offset 36-39)
    data[36] = l.sunColor[0];
    data[37] = l.sunColor[1];
    data[38] = l.sunColor[2];
    data[39] = useNormalMap ? 1.0 : 0.0;
    
    // skyColor vec3f + useTranslucencyMap f32 (offset 40-43)
    data[40] = l.skyColor[0];
    data[41] = l.skyColor[1];
    data[42] = l.skyColor[2];
    data[43] = useTranslucencyMap ? 1.0 : 0.0;
    
    // groundColor vec3f + pad (offset 44-47)
    data[44] = l.groundColor[0];
    data[45] = l.groundColor[1];
    data[46] = l.groundColor[2];
    data[47] = 0.0;
    
    this.ctx.queue.writeBuffer(this.uniformsBuffer!, bufferOffset, data);
  }
  
  private writeWindParams(wind: WindParams): void {
    const data = new Float32Array(WIND_PARAMS_SIZE / 4);
    
    data[0] = wind.direction[0];
    data[1] = wind.direction[1];
    data[2] = wind.strength;
    data[3] = wind.frequency;
    data[4] = wind.gustStrength;
    data[5] = wind.gustFrequency;
    data[6] = 0; // pad
    data[7] = 0; // pad
    
    this.windBuffer!.write(this.ctx, data);
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.uniformsBuffer?.destroy();
    this.windBuffer?.destroy();
    this.defaultTexture?.destroy();
    this.defaultNormalTexture?.destroy();
    this.defaultTranslucencyTexture?.destroy();
    this._vegShadowPlaceholderTexture?.destroy();
    this._vegShadowPlaceholderUniform?.destroy();
    
    this.uniformsBuffer = null;
    this.windBuffer = null;
    this.defaultTexture = null;
    this.defaultNormalTexture = null;
    this.defaultTranslucencyTexture = null;
    this._vegShadowPlaceholderTexture = null;
    this._vegShadowPlaceholderView = null;
    this._vegShadowComparisonSampler = null;
    this._vegShadowPlaceholderUniform = null;
    this.sampler = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this._vegShadowBindGroupLayout = null;
    this.initialized = false;
  }
}
