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
import {
  MAX_CASCADES,
  calculateCascadeSplits,
  getFrustumCornersWorldSpace,
  calculateCascadeLightMatrix,
  type CascadeLightResult,
  type SceneAABB,
} from './shared/CSMUtils';
import { MAX_SHADOW_SLOTS, SHADOW_SLOT_SIZE } from './shared/constants';

export { MAX_CASCADES };

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
  /** Camera view matrix (required for CSM frustum-fitting) */
  cameraViewMatrix?: mat4 | Float32Array;
  /** Camera projection matrix (required for CSM frustum-fitting) */
  cameraProjectionMatrix?: mat4 | Float32Array;
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
    cascadeBlendFraction: 0.15,
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
  private cameraForward: vec3 = [0, 0, -1];

  /** Optional scene AABB for Z-range expansion (prevents tall terrain clipping) */
  private _sceneAABB: SceneAABB | undefined = undefined;

  private _debugOnce: boolean = false;
  
  // ── Spot/Point shadow atlas ──────────────────────────────────────────
  /** Maximum number of spot/point shadow atlas layers */
  static readonly MAX_SHADOW_ATLAS_LAYERS = 16;

  /** Shadow atlas texture array for spot/point lights */
  private spotShadowAtlasTexture: GPUTexture | null = null;
  private spotShadowAtlasView: GPUTextureView | null = null;
  private spotShadowAtlasLayerViews: GPUTextureView[] = [];
  /** Current resolution of the spot shadow atlas layers */
  private spotShadowAtlasResolution: number = 0;

  /** Light-space matrices for spot shadow atlas layers */
  private spotShadowMatrices: mat4[] = [];

  /** Tracks which atlas layers are allocated (-1 = free, entityId = in use) */
  private spotShadowSlots: (string | null)[] = [];

  // Debug visualization
  private depthVisualizer: DepthTextureVisualizer | null = null;

  // ── Shared Depth-Pass Resources ──────────────────────────────────────
  // Single source of truth for shadow depth rendering across all renderers.
  // Each renderer's shadow pipeline uses this as Group 0 (dynamic offset)
  // and their own renderer-specific data as Group 1+.

  /** Shared dynamic uniform buffer for light-space matrices (256-byte aligned slots) */
  private _shadowUniformBuffer: UnifiedGPUBuffer | null = null;
  /** Shared bind group layout: binding 0 = mat4 uniform with hasDynamicOffset */
  private _shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  /** Shared bind group referencing the dynamic uniform buffer */
  private _shadowBindGroup: GPUBindGroup | null = null;
  
  constructor(ctx: GPUContext, config?: Partial<ShadowConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultShadowConfig(), ...config };
    
    this.createShadowMaps();
    this.createCSMUniformBuffer();
    this.initializeCascades();
    this.createSpotShadowAtlas();
    this.createSharedDepthPassResources();
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
    // - cameraForward (vec4f): 16 bytes (xyz = forward dir, w = pad)
    // Total: 304 bytes
    const bufferSize = 304;
    
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
   * Calculate light space matrix for single shadow map using frustum-fitting.
   * Uses the same approach as CSM: fits a tight ortho to the camera frustum
   * from [near, far] where far = shadowRadius (the shadow distance).
   * Falls back to legacy camera-center approach if no camera matrices provided.
   */
  private calculateLightMatrix(
    lightDir: vec3,
    cameraPos: vec3,
    cameraForward?: vec3,
    cameraView?: mat4,
    cameraProj?: mat4,
    nearPlane?: number,
    farPlane?: number
  ): mat4 {
    // Use frustum-fitting if camera matrices are available
    if (cameraView && cameraProj && nearPlane !== undefined && farPlane !== undefined) {
      const result = calculateCascadeLightMatrix(
        lightDir,
        cameraView,
        cameraProj,
        nearPlane,
        farPlane,
        this.config.shadowRadius,
        this.config.resolution,
      );
      mat4.copy(this.lightSpaceMatrix, result.lightSpaceMatrix);
      
      // Compute light position for external access (center of frustum + light offset)
      const corners = getFrustumCornersWorldSpace(cameraView, cameraProj, nearPlane, farPlane);
      const center: vec3 = vec3.fromValues(0, 0, 0);
      for (const c of corners) {
        center[0] += c[0]; center[1] += c[1]; center[2] += c[2];
      }
      center[0] /= corners.length; center[1] /= corners.length; center[2] /= corners.length;
      this.directionalLightPosition = vec3.fromValues(
        center[0] + lightDir[0],
        center[1] + lightDir[1],
        center[2] + lightDir[2]
      );
      this.shadowCenter = [cameraPos[0], cameraPos[2]];
      
      return this.lightSpaceMatrix;
    }
    
    // Legacy fallback: fixed-radius ortho centered on camera XZ
    const radius = this.config.shadowRadius;
    this.shadowCenter = [cameraPos[0], cameraPos[2]];
    const center: vec3 = [this.shadowCenter[0], 0, this.shadowCenter[1]];
    const lightDistance = radius * 2;
    const lightPos: vec3 = vec3.fromValues(
      center[0] + lightDir[0] * lightDistance,
      center[1] + lightDir[1] * lightDistance,
      center[2] + lightDir[2] * lightDistance
    );
    let up: vec3 = [0, 1, 0];
    if (Math.abs(lightDir[1]) > 0.99) { up = [0, 0, 1]; }
    mat4.lookAt(this.lightViewMatrix, lightPos, center, up);
    const near = 0.1;
    const far = radius * 3;
    mat4.ortho(this.lightProjMatrix, -radius, radius, -radius, radius, near, far);
    this.lightProjMatrix[10] = -1 / (far - near);
    this.lightProjMatrix[14] = -near / (far - near);
    mat4.multiply(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);
    this.directionalLightPosition = lightPos;
    return this.lightSpaceMatrix;
  }
  
  /**
   * Update light space matrices for all cascades (CSM mode)
   * Uses frustum-fitting: each cascade's ortho tightly wraps the camera sub-frustum.
   */
  private updateCascadeMatrices(
    lightDir: vec3,
    cameraView: mat4,
    cameraProj: mat4,
    nearPlane: number,
    farPlane: number
  ): void {
    // Make sure the full far plane is not considered for cascade split.
    // Shadow map distance <= View distance 
    const cappedFarPlane = Math.min(farPlane, this.config.shadowRadius);

    // Calculate split distances using shared utility
    this.cascadeSplits = calculateCascadeSplits(
      nearPlane, cappedFarPlane,
      this.config.cascadeCount,
      this.config.cascadeSplitLambda
    );
    
    // Calculate light matrix for each cascade
    let prevSplit = nearPlane;
    
    for (let i = 0; i < this.config.cascadeCount; i++) {
      const splitEnd = this.cascadeSplits[i];
      
      const result = calculateCascadeLightMatrix(
        lightDir,
        cameraView,
        cameraProj,
        prevSplit,
        splitEnd,
        this.config.shadowRadius,
        this.config.resolution,
        this._sceneAABB,
      );
      if (!this._debugOnce) {
        console.log(`Matrix for cascade: ${i}`, result);
      }
      
      mat4.copy(this.cascades[i].lightSpaceMatrix, result.lightSpaceMatrix);
      this.cascades[i].splitDistance = splitEnd;
      this.cascades[i].radius = result.radius;
      
      prevSplit = splitEnd;
    }

    this._debugOnce = true;
  }
  
  /**
   * Update CSM uniform buffer with current cascade data
   */
  updateCSMUniforms(): void {
    if (!this.csmUniformBuffer) return;
    
    const data = new Float32Array(76); // 304 bytes / 4
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
    offset += 4;
    
    // Camera forward direction (vec4f): xyz = normalized forward, w = 0
    data[offset + 0] = this.cameraForward[0];
    data[offset + 1] = this.cameraForward[1];
    data[offset + 2] = this.cameraForward[2];
    data[offset + 3] = 0; // padding
    
    this.csmUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Update light space matrix for external shadow rendering
   * Called by ShadowPass before terrain/objects render their shadows.
   * 
   * For CSM: requires cameraViewMatrix and cameraProjectionMatrix to compute
   * frustum-fitted cascade ortho projections.
   */
  updateLightMatrix(params: LightMatrixParams): void {
    const lightDir = params.lightDirection as vec3;
    const cameraPos = params.cameraPosition as vec3;
    const cameraFwd = params.cameraForward;
    const nearPlane = params.cameraNearPlane ?? 0.1;
    const farPlane = params.cameraFarPlane ?? this.config.shadowRadius;
    
    // Store camera forward for CSM view-space depth calculation
    if (cameraFwd) {
      vec3.normalize(this.cameraForward, cameraFwd);
    }
    
    const hasCameraMatrices = !!(params.cameraViewMatrix && params.cameraProjectionMatrix);
    const cameraView = params.cameraViewMatrix as mat4 | undefined;
    const cameraProj = params.cameraProjectionMatrix as mat4 | undefined;
    
    if (this.config.csmEnabled && hasCameraMatrices) {
      // Update all cascade matrices using frustum-fitting
      this.updateCascadeMatrices(lightDir, cameraView!, cameraProj!, nearPlane, farPlane);
      // Also update single map using frustum-fitting for fallback/compatibility
      this.calculateLightMatrix(lightDir, cameraPos, cameraFwd, cameraView, cameraProj, nearPlane, farPlane);
      // Update CSM uniforms
      this.updateCSMUniforms();
    } else {
      // Single shadow map mode — use frustum-fitting if camera matrices available
      this.calculateLightMatrix(lightDir, cameraPos, cameraFwd, cameraView, cameraProj, nearPlane, farPlane);
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
  
  /**
   * Set the scene bounding box for shadow Z-range expansion.
   * When set, the ortho projection's near/far planes for each cascade will be
   * expanded to fully contain the scene AABB corners (projected into light space).
   * This prevents tall terrain features (cliffs, mountains) from being clipped
   * by the shadow map depth range, regardless of light angle.
   * 
   * @param aabb World-space AABB {min, max}, or undefined to clear
   */
  setSceneAABB(aabb: SceneAABB | undefined): void {
    this._sceneAABB = aabb;
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
  
  // ============ Shared Depth-Pass Resources ============

  /**
   * Create the shared dynamic uniform buffer, bind group layout, and bind group
   * used by all renderers for shadow depth passes.
   *
   * Layout: Group 0, Binding 0 = mat4x4f (64 bytes visible, 256-byte stride)
   *         with hasDynamicOffset: true
   */
  private createSharedDepthPassResources(): void {
    const totalSize = SHADOW_SLOT_SIZE * MAX_SHADOW_SLOTS;

    this._shadowUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'shadow-shared-uniforms-dynamic',
      size: totalSize,
    });

    this._shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'shadow-shared-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });

    this._shadowBindGroup = this.ctx.device.createBindGroup({
      label: 'shadow-shared-bind-group',
      layout: this._shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._shadowUniformBuffer.buffer, size: 64 } },
      ],
    });
  }

  /**
   * Get the shared shadow bind group layout (Group 0 for all shadow pipelines).
   * Renderers use this when creating their shadow render pipelines.
   */
  getShadowBindGroupLayout(): GPUBindGroupLayout {
    return this._shadowBindGroupLayout!;
  }

  /**
   * Get the shared shadow bind group (Group 0 for all shadow draw calls).
   * Pass a dynamic offset of `slotIndex * SHADOW_SLOT_SIZE` to select the matrix.
   */
  getShadowBindGroup(): GPUBindGroup {
    return this._shadowBindGroup!;
  }

  /**
   * Get the shared shadow uniform buffer (for direct writeBuffer access if needed).
   */
  getShadowUniformBuffer(): UnifiedGPUBuffer {
    return this._shadowUniformBuffer!;
  }

  /**
   * Pre-write all shadow matrices to the shared dynamic uniform buffer starting at slot 0.
   * Must be called ONCE before recording any shadow render passes.
   *
   * @param matrices - Array of light-space matrices to write.
   *   For CSM: [cascade0, cascade1, cascade2, cascade3, singleMap]
   *   For single map only: [singleMap]
   */
  writeShadowMatrices(matrices: (mat4 | Float32Array)[]): void {
    this.writeShadowMatricesAt(0, matrices);
  }

  /**
   * Write shadow matrices to the shared dynamic uniform buffer starting at a specific slot.
   * Only writes to the specified slot range, leaving other slots untouched.
   *
   * @param startSlot - First slot index to write to
   * @param matrices - Array of light-space matrices to write at consecutive slots
   */
  writeShadowMatricesAt(startSlot: number, matrices: (mat4 | Float32Array)[]): void {
    if (!this._shadowUniformBuffer || matrices.length === 0) return;

    const floatsPerSlot = SHADOW_SLOT_SIZE / 4; // 64 floats per 256-byte slot
    const totalFloats = floatsPerSlot * matrices.length;
    const data = new Float32Array(totalFloats);

    for (let i = 0; i < matrices.length; i++) {
      // Write mat4 (16 floats = 64 bytes) at the start of each 256-byte slot
      data.set(matrices[i] as Float32Array, i * floatsPerSlot);
    }

    // Write at byte offset for the starting slot
    const byteOffset = startSlot * SHADOW_SLOT_SIZE;
    this.ctx.queue.writeBuffer(
      this._shadowUniformBuffer.buffer,
      byteOffset,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  // ============ Spot Shadow Atlas ============

  /** Create the spot/point shadow atlas texture array */
  private createSpotShadowAtlas(resolution?: number): void {
    const atlasResolution = resolution ?? 1024; // Default 1024 for spot shadows
    const layers = ShadowRendererGPU.MAX_SHADOW_ATLAS_LAYERS;

    // Destroy old atlas if exists
    this.spotShadowAtlasTexture?.destroy();
    this.spotShadowAtlasResolution = atlasResolution;

    this.spotShadowAtlasTexture = this.ctx.device.createTexture({
      label: 'spot-shadow-atlas',
      size: {
        width: atlasResolution,
        height: atlasResolution,
        depthOrArrayLayers: layers,
      },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.spotShadowAtlasView = this.spotShadowAtlasTexture.createView({
      label: 'spot-shadow-atlas-view',
      dimension: '2d-array',
      arrayLayerCount: layers,
    });

    this.spotShadowAtlasLayerViews = [];
    for (let i = 0; i < layers; i++) {
      this.spotShadowAtlasLayerViews.push(
        this.spotShadowAtlasTexture.createView({
          label: `spot-shadow-atlas-layer-${i}`,
          dimension: '2d',
          baseArrayLayer: i,
          arrayLayerCount: 1,
        }),
      );
    }

    this.spotShadowMatrices = [];
    this.spotShadowSlots = [];
    for (let i = 0; i < layers; i++) {
      this.spotShadowMatrices.push(mat4.create());
      this.spotShadowSlots.push(null);
    }
  }

  /**
   * Allocate a shadow atlas slot for a light entity.
   * @returns The atlas layer index, or -1 if no slot available.
   */
  allocateShadowSlot(entityId: string): number {
    // Check if entity already has a slot
    const existingIdx = this.spotShadowSlots.indexOf(entityId);
    if (existingIdx >= 0) return existingIdx;

    // Find a free slot
    const freeIdx = this.spotShadowSlots.indexOf(null);
    if (freeIdx < 0) {
      return -1;
    }

    this.spotShadowSlots[freeIdx] = entityId;
    return freeIdx;
  }

  /**
   * Free a shadow atlas slot previously allocated for a light entity.
   */
  freeShadowSlot(entityId: string): void {
    const idx = this.spotShadowSlots.indexOf(entityId);
    if (idx >= 0) {
      this.spotShadowSlots[idx] = null;
      mat4.identity(this.spotShadowMatrices[idx]);
    }
  }

  /**
   * Get the render attachment view for a specific atlas layer (for rendering into it).
   */
  getSpotShadowAtlasLayerView(layerIndex: number): GPUTextureView | null {
    return this.spotShadowAtlasLayerViews[layerIndex] ?? null;
  }

  /**
   * Get the full atlas array view (for shader sampling).
   */
  getSpotShadowAtlasView(): GPUTextureView | null {
    return this.spotShadowAtlasView;
  }

  /**
   * Set the light-space matrix for a specific atlas layer.
   * Called by LightingSystem after computing the spot light projection.
   */
  setSpotShadowMatrix(layerIndex: number, matrix: mat4): void {
    if (layerIndex >= 0 && layerIndex < this.spotShadowMatrices.length) {
      mat4.copy(this.spotShadowMatrices[layerIndex], matrix);
    }
  }

  /**
   * Get the light-space matrix for a specific atlas layer.
   */
  getSpotShadowMatrix(layerIndex: number): mat4 {
    return this.spotShadowMatrices[layerIndex] ?? mat4.create();
  }

  /**
   * Get the number of currently allocated shadow slots.
   */
  getActiveSpotShadowCount(): number {
    return this.spotShadowSlots.filter((s) => s !== null).length;
  }

  /**
   * Get the current spot shadow atlas resolution.
   */
  getSpotShadowAtlasResolution(): number {
    return this.spotShadowAtlasResolution;
  }

  /**
   * Resize the spot shadow atlas to a new resolution.
   * Recreates the atlas texture and all layer views. Existing slot allocations
   * and matrices are preserved; only the texture storage changes.
   * @returns true if the atlas was actually recreated (resolution changed)
   */
  resizeSpotShadowAtlas(resolution: number): boolean {
    const clamped = Math.max(256, Math.min(4096, resolution));
    if (clamped === this.spotShadowAtlasResolution) return false;

    // Preserve slot allocations and matrices
    const savedSlots = [...this.spotShadowSlots];
    const savedMatrices = this.spotShadowMatrices.map(m => {
      const copy = mat4.create();
      mat4.copy(copy, m);
      return copy;
    });

    this.createSpotShadowAtlas(clamped);

    // Restore slot allocations and matrices
    for (let i = 0; i < savedSlots.length && i < this.spotShadowSlots.length; i++) {
      this.spotShadowSlots[i] = savedSlots[i];
    }
    for (let i = 0; i < savedMatrices.length && i < this.spotShadowMatrices.length; i++) {
      mat4.copy(this.spotShadowMatrices[i], savedMatrices[i]);
    }

    console.log(`[ShadowRendererGPU] Spot shadow atlas resized to ${clamped}x${clamped}`);
    return true;
  }

  // ============ Cleanup ============
  
  destroy(): void {
    this.shadowMap?.destroy();
    this.shadowMapArrayTexture?.destroy();
    this.csmUniformBuffer?.destroy();
    this.depthVisualizer?.destroy();
    this.spotShadowAtlasTexture?.destroy();
    this._shadowUniformBuffer?.destroy();
    
    this.shadowMap = null;
    this.shadowMapArrayTexture = null;
    this.shadowMapArrayView = null;
    this.csmUniformBuffer = null;
    this.depthVisualizer = null;
    this.cascadeViews = [];
    this.spotShadowAtlasTexture = null;
    this.spotShadowAtlasView = null;
    this.spotShadowAtlasLayerViews = [];
    this._shadowUniformBuffer = null;
    this._shadowBindGroupLayout = null;
    this._shadowBindGroup = null;
  }
}
