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

import grassBladeShader from '../gpu/shaders/vegetation/grass-blade.wgsl?raw';

// ==================== Constants ====================

/** Uniforms struct size: mat4x4f(64) + vec3f+f32(16) + 4xf32(16) + vec3f+f32(16) + 4×vec4f(64 for light) = 192 bytes */
const UNIFORMS_SIZE = 192;

/** WebGPU minimum uniform buffer offset alignment */
const UNIFORM_ALIGNMENT = 256;

/** Maximum draw calls per frame */
const MAX_DRAW_SLOTS = 512;

/** WindParams struct size: 8 floats × 4 bytes = 32 bytes */
const WIND_PARAMS_SIZE = 32;

/** Vertices per grass blade: (N_SEGMENTS-1) quads × 6 + 3 tip = 27 with N_SEGMENTS=5 */
const VERTICES_PER_BLADE = 27;

/** Re-export for backward compatibility */
export type GrassLightParams = VegetationLightParams;

// ==================== VegetationGrassBladeRenderer ====================

/** Bitmask for grass CSM shadow bindings: comparison sampler + CSM array + CSM uniforms */
const GRASS_CSM_MASK = ENV_BINDING_MASK.CSM_SHADOW;

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

  private initialized = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
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

    // Render pipeline
    this.pipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'vegetation-grass-blade-pipeline',
      vertexShader: grassBladeShader,
      vertexEntryPoint: 'vertexMain',
      fragmentEntryPoint: 'fragmentMain',
      bindGroupLayouts: [this.bindGroupLayout, envBindGroupLayout],
      vertexBuffers: [], // No vertex buffers — all data from storage buffer + vertex index
      colorFormats: [colorFormat],
      blendStates: [CommonBlendStates.alpha()],
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
    data[27] = 0.0;

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

    // Remaining up to 48 floats (192 bytes) — zeros

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

  // ==================== Cleanup ====================

  destroy(): void {
    this.uniformsBuffer?.destroy();
    this.windBuffer?.destroy();

    this.uniformsBuffer = null;
    this.windBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}