/**
 * RockLayerGenerator — Procedural rock formations via noise stepping
 *
 * Owns the rock compute pipeline and uniform buffer.
 * Generates a heightmap by passing domain-warped fBm through a
 * quantization/stepping function to create plateau/mesa formations.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  calculateWorkgroupCount2D,
} from '../../gpu';
import { TerrainLayer, TerrainLayerType, RockLayerParams, createDefaultRockLayerParams } from '../types';
import { ITerrainLayerGenerator } from './ITerrainLayerGenerator';

import rockLayerShader from '../../gpu/shaders/terrain/terrain-rock-layer.wgsl?raw';

// RockParams uniform: 22 floats × 4 = 88 bytes → pad to 96 for alignment
const ROCK_PARAMS_SIZE = 96;

export class RockLayerGenerator implements ITerrainLayerGenerator {
  readonly type: TerrainLayerType = 'rock';

  private pipeline: ComputePipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  private initialized = false;

  constructor(private ctx: GPUContext) {
    this.initPipeline();
  }

  private initPipeline(): void {
    this.bindGroupLayout = new BindGroupLayoutBuilder('rock-layer-layout')
      .uniformBuffer(0, 'compute')
      .storageTexture(1, 'r32float', 'compute', 'write-only')
      .build(this.ctx);

    this.pipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'terrain-rock-layer',
      shader: rockLayerShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'rock-params-buffer',
      size: ROCK_PARAMS_SIZE,
    });

    this.initialized = true;
  }

  generate(
    layer: TerrainLayer,
    resolution: number,
    ctx: GPUContext,
  ): UnifiedGPUTexture {
    if (!this.initialized || !this.pipeline || !this.bindGroupLayout || !this.paramsBuffer) {
      throw new Error('[RockLayerGenerator] Pipeline not initialized');
    }

    const params = layer.rockParams || createDefaultRockLayerParams();

    // Create output texture
    const output = UnifiedGPUTexture.create2D(ctx, {
      label: `rock-layer-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
    });

    // Pack RockParams uniform (must match WGSL struct layout)
    const noise = params.noise;
    const buffer = new ArrayBuffer(ROCK_PARAMS_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);

    // Noise params (indices 0-13)
    f[0] = noise.offsetX;
    f[1] = noise.offsetY;
    f[2] = noise.scaleX;
    f[3] = noise.scaleY;
    u[4] = noise.octaves;
    f[5] = noise.persistence;
    f[6] = noise.lacunarity;
    f[7] = noise.seed;
    f[8] = noise.warpStrength;
    f[9] = noise.warpScale;
    u[10] = noise.warpOctaves;
    f[11] = noise.ridgeWeight;
    u[12] = noise.rotateOctaves ? 1 : 0;
    f[13] = noise.octaveRotation;

    // Rock-specific params (indices 14-21)
    f[14] = params.rockSharpness;
    f[15] = params.strataFrequency;
    f[16] = params.strataStrength;
    f[17] = params.ridgeExponent;
    f[18] = params.detailFrequency;
    f[19] = params.detailStrength;
    f[20] = params.heightScale;
    f[21] = 0; // _pad0

    this.paramsBuffer.write(ctx, f);

    // Create bind group
    const bindGroup = ctx.device.createBindGroup({
      label: 'rock-layer-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer.buffer } },
        { binding: 1, resource: output.view },
      ],
    });

    // Dispatch
    const encoder = ctx.device.createCommandEncoder({ label: 'rock-layer-encoder' });
    const pass = encoder.beginComputePass({ label: 'rock-layer-pass' });
    pass.setPipeline(this.pipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    const wg = calculateWorkgroupCount2D(resolution, resolution, 8, 8);
    pass.dispatchWorkgroups(wg.x, wg.y);
    pass.end();
    ctx.queue.submit([encoder.finish()]);

    return output;
  }

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.paramsBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.initialized = false;
  }
}
