import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Wetness component — per-entity wetness state for objects interacting with water.
 *
 * WetnessSystem computes `waterLineY` (world-space Y of water surface at the
 * entity's XZ position) and `wetnessFactor` (0 = dry, 1 = fully wet) each frame.
 *
 * The shader feature uses these values to darken albedo and reduce roughness
 * below the water line, creating a realistic wet surface appearance.
 */
export class WetnessComponent extends Component {
  readonly type: ComponentType = 'wetness';

  /**
   * World-space Y of the wet/dry boundary on the mesh.
   * Computed from bounds.minY + highWaterMark.
   * Sent to the shader as wetnessParams.x for per-pixel boundary.
   */
  waterLineY: number = 0;

  /**
   * High water mark — relative height from object base (bounds.minY) in world units.
   * Ratchets up when object is submerged deeper, slowly evaporates when above water.
   * Clamped to [0, objectHeight].
   */
  highWaterMark: number = 0;

  /**
   * Wetness intensity factor (0 = dry, 1 = fully wet).
   * Written by WetnessSystem based on submersion depth.
   * The shader scales the wetness effect by this value.
   */
  wetnessFactor: number = 0;

  /**
   * How quickly the surface dries when above water (units per second).
   * Higher values = faster evaporation.
   */
  evaporationRate: number = 0.1;

  /**
   * Whether this entity should interact with ocean wetness at all.
   * Can be toggled off for objects that shouldn't get wet.
   */
  enabled: boolean = true;

  /**
   * Debug mode: when true, wet areas are tinted bright blue for visualization.
   */
  debug: boolean = false;

  serialize(): Record<string, unknown> {
    return {
      evaporationRate: this.evaporationRate,
      enabled: this.enabled,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.evaporationRate !== undefined)
      this.evaporationRate = data.evaporationRate as number;
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    // waterLineY and wetnessFactor are runtime state — not serialized
  }
}