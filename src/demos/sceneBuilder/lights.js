/**
 * Lighting classes for the scene builder
 * OOP structure for extensible light types
 */

/**
 * Base Light class - all lights extend this
 */
export class Light {
  constructor(type) {
    this.type = type;
    this.enabled = true;
    this.intensity = 1.0;
    this.color = [1.0, 1.0, 1.0];
    this.castsShadow = false;
  }
  
  /**
   * Get the direction of the light (for directional lights)
   * Override in subclasses
   */
  getDirection() {
    return [0, -1, 0]; // Default: straight down
  }
  
  /**
   * Get ambient contribution
   * Override in subclasses
   */
  getAmbient() {
    return 0.2;
  }
  
  /**
   * Get light parameters for shader
   * Override in subclasses to add type-specific params
   */
  getLightParams() {
    return {
      type: this.type,
      enabled: this.enabled,
      intensity: this.intensity,
      color: [...this.color],
      castsShadow: this.castsShadow,
    };
  }
  
  /**
   * Serialize light state for saving
   */
  serialize() {
    return {
      type: this.type,
      enabled: this.enabled,
      intensity: this.intensity,
      color: [...this.color],
      castsShadow: this.castsShadow,
    };
  }
  
  /**
   * Deserialize light state from saved data
   * Override in subclasses
   */
  deserialize(data) {
    if (data.enabled !== undefined) this.enabled = data.enabled;
    if (data.intensity !== undefined) this.intensity = data.intensity;
    if (data.color) this.color = [...data.color];
    if (data.castsShadow !== undefined) this.castsShadow = data.castsShadow;
  }
}

/**
 * Sun/Directional Light - simulates distant light source like the sun
 */
export class SunLight extends Light {
  constructor() {
    super('sun');
    this.azimuth = 45;      // Horizontal angle (degrees)
    this.elevation = 45;    // Vertical angle (degrees)
    this.castsShadow = true;
    this.shadowResolution = 2048;
  }
  
  /**
   * Calculate sun direction from azimuth and elevation
   */
  getDirection() {
    const azRad = this.azimuth * Math.PI / 180;
    const elRad = this.elevation * Math.PI / 180;
    return [
      Math.cos(elRad) * Math.sin(azRad),
      Math.sin(elRad),
      Math.cos(elRad) * Math.cos(azRad),
    ];
  }
  
  /**
   * Get ambient based on sun elevation (day/night cycle)
   */
  getAmbient() {
    if (this.elevation <= 0) {
      // Night mode: low ambient when sun below horizon
      return 0.1 + (this.elevation + 90) / 900;
    }
    // Day mode: ramp up ambient
    return 0.2 + this.elevation / 180;
  }
  
  /**
   * Get sun color based on elevation (sunset/sunrise tint)
   */
  getSunColor() {
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
  
  getLightParams() {
    return {
      ...super.getLightParams(),
      mode: 'sun',
      sunDir: this.getDirection(),
      ambient: this.getAmbient(),
      lightColor: this.getSunColor(),
      shadowResolution: this.shadowResolution,
    };
  }
  
  serialize() {
    return {
      ...super.serialize(),
      azimuth: this.azimuth,
      elevation: this.elevation,
      shadowResolution: this.shadowResolution,
    };
  }
  
  deserialize(data) {
    super.deserialize(data);
    if (data.azimuth !== undefined) this.azimuth = data.azimuth;
    if (data.elevation !== undefined) this.elevation = data.elevation;
    if (data.shadowResolution !== undefined) this.shadowResolution = data.shadowResolution;
    // Legacy support: sunAzimuth/sunElevation
    if (data.sunAzimuth !== undefined) this.azimuth = data.sunAzimuth;
    if (data.sunElevation !== undefined) this.elevation = data.sunElevation;
  }
}

/**
 * HDR Environment Light - image-based lighting from HDR texture
 */
export class HDRLight extends Light {
  constructor() {
    super('hdr');
    this.texture = null;
    this.exposure = 1.0;
    this.filename = null;
    this.castsShadow = false; // HDR doesn't cast direct shadows
  }
  
  /**
   * Set HDR texture
   * @param {WebGLTexture} texture - The HDR texture
   * @param {string} filename - Original filename for serialization
   */
  setTexture(texture, filename = null) {
    this.texture = texture;
    this.filename = filename;
  }
  
  getAmbient() {
    // HDR provides ambient through IBL
    return 0.1; // Minimal fallback ambient
  }
  
  getLightParams() {
    return {
      ...super.getLightParams(),
      mode: 'hdr',
      hdrTexture: this.texture,
      hdrExposure: this.exposure,
      ambient: this.getAmbient(),
      // Provide default values for shader uniforms (even though HDR doesn't use directional lighting)
      sunDir: [0, 1, 0],
      lightColor: [1.0, 1.0, 1.0],
    };
  }
  
  serialize() {
    return {
      ...super.serialize(),
      exposure: this.exposure,
      filename: this.filename,
    };
  }
  
