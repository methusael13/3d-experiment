import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * VegetationInstanceComponent
 * 
 * Marks an entity as a vegetation instanced draw group, providing references
 * to GPU-culled instance buffers and indirect draw args from the
 * VegetationCullingPipeline. Used by MeshRenderSystem to enable the
 * 'vegetation-instancing' shader feature, routing these entities through
 * the variant PBR pipeline with drawIndexedIndirect.
 * 
 * One entity per plant-type × active-tile × submesh combination.
 * Lightweight — no GPU resource ownership (buffers owned by VegetationCullingPipeline).
 */
export class VegetationInstanceComponent extends Component {
  readonly type: ComponentType = 'vegetation-instance';

  // ==================== GPU Buffer References ====================

  /** Culled instance storage buffer (PlantInstance array, compacted by cull shader) */
  culledInstanceBuffer: GPUBuffer | null = null;

  /** Indirect draw args buffer (shared across submeshes of one plant group) */
  drawArgsBuffer: GPUBuffer | null = null;

  /**
   * Byte offset into drawArgsBuffer for this submesh's drawIndexedIndirect args.
   * Computed as: 16 + subMeshIndex * 20  (billboard args = 16 bytes, each mesh arg = 20 bytes)
   */
  drawArgsOffset: number = 0;

  // ==================== Shadow-Specific GPU Buffer References ====================
  // Separate buffers from a second GPU cull pass using shadowCastDistance instead of
  // maxDistance. When non-null, VariantRenderer.renderDepthOnly() uses these for
  // vegetation entities instead of the color drawArgsBuffer, allowing shadow rendering
  // to use a different (typically shorter) distance threshold than color rendering.

  /** Shadow-specific indirect draw args buffer (culled with shadowCastDistance). Null = use color drawArgsBuffer. */
  shadowDrawArgsBuffer: GPUBuffer | null = null;

  /** Byte offset into shadowDrawArgsBuffer (same layout as drawArgsOffset). */
  shadowDrawArgsOffset: number = 0;

  /** Shadow-specific culled instance buffer (for vegInstances binding in shadow depth pass). Null = use color culledInstanceBuffer. */
  shadowCulledInstanceBuffer: GPUBuffer | null = null;

  // ==================== Vegetation Wind Parameters ====================
  // These are written to MaterialUniforms extra region each frame
  // by VegetationInstanceSystem, matching the vegetationInstancingFeature resources.

  /** Global wind strength (already scaled by per-plant windInfluence) */
  windStrength: number = 0;

  /** Wind oscillation frequency */
  windFrequency: number = 1;

  /** Normalized wind direction [x, z] */
  windDirection: [number, number] = [1, 0];

  /** Gust noise strength */
  gustStrength: number = 0;

  /** Gust noise frequency */
  gustFrequency: number = 0.5;

  /** Per-submesh wind multiplier (e.g., leaves vs trunk) */
  windMultiplier: number = 1.0;

  /** Current animation time (from global wind system / VegetationManager) */
  time: number = 0;

  /** Max vegetation render distance (for distance fade in vertex shader) */
  maxDistance: number = 200;

  // ==================== State ====================

  /** Whether this draw group is active this frame (has surviving instances after cull) */
  active: boolean = false;

  /** Plant type ID for debugging / grouping */
  plantId: string = '';

  /** Tile ID for debugging / lifecycle management */
  tileId: string = '';
}
