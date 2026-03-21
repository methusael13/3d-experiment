/**
 * WeatherPresets — Coordinated weather preset system
 *
 * Each preset defines cloud, lighting, fog, and wind settings that work together
 * for a consistent atmospheric look. Transitions between presets lerp all parameters
 * over a configurable duration for smooth weather changes.
 *
 * Phase 5: Weather, Lighting & Polish
 */

// ========== Weather Preset Interface ==========

export interface WeatherPreset {
  name: string;

  // Cloud parameters
  cloudCoverage: number;          // 0–1
  cloudType: number;              // 0=stratus, 0.5=stratocumulus, 1.0=cumulus
  cloudDensity: number;           // extinction coefficient
  cloudBaseAltitude: number;      // meters
  cloudThickness: number;         // meters
  cirrusOpacity: number;          // 0–1
  precipitation: number;          // 0=none, 1=heavy

  // Lighting adaptation
  sunIntensityScale: number;      // multiplier on DirectionalLight intensity
  ambientBoost: number;           // extra ambient under overcast
  shadowVisibility: number;       // 0=no shadows, 1=full shadows

  // Wind
  windSpeed: number;              // m/s
  windDirection: number;          // azimuth degrees
}

// ========== Built-in Presets ==========

export const WEATHER_PRESETS: Record<string, WeatherPreset> = {
  'Clear': {
    name: 'Clear',
    cloudCoverage: 0.1,
    cloudType: 1.0,
    cloudDensity: 0.15,
    cloudBaseAltitude: 2000,
    cloudThickness: 2500,
    cirrusOpacity: 0.1,
    precipitation: 0,
    sunIntensityScale: 1.0,
    ambientBoost: 0.0,
    shadowVisibility: 1.0,
    windSpeed: 3,
    windDirection: 45,
  },
  'Partly Cloudy': {
    name: 'Partly Cloudy',
    cloudCoverage: 0.4,
    cloudType: 0.8,
    cloudDensity: 0.2,
    cloudBaseAltitude: 1500,
    cloudThickness: 2500,
    cirrusOpacity: 0.2,
    precipitation: 0,
    sunIntensityScale: 0.85,
    ambientBoost: 0.1,
    shadowVisibility: 0.9,
    windSpeed: 5,
    windDirection: 45,
  },
  'Cloudy': {
    name: 'Cloudy',
    cloudCoverage: 0.65,
    cloudType: 0.5,
    cloudDensity: 0.25,
    cloudBaseAltitude: 1200,
    cloudThickness: 2000,
    cirrusOpacity: 0.0,
    precipitation: 0,
    sunIntensityScale: 0.45,
    ambientBoost: 0.05,
    shadowVisibility: 0.5,
    windSpeed: 8,
    windDirection: 90,
  },
  'Overcast': {
    name: 'Overcast',
    cloudCoverage: 0.95,
    cloudType: 0.05,
    cloudDensity: 0.3,
    cloudBaseAltitude: 600,
    cloudThickness: 1800,
    cirrusOpacity: 0.0,
    precipitation: 0,
    sunIntensityScale: 0.25,
    ambientBoost: -0.15,
    shadowVisibility: 0.0,
    windSpeed: 10,
    windDirection: 180,
  },
  'Rainy': {
    name: 'Rainy',
    cloudCoverage: 1.0,
    cloudType: 0.0,
    cloudDensity: 0.35,
    cloudBaseAltitude: 500,
    cloudThickness: 1500,
    cirrusOpacity: 0.0,
    precipitation: 0.8,
    sunIntensityScale: 0.12,
    ambientBoost: -0.3,
    shadowVisibility: 0.0,
    windSpeed: 15,
    windDirection: 200,
  },
  'Stormy': {
    name: 'Stormy',
    cloudCoverage: 0.9,
    cloudType: 0.2,
    cloudDensity: 0.45,
    cloudBaseAltitude: 400,
    cloudThickness: 3500,
    cirrusOpacity: 0.0,
    precipitation: 1.0,
    sunIntensityScale: 0.06,
    ambientBoost: -0.4,
    shadowVisibility: 0.0,
    windSpeed: 25,
    windDirection: 270,
  },
};

