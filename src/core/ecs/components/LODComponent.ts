import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * LOD (Level of Detail) component — per-entity LOD level.
 *
 * Computed by LODSystem based on camera distance.
 * LOD 0 = highest detail (closest), higher = lower detail.
 *
 * Other systems read `currentLOD` to adjust their behavior:
 * - WetnessSystem: LOD 0 = Gerstner waves, LOD 1 = flat water, LOD ≥2 = skip
 * - Future: mesh LOD switching, shadow quality, etc.
 */
export class LODComponent extends Component {
  readonly type: ComponentType = 'lod';

  /** Current LOD level — written by LODSystem each frame */
  currentLOD: number = 0;

  /** Maximum LOD level (clamped to this) */
  maxLOD: number = 3;

  /**
   * Distance thresholds for LOD transitions (in world units).
   * thresholds[i] = distance at which LOD switches from i to i+1.
   * Default: [50, 150, 400] → LOD 0 < 50m, LOD 1 < 150m, LOD 2 < 400m, LOD 3 beyond.
   */
  thresholds: number[] = [50, 150, 400];

  serialize(): Record<string, unknown> {
    return {
      maxLOD: this.maxLOD,
      thresholds: [...this.thresholds],
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.maxLOD !== undefined) this.maxLOD = data.maxLOD as number;
    if (data.thresholds) this.thresholds = [...(data.thresholds as number[])];
    // currentLOD is runtime state — not serialized
  }
}