import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Light component — describes a light source attached to an entity.
 *
 * The entity's TransformComponent provides position/direction.
 * This component holds light-specific properties.
 */
export class LightComponent extends Component {
  readonly type: ComponentType = 'light';

  lightType: 'directional' | 'point' | 'spot' = 'directional';
  enabled: boolean = true;
  color: [number, number, number] = [1, 1, 1];
  intensity: number = 1.0;
  castsShadow: boolean = false;

  // Directional-specific
  azimuth?: number;
  elevation?: number;
  ambientIntensity?: number;

  // Point/Spot-specific
  range?: number;

  // Spot-specific
  innerConeAngle?: number;
  outerConeAngle?: number;

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
  }
}