/** Ordered list of preset names for UI dropdown */
export const WEATHER_PRESET_NAMES = Object.keys(WEATHER_PRESETS);

// ========== Weather State Manager ==========

/**
 * WeatherStateManager handles smooth interpolation between weather presets.
 *
 * It maintains a "current" and "target" state, lerping all parameters
 * over a configurable transition duration.
 */
export class WeatherStateManager {
  /** Current interpolated weather state */
  private _current: WeatherPreset;
  /** Target weather state (destination of transition) */
  private _target: WeatherPreset;
  /** Progress of transition [0, 1]. 1 = fully arrived at target. */
  private _progress = 1.0;
  /** Transition duration in seconds */
  private _transitionDuration = 7.0;
  /** Name of the active preset (null if custom/manual) */
  private _activePreset: string | null = 'Partly Cloudy';

  // Lighting adaptation computed values (derived from current state + coverage)
  private _effectiveSunScale = 1.0;
  private _effectiveAmbientBoost = 0.0;
  private _effectiveShadowVisibility = 1.0;

  constructor() {
    const defaultPreset = WEATHER_PRESETS['Partly Cloudy'];
    this._current = { ...defaultPreset };
    this._target = { ...defaultPreset };
  }

  // ========== Accessors ==========

  get current(): Readonly<WeatherPreset> { return this._current; }
  get target(): Readonly<WeatherPreset> { return this._target; }
  get progress(): number { return this._progress; }
  get isTransitioning(): boolean { return this._progress < 1.0; }
  get activePreset(): string | null { return this._activePreset; }
  get transitionDuration(): number { return this._transitionDuration; }

  /** Effective sun intensity multiplier (accounts for cloud coverage) */
  get effectiveSunScale(): number { return this._effectiveSunScale; }
  /** Effective ambient boost (accounts for cloud coverage) */
  get effectiveAmbientBoost(): number { return this._effectiveAmbientBoost; }
  /** Effective shadow visibility (0 = no shadows, 1 = full shadows) */
  get effectiveShadowVisibility(): number { return this._effectiveShadowVisibility; }

  // ========== Transition ==========

  /**
   * Set a new target weather preset with smooth transition.
   */
  setPreset(name: string, duration?: number): void {
    const preset = WEATHER_PRESETS[name];
    if (!preset) return;

    this._target = { ...preset };
    this._progress = 0.0;
    this._activePreset = name;
    if (duration !== undefined) {
      this._transitionDuration = duration;
    }
  }

  /**
   * Jump immediately to a preset (no transition).
   */
  jumpToPreset(name: string): void {
    const preset = WEATHER_PRESETS[name];
    if (!preset) return;

    this._current = { ...preset };
    this._target = { ...preset };
    this._progress = 1.0;
    this._activePreset = name;
    this.updateDerivedValues();
  }

  /**
   * Set a custom target state (not from a named preset).
   */
  setCustomTarget(partial: Partial<WeatherPreset>): void {
    Object.assign(this._target, partial);
    this._progress = 0.0;
    this._activePreset = null; // Custom means no named preset
  }

  /**
   * Override the current state instantly (e.g., from UI slider).
   * Only affects the overridden fields; others continue transitioning.
   */
  overrideCurrent(partial: Partial<WeatherPreset>): void {
    Object.assign(this._current, partial);
    Object.assign(this._target, partial);
    this.updateDerivedValues();
  }

  /**
   * Clear the active preset, switching to Custom mode.
   * Stops any active transition and resets lighting adaptation to neutral
   * (sunIntensityScale=1, ambientBoost=0) so manual cloud settings
   * don't carry the preset's dimming.
   */
  clearPreset(): void {
    this._activePreset = null;
    this._progress = 1.0;
    // Reset lighting adaptation to neutral (no weather dimming)
    this._current.sunIntensityScale = 1.0;
    this._current.ambientBoost = 0.0;
    this._target.sunIntensityScale = 1.0;
    this._target.ambientBoost = 0.0;
    this.updateDerivedValues();
  }

