import { 
  DirectionalLight, 
  HDRLight, 
  PointLight,
  SceneLightingParams,
  ShadowParams,
  ToneMappingMode,
  TONE_MAPPING
} from '../../core/sceneObjects/lights';
import type { ShadowRenderer } from '../../core/renderers/ShadowRenderer';

export type SceneLightMode = 'directional' | 'hdr';

/**
 * Serialized lighting manager data
 */
export interface SerializedLightingManager {
  mode: SceneLightMode;
  shadowEnabled: boolean;
  toneMapping: ToneMappingMode;
  sun: ReturnType<DirectionalLight['serialize']>;
  hdr: ReturnType<HDRLight['serialize']>;
  pointLights: ReturnType<PointLight['serialize']>[];
}

/**
 * Lighting Manager - manages all lights in the scene
 */
export class LightingManager {
  /** Sun/directional light */
  public sunLight: DirectionalLight;
  
  /** HDR environment light */
  public hdrLight: HDRLight;
  
  /** Additional point lights */
  public pointLights: PointLight[];
  
  /** Active lighting mode ('directional' or 'hdr') */
  public activeMode: SceneLightMode;
  
  /** Whether shadows are enabled */
  public shadowEnabled: boolean;
  
  /** Shadow debug visualization mode */
  public shadowDebug: number;
  
  /** Tone mapping mode */
  public toneMapping: ToneMappingMode;
  
  constructor() {
    this.sunLight = new DirectionalLight();
    this.hdrLight = new HDRLight();
    this.pointLights = [];
    this.activeMode = 'directional';
    this.shadowEnabled = true;
    this.shadowDebug = 0;
    this.toneMapping = TONE_MAPPING.ACES;
  }
  
  /**
   * Alias for sunLight for backward compatibility
   */
  get directionalLight(): DirectionalLight {
    return this.sunLight;
  }
  
  /**
   * Get the active primary light
   */
  getActiveLight(): DirectionalLight | HDRLight {
    return this.activeMode === 'hdr' ? this.hdrLight : this.sunLight;
  }
  
  /**
   * Set the active lighting mode
   */
  setMode(mode: SceneLightMode): void {
    this.activeMode = mode;
  }
  
  /**
   * Add a point light to the scene
   */
  addPointLight(pointLight: PointLight | null = null): PointLight {
    const light = pointLight || new PointLight();
    this.pointLights.push(light);
    return light;
  }
  
  /**
   * Remove a point light
   */
  removePointLight(light: PointLight): boolean {
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
  getLightParams(shadowRenderer: ShadowRenderer | null = null): SceneLightingParams {
    const activeLight = this.getActiveLight();
    const lightParams = activeLight.getLightParams();
    
    // Shadow params
    const shadowEnabled = this.shadowEnabled && activeLight.castsShadow;
    const shadowParams: ShadowParams = {
      shadowEnabled,
      shadowDebug: this.shadowDebug,
    };
    
    if (shadowRenderer && shadowEnabled) {
      shadowParams.shadowMap = shadowRenderer.getTexture();
      shadowParams.lightSpaceMatrix = shadowRenderer.getLightSpaceMatrix();
      shadowParams.shadowBias = 0.003;
    }
    
    // Combine all params
    return {
      ...lightParams,
      ...shadowParams,
      toneMapping: this.toneMapping,
      pointLights: this.pointLights.map(p => p.getLightParams()),
    };
  }
  
  /**
   * Serialize all lighting state
   */
  serialize(): SerializedLightingManager {
    return {
      mode: this.activeMode,
      shadowEnabled: this.shadowEnabled,
      toneMapping: this.toneMapping,
      sun: this.sunLight.serialize(),
      hdr: this.hdrLight.serialize(),
      pointLights: this.pointLights.map(p => p.serialize()),
    };
  }
  
  /**
   * Deserialize lighting state
   */
  deserialize(data: Partial<SerializedLightingManager> & Record<string, unknown>): void {
    if (!data) return;
    
    // Handle legacy 'sun' mode
    if (data.mode) {
      const mode = data.mode as string;
      this.activeMode = mode === 'sun' ? 'directional' : mode as 'directional' | 'hdr';
    }
    if (data.shadowEnabled !== undefined) this.shadowEnabled = data.shadowEnabled;
    
    // Sun light
    if (data.sun) {
      this.sunLight.deserialize(data.sun);
    }
    // Legacy format support
    if (data.sunAzimuth !== undefined || data.sunElevation !== undefined) {
      this.sunLight.deserialize(data as Record<string, unknown>);
    }
    
    // HDR light
    if (data.hdr) {
      this.hdrLight.deserialize(data.hdr);
    }
    // Legacy format support
    if (data.hdrExposure !== undefined || data.hdrFilename !== undefined) {
      this.hdrLight.deserialize(data as Record<string, unknown>);
    }
    
    // Point lights
    if (data.pointLights && Array.isArray(data.pointLights)) {
      this.pointLights = data.pointLights.map((pData) => {
        const light = new PointLight();
        light.deserialize(pData as Parameters<PointLight['deserialize']>[0]);
        return light;
      });
    }
    
    // Legacy shadowResolution
    if (data.shadowResolution !== undefined) {
      this.sunLight.shadowResolution = data.shadowResolution as number;
    }
    
    // Tone mapping
    if (data.toneMapping !== undefined) {
      this.toneMapping = data.toneMapping;
    }
  }
}

/**
 * Create a new lighting manager
 */
export function createLightingManager() {
  return new LightingManager();
}
