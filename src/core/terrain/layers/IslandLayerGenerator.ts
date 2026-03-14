/**
 * IslandLayerGenerator — Generates island coastline mask heightmaps
 *
 * Delegates to HeightmapGenerator.generateIslandMask() for the GPU compute work.
 * Produces a mask texture where 1.0 = land, 0.0 = ocean floor.
 */

import { GPUContext, UnifiedGPUTexture } from '../../gpu';
import { HeightmapGenerator } from '../HeightmapGenerator';
import { TerrainLayer, TerrainLayerType, createDefaultIslandLayerParams } from '../types';
import { ITerrainLayerGenerator } from './ITerrainLayerGenerator';

export class IslandLayerGenerator implements ITerrainLayerGenerator {
  readonly type: TerrainLayerType = 'island';

  private heightmapGen: HeightmapGenerator;

  constructor(heightmapGen: HeightmapGenerator) {
    this.heightmapGen = heightmapGen;
  }

  generate(
    layer: TerrainLayer,
    resolution: number,
    _ctx: GPUContext,
  ): UnifiedGPUTexture {
    const params = layer.islandParams || createDefaultIslandLayerParams();

    return this.heightmapGen.generateIslandMask(resolution, {
      seed: params.seed,
      islandRadius: params.islandRadius,
      coastNoiseScale: params.coastNoiseScale,
      coastNoiseStrength: params.coastNoiseStrength,
      coastFalloff: params.coastFalloff,
    });
  }

  destroy(): void {
    // HeightmapGenerator is owned externally — don't destroy it
  }
}
