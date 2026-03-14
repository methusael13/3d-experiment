import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Light component — describes a light source attached to an entity.
 *
 * The entity's TransformComponent provides position/direction.
 * This component holds light-specific properties.
 *
 * **Input fields** (set by UI / serialization):
 *   lightType, enabled, color, intensity, castsShadow,
 *   azimuth, elevation, ambientIntensity, range, innerConeAngle, outerConeAngle
 *
 * **Computed fields** (written by LightingSystem each frame):
 *   direction, effectiveColor, sunIntensityFactor, ambient,
 *   skyColor, groundColor
 */
export class LightComponent extends Component {
  readonly type: ComponentType = 'light';

  lightType: 'directional' | 'point' | 'spot' = 'directional';
  enabled: boolean = true;
  color: [number, number, number] = [1, 1, 1];
  intensity: number = 1.0;
  castsShadow: boolean = false;

  // Directional-specific (input)
  azimuth?: number;
  elevation?: number;
  ambientIntensity?: number;

  // Point/Spot-specific
  range?: number;

  // Spot-specific
  innerConeAngle?: number;
  outerConeAngle?: number;
  /** Shadow map resolution for this light (spot/point, default: 1024) */
  shadowMapResolution: number = 1024;

  // ── Shadow atlas (managed by ShadowRendererGPU, not owned) ──────────
  /** Index into the shadow atlas texture array (-1 = no shadow slot) */
  shadowAtlasIndex: number = -1;

  // ── Cookie textures (managed externally) ────────────────────────────
  /** Path to the cookie texture asset (null = no cookie) */
  cookieTexturePath: string | null = null;
  /** Index into the cookie atlas texture array (-1 = no cookie) */
  cookieAtlasIndex: number = -1;
  /** Cookie modulation intensity (0 = no effect, 1 = full cookie pattern) */
  cookieIntensity: number = 1.0;
  /** Cookie UV tiling */
  cookieTiling: [number, number] = [1, 1];
  /** Cookie UV offset */
  cookieOffset: [number, number] = [0, 0];

  // ── Computed fields (written by LightingSystem) ──────────────────────
  /** Light direction vector (points towards the light source) */
  direction: [number, number, number] = [0.3, 0.8, 0.5];
  /** Effective color (includes atmospheric tinting, moonlight, and intensity factor) */
  effectiveColor: [number, number, number] = [1, 1, 0.95];
  /** Sun intensity factor: 0→MOON_INTENSITY at night, 1 during day, smooth twilight transition */
  sunIntensityFactor: number = 1.0;
  /** Ambient contribution (computed from elevation and ambientIntensity) */
  ambient: number = 0.3;
  /** Sky hemisphere color for ambient lighting */
  skyColor: [number, number, number] = [0.4, 0.6, 1.0];
  /** Ground hemisphere color for ambient lighting */
  groundColor: [number, number, number] = [0.3, 0.25, 0.2];

  serialize(): Record<string, unknown> {
    return {
      lightType: this.lightType,
      enabled: this.enabled,
      color: [...this.color],
      intensity: this.intensity,
      castsShadow: this.castsShadow,
      azimuth: this.azimuth,
      elevation: this.elevation,
      ambientIntensity: this.ambientIntensity,
      range: this.range,
      innerConeAngle: this.innerConeAngle,
      outerConeAngle: this.outerConeAngle,
      shadowMapResolution: this.shadowMapResolution,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.lightType)
      this.lightType = data.lightType as 'directional' | 'point' | 'spot';
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    if (data.color) this.color = data.color as [number, number, number];
    if (data.intensity !== undefined) this.intensity = data.intensity as number;
    if (data.castsShadow !== undefined)
      this.castsShadow = data.castsShadow as boolean;
    if (data.azimuth !== undefined) this.azimuth = data.azimuth as number;
    if (data.elevation !== undefined)
      this.elevation = data.elevation as number;
    if (data.ambientIntensity !== undefined)
      this.ambientIntensity = data.ambientIntensity as number;
    if (data.range !== undefined) this.range = data.range as number;
    if (data.innerConeAngle !== undefined)
      this.innerConeAngle = data.innerConeAngle as number;
    if (data.outerConeAngle !== undefined)
      this.outerConeAngle = data.outerConeAngle as number;
    if (data.shadowMapResolution !== undefined)
      this.shadowMapResolution = data.shadowMapResolution as number;
  }

  clone(): LightComponent {
    const c = new LightComponent();
    c.deserialize(this.serialize());
    return c;
  }
}
