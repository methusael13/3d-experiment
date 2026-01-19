/**
 * Wind System - Physics-based wind with spring dynamics
 */
export function createWindManager() {
  // Global wind parameters
  let enabled = false;
  let strength = 0.5;        // 0-2, wind force magnitude
  let direction = 45;        // degrees (0 = +X, 90 = +Z)
  let turbulence = 0.5;      // 0-1, adds random variation
  let gustStrength = 0.3;    // 0-1, random intensity spikes
  let gustFrequency = 0.2;   // How often gusts occur
  
  // Physics parameters
  let springStiffness = 2.0;  // Spring constant (higher = faster return)
  let damping = 0.92;         // Velocity damping (0-1, lower = more damping)
  let mass = 1.0;             // Effective mass
  
  // Internal state
  let time = 0;
  let gustTime = 0;
  let currentGust = 0;
  let gustVector = [0, 0];    // Random gust direction offset
  
  // Debug mode
  let debug = 0; // 0=off, 1=wind type, 2=height factor, 3=displacement
  
  // Physics state for each object (stored externally in objectWindSettings)
  
  /**
   * Calculate wind force at current time with turbulence
   * @returns {[number, number]} Force vector [x, z]
   */
  function calculateWindForce() {
    const rad = direction * Math.PI / 180;
    const baseDir = [Math.cos(rad), Math.sin(rad)];
    
    // Add turbulence as time-varying noise
    const turbX = Math.sin(time * 1.3) * 0.3 + Math.sin(time * 2.7) * 0.2;
    const turbZ = Math.cos(time * 1.7) * 0.3 + Math.cos(time * 2.3) * 0.2;
    
    // Effective strength with gust
    const effectiveStrength = strength + currentGust;
    
    // Apply turbulence to direction
    const force = [
      (baseDir[0] + turbX * turbulence + gustVector[0]) * effectiveStrength,
      (baseDir[1] + turbZ * turbulence + gustVector[1]) * effectiveStrength
    ];
    
    return force;
  }
  
  /**
   * Update wind simulation (call each frame)
   * @param {number} deltaTime - Time since last update in seconds
   */
  function update(deltaTime) {
    time += deltaTime;
    gustTime += deltaTime;
    
    // Random gusts with random direction variation
    if (gustTime > (1 / gustFrequency)) {
      gustTime = 0;
      currentGust = Math.random() * gustStrength;
      // Random gust direction offset
      gustVector = [
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5
      ];
    }
    // Decay gust over time
    currentGust *= 0.93;
    gustVector[0] *= 0.95;
    gustVector[1] *= 0.95;
  }
  
  /**
   * Update physics simulation for an object
   * Call this for each object that has wind enabled
   * @param {object} settings - Object wind settings with physics state
   * @param {number} deltaTime - Time step in seconds
   */
  function updateObjectPhysics(settings, deltaTime) {
    if (!enabled || !settings.enabled) {
      // Reset to rest when disabled
      settings.displacement[0] *= 0.9;
      settings.displacement[1] *= 0.9;
      settings.velocity[0] *= 0.8;
      settings.velocity[1] *= 0.8;
      return;
    }
    
    const windForce = calculateWindForce();
    const stiffnessFactor = 1.0 - settings.stiffness;
    const effectiveInfluence = settings.influence * stiffnessFactor;
    
    // Forces acting on the object:
    // 1. Wind force (scaled by influence)
    // 2. Spring force (pulls back to rest, F = -k * x)
    // 3. Damping (velocity reduction)
    
    const springK = springStiffness * (1.0 + settings.stiffness); // Stiffer objects return faster
    const dampingFactor = damping * (0.95 + settings.stiffness * 0.05); // Stiffer objects damp more
    
    for (let i = 0; i < 2; i++) {
      // Wind force
      const fWind = windForce[i] * effectiveInfluence;
      
      // Spring force (restoring)
      const fSpring = -springK * settings.displacement[i];
      
      // Total force
      const fTotal = fWind + fSpring;
      
      // Acceleration (F = ma, so a = F/m)
      const acceleration = fTotal / mass;
      
      // Verlet-style integration
      settings.velocity[i] += acceleration * deltaTime;
      settings.velocity[i] *= dampingFactor; // Apply damping
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
   * Get wind direction as normalized vector [x, z]
   */
  function getDirectionVector() {
    const rad = direction * Math.PI / 180;
    return [Math.cos(rad), Math.sin(rad)];
  }
  
  /**
   * Get uniforms for shader
   */
  function getShaderUniforms() {
    const dir = getDirectionVector();
    return {
      enabled,
      time,
      strength: strength + currentGust,
      direction: dir,
      turbulence,
      debug,
    };
  }
  
  /**
   * Create default wind settings for an object
   * Includes physics state (displacement, velocity)
   */
  function createObjectWindSettings() {
    return {
      enabled: false,
      leafMaterialIndices: new Set(),   // Which materials are "leaves"
      branchMaterialIndices: new Set(), // Which materials are "branches"
      influence: 1.0,                    // Overall influence multiplier
      stiffness: 0.5,                    // 0=flexible, 1=stiff
      anchorHeight: 0.0,                 // Below this Y, no movement
      // Physics state
      displacement: [0, 0],              // Current displacement [x, z]
      velocity: [0, 0],                  // Current velocity [x, z]
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
    get debug() { return debug; },
    set debug(v) { debug = v; },
    get springStiffness() { return springStiffness; },
    set springStiffness(v) { springStiffness = Math.max(0.1, Math.min(10, v)); },
    get damping() { return damping; },
    set damping(v) { damping = Math.max(0.5, Math.min(0.99, v)); },
    
    // Time
    get time() { return time; },
    
    // Methods
    update,
    updateObjectPhysics,
    calculateWindForce,
    getDirectionVector,
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
    branchMaterialIndices: [...(settings.branchMaterialIndices || [])],
    influence: settings.influence,
    stiffness: settings.stiffness,
    anchorHeight: settings.anchorHeight,
    // Note: displacement/velocity are runtime state, not saved
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
    branchMaterialIndices: new Set(data.branchMaterialIndices || []),
    influence: data.influence ?? 1.0,
    stiffness: data.stiffness ?? 0.5,
    anchorHeight: data.anchorHeight ?? 0.0,
    // Initialize physics state
    displacement: [0, 0],
    velocity: [0, 0],
  };
}
