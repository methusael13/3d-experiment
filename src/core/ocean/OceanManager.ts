/**
 * OceanManager - High-level ocean/water orchestration
 * 
 * Manages the water rendering pipeline, following the TerrainManager pattern.
 * Owns the WaterRendererGPU and handles configuration.
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../gpu/GPUContext';
import { 
  WaterRendererGPU, 
  WaterConfig, 
  WaterRenderParams,
  createDefaultWaterConfig 
} from '../gpu/renderers/WaterRendererGPU';
import { UnifiedGPUTexture } from '../gpu/GPUTexture';
import type { SceneEnvironment } from '../gpu/renderers/shared';
import { SSRConfig } from '../gpu/pipeline/SSRConfig';

/**
 * Ocean manager configuration
 */
export interface OceanManagerConfig {
  /** Water configuration */
  waterConfig?: Partial<WaterConfig>;
}

/**
 * Default ocean manager configuration
 */
export function createDefaultOceanManagerConfig(): OceanManagerConfig {
  return {
    waterConfig: createDefaultWaterConfig(),
  };
}

/**
 * Render parameters for ocean (subset needed from external context)
 */
export interface OceanRenderParams {
  viewProjectionMatrix: mat4;
  cameraPosition: vec3;
  terrainSize: number;
  heightScale: number;
  time: number;
  sunDirection?: vec3;
  sunIntensity?: number;
  ambientIntensity?: number;
  depthTexture: UnifiedGPUTexture;
  near?: number;
  far?: number;
  /** Scene environment for IBL reflections (optional) */
  sceneEnvironment?: SceneEnvironment | null;
  /** Scene color texture for water refraction (copy of scene before water renders) */
  sceneColorTexture?: UnifiedGPUTexture;
  /** Screen width in pixels (for refraction UV calculation) */
  screenWidth?: number;
  /** Screen height in pixels (for refraction UV calculation) */
  screenHeight?: number;
  /** Light-space matrix for shadow mapping */
  lightSpaceMatrix?: mat4 | Float32Array;
  /** Whether shadows are enabled */
  shadowEnabled?: boolean;
  /** Shadow bias */
  shadowBias?: number;
  /** Whether CSM is enabled */
  csmEnabled?: boolean;
  /** Camera projection matrix (for inline SSR ray marching) */
  projectionMatrix?: Float32Array;
  /** Inverse projection matrix (for inline SSR view-space reconstruction) */
  inverseProjectionMatrix?: Float32Array;
  /** Camera view matrix (for inline SSR world→view-space normal transform) */
  viewMatrix?: Float32Array;
  /** Whether SSR is globally enabled (user toggle) */
  ssrEnabled?: boolean;
  /** SSR ray march settings (from SSRConfig quality preset) */
  ssrConfig?: Omit<SSRConfig, 'enabled' | 'quality'>;
}

/**
 * OceanManager - Orchestrates ocean/water rendering
 */
export class OceanManager {
  private ctx: GPUContext;
  private config: OceanManagerConfig;
  
  // Water renderer (owned by this manager)
  private waterRenderer: WaterRendererGPU | null = null;
  
  // State
  private isInitialized = false;
  
