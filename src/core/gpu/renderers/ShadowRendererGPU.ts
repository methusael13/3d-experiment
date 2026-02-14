/**
 * ShadowRendererGPU - Shadow Map Manager with CSM Support
 * 
 * Manages shadow map textures and light matrix calculation.
 * Supports both single shadow map and Cascaded Shadow Maps (CSM).
 * Actual shadow rendering is done by CDLODRendererGPU and ObjectRendererGPU
 * using their own shadow pass methods.
 */

import { mat4, vec3, vec4 } from 'gl-matrix';
import { GPUContext, UnifiedGPUTexture, UnifiedGPUBuffer } from '../index';
import { DepthTextureVisualizer } from './DepthTextureVisualizer';

/** Maximum number of cascades supported */
export const MAX_CASCADES = 4;

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
  /** Enable Cascaded Shadow Maps */
  csmEnabled: boolean;
  /** Number of cascades (2-4, default: 4) */
  cascadeCount: number;
  /** Lambda for cascade split blending (0 = linear, 1 = logarithmic, default: 0.5) */
  cascadeSplitLambda: number;
  /** Cascade blend distance as fraction of cascade size (default: 0.1) */
  cascadeBlendFraction: number;
}

/** Parameters for light matrix calculation */
export interface LightMatrixParams {
  lightDirection: vec3;
  cameraPosition: vec3;
  cameraForward?: vec3;
  cameraViewMatrix?: mat4;
  cameraNearPlane?: number;
  cameraFarPlane?: number;
}

/** Cascade data for CSM */
export interface CascadeData {
  lightSpaceMatrix: mat4;
  splitDistance: number;
  radius: number;
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
    // CSM defaults
    csmEnabled: false,
    cascadeCount: 4,
    cascadeSplitLambda: 0.5,
    cascadeBlendFraction: 0.1,
  };
}

/**
 * WebGPU Shadow Map Manager with CSM Support
 * Manages shadow map texture and light space matrix calculation
 */
export class ShadowRendererGPU {
  private ctx: GPUContext;
  private config: ShadowConfig;
  
  // Single shadow map texture (depth only) - used when CSM disabled
  private shadowMap: UnifiedGPUTexture | null = null;
  
  // CSM cascade shadow map array (depth texture array)
  private shadowMapArrayTexture: GPUTexture | null = null;
  private shadowMapArrayView: GPUTextureView | null = null;
  private cascadeViews: GPUTextureView[] = [];
  
  // Light space matrix for single shadow map
  private lightSpaceMatrix = mat4.create();
  private lightViewMatrix = mat4.create();
  private lightProjMatrix = mat4.create();
  
  // CSM cascade data
  private cascades: CascadeData[] = [];
  private cascadeSplits: number[] = [];
  
  // CSM uniform buffer
  private csmUniformBuffer: UnifiedGPUBuffer | null = null;
  
  // Shadow center (updated each frame)
  private shadowCenter: [number, number] = [0, 0];
  private directionalLightPosition: vec3 = [0, 0, 0];
  
  // Debug visualization
  private depthVisualizer: DepthTextureVisualizer | null = null;
  
  constructor(ctx: GPUContext, config?: Partial<ShadowConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultShadowConfig(), ...config };
    
