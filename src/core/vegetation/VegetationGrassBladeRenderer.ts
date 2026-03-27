/**
 * VegetationGrassBladeRenderer
 * 
 * Renders vegetation instances as procedural Bézier-curve grass blades.
 * Uses the shared instance buffer from VegetationSpawner.
 * Only draws instances where renderMode = 3 (grass-blade).
 * 
 * Each blade is a quadratic Bézier curve with width tapering,
 * wind animation, and persistent-length correction (Jahrmann & Wimmer).
 * 
 * Uses dynamic uniform buffer offsets for per-draw-call uniform data.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  RenderPipelineWrapper,
  CommonBlendStates,
} from '../gpu';
import type { WindParams, VegetationLightParams } from './types';
import { DEFAULT_VEGETATION_LIGHT } from './types';
import { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';
import { ENV_BINDING_MASK } from '../gpu/renderers/shared/types';
import type { VegetationShadowMap } from './VegetationShadowMap';

import grassBladeShader from '../gpu/shaders/vegetation/grass-blade.wgsl?raw';
import grassBladeShadowShader from '../gpu/shaders/vegetation/grass-blade-shadow.wgsl?raw';

// ==================== Constants ====================

/** Uniforms struct size: mat4x4f(64) + vec3f+f32(16) + 4xf32(16) + vec3f+f32(16) + 4×vec4f(64 for light) + vec4f(16 blade params) = 208 bytes */
const UNIFORMS_SIZE = 208;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame */
const MAX_DRAW_SLOTS = 512;

/** WindParams struct size: 8 floats × 4 bytes = 32 bytes */
const WIND_PARAMS_SIZE = 32;

/** Vertices per grass blade: (N_SEGMENTS-1) quads × 6 + 3 tip = 27 with N_SEGMENTS=5 */
const VERTICES_PER_BLADE = 27;

/** Shadow uniforms struct size: mat4(64) + vec3f+f32(16) + 2×vec4f(32) = 112 bytes, rounded to 128 for alignment */
const SHADOW_UNIFORMS_SIZE = 128;

/** Re-export for backward compatibility */
export type GrassLightParams = VegetationLightParams;

// ==================== VegetationGrassBladeRenderer ====================

/** Bitmask for grass environment bindings: CSM shadow + multi-light + spot shadow + cloud shadow */
const GRASS_CSM_MASK = ENV_BINDING_MASK.CSM_SHADOW | ENV_BINDING_MASK.MULTI_LIGHT | ENV_BINDING_MASK.SPOT_SHADOW
  | ENV_BINDING_MASK.CLOUD_SHADOW | ENV_BINDING_MASK.IBL_CUBE_SAMPLER;

export class VegetationGrassBladeRenderer {
  private ctx: GPUContext;

  // Pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Dynamic uniform buffer
  private uniformsBuffer: GPUBuffer | null = null;
  private windBuffer: UnifiedGPUBuffer | null = null;

  // Current slot index (reset each frame)
  private currentSlot = 0;

  // Scene environment for shadow receiving
  private sceneEnvironment: SceneEnvironment | null = null;

  // Vegetation shadow map bind group (Group 2) resources
  private _vegShadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private _vegShadowPlaceholderTexture: GPUTexture | null = null;
  private _vegShadowPlaceholderView: GPUTextureView | null = null;
  private _vegShadowComparisonSampler: GPUSampler | null = null;
  private _vegShadowPlaceholderUniform: GPUBuffer | null = null;

  // Grass blade shape parameters (set per-plant-type before rendering)
  private _bladeWidthFactor = 0.025;
  private _bladeTaperPower = 1.8;
  private _veinFoldStrength = 0.4;
  private _sssStrength = 0.65;
  private _bladeMinBendRad = 0.0; // Stored in radians internally

  private initialized = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ==================== Blade Shape Parameters ====================

  /**
   * Set grass blade shape parameters for the next draw calls.
   * Call before render() or renderIndirect() to configure per-plant-type appearance.
   */
  setBladeParams(params: {
    widthFactor?: number;
    taperPower?: number;
    veinFoldStrength?: number;
    sssStrength?: number;
    minBendDeg?: number;
  }): void {
    if (params.widthFactor !== undefined) this._bladeWidthFactor = params.widthFactor;
    if (params.taperPower !== undefined) this._bladeTaperPower = params.taperPower;
    if (params.veinFoldStrength !== undefined) this._veinFoldStrength = params.veinFoldStrength;
    if (params.sssStrength !== undefined) this._sssStrength = params.sssStrength;
    if (params.minBendDeg !== undefined) this._bladeMinBendRad = params.minBendDeg * Math.PI / 180;
  }

