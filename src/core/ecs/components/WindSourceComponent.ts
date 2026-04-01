import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { WindSourceShape } from '../../wind/types';
import type { Vec2 } from '../../types';

/**
 * WindSourceComponent — marks an entity as a local wind emitter.
 *
 * Entities with this component generate wind force in a volume around
 * their transform position. The force is combined with global wind
 * (from WindManager) when affecting nearby WindComponent receivers.
 *
 * Examples: helicopter rotor downwash, jet exhaust, fan, explosion shockwave.
 *
 * The WindSystem queries all wind-source entities each frame and accumulates
 * their contributions onto receivers based on distance, shape, and falloff.
 */
export class WindSourceComponent extends Component {
  readonly type: ComponentType = 'wind-source';

  /** Whether this source is currently active */
  enabled: boolean = true;

  /** Volume shape of the wind emission */
  shape: WindSourceShape = 'sphere';

  // ─── Wind Force Parameters ─────────────────────────────────

  /** Wind strength magnitude (0–5) */
  strength: number = 1.0;

  /** Direction [x, z] normalized — used by 'directional' and 'cone' shapes.
   *  For 'sphere' shape, wind radiates outward and this is ignored. */
  direction: Vec2 = [1, 0];

  /** Direction as angle in degrees (0 = +X, 90 = +Z). Convenience for UI.
   *  Kept in sync with `direction` vector. */
  directionAngle: number = 0;

  /** Turbulence amount (0–1) */
  turbulence: number = 0.3;

  /** Gust strength (0–1) — random intensity spikes */
  gustStrength: number = 0.2;

  /** Gust frequency in Hz */
  gustFrequency: number = 0.3;

  // ─── Spatial Parameters ────────────────────────────────────

  /** Maximum reach radius in world units */
  radius: number = 10.0;

  /** Full-strength inner radius (no attenuation within this) */
  innerRadius: number = 2.0;

  /** Falloff exponent (1 = linear, 2 = quadratic, 3 = cubic) */
  falloff: number = 2.0;

  /** Cone half-angle in degrees (only for 'cone' shape) */
  coneAngle: number = 45;

  // ─── Runtime State (managed by WindSystem) ─────────────────

  /** Internal time accumulator for this source's turbulence/gust simulation */
  _time: number = 0;

  /** Current gust intensity (decays over time) */
  _currentGust: number = 0;

  /** Random gust direction offset */
  _gustVector: Vec2 = [0, 0];

  /** Gust timer */
  _gustTime: number = 0;

  // ─── Methods ───────────────────────────────────────────────

  /**
   * Set direction from an angle in degrees (0 = +X, 90 = +Z).
   */
  setDirectionFromAngle(degrees: number): void {
    this.directionAngle = degrees % 360;
    const rad = (degrees * Math.PI) / 180;
    this.direction = [Math.cos(rad), Math.sin(rad)];
  }

  /**
   * Update direction angle from the current direction vector.
   */
  syncAngleFromDirection(): void {
    this.directionAngle =
      (Math.atan2(this.direction[1], this.direction[0]) * 180) / Math.PI;
    if (this.directionAngle < 0) this.directionAngle += 360;
  }

  serialize(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      shape: this.shape,
      strength: this.strength,
      directionAngle: this.directionAngle,
      turbulence: this.turbulence,
      gustStrength: this.gustStrength,
      gustFrequency: this.gustFrequency,
      radius: this.radius,
      innerRadius: this.innerRadius,
      falloff: this.falloff,
      coneAngle: this.coneAngle,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    if (data.shape !== undefined) this.shape = data.shape as WindSourceShape;
    if (data.strength !== undefined) this.strength = data.strength as number;
    if (data.directionAngle !== undefined) {
      this.setDirectionFromAngle(data.directionAngle as number);
    }
    if (data.turbulence !== undefined)
      this.turbulence = data.turbulence as number;
    if (data.gustStrength !== undefined)
      this.gustStrength = data.gustStrength as number;
    if (data.gustFrequency !== undefined)
      this.gustFrequency = data.gustFrequency as number;
    if (data.radius !== undefined) this.radius = data.radius as number;
    if (data.innerRadius !== undefined)
      this.innerRadius = data.innerRadius as number;
    if (data.falloff !== undefined) this.falloff = data.falloff as number;
    if (data.coneAngle !== undefined) this.coneAngle = data.coneAngle as number;
    // Runtime state (_time, _currentGust, etc.) is not serialized
  }
}
