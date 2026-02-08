/**
 * ShadowRendererGPU - Shadow Map Manager
 * 
 * Manages the shadow map texture and light matrix calculation.
 * Actual shadow rendering is done by CDLODRendererGPU and ObjectRendererGPU
 * using their own shadow pass methods.
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext, UnifiedGPUTexture } from '../index';
import { DepthTextureVisualizer } from './DepthTextureVisualizer';

/** Shadow renderer configuration */
export interface ShadowConfig {
  /** Shadow map resolution (512-4096, default: 2048) */
  resolution: number;
  /** Radius of shadow coverage around camera (default: 200) */
  shadowRadius: number;
  /** Depth bias to prevent shadow acne (default: 0.5) */
  depthBias: number;
  /** Normal-based bias for slopes (default: 0.02) */
  normalBias: number;
  /** Enable soft shadows via PCF (default: true) */
  softShadows: boolean;
  /** PCF kernel size: 3, 5, or 7 (default: 3) */
  pcfKernelSize: number;
  /** Forward offset ratio (0.0-0.8) */
  forwardOffset: number;
}

/** Parameters for light matrix calculation */
export interface LightMatrixParams {
  lightDirection: vec3;
  cameraPosition: vec3;
  cameraForward?: vec3;
}

/** Default shadow configuration */
export function createDefaultShadowConfig(): ShadowConfig {
  return {
    resolution: 2048,
    shadowRadius: 200,
    depthBias: 4,
    normalBias: 2.0,
    softShadows: true,
    pcfKernelSize: 3,
    forwardOffset: 0.0,
  };
}

/**
 * WebGPU Shadow Map Manager
 * Manages shadow map texture and light space matrix calculation
 */
export class ShadowRendererGPU {
  private ctx: GPUContext;
  private config: ShadowConfig;
  
  // Shadow map texture (depth only)
  private shadowMap: UnifiedGPUTexture | null = null;
  
  // Light space matrix (computed each frame)
  private lightSpaceMatrix = mat4.create();
  private lightViewMatrix = mat4.create();
  private lightProjMatrix = mat4.create();
  
  // Shadow center (updated each frame)
  private shadowCenter: [number, number] = [0, 0];
  private directionalLightPosition: vec3 = [0, 0, 0];
  
  // Debug visualization
  private depthVisualizer: DepthTextureVisualizer | null = null;
  
  constructor(ctx: GPUContext, config?: Partial<ShadowConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultShadowConfig(), ...config };
    
    this.createShadowMap();
  }
  
  /** Create depth-only shadow map texture */
  private createShadowMap(): void {
    this.shadowMap?.destroy();
    
    this.shadowMap = UnifiedGPUTexture.createDepth(
      this.ctx,
      this.config.resolution,
      this.config.resolution,
      'depth32float',
      'shadow-map'
    );
    
    console.log(`[ShadowRendererGPU] Created ${this.config.resolution}x${this.config.resolution} shadow map`);
  }
  
  /** Calculate light space matrix */
  private calculateLightMatrix(lightDir: vec3, cameraPos: vec3, cameraForward?: vec3): mat4 {
    const radius = this.config.shadowRadius;
    
    // Shadow center at origin (or could follow camera with forward offset)
    this.shadowCenter = [0, 0];
    
    const center: vec3 = [this.shadowCenter[0], 0, this.shadowCenter[1]];
    
    // Light position: negate lightDir to get position opposite to light direction
    const lightDistance = radius * 2;
    const lightPos: vec3 = vec3.fromValues(
      center[0] + lightDir[0] * lightDistance,
      center[1] + lightDir[1] * lightDistance,
      center[2] + lightDir[2] * lightDistance
    );
    
    // Up vector
    let up: vec3 = [0, 1, 0];
    if (Math.abs(lightDir[1]) > 0.99) {
      up = [0, 0, 1];
    }
    
    mat4.lookAt(this.lightViewMatrix, lightPos, center, up);
    
    const near = 0.1;
    const far = radius * 3;
    mat4.ortho(this.lightProjMatrix, -radius, radius, -radius, radius, near, far);
    
    mat4.multiply(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);
    this.directionalLightPosition = lightPos;

    return this.lightSpaceMatrix;
  }
  
  /**
   * Update light space matrix for external shadow rendering
   * Called by ShadowPass before terrain/objects render their shadows
   */
  updateLightMatrix(params: LightMatrixParams): void {
    const lightDir = params.lightDirection as vec3;
    const cameraPos = params.cameraPosition as vec3;
    const cameraFwd = params.cameraForward;
    
    this.calculateLightMatrix(lightDir, cameraPos, cameraFwd);
  }
  
  // ============ Getters ============
  
  getDirectionalLightPos(): vec3 {
    return this.directionalLightPosition;
  }

  getShadowMap(): UnifiedGPUTexture | null {
    return this.shadowMap;
  }
  
  getLightSpaceMatrix(): mat4 {
    return this.lightSpaceMatrix;
  }
  
  getConfig(): ShadowConfig {
    return { ...this.config };
  }
  
  // ============ Configuration ============
  
  setResolution(resolution: number): void {
    if (this.config.resolution !== resolution) {
      this.config.resolution = resolution;
      this.createShadowMap();
    }
  }
  
  setShadowRadius(radius: number): void {
    this.config.shadowRadius = radius;
  }
  
  setDepthBias(bias: number): void {
    this.config.depthBias = bias;
  }
  
  setNormalBias(bias: number): void {
    this.config.normalBias = bias;
  }
  
  setSoftShadows(enabled: boolean): void {
    this.config.softShadows = enabled;
  }
  
  setPcfKernelSize(size: number): void {
    this.config.pcfKernelSize = size;
  }
  
  setForwardOffset(offset: number): void {
    this.config.forwardOffset = Math.max(0, Math.min(0.8, offset));
  }
  
  // ============ Debug Thumbnail ============
  
  renderDebugThumbnail(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number
  ): void {
    if (!this.shadowMap) return;
    
    if (!this.depthVisualizer) {
      this.depthVisualizer = new DepthTextureVisualizer(this.ctx);
    }
    
    this.depthVisualizer.render(
      encoder,
      targetView,
      this.shadowMap.view,
      x,
      y,
      size,
      screenWidth,
      screenHeight
    );
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    this.shadowMap?.destroy();
    this.depthVisualizer?.destroy();
    this.shadowMap = null;
    this.depthVisualizer = null;
  }
}
