/**
 * GlobalDistanceField - Manages cascaded SDF 3D textures
 * 
 * Phase G1: Single cascade, terrain-only stamping.
 * Provides SDF texture + sampler + uniform buffer for consumers (water, fog, AO).
 */

import { vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer, UniformBuilder } from '../index';
import { SDFTerrainStamper } from './SDFTerrainStamper';
import { ShaderModuleManager } from '../GPUShaderModule';
import type { SDFConfig, SDFCascade, SDFTerrainStampParams } from './types';
import { createDefaultSDFConfig } from './types';
import sdfClearSource from '../shaders/sdf/sdf-clear.wgsl?raw';

export class GlobalDistanceField {
  private ctx: GPUContext;
  private config: SDFConfig;

  // Cascades
  private cascades: SDFCascade[] = [];

  // Compute resources
  private terrainStamper: SDFTerrainStamper | null = null;
  private clearPipeline: GPUComputePipeline | null = null;
  private clearBindGroupLayout: GPUBindGroupLayout | null = null;
  private clearUniformBuffer: UnifiedGPUBuffer | null = null;

  // Sampler for consumers
  private _sampler: GPUSampler | null = null;

  // Consumer uniform buffer (matches SDFParams in water.wgsl)
  private _consumerUniformBuffer: UnifiedGPUBuffer | null = null;
  private consumerUniformBuilder: UniformBuilder;

  // State
  private initialized = false;
  private needsRebuild = true;

