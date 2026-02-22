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
  /** Sun intensity factor (0 at night, 1 during day, smooth transition at twilight) */
  sunIntensityFactor: number;
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
  
  /** Moonlight intensity relative to sunlight (≈3% of full sun) */
  static readonly MOON_INTENSITY = 0.03;
  
  /** Moonlight color (cool blue) */
  static readonly MOON_COLOR: [number, number, number] = [0.4, 0.5, 0.7];
  
  /**
   * Whether the scene is currently in night mode (sun below horizon threshold)
   */
  isNightMode(): boolean {
    return this.elevation < -5;
  }
  
  /**
   * Calculate direction from azimuth and elevation.
   * During night (elevation < -5°), returns a "moon" direction:
   * the sun direction is mirrored to the opposite side of the sky
   * (reversed XZ, positive Y using the magnitude of the below-horizon angle).
   */
  getDirection(): vec3 {
    const azRad = this.azimuth * Math.PI / 180;
    const elRad = this.elevation * Math.PI / 180;
    
    if (this.isNightMode()) {
      // Moon direction: opposite side of the sky from the sun
      // Use the absolute elevation angle to place moon above horizon
      const moonElRad = Math.abs(elRad);
      // Reverse azimuth (add 180°) to place moon on opposite side
      const moonAzRad = azRad + Math.PI;
      return vec3.fromValues(
        Math.cos(moonElRad) * Math.sin(moonAzRad),
        Math.sin(moonElRad),
        Math.cos(moonElRad) * Math.cos(moonAzRad)
      );
    }
    
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
   * Get directional light intensity factor based on elevation.
   * Smoothly fades from 1.0 (full sun) to MOON_INTENSITY (moonlight) through twilight.
   * Never reaches zero — at night, moonlight provides faint directional illumination.
   */
  getSunIntensityFactor(): number {
    const moon = DirectionalLight.MOON_INTENSITY;
    if (this.elevation >= 5) return 1.0;                              // Full sun
    if (this.elevation <= -5) return moon;                             // Moonlight
    // Smooth fade from 1.0 → moon across [-5°, +5°]
    const t = (this.elevation + 5) / 10;                              // 0 at -5°, 1 at +5°
    return moon + (1.0 - moon) * t;
  }
  
  /**
   * Get effective light color based on elevation (sunset/sunrise tint, moonlight at night).
   * Scaled by sunIntensityFactor so light is dim moonlight blue at night, warm white during day.
   */
  getSunColor(): [number, number, number] {
    const factor = this.getSunIntensityFactor();
    
    let r: number, g: number, b: number;
    if (this.isNightMode()) {
      // Night: cool blue moonlight color
      [r, g, b] = DirectionalLight.MOON_COLOR;
    } else if (Math.abs(this.elevation) < 15) {
      // Sunset/sunrise/twilight tint
      const t = Math.abs(this.elevation) / 15;
      r = 1.0;
      g = 0.6 + 0.4 * t;
      b = 0.4 + 0.6 * t;
    } else {
      // Day: white light
      r = 1.0; g = 1.0; b = 0.95;
    }
    
    return [r * factor, g * factor, b * factor];
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
      sunIntensityFactor: this.getSunIntensityFactor(),
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
  
  /**
   * Construct a DirectionalLight from renderer output params.
   * Inverts getDirection() using light color luminance to detect night mode,
   * then recovers the true elevation/azimuth for correct light param computation.
   * 
   * @param direction - Upper-hemisphere light direction from renderer (mirrored during night)
   * @param lightColor - Effective light color (includes atmospheric tinting / moonlight)
   * @param ambientIntensity - Ambient intensity multiplier
   */
  static fromRendererParams(
    direction: [number, number, number],
    lightColor: [number, number, number],
    ambientIntensity: number = 1.0,
  ): DirectionalLight {
    const light = new DirectionalLight('_proxy');
    light.ambientIntensity = ambientIntensity;
    
    // Detect night: moonlight total luminance is very low (~0.048)
    // Daytime is ~2.95, twilight is intermediate
    const luminance = lightColor[0] + lightColor[1] + lightColor[2];
    const isNight = luminance < 0.15;
    
    // Elevation from direction Y (always positive since night mirrors to upper hemisphere)
    const elevRad = Math.asin(Math.max(-1, Math.min(1, direction[1])));
    
    if (isNight) {
      // Night: getDirection() mirrors the direction (azimuth + 180°, elevation = |original|)
      // Reverse: true elevation = -|elevRad|, azimuth = atan2(x,z) - 180°
      light.elevation = -Math.abs(elevRad * 180 / Math.PI);
      light.azimuth = (Math.atan2(direction[0], direction[2]) * 180 / Math.PI) - 180;
    } else {
      light.elevation = elevRad * 180 / Math.PI;
      light.azimuth = Math.atan2(direction[0], direction[2]) * 180 / Math.PI;
    }
    
    return light;
  }
}
