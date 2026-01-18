/**
 * Wind System - manages global wind parameters and per-object wind settings
 */
export function createWindManager() {
  // Global wind parameters
  let enabled = false;
  let strength = 0.5;        // 0-2
  let direction = 45;        // degrees (0 = +X, 90 = +Z)
  let turbulence = 0.5;      // 0-1, affects frequency variation
  let gustStrength = 0.3;    // 0-1, random intensity spikes
  let gustFrequency = 0.2;   // How often gusts occur
  
  // Internal time tracking
  let time = 0;
  let gustTime = 0;
  let currentGust = 0;
  
  /**
   * Update wind simulation (call each frame)
   * @param {number} deltaTime - Time since last update in seconds
   */
  function update(deltaTime) {
    time += deltaTime;
    gustTime += deltaTime;
    
    // Random gusts
    if (gustTime > (1 / gustFrequency)) {
      gustTime = 0;
      currentGust = Math.random() * gustStrength;
    }
    // Decay gust over time
    currentGust *= 0.95;
  }
  
  /**
   * Get wind direction as normalized vector [x, z]
   */
  function getDirectionVector() {
    const rad = direction * Math.PI / 180;
    return [Math.cos(rad), Math.sin(rad)];
  }
  
  /**
   * Get effective wind strength (base + gust)
   */
  function getEffectiveStrength() {
    return strength + currentGust;
  }
  
  /**
   * Get uniforms for shader
   */
  function getShaderUniforms() {
    const dir = getDirectionVector();
    return {
      uWindEnabled: enabled ? 1 : 0,
      uWindTime: time,
      uWindStrength: getEffectiveStrength(),
      uWindDirection: dir,
      uWindTurbulence: turbulence,
    };
  }
  
  /**
   * Create default wind settings for an object
   */
  function createObjectWindSettings() {
    return {
      enabled: false,
      leafMaterialIndices: new Set(), // Which materials are "leaves"
      influence: 1.0,                  // Overall influence multiplier
      stiffness: 0.5,                  // 0=flexible, 1=stiff
      anchorHeight: 0.0,               // Below this Y, no movement
    };
  }
  
  /**
   * Serialize for scene saving
   */
  function serialize() {
    return {
      enabled,
      strength,
      direction,
      turbulence,
      gustStrength,
      gustFrequency,
    };
  }
  
  /**
   * Deserialize from saved scene
   */
  function deserialize(data) {
    if (!data) return;
    enabled = data.enabled ?? false;
    strength = data.strength ?? 0.5;
    direction = data.direction ?? 45;
    turbulence = data.turbulence ?? 0.5;
    gustStrength = data.gustStrength ?? 0.3;
    gustFrequency = data.gustFrequency ?? 0.2;
  }
  
  return {
    // Global settings (read/write)
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; },
    get strength() { return strength; },
    set strength(v) { strength = Math.max(0, Math.min(2, v)); },
    get direction() { return direction; },
    set direction(v) { direction = v % 360; },
    get turbulence() { return turbulence; },
    set turbulence(v) { turbulence = Math.max(0, Math.min(1, v)); },
    get gustStrength() { return gustStrength; },
    set gustStrength(v) { gustStrength = Math.max(0, Math.min(1, v)); },
    get gustFrequency() { return gustFrequency; },
    set gustFrequency(v) { gustFrequency = Math.max(0.1, Math.min(2, v)); },
    
    // Time
    get time() { return time; },
    
    // Methods
    update,
    getDirectionVector,
    getEffectiveStrength,
    getShaderUniforms,
    createObjectWindSettings,
    serialize,
    deserialize,
  };
}

/**
 * Serialize object wind settings
 */
export function serializeObjectWindSettings(settings) {
  if (!settings) return null;
  return {
    enabled: settings.enabled,
    leafMaterialIndices: [...settings.leafMaterialIndices],
    influence: settings.influence,
    stiffness: settings.stiffness,
    anchorHeight: settings.anchorHeight,
  };
}

/**
 * Deserialize object wind settings
 */
export function deserializeObjectWindSettings(data) {
  if (!data) return null;
  return {
    enabled: data.enabled ?? false,
    leafMaterialIndices: new Set(data.leafMaterialIndices || []),
    influence: data.influence ?? 1.0,
    stiffness: data.stiffness ?? 0.5,
    anchorHeight: data.anchorHeight ?? 0.0,
  };
}