  deserialize(data) {
    super.deserialize(data);
    if (data.exposure !== undefined) this.exposure = data.exposure;
    if (data.hdrExposure !== undefined) this.exposure = data.hdrExposure; // Legacy support
    if (data.filename !== undefined) this.filename = data.filename;
    if (data.hdrFilename !== undefined) this.filename = data.hdrFilename; // Legacy support
    // Note: texture must be reloaded separately
  }
}

/**
 * Point Light - emits light from a point in all directions (for future use)
 */
export class PointLight extends Light {
  constructor() {
    super('point');
    this.position = [0, 2, 0];
    this.radius = 10;           // Light range/falloff distance
    this.falloff = 2;           // Falloff exponent (2 = physically correct)
  }
  
  getDirection() {
    // Point lights don't have a single direction
    return null;
  }
  
  /**
   * Get direction from a world position to this light
   */
  getDirectionFrom(worldPos) {
    const dx = this.position[0] - worldPos[0];
    const dy = this.position[1] - worldPos[1];
    const dz = this.position[2] - worldPos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.0001) return [0, 1, 0];
    return [dx / len, dy / len, dz / len];
  }
  
  /**
   * Get attenuation at a given distance
   */
  getAttenuation(distance) {
    if (distance >= this.radius) return 0;
    const normalized = distance / this.radius;
    return Math.pow(1 - normalized, this.falloff);
  }
  
  getLightParams() {
    return {
      ...super.getLightParams(),
      mode: 'point',
      position: [...this.position],
      radius: this.radius,
      falloff: this.falloff,
    };
  }
  
  serialize() {
    return {
      ...super.serialize(),
      position: [...this.position],
      radius: this.radius,
      falloff: this.falloff,
    };
  }
  
  deserialize(data) {
    super.deserialize(data);
    if (data.position) this.position = [...data.position];
    if (data.radius !== undefined) this.radius = data.radius;
    if (data.falloff !== undefined) this.falloff = data.falloff;
  }
}

/**
 * Lighting Manager - manages all lights in the scene
 */
export class LightingManager {
  constructor() {
    this.sunLight = new SunLight();
    this.hdrLight = new HDRLight();
    this.pointLights = [];
    this.activeMode = 'sun'; // 'sun' | 'hdr'
    this.shadowEnabled = true;
    this.shadowDebug = 0;
  }
  
  /**
   * Get the active primary light
   */
  getActiveLight() {
    return this.activeMode === 'hdr' ? this.hdrLight : this.sunLight;
  }
  
  /**
   * Set the active lighting mode
   */
  setMode(mode) {
    this.activeMode = mode;
  }
  
  /**
   * Add a point light to the scene
   */
  addPointLight(pointLight = null) {
    const light = pointLight || new PointLight();
    this.pointLights.push(light);
    return light;
  }
  
  /**
   * Remove a point light
   */
  removePointLight(light) {
    const index = this.pointLights.indexOf(light);
    if (index >= 0) {
      this.pointLights.splice(index, 1);
      return true;
    }
    return false;
  }
  
  /**
   * Get combined light parameters for rendering
   */
  getLightParams(shadowRenderer = null) {
    const activeLight = this.getActiveLight();
    const params = activeLight.getLightParams();
    
    // Add shadow info
    params.shadowEnabled = this.shadowEnabled && activeLight.castsShadow;
    params.shadowDebug = this.shadowDebug;
    
    if (shadowRenderer && params.shadowEnabled) {
      params.shadowMap = shadowRenderer.getTexture();
      params.lightSpaceMatrix = shadowRenderer.getLightSpaceMatrix();
      params.shadowBias = 0.003;
    }
    
    // Add point lights (for future multi-light support)
    params.pointLights = this.pointLights.map(p => p.getLightParams());
    
    return params;
  }
  
  /**
   * Serialize all lighting state
   */
  serialize() {
    return {
      mode: this.activeMode,
      shadowEnabled: this.shadowEnabled,
      sun: this.sunLight.serialize(),
      hdr: this.hdrLight.serialize(),
      pointLights: this.pointLights.map(p => p.serialize()),
    };
  }
  
  /**
   * Deserialize lighting state
   */
  deserialize(data) {
    if (!data) return;
    
    if (data.mode) this.activeMode = data.mode;
    if (data.shadowEnabled !== undefined) this.shadowEnabled = data.shadowEnabled;
    
    // Sun light
    if (data.sun) {
      this.sunLight.deserialize(data.sun);
    }
    // Legacy format support
    if (data.sunAzimuth !== undefined || data.sunElevation !== undefined) {
      this.sunLight.deserialize(data);
    }
    
    // HDR light
    if (data.hdr) {
      this.hdrLight.deserialize(data.hdr);
    }
    // Legacy format support
    if (data.hdrExposure !== undefined || data.hdrFilename !== undefined) {
      this.hdrLight.deserialize(data);
    }
    
    // Point lights
    if (data.pointLights && Array.isArray(data.pointLights)) {
      this.pointLights = data.pointLights.map(pData => {
        const light = new PointLight();
        light.deserialize(pData);
        return light;
      });
    }
    
    // Legacy shadowResolution
    if (data.shadowResolution !== undefined) {
      this.sunLight.shadowResolution = data.shadowResolution;
    }
  }
}

/**
 * Create a new lighting manager
 */
export function createLightingManager() {
  return new LightingManager();
}