  // ==================== Initialization ====================

  initialize(depthFormat: GPUTextureFormat = 'depth24plus', colorFormat: GPUTextureFormat = 'rgba16float'): void {
    if (this.initialized) return;

    // Bind group layout — binding 0 has hasDynamicOffset: true
    // No texture needed — grass blades are procedurally colored
    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-grass-blade-layout',
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
      ],
    });

    // Group 1: Environment shadow (CSM) — uses SceneEnvironment masked layout
    const envLayout = SceneEnvironment.getBindGroupLayoutEntriesForMask(GRASS_CSM_MASK);
    const envBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-grass-blade-env-layout-g1',
      entries: envLayout,
    });

    // Group 2: Vegetation shadow map (depth texture + comparison sampler + uniforms)
    this._vegShadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'vegetation-grass-blade-veg-shadow-layout-g2',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // Create placeholder resources for when no veg shadow map is active
    this._vegShadowPlaceholderTexture = this.ctx.device.createTexture({
      label: 'veg-shadow-placeholder',
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._vegShadowPlaceholderView = this._vegShadowPlaceholderTexture.createView();
    this._vegShadowComparisonSampler = this.ctx.device.createSampler({
      label: 'veg-shadow-comparison-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    // Placeholder uniform buffer (96 bytes, all zeros = enabled=0 → disabled)
    this._vegShadowPlaceholderUniform = this.ctx.device.createBuffer({
      label: 'veg-shadow-placeholder-uniform',
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Render pipeline
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-grass-blade-pipeline',
      vertexShader: grassBladeShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout, envBindGroupLayout, this._vegShadowBindGroupLayout],
      vertexBuffers: [], // No vertex buffers — all data from storage buffer + vertex index
      colorFormats: [colorFormat, colorFormat],
      blendStates: [CommonBlendStates.alpha(), CommonBlendStates.alpha()],
      depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'greater',  // Reversed-Z depth buffer
      topology: 'triangle-list',
      cullMode: 'none', // Grass blades visible from both sides
    });

    // Dynamic uniform buffer
    this.uniformsBuffer = this.ctx.device.createBuffer({
      label: 'vegetation-grass-blade-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.windBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-grass-blade-wind',
      size: WIND_PARAMS_SIZE,
    });

    this.initialized = true;
  }

  // ==================== Frame Management ====================

  resetFrame(): void {
    this.currentSlot = 0;
  }

  /**
   * Set the scene environment for shadow receiving.
   */
  setSceneEnvironment(env: SceneEnvironment | null): void {
    this.sceneEnvironment = env;
  }

  /**
   * Set environment bind group (group 1) on the pass encoder.
   */
  private _setEnvBindGroup(passEncoder: GPURenderPassEncoder): void {
    if (this.sceneEnvironment) {
      const envBindGroup = this.sceneEnvironment.getBindGroupForMask(GRASS_CSM_MASK);
      passEncoder.setBindGroup(1, envBindGroup);
    }
  }

  /**
   * Set vegetation shadow bind group (group 2) on the pass encoder.
   * Uses the vegetation shadow map from SceneEnvironment if available,
   * otherwise binds placeholders (with enabled=0 so shader skips sampling).
   */
  private _setVegShadowBindGroup(passEncoder: GPURenderPassEncoder): void {
    if (!this._vegShadowBindGroupLayout || !this._vegShadowComparisonSampler) return;

    // Check SceneEnvironment for vegetation shadow map
    const vegView = this.sceneEnvironment?.getVegetationShadowView() ?? null;
    const vegUniform = this.sceneEnvironment?.getVegetationShadowUniformBuffer() ?? null;

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'grass-blade-veg-shadow-bg',
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
   * Render grass blade instances using direct draw.
   */
  render(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    instanceBuffer: UnifiedGPUBuffer,
    instanceCount: number,
    fallbackColor: [number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    light?: VegetationLightParams,
  ): void {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return;
    if (instanceCount === 0) return;
    if (this.currentSlot >= MAX_DRAW_SLOTS) return;

    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, slotOffset, 0, light);
    this.writeWindParams(wind);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-grass-blade-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: instanceBuffer.buffer } },
      ],
    });

    passEncoder.setPipeline(this.pipeline.pipeline);
    this._setEnvBindGroup(passEncoder);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.draw(VERTICES_PER_BLADE, instanceCount);

    this.currentSlot++;
  }

  /**
   * Render grass blade instances using GPU indirect draw (from culled buffer).
   * 
   * drawArgsBuffer layout at offset 0 (billboard slot):
   *   [0] vertexCount, [1] instanceCount, [2] firstVertex (0), [3] firstInstance (0)
   */
  renderIndirect(
    passEncoder: GPURenderPassEncoder,
    viewProjection: Float32Array,
    cameraPosition: [number, number, number],
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    fallbackColor: [number, number, number],
    wind: WindParams,
    time: number,
    maxDistance: number = 200,
    lodLevel: number = 0,
    light?: VegetationLightParams,
  ): number {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.uniformsBuffer) return 0;
    if (this.currentSlot >= MAX_DRAW_SLOTS) return 0;

    const slotOffset = this.currentSlot * UNIFORM_ALIGNMENT;
    this.writeUniformsAtOffset(viewProjection, cameraPosition, time, maxDistance, fallbackColor, slotOffset, lodLevel, light);
    this.writeWindParams(wind);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'vegetation-grass-blade-indirect-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformsBuffer, size: UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.windBuffer!.buffer } },
        { binding: 2, resource: { buffer: culledInstanceBuffer } },
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
    bufferOffset: number,
    lodLevel: number = 0,
    light?: VegetationLightParams,
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
    data[21] = 0.75;
    data[22] = lodLevel;
    data[23] = 10;

    // fallbackColor vec3f + pad (offset 24-27)
    data[24] = fallbackColor[0];
    data[25] = fallbackColor[1];
    data[26] = fallbackColor[2];
    data[27] = this._bladeMinBendRad;

    // sunDirection vec3f + sunIntensityFactor f32 (offset 28-31)
    data[28] = l.sunDirection[0];
    data[29] = l.sunDirection[1];
    data[30] = l.sunDirection[2];
    data[31] = l.sunIntensityFactor;

    // sunColor vec3f + pad (offset 32-35)
    data[32] = l.sunColor[0];
    data[33] = l.sunColor[1];
    data[34] = l.sunColor[2];
    data[35] = 0.0;

    // skyColor vec3f + pad (offset 36-39)
    data[36] = l.skyColor[0];
    data[37] = l.skyColor[1];
    data[38] = l.skyColor[2];
    data[39] = 0.0;

    // groundColor vec3f + pad (offset 40-43)
    data[40] = l.groundColor[0];
    data[41] = l.groundColor[1];
    data[42] = l.groundColor[2];
    data[43] = 0.0;

    // Grass blade shape params (offset 44-47) — new in v2
    data[44] = this._bladeWidthFactor;   // bladeWidthFactor (default 0.025)
    data[45] = this._bladeTaperPower;    // bladeTaperPower (default 1.8)
    data[46] = this._veinFoldStrength;   // veinFoldStrength (default 0.4)
    data[47] = this._sssStrength;        // sssStrength (default 0.65)

    // Total: 48 floats = 192 bytes + 16 bytes blade params = 208 bytes

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
    data[6] = 0;
    data[7] = 0;

    this.windBuffer!.write(this.ctx, data);
  }

  // ==================== Shadow Depth-Only Pipeline ====================

  // Shadow pipeline resources (lazily initialized)
  private shadowPipeline: GPURenderPipeline | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowUniformsBuffer: GPUBuffer | null = null;
  private shadowWindBuffer: UnifiedGPUBuffer | null = null;
  private shadowCurrentSlot = 0;

  /**
   * Lazily initialize the shadow depth-only pipeline.
   * Uses grass-blade-shadow.wgsl which outputs only @builtin(position).
   */
  private ensureShadowPipeline(depthFormat: GPUTextureFormat): void {
    if (this.shadowPipeline) return;

    this.shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'grass-blade-shadow-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SHADOW_UNIFORMS_SIZE },
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
      ],
    });

    const shaderModule = this.ctx.device.createShaderModule({
      label: 'grass-blade-shadow-shader',
      code: grassBladeShadowShader,
    });

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'grass-blade-shadow-pipeline-layout',
      bindGroupLayouts: [this.shadowBindGroupLayout],
    });

    this.shadowPipeline = this.ctx.device.createRenderPipeline({
      label: 'grass-blade-shadow-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain',
      },
      // No fragment stage — depth-only
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: 'less', // Standard depth (not reversed-Z for shadow maps)
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    // Shadow-specific uniform + wind buffers
    this.shadowUniformsBuffer = this.ctx.device.createBuffer({
      label: 'grass-blade-shadow-uniforms-dynamic',
      size: UNIFORM_ALIGNMENT * MAX_DRAW_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.shadowWindBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'grass-blade-shadow-wind',
      size: WIND_PARAMS_SIZE,
    });
  }

  /**
   * Reset shadow frame slot counter.
   */
  resetShadowFrame(): void {
    this.shadowCurrentSlot = 0;
  }

  /**
   * Render grass blade instances into a shadow depth map using indirect draw.
   * 
   * @param passEncoder - Render pass encoder targeting the shadow depth texture
   * @param lightSpaceMatrix - Light-space VP matrix from VegetationShadowMap
   * @param cameraPosition - Camera world position (for distance culling in shader)
   * @param culledInstanceBuffer - Billboard output buffer from the cull pipeline
   * @param drawArgsBuffer - Indirect draw args (billboard slot at offset 0)
   * @param wind - Current wind params (must match color shader for shadow consistency)
   * @param time - Animation time
   * @param maxShadowDistance - Max distance for shadow casting
   * @param depthFormat - Depth texture format of the shadow map
   */
  renderShadowPassIndirect(
    passEncoder: GPURenderPassEncoder,
    lightSpaceMatrix: Float32Array,
    cameraPosition: [number, number, number],
    culledInstanceBuffer: GPUBuffer,
    drawArgsBuffer: GPUBuffer,
    wind: WindParams,
    time: number,
    maxShadowDistance: number,
    depthFormat: GPUTextureFormat = 'depth32float',
  ): number {
    this.ensureShadowPipeline(depthFormat);
    if (!this.shadowPipeline || !this.shadowBindGroupLayout || !this.shadowUniformsBuffer) return 0;
    if (this.shadowCurrentSlot >= MAX_DRAW_SLOTS) return 0;

    const slotOffset = this.shadowCurrentSlot * UNIFORM_ALIGNMENT;

    // Write shadow uniforms
    const data = new Float32Array(SHADOW_UNIFORMS_SIZE / 4);
    data.set(lightSpaceMatrix, 0);                    // mat4 lightSpaceMatrix (0-15)
    data[16] = cameraPosition[0];                     // cameraPosition.x
    data[17] = cameraPosition[1];                     // cameraPosition.y
    data[18] = cameraPosition[2];                     // cameraPosition.z
    data[19] = time;                                  // time
    data[20] = maxShadowDistance;                      // maxFadeDistance
    data[21] = 0.75;                                   // fadeStartRatio (must match color shader)
    data[22] = this._bladeWidthFactor;                 // bladeWidthFactor
    data[23] = this._bladeTaperPower;                  // bladeTaperPower
    data[24] = this._bladeMinBendRad;                  // bladeMinBendRad
    data[25] = 0; data[26] = 0; data[27] = 0;         // padding
    this.ctx.queue.writeBuffer(this.shadowUniformsBuffer, slotOffset, data);

    // Write wind params
    const windData = new Float32Array(WIND_PARAMS_SIZE / 4);
    windData[0] = wind.direction[0];
    windData[1] = wind.direction[1];
    windData[2] = wind.strength;
    windData[3] = wind.frequency;
    windData[4] = wind.gustStrength;
    windData[5] = wind.gustFrequency;
    this.shadowWindBuffer!.write(this.ctx, windData);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'grass-blade-shadow-bg',
      layout: this.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformsBuffer, size: SHADOW_UNIFORMS_SIZE } },
        { binding: 1, resource: { buffer: this.shadowWindBuffer!.buffer } },
        { binding: 2, resource: { buffer: culledInstanceBuffer } },
      ],
    });

    passEncoder.setPipeline(this.shadowPipeline);
    passEncoder.setBindGroup(0, bindGroup, [slotOffset]);
    passEncoder.drawIndirect(drawArgsBuffer, 0); // Billboard draw args at offset 0

    this.shadowCurrentSlot++;
    return 1;
  }

  // ==================== Cleanup ====================

  destroy(): void {
    this.uniformsBuffer?.destroy();
    this.windBuffer?.destroy();
    this.shadowUniformsBuffer?.destroy();
    this.shadowWindBuffer?.destroy();

    this.uniformsBuffer = null;
    this.windBuffer = null;
    this.shadowUniformsBuffer = null;
    this.shadowWindBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.shadowPipeline = null;
    this.shadowBindGroupLayout = null;
    this.initialized = false;
  }
}