  constructor(ctx: GPUContext, config?: Partial<SDFConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultSDFConfig(), ...config };
    this.consumerUniformBuilder = new UniformBuilder(8); // 2 vec4: center+pad, extent+voxelSize
  }

  /**
   * Initialize all GPU resources
   */
  initialize(): void {
    if (this.initialized) return;

    this.createCascades();
    this.createClearPipeline();
    this.terrainStamper = new SDFTerrainStamper(this.ctx);

    // Non-filtering sampler required for r32float (unfilterable-float) textures
    this._sampler = this.ctx.device.createSampler({
      label: 'sdf-sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this._consumerUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'sdf-consumer-uniforms',
      size: 32, // 8 floats * 4 bytes
    });

    this.initialized = true;
    this.needsRebuild = true;
    console.log(`[GlobalDistanceField] Initialized with ${this.config.cascadeCount} cascade(s), resolution ${this.config.baseResolution}`);
  }

  private createCascades(): void {
    // Destroy old cascades
    for (const c of this.cascades) {
      c.texture.destroy();
    }
    this.cascades = [];

    const res = this.config.baseResolution;
    const count = Math.min(this.config.cascadeCount, this.config.cascadeExtents.length);

    for (let i = 0; i < count; i++) {
      const ext = this.config.cascadeExtents[i];
      const extent = vec3.fromValues(ext.halfWidth, ext.halfHeight, ext.halfDepth);
      const voxelSize = (ext.halfWidth * 2) / res;

      const texture = this.ctx.device.createTexture({
        label: `sdf-cascade-${i}`,
        size: [res, res, res],
        format: 'r32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        dimension: '3d',
      });

      this.cascades.push({
        texture,
        storageView: texture.createView({ label: `sdf-cascade-${i}-storage` }),
        sampleView: texture.createView({ label: `sdf-cascade-${i}-sample` }),
        center: vec3.fromValues(0, 0, 0),
        extent,
        voxelSize,
        resolution: res,
        dirty: true,
      });
    }
  }

  private createClearPipeline(): void {
    this.clearBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'sdf-clear-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const shaderModule = ShaderModuleManager.getOrCreate(this.ctx, sdfClearSource, 'sdf-clear-shader');

    this.clearPipeline = this.ctx.device.createComputePipeline({
      label: 'sdf-clear-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        label: 'sdf-clear-pipeline-layout',
        bindGroupLayouts: [this.clearBindGroupLayout],
      }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    this.clearUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'sdf-clear-uniforms',
      size: 16, // vec4u
    });
  }

  /**
   * Clear a cascade (set all voxels to max distance)
   */
  private clearCascade(encoder: GPUCommandEncoder, cascade: SDFCascade): void {
    if (!this.clearPipeline || !this.clearBindGroupLayout || !this.clearUniformBuffer) return;

    const data = new Uint32Array([cascade.resolution, 0, 0, 0]);
    this.clearUniformBuffer.write(this.ctx, data);

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'sdf-clear-bind-group',
      layout: this.clearBindGroupLayout,
      entries: [
        { binding: 0, resource: cascade.storageView },
        { binding: 1, resource: { buffer: this.clearUniformBuffer.buffer } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'sdf-clear' });
    pass.setPipeline(this.clearPipeline);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(cascade.resolution / 8);
    pass.dispatchWorkgroups(wg, wg, wg);
    pass.end();
  }

  /**
   * Update the SDF. Called each frame (or when dirty).
   * 
   * @param encoder - Command encoder to record compute passes into
   * @param cameraPosition - Current camera position (for cascade centering in G2)
   * @param terrainParams - Terrain heightmap info for stamping
   */
  update(
    encoder: GPUCommandEncoder,
    cameraPosition: vec3,
    terrainParams?: SDFTerrainStampParams
  ): void {
    if (!this.initialized || !this.config.enabled) return;

    // For G1: single cascade, center on camera XZ, fixed Y range
    const cascade = this.cascades[0];
    if (!cascade) return;

    // Re-center cascade on camera (snap to voxel grid)
    const snapX = Math.round(cameraPosition[0] / cascade.voxelSize) * cascade.voxelSize;
    const snapZ = Math.round(cameraPosition[2] / cascade.voxelSize) * cascade.voxelSize;
    // Y center: offset slightly above typical water level
    const snapY = Math.round(cameraPosition[1] / cascade.voxelSize) * cascade.voxelSize;

    const moved = cascade.center[0] !== snapX || cascade.center[1] !== snapY || cascade.center[2] !== snapZ;
    if (moved || this.needsRebuild) {
      vec3.set(cascade.center, snapX, snapY, snapZ);
      cascade.dirty = true;
    }

    if (!cascade.dirty) return;

    // Clear + stamp terrain
    this.clearCascade(encoder, cascade);

    if (this.config.enableTerrainStamping && terrainParams && this.terrainStamper) {
      this.terrainStamper.stamp(encoder, cascade, terrainParams);
    }

    cascade.dirty = false;
    this.needsRebuild = false;

    // Update consumer uniform buffer
    this.updateConsumerUniforms(cascade);
  }

  /**
   * Update the uniform buffer that water/fog shaders will read
   */
  private updateConsumerUniforms(cascade: SDFCascade): void {
    if (!this._consumerUniformBuffer) return;

    this.consumerUniformBuilder.reset()
      .vec4(cascade.center[0], cascade.center[1], cascade.center[2], 0.0)
      .vec4(cascade.extent[0], cascade.extent[1], cascade.extent[2], cascade.voxelSize);

    this._consumerUniformBuffer.write(this.ctx, this.consumerUniformBuilder.build());
  }

  /** Mark the SDF as needing a full rebuild (e.g. terrain changed) */
  markDirty(): void {
    this.needsRebuild = true;
    for (const c of this.cascades) {
      c.dirty = true;
    }
  }

  // ============ Public Accessors for Consumers ============

  /** Get cascade 0 sample view for fragment shader binding */
  getSampleView(cascadeIndex = 0): GPUTextureView | null {
    return this.cascades[cascadeIndex]?.sampleView ?? null;
  }

  /** Get the linear sampler for SDF texture */
  get sampler(): GPUSampler | null {
    return this._sampler;
  }

  /** Get the consumer uniform buffer (SDFParams) */
  get consumerUniformBuffer(): UnifiedGPUBuffer | null {
    return this._consumerUniformBuffer;
  }

  /** Whether the GDF is ready to be sampled */
  get isReady(): boolean {
    return this.initialized && this.cascades.length > 0;
  }

  /** Get current config */
  getConfig(): SDFConfig {
    return { ...this.config };
  }

  /** Update config */
  setConfig(config: Partial<SDFConfig>): void {
    this.config = { ...this.config, ...config };
    this.needsRebuild = true;
  }

  // ============ Cleanup ============

  destroy(): void {
    this.terrainStamper?.destroy();
    this.terrainStamper = null;

    for (const c of this.cascades) {
      c.texture.destroy();
    }
    this.cascades = [];

    this.clearUniformBuffer?.destroy();
    this.clearUniformBuffer = null;
    this._consumerUniformBuffer?.destroy();
    this._consumerUniformBuffer = null;

    this.clearPipeline = null;
    this.clearBindGroupLayout = null;
    this._sampler = null;
    this.initialized = false;

    console.log('[GlobalDistanceField] Destroyed');
  }
}