  /**
   * Set transition duration in seconds.
   */
  setTransitionDuration(seconds: number): void {
    this._transitionDuration = Math.max(0.1, seconds);
  }

  // ========== Update ==========

  /**
   * Advance the weather transition by deltaTime seconds.
   * Call once per frame.
   */
  update(deltaTime: number): void {
    if (this._progress >= 1.0) {
      this.updateDerivedValues();
      return;
    }

    // Advance progress
    const speed = 1.0 / Math.max(this._transitionDuration, 0.01);
    this._progress = Math.min(1.0, this._progress + deltaTime * speed);

    // Lerp all parameters
    this._current = lerpPreset(this._current, this._target, this._progress);

    this.updateDerivedValues();
  }

  /**
   * Compute derived lighting values from current weather state.
   */
  private updateDerivedValues(): void {
    const c = this._current;

    // Sun intensity attenuation: use sunIntensityScale directly from the preset.
    // Don't also multiply by coverage occlusion here — the cloud shadow map already
    // provides per-pixel occlusion from cloud density. Applying both causes the
    // effectiveColor to go to near-zero, making objects completely black.
    this._effectiveSunScale = c.sunIntensityScale;

    // Ambient boost: mild compensation for lost direct light (§6.4.5)
    // Was 0.3 per coverage — too aggressive, made terrain too bright under overcast.
    // Now 0.1 per coverage: overcast/rainy presets use negative ambientBoost to darken further.
    this._effectiveAmbientBoost = c.ambientBoost + c.cloudCoverage * 0.1;

    // Shadow visibility: fade out under overcast (§6.4.3)
    const coverageShadowFade = 1.0 - smoothstep(0.6, 0.9, c.cloudCoverage);
    this._effectiveShadowVisibility = c.shadowVisibility * coverageShadowFade;
  }

  // ========== Serialization ==========

  /**
   * Serialize current weather state for scene saving.
   */
  serialize(): SerializedWeatherState {
    return {
      activePreset: this._activePreset,
      current: { ...this._current },
      transitionDuration: this._transitionDuration,
    };
  }

  /**
   * Restore weather state from serialized data.
   */
  deserialize(data: SerializedWeatherState): void {
    if (data.activePreset && WEATHER_PRESETS[data.activePreset]) {
      this.jumpToPreset(data.activePreset);
    }
    if (data.current) {
      this._current = { ...this._current, ...data.current };
      this._target = { ...this._current };
    }
    if (data.transitionDuration !== undefined) {
      this._transitionDuration = data.transitionDuration;
    }
    this._progress = 1.0;
    this.updateDerivedValues();
  }
}

// ========== Serialization Types ==========

export interface SerializedWeatherState {
  activePreset: string | null;
  current: Partial<WeatherPreset>;
  transitionDuration: number;
}

// ========== Interpolation Utilities ==========

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerpPreset(a: WeatherPreset, b: WeatherPreset, t: number): WeatherPreset {
  return {
    name: t >= 0.5 ? b.name : a.name,
    cloudCoverage: lerp(a.cloudCoverage, b.cloudCoverage, t),
    cloudType: lerp(a.cloudType, b.cloudType, t),
    cloudDensity: lerp(a.cloudDensity, b.cloudDensity, t),
    cloudBaseAltitude: lerp(a.cloudBaseAltitude, b.cloudBaseAltitude, t),
    cloudThickness: lerp(a.cloudThickness, b.cloudThickness, t),
    cirrusOpacity: lerp(a.cirrusOpacity, b.cirrusOpacity, t),
    precipitation: lerp(a.precipitation, b.precipitation, t),
    sunIntensityScale: lerp(a.sunIntensityScale, b.sunIntensityScale, t),
    ambientBoost: lerp(a.ambientBoost, b.ambientBoost, t),
    shadowVisibility: lerp(a.shadowVisibility, b.shadowVisibility, t),
    windSpeed: lerp(a.windSpeed, b.windSpeed, t),
    windDirection: lerpAngle(a.windDirection, b.windDirection, t),
  };
}

/**
 * Lerp between two angles in degrees, taking the shortest path.
 */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}
