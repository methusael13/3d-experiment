/**
 * ITerrainLayerGenerator — Interface for terrain layer height generators
 *
 * Each layer type (noise, rock, island, flatten, etc.) implements this
 * interface to encapsulate its own GPU pipeline, uniform packing, and
 * heightmap generation logic.
 *
 * The compositor is layer-type-agnostic — it simply calls generate()
 * on the registered generator for each layer's type.
 */

import { GPUContext, UnifiedGPUTexture } from '../../gpu';
import { TerrainLayer, TerrainLayerType } from '../types';

/**
 * Common interface for all terrain layer generators.
 * 
 * Each implementation owns its GPU pipelines/buffers and knows how to
 * produce an r32float heightmap from a TerrainLayer's config.
 */
export interface ITerrainLayerGenerator {
  /** Unique type identifier — must match TerrainLayerType */
  readonly type: TerrainLayerType;

  /**
   * Generate a heightmap for this layer.
   *
   * @param layer      The layer configuration (type-specific params are on the layer object)
   * @param resolution Heightmap resolution (must be power of 2)
   * @param ctx        GPU context for resource creation
   * @returns A new r32float heightmap texture (caller takes ownership)
   */
  generate(
    layer: TerrainLayer,
    resolution: number,
    ctx: GPUContext,
  ): UnifiedGPUTexture;

  /**
   * Clean up any GPU resources owned by this generator
   * (pipelines, uniform buffers, cached textures, etc.)
   */
  destroy(): void;
}
