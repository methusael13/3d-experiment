import { vec3 } from 'gl-matrix';
import { Light, type BaseLightParams, type RGBColor } from './Light';
import type { SerializedLight } from '../types';

/**
 * Serialized HDR light data
 */
export interface SerializedHDRLight extends SerializedLight {
  exposure: number;
  filename: string | null;
}

/**
 * HDR light parameters for shader uniforms
 */
export interface HDRLightParams extends BaseLightParams<'hdr'> {
  /** HDR environment texture */
  hdrTexture: WebGLTexture | null;
  /** Exposure multiplier */
  exposure: number;
  /** Maximum mip level for roughness-based filtering */
  maxMipLevel: number;
  /** Ambient contribution (fallback when texture not loaded) */
  ambient: number;
}

/**
 * HDR Environment Light - image-based lighting from HDR texture.
 * Provides ambient lighting through IBL (Image-Based Lighting).
 */
export class HDRLight extends Light {
  /** HDR texture (managed externally) */
  private texture: WebGLTexture | null = null;
  
  /** Exposure multiplier */
  public exposure: number = 1.0;
  
  /** Original filename for serialization */
  public filename: string | null = null;
  
  /** Maximum mip level for roughness-based filtering */
  public maxMipLevel: number = 6.0;
  
  constructor(name: string = 'HDR Environment') {
    super('hdr', name);
    // HDR doesn't cast direct shadows
    this.castsShadow = false;
  }
  
  /**
   * HDR lights don't have a direction (ambient from all directions)
   */
  getDirection(): vec3 | null {
    // Return a default up direction for compatibility
    return vec3.fromValues(0, 1, 0);
  }
  
  /**
   * HDR provides ambient through IBL, return minimal fallback
   */
  getAmbient(): number {
    return 0.1;
  }
  
  /**
   * Set HDR texture
   * @param texture - The HDR texture (typically loaded externally)
   * @param filename - Original filename for serialization
   */
  setTexture(texture: WebGLTexture | null, filename: string | null = null): void {
    this.texture = texture;
    this.filename = filename;
  }
  
  /**
   * Get the HDR texture
   */
  getTexture(): WebGLTexture | null {
    return this.texture;
  }
  
  /**
   * Check if HDR texture is loaded
   */
  hasTexture(): boolean {
    return this.texture !== null;
  }
  
  /**
   * Clear the HDR texture
   */
  clearTexture(): void {
    this.texture = null;
    this.filename = null;
  }
  
  /**
   * Get light parameters for shader uniforms
   */
  getLightParams(): HDRLightParams {
    return {
      ...super.getLightParams(),
      type: 'hdr',
      hdrTexture: this.texture,
      exposure: this.exposure,
      maxMipLevel: this.maxMipLevel,
      ambient: this.getAmbient(),
    };
  }
  
  /**
   * Serialize the light
   * Note: The texture itself cannot be serialized, only the filename
   */
  serialize(): SerializedHDRLight {
    return {
      ...super.serialize(),
      exposure: this.exposure,
      filename: this.filename,
    };
  }
  
  /**
   * Restore state from serialized data
   * Note: Texture must be reloaded separately using the filename
   */
  deserialize(data: Partial<SerializedHDRLight>): void {
    super.deserialize(data);
    
    if (data.exposure !== undefined) this.exposure = data.exposure;
    if (data.filename !== undefined) this.filename = data.filename;
    
    // Legacy support
    if ((data as Record<string, unknown>).hdrExposure !== undefined) {
      this.exposure = (data as Record<string, unknown>).hdrExposure as number;
    }
    if ((data as Record<string, unknown>).hdrFilename !== undefined) {
      this.filename = (data as Record<string, unknown>).hdrFilename as string;
    }
  }
  
  /**
   * Clean up (texture is managed externally, but clear reference)
   */
  destroy(): void {
    this.texture = null;
    this.filename = null;
  }
  
  /**
   * Create from serialized data
   * Note: Texture must be loaded separately
   */
  static fromSerialized(data: SerializedHDRLight): HDRLight {
    const light = new HDRLight(data.name);
    light.deserialize(data);
    return light;
  }
}