    this.createShadowMaps();
    this.createCSMUniformBuffer();
    this.initializeCascades();
  }
  
  /** Create depth-only shadow map texture(s) */
  private createShadowMaps(): void {
    this.shadowMap?.destroy();
    this.shadowMapArrayTexture?.destroy();
    this.shadowMapArrayTexture = null;
    this.shadowMapArrayView = null;
    this.cascadeViews = [];
    
    // Always create single shadow map (for fallback or non-CSM mode)
    this.shadowMap = UnifiedGPUTexture.createDepth(
      this.ctx,
      this.config.resolution,
      this.config.resolution,
      'depth32float',
      'shadow-map'
    );
    
    // Create CSM texture array if enabled
    if (this.config.csmEnabled) {
      this.createCascadeTextureArray();
    }
    
    console.log(`[ShadowRendererGPU] Created ${this.config.resolution}x${this.config.resolution} shadow map`);
    if (this.config.csmEnabled) {
      console.log(`[ShadowRendererGPU] CSM enabled with ${this.config.cascadeCount} cascades`);
    }
  }
  
  /** Create texture array for CSM cascades */
  private createCascadeTextureArray(): void {
    const { resolution, cascadeCount } = this.config;
    
    // Create depth texture array for cascades
    this.shadowMapArrayTexture = this.ctx.device.createTexture({
      label: 'csm-shadow-map-array',
      size: {
        width: resolution,
        height: resolution,
        depthOrArrayLayers: cascadeCount,
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    
    // Create array view for shader sampling
    this.shadowMapArrayView = this.shadowMapArrayTexture.createView({
      label: 'csm-shadow-map-array-view',
      dimension: '2d-array',
      arrayLayerCount: cascadeCount,
    });
    
    // Create individual views for each cascade layer (for render attachments)
    for (let i = 0; i < cascadeCount; i++) {
      this.cascadeViews.push(
        this.shadowMapArrayTexture.createView({
          label: `csm-cascade-${i}-view`,
          dimension: '2d',
          baseArrayLayer: i,
          arrayLayerCount: 1,
        })
      );
    }
  }
  
  /** Create uniform buffer for CSM data */
  private createCSMUniformBuffer(): void {
    // CSM uniform layout:
    // - 4 mat4x4 light space matrices: 4 * 64 = 256 bytes
    // - vec4 cascade splits: 16 bytes
    // - cascadeCount, csmEnabled, blendFraction, _pad: 16 bytes
    // Total: 288 bytes
    const bufferSize = 288;
    
    this.csmUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'csm-uniforms',
      size: bufferSize,
    });
  }
  
  /** Initialize cascade data structures */
  private initializeCascades(): void {
    this.cascades = [];
    for (let i = 0; i < MAX_CASCADES; i++) {
      this.cascades.push({
        lightSpaceMatrix: mat4.create(),
        splitDistance: 0,
        radius: 0,
      });
    }
  }
  
  /**
   * Calculate cascade split distances using practical split scheme
   * Blends between logarithmic (better near) and linear (even distribution)
   */
  private calculateCascadeSplits(nearPlane: number, farPlane: number): number[] {
    const { cascadeCount, cascadeSplitLambda } = this.config;
    const splits: number[] = [];
    
    for (let i = 1; i <= cascadeCount; i++) {
      const p = i / cascadeCount;
      
      // Logarithmic split: preserves detail near camera
      const logSplit = nearPlane * Math.pow(farPlane / nearPlane, p);
      
      // Linear split: even distribution
      const linearSplit = nearPlane + (farPlane - nearPlane) * p;
      
      // Blend between the two
      splits.push(cascadeSplitLambda * logSplit + (1 - cascadeSplitLambda) * linearSplit);
    }
    
    return splits;
  }
  
  /**
   * Calculate light space matrix for a single cascade
   * Center follows camera XZ position for camera-relative shadows
   */
  private calculateCascadeLightMatrix(
    lightDir: vec3,
    cameraPos: vec3,
    cascadeNear: number,
    cascadeFar: number,
    cascadeIndex: number
  ): { matrix: mat4; radius: number } {
    // Cascade radius is the distance range it covers
    const cascadeRadius = (cascadeFar - cascadeNear) / 2;
    const cascadeCenter = cascadeNear + cascadeRadius;
    
    // Shadow center follows camera XZ (Y=0 for terrain focus)
    const center: vec3 = vec3.fromValues(cameraPos[0], 0, cameraPos[2]);
    
    // Light position: offset from center in light direction
    const lightDistance = this.config.shadowRadius * 2;
    const lightPos: vec3 = vec3.fromValues(
      center[0] + lightDir[0] * lightDistance,
      center[1] + lightDir[1] * lightDistance,
      center[2] + lightDir[2] * lightDistance
    );
    
    // Up vector (handle straight up/down light)
    let up: vec3 = [0, 1, 0];
    if (Math.abs(lightDir[1]) > 0.99) {
      up = [0, 0, 1];
    }
    
    // View matrix
    const viewMatrix = mat4.create();
    mat4.lookAt(viewMatrix, lightPos, center, up);
    
    // Cascade-specific orthographic bounds
    // Each cascade covers progressively larger area
    const cascadeScale = Math.pow(2, cascadeIndex); // Exponential scaling
    const orthoSize = (this.config.shadowRadius / this.config.cascadeCount) * cascadeScale;
    
    const projMatrix = mat4.create();
    const near = 0.1;
    const far = this.config.shadowRadius * 3;
    mat4.ortho(projMatrix, -orthoSize, orthoSize, -orthoSize, orthoSize, near, far);
    
    // Combined matrix
    const lightSpaceMatrix = mat4.create();
    mat4.multiply(lightSpaceMatrix, projMatrix, viewMatrix);
    
    return { matrix: lightSpaceMatrix, radius: orthoSize };
  }
  
  /** Calculate light space matrix for single shadow map (non-CSM) */
  private calculateLightMatrix(lightDir: vec3, cameraPos: vec3, cameraForward?: vec3): mat4 {
    const radius = this.config.shadowRadius;
    
    // Shadow center follows camera XZ position
    this.shadowCenter = [cameraPos[0], cameraPos[2]];
    
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
   * Update light space matrices for all cascades (CSM mode)
   */
  private updateCascadeMatrices(lightDir: vec3, cameraPos: vec3, nearPlane: number, farPlane: number): void {
    // Calculate split distances
    this.cascadeSplits = this.calculateCascadeSplits(nearPlane, farPlane);
    
    // Calculate light matrix for each cascade
    let prevSplit = nearPlane;
    
    for (let i = 0; i < this.config.cascadeCount; i++) {
      const splitEnd = this.cascadeSplits[i];
      
      const { matrix, radius } = this.calculateCascadeLightMatrix(
        lightDir,
        cameraPos,
        prevSplit,
        splitEnd,
        i
      );
      
      mat4.copy(this.cascades[i].lightSpaceMatrix, matrix);
      this.cascades[i].splitDistance = splitEnd;
      this.cascades[i].radius = radius;
      
      prevSplit = splitEnd;
    }
  }
  
  /**
   * Update CSM uniform buffer with current cascade data
   */
  updateCSMUniforms(): void {
    if (!this.csmUniformBuffer) return;
    
    const data = new Float32Array(72); // 288 bytes / 4
    let offset = 0;
    
    // 4 light space matrices (always write all 4, unused ones are identity)
    for (let i = 0; i < MAX_CASCADES; i++) {
      const matrix = i < this.config.cascadeCount 
        ? this.cascades[i].lightSpaceMatrix 
        : mat4.create();
      data.set(matrix as Float32Array, offset);
      offset += 16;
    }
    
    // Cascade splits (vec4)
    for (let i = 0; i < 4; i++) {
      data[offset + i] = i < this.config.cascadeCount ? this.cascadeSplits[i] : 10000;
    }
    offset += 4;
    
    // Config values (vec4): cascadeCount, csmEnabled, blendFraction, _pad
    data[offset + 0] = this.config.cascadeCount;
    data[offset + 1] = this.config.csmEnabled ? 1.0 : 0.0;
    data[offset + 2] = this.config.cascadeBlendFraction;
    data[offset + 3] = 0; // padding
    
    this.csmUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Update light space matrix for external shadow rendering
   * Called by ShadowPass before terrain/objects render their shadows
   */
  updateLightMatrix(params: LightMatrixParams): void {
    const lightDir = params.lightDirection as vec3;
    const cameraPos = params.cameraPosition as vec3;
    const cameraFwd = params.cameraForward;
    const nearPlane = params.cameraNearPlane ?? 0.1;
    const farPlane = params.cameraFarPlane ?? this.config.shadowRadius;
    
    if (this.config.csmEnabled) {
      // Update all cascade matrices
      this.updateCascadeMatrices(lightDir, cameraPos, nearPlane, farPlane);
      // Also update single map for fallback/compatibility
      this.calculateLightMatrix(lightDir, cameraPos, cameraFwd);
      // Update CSM uniforms
      this.updateCSMUniforms();
    } else {
      // Single shadow map mode
      this.calculateLightMatrix(lightDir, cameraPos, cameraFwd);
    }
    
    // Store light position for external access
    this.directionalLightPosition = vec3.fromValues(
      cameraPos[0] + lightDir[0] * this.config.shadowRadius * 2,
      cameraPos[1] + lightDir[1] * this.config.shadowRadius * 2,
      cameraPos[2] + lightDir[2] * this.config.shadowRadius * 2
    );
  }
  
  // ============ Getters ============
  
  getDirectionalLightPos(): vec3 {
    return this.directionalLightPosition;
  }

  getShadowMap(): UnifiedGPUTexture | null {
    return this.shadowMap;
  }
  
  getShadowMapArrayView(): GPUTextureView | null {
    return this.shadowMapArrayView;
  }
  
  getCascadeView(index: number): GPUTextureView | null {
    return this.cascadeViews[index] ?? null;
  }
  
  getLightSpaceMatrix(): mat4 {
    return this.lightSpaceMatrix;
  }
  
  getCascadeLightSpaceMatrix(index: number): mat4 {
    return this.cascades[index]?.lightSpaceMatrix ?? mat4.create();
  }
  
  getCascadeSplits(): number[] {
    return [...this.cascadeSplits];
  }
  
  getCascadeData(): CascadeData[] {
    return this.cascades.slice(0, this.config.cascadeCount);
  }
  
  getCSMUniformBuffer(): UnifiedGPUBuffer | null {
    return this.csmUniformBuffer;
  }
  
  getConfig(): ShadowConfig {
    return { ...this.config };
  }
  
  isCSMEnabled(): boolean {
    return this.config.csmEnabled;
  }
  
  getShadowCenter(): [number, number] {
    return [...this.shadowCenter];
  }
  
  // ============ Configuration ============
  
  setResolution(resolution: number): void {
    if (this.config.resolution !== resolution) {
      this.config.resolution = resolution;
      this.createShadowMaps();
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
  
  /** Enable/disable CSM */
  setCSMEnabled(enabled: boolean): void {
    if (this.config.csmEnabled !== enabled) {
      this.config.csmEnabled = enabled;
      this.createShadowMaps();
    }
  }
  
  /** Set number of cascades (2-4) */
  setCascadeCount(count: number): void {
    const newCount = Math.max(2, Math.min(MAX_CASCADES, count));
    if (this.config.cascadeCount !== newCount) {
      this.config.cascadeCount = newCount;
      if (this.config.csmEnabled) {
        this.createShadowMaps();
      }
    }
  }
  
  /** Set cascade split blend factor (0 = linear, 1 = logarithmic) */
  setCascadeSplitLambda(lambda: number): void {
    this.config.cascadeSplitLambda = Math.max(0, Math.min(1, lambda));
  }
  
  /** Set cascade blend fraction for smooth transitions */
  setCascadeBlendFraction(fraction: number): void {
    this.config.cascadeBlendFraction = Math.max(0.01, Math.min(0.3, fraction));
  }
  
  // ============ Debug Thumbnail ============
  
  renderDebugThumbnail(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number,
    cascadeIndex: number = 0
  ): void {
    // For CSM, use cascade view; for single map, use shadow map
    const shadowView = this.config.csmEnabled && cascadeIndex < this.cascadeViews.length
      ? this.cascadeViews[cascadeIndex]
      : this.shadowMap?.view;
    
    if (!shadowView) return;
    
    if (!this.depthVisualizer) {
      this.depthVisualizer = new DepthTextureVisualizer(this.ctx);
    }
    
    this.depthVisualizer.render(
      encoder,
      targetView,
      shadowView,
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
    this.shadowMapArrayTexture?.destroy();
    this.csmUniformBuffer?.destroy();
    this.depthVisualizer?.destroy();
    
    this.shadowMap = null;
    this.shadowMapArrayTexture = null;
    this.shadowMapArrayView = null;
    this.csmUniformBuffer = null;
    this.depthVisualizer = null;
    this.cascadeViews = [];
  }
}
