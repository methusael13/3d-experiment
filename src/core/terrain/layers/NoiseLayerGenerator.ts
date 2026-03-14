/**
 * NoiseLayerGenerator — Generates noise heightmaps using domain-warped fBm
 *
 * Delegates to the existing HeightmapGenerator for the actual GPU compute work.
 * This is the simplest generator — it just forwards the layer's noiseParams.
 */

import { GPUContext, UnifiedGPUTexture } from '../../gpu';
import { HeightmapGenerator, createDefaultNoiseParams } from '../HeightmapGenerator';
import { TerrainLayer, TerrainLayerType } from '../types';
import { ITerrainLayerGenerator } from './ITerrainLayerGenerator';

export class NoiseLayerGenerator implements ITerrainLayerGenerator {
  readonly type: TerrainLayerType = 'noise';

  private heightmapGen: HeightmapGenerator;

  constructor(heightmapGen: HeightmapGenerator) {
    this.heightmapGen = heightmapGen;
  }

  generate(
    layer: TerrainLayer,
    resolution: number,
    _ctx: GPUContext,
  ): UnifiedGPUTexture {
    const params = layer.noiseParams || createDefaultNoiseParams();
    // Generate without mipmaps — the final composited heightmap gets mipmaps
    return this.heightmapGen.generateHeightmap(resolution, params, false);
  }

  destroy(): void {
    // HeightmapGenerator is owned externally (by TerrainManager) — don't destroy it
  }
}
