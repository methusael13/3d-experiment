/**
 * Wind System - Physics-based wind with spring dynamics
 */

import type { Vec2 } from '../../core/types';

// ==================== Types ====================

export interface WindParams {
  enabled: boolean;
  time: number;
  strength: number;
  direction: Vec2;
  turbulence: number;
  debug?: number;
  gustStrength?: number;
}

export interface ObjectWindSettings {
  enabled: boolean;
  leafMaterialIndices: Set<number>;
  branchMaterialIndices: Set<number>;
  influence: number;
  stiffness: number;
  anchorHeight: number;
  displacement: Vec2;
  velocity: Vec2;
}

export interface WindManagerState {
  enabled: boolean;
  strength: number;
  direction: number;
  turbulence: number;
  gustStrength: number;
  gustFrequency: number;
}

// ==================== Wind Manager Class ====================

export class WindManager {
  // Global wind parameters
  private _enabled = false;
  private _strength = 0.5;        // 0-2, wind force magnitude
  private _direction = 45;        // degrees (0 = +X, 90 = +Z)
  private _turbulence = 0.5;      // 0-1, adds random variation
  private _gustStrength = 0.3;    // 0-1, random intensity spikes
  private _gustFrequency = 0.2;   // How often gusts occur
  
  // Physics parameters
  private _springStiffness = 2.0;  // Spring constant (higher = faster return)
  private _damping = 0.92;         // Velocity damping (0-1, lower = more damping)
  private readonly mass = 1.0;     // Effective mass
  
  // Internal state
  private _time = 0;
  private gustTime = 0;
  private currentGust = 0;
  private gustVector: Vec2 = [0, 0];  // Random gust direction offset
  
  // Debug mode
  private _debug = 0; // 0=off, 1=wind type, 2=height factor, 3=displacement

  // ==================== Getters/Setters ====================

  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) { this._enabled = v; }

  get strength(): number { return this._strength; }
  set strength(v: number) { this._strength = Math.max(0, Math.min(2, v)); }

  get direction(): number { return this._direction; }
  set direction(v: number) { this._direction = v % 360; }

  get turbulence(): number { return this._turbulence; }
  set turbulence(v: number) { this._turbulence = Math.max(0, Math.min(1, v)); }

  get gustStrength(): number { return this._gustStrength; }
  set gustStrength(v: number) { this._gustStrength = Math.max(0, Math.min(1, v)); }

  get gustFrequency(): number { return this._gustFrequency; }
  set gustFrequency(v: number) { this._gustFrequency = Math.max(0.1, Math.min(2, v)); }

  get debug(): number { return this._debug; }
  set debug(v: number) { this._debug = v; }

  get springStiffness(): number { return this._springStiffness; }
  set springStiffness(v: number) { this._springStiffness = Math.max(0.1, Math.min(10, v)); }

  get damping(): number { return this._damping; }
  set damping(v: number) { this._damping = Math.max(0.5, Math.min(0.99, v)); }

  get time(): number { return this._time; }

  // ==================== Methods ====================

  /**
   * Calculate wind force at current time with turbulence
   */
  calculateWindForce(): Vec2 {
    const rad = this._direction * Math.PI / 180;
    const baseDir: Vec2 = [Math.cos(rad), Math.sin(rad)];
    
    // Add turbulence as time-varying noise
    const turbX = Math.sin(this._time * 1.3) * 0.3 + Math.sin(this._time * 2.7) * 0.2;
    const turbZ = Math.cos(this._time * 1.7) * 0.3 + Math.cos(this._time * 2.3) * 0.2;
    
    // Effective strength with gust
    const effectiveStrength = this._strength + this.currentGust;
    
    // Apply turbulence to direction
    const force: Vec2 = [
      (baseDir[0] + turbX * this._turbulence + this.gustVector[0]) * effectiveStrength,
      (baseDir[1] + turbZ * this._turbulence + this.gustVector[1]) * effectiveStrength
    ];
    
    return force;
  }

  /**
   * Update wind simulation (call each frame)
   */
  update(deltaTime: number): void {
    this._time += deltaTime;
    this.gustTime += deltaTime;
    
    // Random gusts with random direction variation
    if (this.gustTime > (1 / this._gustFrequency)) {
      this.gustTime = 0;
      this.currentGust = Math.random() * this._gustStrength;
      // Random gust direction offset
      this.gustVector = [
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5
      ];
    }
    // Decay gust over time
    this.currentGust *= 0.93;
    this.gustVector[0] *= 0.95;
    this.gustVector[1] *= 0.95;
  }

  /**
   * Update physics simulation for an object
   */
  updateObjectPhysics(settings: ObjectWindSettings, deltaTime: number): void {
    if (!this._enabled || !settings.enabled) {
      // Reset to rest when disabled
      settings.displacement[0] *= 0.9;
      settings.displacement[1] *= 0.9;
      settings.velocity[0] *= 0.8;
      settings.velocity[1] *= 0.8;
      return;
    }
    
    const windForce = this.calculateWindForce();
    const stiffnessFactor = 1.0 - settings.stiffness;
    const effectiveInfluence = settings.influence * stiffnessFactor;
    
    const springK = this._springStiffness * (1.0 + settings.stiffness);
    const dampingFactor = this._damping * (0.95 + settings.stiffness * 0.05);
    
    for (let i = 0; i < 2; i++) {
      const fWind = windForce[i] * effectiveInfluence;
      const fSpring = -springK * settings.displacement[i];
      const fTotal = fWind + fSpring;
      const acceleration = fTotal / this.mass;
      
      settings.velocity[i] += acceleration * deltaTime;
      settings.velocity[i] *= dampingFactor;
      settings.displacement[i] += settings.velocity[i] * deltaTime;
    }
    
    // Clamp maximum displacement
    const maxDisp = 1.5 * effectiveInfluence;
    const dispMag = Math.sqrt(settings.displacement[0] ** 2 + settings.displacement[1] ** 2);
    if (dispMag > maxDisp) {
      const scale = maxDisp / dispMag;
      settings.displacement[0] *= scale;
      settings.displacement[1] *= scale;
    }
  }

  /**
   * Get wind direction as normalized vector [x, z]
   */
  getDirectionVector(): Vec2 {
    const rad = this._direction * Math.PI / 180;
    return [Math.cos(rad), Math.sin(rad)];
  }

  /**
   * Get uniforms for shader
   */
  getShaderUniforms(): WindParams {
    const dir = this.getDirectionVector();
    return {
      enabled: this._enabled,
      time: this._time,
      strength: this._strength + this.currentGust,
      direction: dir,
      turbulence: this._turbulence,
      debug: this._debug,
    };
  }

  /**
   * Serialize for scene saving
   */
  serialize(): WindManagerState {
    return {
      enabled: this._enabled,
      strength: this._strength,
      direction: this._direction,
      turbulence: this._turbulence,
      gustStrength: this._gustStrength,
      gustFrequency: this._gustFrequency,
    };
  }

  /**
   * Deserialize from saved scene
   */
  deserialize(data: Partial<WindManagerState> | null): void {
    if (!data) return;
    this._enabled = data.enabled ?? false;
    this._strength = data.strength ?? 0.5;
    this._direction = data.direction ?? 45;
    this._turbulence = data.turbulence ?? 0.5;
    this._gustStrength = data.gustStrength ?? 0.3;
    this._gustFrequency = data.gustFrequency ?? 0.2;
  }
}

