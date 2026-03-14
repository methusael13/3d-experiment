/**
 * FlattenLayerGenerator — Creates a constant-height heightmap
 *
 * Used for building pads, roads, or clearings within layer bounds.
 * Simply fills the texture with the configured target height value.
 */

import { GPUContext, UnifiedGPUTexture } from '../../gpu';
import { TerrainLayer, TerrainLayerType, createDefaultFlattenLayerParams } from '../types';
import { ITerrainLayerGenerator } from './ITerrainLayerGenerator';

export class FlattenLayerGenerator implements ITerrainLayerGenerator {
  readonly type: TerrainLayerType = 'flatten';

  generate(
    layer: TerrainLayer,
    resolution: number,
    ctx: GPUContext,
  ): UnifiedGPUTexture {
    const params = layer.flattenParams || createDefaultFlattenLayerParams();

    const output = UnifiedGPUTexture.create2D(ctx, {
      label: `flatten-layer-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      storage: false,
      sampled: true,
      copyDst: true,
    });

    // Fill with constant height value via CPU → GPU upload
    const data = new Float32Array(resolution * resolution);
    data.fill(params.targetHeight);

    ctx.queue.writeTexture(
      { texture: output.texture },
      data.buffer,
      { bytesPerRow: resolution * 4, rowsPerImage: resolution },
      { width: resolution, height: resolution },
    );

    return output;
  }

  destroy(): void {
    // No GPU resources to clean up — each texture is returned to the caller
  }
}
