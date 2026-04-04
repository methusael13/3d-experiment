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
import { SDFPrimitiveStamper } from './SDFPrimitiveStamper';
import { ShaderModuleManager } from '../GPUShaderModule';
import type { SDFConfig, SDFCascade, SDFTerrainStampParams, SDFPrimitive } from './types';
import { createDefaultSDFConfig } from './types';
import sdfClearSource from '../shaders/sdf/sdf-clear.wgsl?raw';

export class GlobalDistanceField {
  private ctx: GPUContext;
  private config: SDFConfig;

  // Cascades
  private cascades: SDFCascade[] = [];

  // Compute resources
  private terrainStamper: SDFTerrainStamper | null = null;
  private primitiveStamper: SDFPrimitiveStamper | null = null;
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
    if (this.config.enableMeshStamping) {
      this.primitiveStamper = new SDFPrimitiveStamper(this.ctx);
    }

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
   * Update the SDF. Called each frame.
   * G2: Updates all cascades with hysteresis-based camera scrolling.
   * G3: Stamps mesh primitives after terrain stamping.
   * 
   * @param encoder - Command encoder to record compute passes into
   * @param cameraPosition - Current camera position (for cascade centering)
   * @param terrainParams - Terrain heightmap info for stamping
   * @param meshPrimitives - Scene mesh primitives to stamp into SDF (G3)
   */
  update(
    encoder: GPUCommandEncoder,
    cameraPosition: vec3,
    terrainParams?: SDFTerrainStampParams,
    meshPrimitives?: SDFPrimitive[]
  ): void {
    if (!this.initialized || !this.config.enabled) return;

    let anyUpdated = false;

    // G2: Process ALL cascades with hysteresis-based re-centering
    for (let i = 0; i < this.cascades.length; i++) {
      const cascade = this.cascades[i];

      // Snap camera position to voxel grid for this cascade
      const snapX = Math.round(cameraPosition[0] / cascade.voxelSize) * cascade.voxelSize;
      const snapZ = Math.round(cameraPosition[2] / cascade.voxelSize) * cascade.voxelSize;
      const snapY = Math.round(cameraPosition[1] / cascade.voxelSize) * cascade.voxelSize;

      // Hysteresis: only re-center if camera moved beyond threshold (in voxels)
      const dx = Math.abs(cascade.center[0] - snapX) / cascade.voxelSize;
      const dy = Math.abs(cascade.center[1] - snapY) / cascade.voxelSize;
      const dz = Math.abs(cascade.center[2] - snapZ) / cascade.voxelSize;
      const maxDrift = Math.max(dx, dy, dz);

      if (maxDrift > this.config.hysteresisDistance || this.needsRebuild) {
        vec3.set(cascade.center, snapX, snapY, snapZ);
        cascade.dirty = true;
      }

      if (!cascade.dirty) continue;

      // Clear cascade
      this.clearCascade(encoder, cascade);

      // Stamp terrain (all cascades get terrain)
      if (this.config.enableTerrainStamping && terrainParams && this.terrainStamper) {
        this.terrainStamper.stamp(encoder, cascade, terrainParams);
      }

      // G3: Stamp mesh primitives (after terrain, so min() combines both)
      if (this.config.enableMeshStamping && meshPrimitives && meshPrimitives.length > 0 && this.primitiveStamper) {
        // For coarser cascades, filter to only primitives that overlap the cascade volume
        const filtered = this.filterPrimitivesForCascade(cascade, meshPrimitives);
        if (filtered.length > 0) {
          this.primitiveStamper.stamp(encoder, cascade, filtered);
        }
      }

      cascade.dirty = false;
      anyUpdated = true;
    }

    if (anyUpdated) {
      this.needsRebuild = false;
      // Consumer uniforms use cascade 0 (finest) for water/foam sampling
      if (this.cascades.length > 0) {
        this.updateConsumerUniforms(this.cascades[0]);
      }
    }
  }

  /**
   * Filter primitives to only those that overlap a cascade's bounding volume.
   * Avoids wasting compute on distant primitives in fine cascades,
   * or tiny primitives in coarse cascades.
   */
  private filterPrimitivesForCascade(cascade: SDFCascade, primitives: SDFPrimitive[]): SDFPrimitive[] {
    const cx = cascade.center[0], cy = cascade.center[1], cz = cascade.center[2];
    const ex = cascade.extent[0], ey = cascade.extent[1], ez = cascade.extent[2];
    const minX = cx - ex, maxX = cx + ex;
    const minY = cy - ey, maxY = cy + ey;
    const minZ = cz - ez, maxZ = cz + ez;
    // Expand AABB by the largest primitive radius to catch overlapping ones
    const expand = cascade.voxelSize * 4; // generous overlap margin

    return primitives.filter(p => {
      const px = p.center[0], py = p.center[1], pz = p.center[2];
      const pr = Math.max(p.extents[0], p.extents[1], p.extents[2]);
      return px + pr > minX - expand && px - pr < maxX + expand
          && py + pr > minY - expand && py - pr < maxY + expand
          && pz + pr > minZ - expand && pz - pr < maxZ + expand;
    });
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
    this.primitiveStamper?.destroy();
    this.primitiveStamper = null;

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
