import { vec3 } from 'gl-matrix';
import { Light, type BaseLightParams, type RGBColor } from './Light';
import type { SerializedLight } from '../types';

/**
 * Serialized directional light data
 */
export interface SerializedDirectionalLight extends SerializedLight {
  azimuth: number;
  elevation: number;
  shadowResolution: number;
  ambientIntensity: number;
}

/**
 * Directional light parameters for shader uniforms
 */
export interface DirectionalLightParams extends BaseLightParams<'directional'> {
  /** Direction vector pointing towards the light source */
  direction: vec3;
  /** Computed effective color (includes atmospheric tinting based on elevation) */
  effectiveColor: RGBColor;
  /** Ambient contribution (computed from elevation and ambientIntensity) */
  ambient: number;
  /** Sky hemisphere color for ambient lighting */
  skyColor: RGBColor;
  /** Ground hemisphere color for ambient lighting */
  groundColor: RGBColor;
  /** Shadow map resolution */
  shadowResolution: number;
}

/**
 * Directional/Sun light - simulates distant light source like the sun.
 * Direction is computed from azimuth and elevation angles.
 */
export class DirectionalLight extends Light {
  /** Horizontal angle in degrees */
  public azimuth: number = 45;
  
  /** Vertical angle in degrees */
  public elevation: number = 45;
  
  /** Shadow map resolution */
  public shadowResolution: number = 2048;
  
  /** Ambient intensity multiplier (lower = darker shadows) */
  public ambientIntensity: number = 1.0;
  
  constructor(name: string = 'Sun') {
    super('directional', name);
    this.castsShadow = true;
  }
  
  /**
   * Calculate direction from azimuth and elevation
   */
  getDirection(): vec3 {
    const azRad = this.azimuth * Math.PI / 180;
    const elRad = this.elevation * Math.PI / 180;
    return vec3.fromValues(
      Math.cos(elRad) * Math.sin(azRad),
      Math.sin(elRad),
      Math.cos(elRad) * Math.cos(azRad)
    );
  }
  
  /**
   * Get ambient based on sun elevation (day/night cycle) and user intensity multiplier
   */
  getAmbient(): number {
    let baseAmbient: number;
    if (this.elevation <= 0) {
      // Night mode: low ambient when sun below horizon
      baseAmbient = 0.1 + (this.elevation + 90) / 900;
    } else {
      // Day mode: ramp up ambient with elevation
      baseAmbient = 0.2 + this.elevation / 180;
    }
    return baseAmbient * this.ambientIntensity;
  }
  
  /**
   * Get sun color based on elevation (sunset/sunrise tint)
   */
  getSunColor(): [number, number, number] {
    if (Math.abs(this.elevation) < 15) {
      // Sunset/sunrise tint
      const t = Math.abs(this.elevation) / 15;
      return [1.0, 0.6 + 0.4 * t, 0.4 + 0.6 * t];
    }
    if (this.elevation > 0) {
      // Day: white light
      return [1.0, 1.0, 0.95];
    }
    // Night: cool blue moonlight
    return [0.4, 0.5, 0.7];
  }
  
  /**
   * Get sky color for hemisphere ambient lighting based on elevation
   */
  getSkyColor(): [number, number, number] {
    if (this.elevation < -10) {
      return [0.1, 0.12, 0.2]; // Night
    }
    if (this.elevation < 5) {
      const t = (this.elevation + 10) / 15;
      return [0.1 + 0.5 * t, 0.12 + 0.28 * t, 0.2 + 0.3 * t]; // Twilight
    }
    if (this.elevation < 20) {
      const t = (this.elevation - 5) / 15;
      return [0.6 - 0.2 * t, 0.4 + 0.2 * t, 0.5 + 0.5 * t]; // Sunrise/sunset
    }
    return [0.4, 0.6, 1.0]; // Day
  }
  
  /**
   * Get ground color for hemisphere ambient lighting based on elevation
   */
  getGroundColor(): [number, number, number] {
    if (this.elevation < 0) {
      return [0.05, 0.05, 0.08]; // Night
    }
    if (this.elevation < 20) {
      const t = this.elevation / 20;
      return [0.2 + 0.1 * t, 0.15 + 0.1 * t, 0.1 + 0.1 * t]; // Low sun
    }
    return [0.3, 0.25, 0.2]; // Day
  }
  
  /**
   * Get light parameters for shader uniforms
   */
  getLightParams(): DirectionalLightParams {
    return {
      ...super.getLightParams(),
      type: 'directional',
      direction: this.getDirection(),
      effectiveColor: this.getSunColor(),
      ambient: this.getAmbient(),
      skyColor: this.getSkyColor(),
      groundColor: this.getGroundColor(),
      shadowResolution: this.shadowResolution,
    };
  }
  
  /**
   * Serialize the light
   */
  serialize(): SerializedDirectionalLight {
    return {
      ...super.serialize(),
      azimuth: this.azimuth,
      elevation: this.elevation,
      shadowResolution: this.shadowResolution,
      ambientIntensity: this.ambientIntensity,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedDirectionalLight>): void {
    super.deserialize(data);
    
    if (data.azimuth !== undefined) this.azimuth = data.azimuth;
    if (data.elevation !== undefined) this.elevation = data.elevation;
    if (data.shadowResolution !== undefined) this.shadowResolution = data.shadowResolution;
    if (data.ambientIntensity !== undefined) this.ambientIntensity = data.ambientIntensity;
    
    // Legacy support
    if ((data as Record<string, unknown>).sunAzimuth !== undefined) {
      this.azimuth = (data as Record<string, unknown>).sunAzimuth as number;
    }
    if ((data as Record<string, unknown>).sunElevation !== undefined) {
      this.elevation = (data as Record<string, unknown>).sunElevation as number;
    }
  }
  
  /**
   * Create from serialized data
   */
  static fromSerialized(data: SerializedDirectionalLight): DirectionalLight {
    const light = new DirectionalLight(data.name);
    light.deserialize(data);
    return light;
  }
}