// ==================== Factory Function ====================

/**
 * Create a new WindManager instance
 * @deprecated Use `new WindManager()` directly
 */
export function createWindManager(): WindManager {
  return new WindManager();
}

// ==================== Object Wind Settings Helpers ====================

/**
 * Create default wind settings for an object
 */
export function createObjectWindSettings(): ObjectWindSettings {
  return {
    enabled: false,
    leafMaterialIndices: new Set(),
    branchMaterialIndices: new Set(),
    influence: 1.0,
    stiffness: 0.5,
    anchorHeight: 0.0,
    displacement: [0, 0],
    velocity: [0, 0],
  };
}

/**
 * Serialize object wind settings
 */
export function serializeObjectWindSettings(settings: ObjectWindSettings | null): {
  enabled: boolean;
  leafMaterialIndices: number[];
  branchMaterialIndices: number[];
  influence: number;
  stiffness: number;
  anchorHeight: number;
} | null {
  if (!settings) return null;
  return {
    enabled: settings.enabled,
    leafMaterialIndices: [...settings.leafMaterialIndices],
    branchMaterialIndices: [...settings.branchMaterialIndices],
    influence: settings.influence,
    stiffness: settings.stiffness,
    anchorHeight: settings.anchorHeight,
  };
}

/**
 * Deserialize object wind settings
 */
export function deserializeObjectWindSettings(data: {
  enabled?: boolean;
  leafMaterialIndices?: number[];
  branchMaterialIndices?: number[];
  influence?: number;
  stiffness?: number;
  anchorHeight?: number;
} | null): ObjectWindSettings | null {
  if (!data) return null;
  return {
    enabled: data.enabled ?? false,
    leafMaterialIndices: new Set(data.leafMaterialIndices || []),
    branchMaterialIndices: new Set(data.branchMaterialIndices || []),
    influence: data.influence ?? 1.0,
    stiffness: data.stiffness ?? 0.5,
    anchorHeight: data.anchorHeight ?? 0.0,
    displacement: [0, 0],
    velocity: [0, 0],
  };
}
