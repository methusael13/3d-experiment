import { vec3 } from 'gl-matrix';
import { SceneObject } from '../SceneObject';
import type { SerializedLight } from '../types';

/**
 * Light type identifiers
 */
export type LightType = 'directional' | 'point' | 'hdr' | 'spot';

/**
 * RGB color tuple
 */
export type RGBColor = [number, number, number];

/**
 * Base light parameters for shader uniforms.
 * Generic type T allows discriminating between light types.
 */
export interface BaseLightParams<T extends LightType = LightType> {
  type: T;
  enabled: boolean;
  intensity: number;
  color: RGBColor;
  castsShadow: boolean;
}

/**
 * Base class for all light types in the scene.
 * Extends SceneObject with lighting-specific properties.
 */
export abstract class Light extends SceneObject {
  /** Light type identifier */
  public readonly lightType: LightType;
  
  /** Whether the light is enabled */
  public enabled: boolean = true;
  
  /** Light intensity multiplier */
  public intensity: number = 1.0;
  
  /** Light color (RGB, 0-1 range) */
  public color: vec3;
  
  /** Whether this light casts shadows */
  public castsShadow: boolean = false;
  
  constructor(lightType: LightType, name: string = 'Light') {
    super(name);
    this.lightType = lightType;
    this.color = vec3.fromValues(1.0, 1.0, 1.0);
  }
  
  /**
   * Object type identifier
   */
  get objectType(): string {
    return 'light';
  }
  
  /**
   * Get the direction of the light (for directional lights).
   * Override in subclasses.
   * @returns Direction vector or null if not applicable
   */
  getDirection(): vec3 | null {
    return vec3.fromValues(0, -1, 0); // Default: straight down
  }
  
  /**
   * Get ambient contribution.
   * Override in subclasses.
   */
  getAmbient(): number {
    return 0.2;
  }
  
  /**
   * Get light parameters for shader uniforms.
   * Override in subclasses to add type-specific params.
   */
  getLightParams(): BaseLightParams {
    return {
      type: this.lightType,
      enabled: this.enabled,
      intensity: this.intensity,
      color: [this.color[0], this.color[1], this.color[2]],
      castsShadow: this.castsShadow,
    };
  }
  
  /**
   * Set light color from RGB values (0-1 range)
   */
  setColor(r: number, g: number, b: number): void {
    vec3.set(this.color, r, g, b);
  }
  
  /**
   * Set light color from array
   */
  setColorArray(color: [number, number, number] | vec3): void {
    vec3.copy(this.color, color as vec3);
  }
  
  /**
   * Serialize the light
   */
  serialize(): SerializedLight {
    const base = super.serialize();
    return {
      ...base,
      type: this.lightType,
      enabled: this.enabled,
      intensity: this.intensity,
      color: [this.color[0], this.color[1], this.color[2]],
      castsShadow: this.castsShadow,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedLight>): void {
    super.deserialize(data);
    
    if (data.enabled !== undefined) this.enabled = data.enabled;
    if (data.intensity !== undefined) this.intensity = data.intensity;
    if (data.color) this.setColorArray(data.color);
    if (data.castsShadow !== undefined) this.castsShadow = data.castsShadow;
  }
  
  /**
   * Clean up (lights typically don't have GPU resources)
   */
  destroy(): void {
    // Nothing to clean up by default
  }
}
