import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * SSR (Screen Space Reflections) component — opt-in per-entity SSR for metallic objects.
 *
 * When attached to an entity with a LODComponent, SSR is only active at LOD 0
 * (highest detail / closest to camera). At LOD ≥1, the SSR shader feature is
 * excluded from the variant to save performance.
 *
 * The opaque pass reads the previous frame's SSR texture (1-frame lag) and blends
 * it into the final color based on metallic value and SSR confidence.
 *
 * Usage:
 *   entity.addComponent(new SSRComponent());
 *   // Optionally: entity.addComponent(new LODComponent()); // gates SSR to LOD 0
 */
export class SSRComponent extends Component {
  readonly type: ComponentType = 'ssr';

  /**
   * Whether SSR is enabled for this entity.
   * Can be toggled per-entity without removing the component.
   */
  enabled: boolean = true;

  /**
   * SSR intensity multiplier (0 = no SSR, 1 = full SSR).
   * Allows artistic control over how strongly SSR affects this object.
   */
  intensity: number = 1.0;

  /**
   * Minimum metallic value required for SSR to be applied.
   * Objects below this threshold won't get SSR even with the component.
   * Default 0.3 means only moderately metallic+ surfaces get SSR.
   */
  metallicThreshold: number = 0.3;

  serialize(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      intensity: this.intensity,
      metallicThreshold: this.metallicThreshold,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    if (data.intensity !== undefined) this.intensity = data.intensity as number;
    if (data.metallicThreshold !== undefined) this.metallicThreshold = data.metallicThreshold as number;
  }
}