  constructor(ctx: GPUContext, config?: Partial<OceanManagerConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultOceanManagerConfig(), ...config };
  }
  
  /**
   * Initialize the ocean manager and water renderer
   */
  initialize(): void {
    if (this.isInitialized) return;
    
    // Create water renderer with config
    this.waterRenderer = new WaterRendererGPU(this.ctx, this.config.waterConfig);
    
    this.isInitialized = true;
    console.log('[OceanManager] Initialized');
  }
  
  /**
   * Render the ocean/water surface
   */
  render(
    passEncoder: GPURenderPassEncoder,
    params: OceanRenderParams
  ): number {
    if (!this.waterRenderer) {
      console.warn('[OceanManager] Not initialized');
      return 0;
    }
    
    // Create identity model matrix (water is always at origin)
    const modelMatrix = mat4.create();
    
    // Delegate to water renderer
    return this.waterRenderer.render(passEncoder, {
      viewProjectionMatrix: params.viewProjectionMatrix,
      modelMatrix,
      cameraPosition: params.cameraPosition,
      terrainSize: params.terrainSize,
      heightScale: params.heightScale,
      time: params.time,
      sunDirection: params.sunDirection,
      sunIntensity: params.sunIntensity,
      ambientIntensity: params.ambientIntensity,
      depthTexture: params.depthTexture,
      near: params.near,
      far: params.far,
      sceneEnvironment: params.sceneEnvironment,
      // Refraction support
      sceneColorTexture: params.sceneColorTexture,
      screenWidth: params.screenWidth,
      screenHeight: params.screenHeight,
      // Shadow support
      lightSpaceMatrix: params.lightSpaceMatrix,
      shadowEnabled: params.shadowEnabled,
      shadowBias: params.shadowBias,
      csmEnabled: params.csmEnabled,
      projectionMatrix: params.projectionMatrix,
      inverseProjectionMatrix: params.inverseProjectionMatrix,
      viewMatrix: params.viewMatrix,
      ssrEnabled: params.ssrEnabled,
      ssrConfig: params.ssrConfig,
    });
  }
  
  // ============ Getters ============
  
  get isReady(): boolean {
    return this.isInitialized;
  }
  
  /**
   * Get the water renderer (for advanced access)
   */
  getWaterRenderer(): WaterRendererGPU | null {
    return this.waterRenderer;
  }
  
  /**
   * Get current water level (normalized)
   */
  getWaterLevel(): number {
    return this.waterRenderer?.getConfig().waterLevel ?? 0.2;
  }
  
  /**
   * Get water level in world units
   */
  getWaterLevelWorld(heightScale: number): number {
    return this.getWaterLevel() * heightScale;
  }
  
  // ============ Configuration ============
  
  /**
   * Set water configuration
   */
  setConfig(config: Partial<WaterConfig>): void {
    if (!this.isInitialized) {
      // Store config for later initialization
      this.config.waterConfig = { ...this.config.waterConfig, ...config };
      return;
    }
    
    this.waterRenderer?.setConfig(config);
  }
  
  /**
   * Get current water configuration
   */
  getConfig(): WaterConfig {
    if (!this.waterRenderer) {
      return { ...createDefaultWaterConfig(), ...this.config.waterConfig };
    }
    return this.waterRenderer.getConfig();
  }
  
  /**
   * Set water level (normalized -0.5 to 0.5)
   */
  setWaterLevel(level: number): void {
    if (!this.isInitialized) {
      if (!this.config.waterConfig) {
        this.config.waterConfig = {};
      }
      this.config.waterConfig.waterLevel = level;
      return;
    }
    
    this.waterRenderer?.setWaterLevel(level);
  }
  
  /**
   * Get the AABB for the ocean based on its grid config
   * Uses gridCenterX/Z and gridSizeX/Z from the water config
   * 
   * @param heightScale - Optional terrain height scale for water level calculation (default: 100)
   */
  getBoundingBox(heightScale: number = 100): {
    min: vec3;
    max: vec3;
  } {
    const config = this.getConfig();
    const waterLevel = this.getWaterLevelWorld(heightScale);
    
    // Calculate bounds from grid config
    const halfSizeX = config.gridSizeX / 2;
    const halfSizeZ = config.gridSizeZ / 2;
    
    const minX = config.gridCenterX - halfSizeX;
    const maxX = config.gridCenterX + halfSizeX;
    const minZ = config.gridCenterZ - halfSizeZ;
    const maxZ = config.gridCenterZ + halfSizeZ;
    
    // Thin box at water level spanning the configured grid area
    return {
      min: vec3.fromValues(minX, waterLevel - 0.1, minZ),
      max: vec3.fromValues(maxX, waterLevel + 0.1, maxZ),
    };
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    this.waterRenderer?.destroy();
    this.waterRenderer = null;
    this.isInitialized = false;
    console.log('[OceanManager] Destroyed');
  }
}
