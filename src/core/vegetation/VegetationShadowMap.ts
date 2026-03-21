/**
 * VegetationShadowMap
 * 
 * Dedicated shadow map for grass blade vegetation. Uses a simple ortho projection
 * centered on the camera position with a small radius (shadowDistance), rendering
 * into a fixed 1024×1024 depth texture.
 * 
 * This is separate from the CSM cascade system because:
 * 1. Grass is small and only relevant at close range
 * 2. CSM cascades are too coarse for individual blade shadows
 * 3. A tight ortho fit gives much better shadow resolution for nearby grass
 * 
 * The shadow map is sampled by:
 * - grass-blade.wgsl (grass blades shadow each other)
 * - cdlod.wgsl (terrain receives grass shadows for ground darkening)
 */

import { mat4, vec3 } from 'gl-matrix';
import type { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUBuffer } from '../gpu/GPUBuffer';

// ==================== Constants ====================

const SHADOW_MAP_SIZE = 1024;
const SHADOW_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

/** Uniform buffer size: mat4(64) + vec4(16) = 80 bytes, pad to 96 */
const UNIFORM_SIZE = 96;

// ==================== VegetationShadowMap ====================

export class VegetationShadowMap {
  private ctx: GPUContext;

  // Shadow map texture
  private shadowTexture: GPUTexture | null = null;
  private shadowTextureView: GPUTextureView | null = null;

  // Light space matrix (ortho projection from sun direction)
  private lightSpaceMatrix = mat4.create();
  private lightViewMatrix = mat4.create();
  private lightProjMatrix = mat4.create();

  // Uniform buffer for shaders that sample this shadow map
  private uniformBuffer: UnifiedGPUBuffer | null = null;

  // Current parameters
  private shadowRadius = 50;
  private shadowCenter: [number, number, number] = [0, 0, 0];
  private lightDirection: [number, number, number] = [0.3, 0.8, 0.2];

  private initialized = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ==================== Initialization ====================

  initialize(): void {
    if (this.initialized) return;

    // Create depth texture
    this.shadowTexture = this.ctx.device.createTexture({
      label: 'vegetation-shadow-map',
      size: { width: SHADOW_MAP_SIZE, height: SHADOW_MAP_SIZE },
      format: SHADOW_DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.shadowTextureView = this.shadowTexture.createView({
      label: 'vegetation-shadow-map-view',
    });

    // Uniform buffer: lightSpaceMatrix (mat4) + shadowParams (vec4: center.xz, radius, enabled)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'vegetation-shadow-uniforms',
      size: UNIFORM_SIZE,
    });

    this.initialized = true;
    console.log(`[VegetationShadowMap] Initialized ${SHADOW_MAP_SIZE}×${SHADOW_MAP_SIZE}`);
  }

  // ==================== Light Matrix ====================

  /**
   * Update the ortho light-space matrix for the vegetation shadow map.
   * 
   * The ortho projection is a tight box centered on cameraPosition (XZ) with
   * the given shadowRadius. The light looks from above along -lightDirection.
   * 
   * @param lightDir - Normalized light direction (pointing towards the light)
   * @param cameraPos - Camera world position (shadow center)
   * @param shadowRadius - Half-extent of the ortho box (meters)
   */
  updateLightMatrix(
    lightDir: [number, number, number],
    cameraPos: [number, number, number],
    shadowRadius: number,
  ): void {
    this.lightDirection = lightDir;
    this.shadowCenter = cameraPos;
    this.shadowRadius = shadowRadius;

    const radius = shadowRadius;

    // Light position: offset from ground-projected camera center ALONG the light direction.
    // lightDir points towards the light source (e.g., towards the sun).
    // So lightPos = center + lightDir * distance places us on the sun side.
    //
    // Use Y=0 (ground level) instead of camera Y to keep the shadow map
    // coverage centered on the terrain surface where grass actually grows,
    // regardless of camera elevation.
    const lightDistance = radius * 2;
    const center: vec3 = [cameraPos[0], 0, cameraPos[2]];
    const lightPos: vec3 = [
      center[0] + lightDir[0] * lightDistance,
      center[1] + lightDir[1] * lightDistance,
      center[2] + lightDir[2] * lightDistance,
    ];

    // Look-at target is the ground-projected camera position (center of shadow area)
    const target: vec3 = center;

    // Up vector
    let up: vec3 = [0, 1, 0];
    if (Math.abs(lightDir[1]) > 0.99) {
      up = [0, 0, 1];
    }

    // View matrix
    mat4.lookAt(this.lightViewMatrix, lightPos, target, up);

    // Ortho projection — tight box around the shadow area.
    // Use orthoZO (Zero-to-One) which produces Z in [0, 1] for WebGPU clip space,
    // unlike mat4.ortho() which produces OpenGL-convention Z in [-1, +1].
    const near = 0.1;
    const far = radius * 4;
    mat4.orthoZO(this.lightProjMatrix, -radius, radius, -radius, radius, near, far);

    // Combine
    mat4.multiply(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);

    // Write uniform buffer
    this.writeUniforms();
  }

  /**
   * Write the light-space matrix and shadow params to the uniform buffer.
   */
  private writeUniforms(): void {
    if (!this.uniformBuffer) return;

    const data = new Float32Array(UNIFORM_SIZE / 4);

    // mat4 lightSpaceMatrix (offset 0-15)
    data.set(this.lightSpaceMatrix as Float32Array, 0);

    // vec4 shadowParams (offset 16-19): center.x, center.z, radius, enabled(1.0)
    data[16] = this.shadowCenter[0];
    data[17] = this.shadowCenter[2];
    data[18] = this.shadowRadius;
    data[19] = 1.0; // enabled

    // texelSize (offset 20): 1.0 / SHADOW_MAP_SIZE
    data[20] = 1.0 / SHADOW_MAP_SIZE;
    data[21] = 0;
    data[22] = 0;
    data[23] = 0;

    this.uniformBuffer.write(this.ctx, data);
  }

  // ==================== Getters ====================

  /** Get the shadow map depth texture view for render attachment */
  getShadowTextureView(): GPUTextureView | null {
    return this.shadowTextureView;
  }

  /** Get the shadow map depth texture view for shader sampling */
  getShadowMapView(): GPUTextureView | null {
    return this.shadowTextureView;
  }

  /** Get the light-space matrix */
  getLightSpaceMatrix(): mat4 {
    return this.lightSpaceMatrix;
  }

  /** Get the uniform buffer for shader binding */
  getUniformBuffer(): UnifiedGPUBuffer | null {
    return this.uniformBuffer;
  }

  /** Get the shadow map resolution */
  getResolution(): number {
    return SHADOW_MAP_SIZE;
  }

  /** Get the depth format */
  getDepthFormat(): GPUTextureFormat {
    return SHADOW_DEPTH_FORMAT;
  }

  /** Get current shadow radius */
  getShadowRadius(): number {
    return this.shadowRadius;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ==================== Cleanup ====================

  destroy(): void {
    this.shadowTexture?.destroy();
    this.uniformBuffer?.destroy();

    this.shadowTexture = null;
    this.shadowTextureView = null;
    this.uniformBuffer = null;
    this.initialized = false;
  }
}
