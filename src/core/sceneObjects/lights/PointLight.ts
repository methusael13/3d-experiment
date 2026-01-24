import { vec3 } from 'gl-matrix';
import { Light, type BaseLightParams, type RGBColor } from './Light';
import type { SerializedLight } from '../types';

/**
 * Serialized point light data
 */
export interface SerializedPointLight extends SerializedLight {
  radius: number;
  falloff: number;
}

/**
 * Point light parameters for shader uniforms
 */
export interface PointLightParams extends BaseLightParams<'point'> {
  /** Position of the light in world space */
  position: vec3;
  /** Light range/falloff distance */
  radius: number;
  /** Falloff exponent (2 = physically correct inverse square) */
  falloff: number;
}

/**
 * Point light - emits light from a point in all directions.
 * Uses the position inherited from SceneObject.
 */
export class PointLight extends Light {
  /** Light range/falloff distance */
  public radius: number = 10;
  
  /** Falloff exponent (2 = physically correct inverse square) */
  public falloff: number = 2;
  
  constructor(name: string = 'Point Light') {
    super('point', name);
    // Default position above ground
    this.position = vec3.fromValues(0, 2, 0);
  }
  
  /**
   * Point lights don't have a single direction
   */
  getDirection(): vec3 | null {
    return null;
  }
  
  /**
   * Get direction from a world position to this light
   */
  getDirectionFrom(worldPos: vec3 | [number, number, number]): vec3 {
    const dx = this.position[0] - (worldPos as number[])[0];
    const dy = this.position[1] - (worldPos as number[])[1];
    const dz = this.position[2] - (worldPos as number[])[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    if (len < 0.0001) {
      return vec3.fromValues(0, 1, 0);
    }
    
    return vec3.fromValues(dx / len, dy / len, dz / len);
  }
  
  /**
   * Get distance from a world position to this light
   */
  getDistanceFrom(worldPos: vec3 | [number, number, number]): number {
    return vec3.distance(this.position, worldPos as vec3);
  }
  
  /**
   * Get attenuation at a given distance
   */
  getAttenuation(distance: number): number {
    if (distance >= this.radius) return 0;
    const normalized = distance / this.radius;
    return Math.pow(1 - normalized, this.falloff);
  }
  
  /**
   * Calculate light contribution at a world position
   */
  getLightContribution(worldPos: vec3 | [number, number, number]): {
    direction: vec3;
    attenuation: number;
    color: vec3;
  } {
    const distance = this.getDistanceFrom(worldPos);
    const direction = this.getDirectionFrom(worldPos);
    const attenuation = this.getAttenuation(distance) * this.intensity;
    
    return {
      direction,
      attenuation,
      color: vec3.clone(this.color),
    };
  }
  
  /**
   * Get light parameters for shader uniforms
   */
  getLightParams(): PointLightParams {
    return {
      ...super.getLightParams(),
      type: 'point',
      position: [this.position[0], this.position[1], this.position[2]],
      radius: this.radius,
      falloff: this.falloff,
    };
  }
  
  /**
   * Serialize the light
   */
  serialize(): SerializedPointLight {
    return {
      ...super.serialize(),
      radius: this.radius,
      falloff: this.falloff,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedPointLight>): void {
    super.deserialize(data);
    
    if (data.radius !== undefined) this.radius = data.radius;
    if (data.falloff !== undefined) this.falloff = data.falloff;
  }
  
  /**
   * Create from serialized data
   */
  static fromSerialized(data: SerializedPointLight): PointLight {
    const light = new PointLight(data.name);
    light.deserialize(data);
    return light;
  }
}
