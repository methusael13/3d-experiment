import type { GPUContext } from '../GPUContext';
import type { Entity } from '../../ecs/Entity';
import { LightComponent } from '../../ecs/components/LightComponent';
import { TransformComponent } from '../../ecs/components/TransformComponent';
import { Logger } from '@/core/utils/logger';

/**
 * Maximum number of point/spot lights supported.
 * Sufficient for an editor; can be increased later for Forward+ tiled shading.
 */
export const MAX_POINT_LIGHTS = 16;
export const MAX_SPOT_LIGHTS = 16;

/**
 * Byte sizes for GPU buffer layouts (must match lights.wgsl structs).
 *
 * PointLightData: position(12) + range(4) + color(12) + intensity(4) = 32 bytes
 * SpotLightData:  position(12) + range(4) + direction(12) + intensity(4) +
 *                 color(12) + innerCos(4) + outerCos(4) + shadowAtlasIndex(4) +
 *                 cookieAtlasIndex(4) + cookieIntensity(4) +
 *                 lightSpaceMatrix(64) = 128 bytes
 * LightCounts:    numPoint(4) + numSpot(4) + pad(8) = 16 bytes
 */
const POINT_LIGHT_STRIDE = 32;  // bytes per point light
const SPOT_LIGHT_STRIDE = 128;  // bytes per spot light (with mat4x4 + shadow/cookie)
const LIGHT_COUNTS_SIZE = 16;   // bytes for count header

/**
 * LightBufferManager — packs point/spot light data into GPU storage buffers.
 *
 * Manages three GPU buffers:
 * - lightCounts (uniform): { numPoint, numSpot, _pad, _pad }
 * - pointLightsBuffer (storage, read-only): array of PointLightData
 * - spotLightsBuffer (storage, read-only): array of SpotLightData
 *
 * LightingSystem calls `update()` each frame with visible light entities.
 * The buffers are bound to the environment group (Group 3) by SceneEnvironment.
 */
export class LightBufferManager {
  private ctx: GPUContext;

  // GPU Buffers
  private lightCountsBuffer: GPUBuffer;
  private pointLightsBuffer: GPUBuffer;
  private spotLightsBuffer: GPUBuffer;

  // CPU staging arrays
  private lightCountsData = new Uint32Array(4);  // [numPoint, numSpot, 0, 0]
  private pointLightsData: Float32Array;
  private spotLightsData: Float32Array;

  // Current counts
  private _numPointLights = 0;
  private _numSpotLights = 0;

  private _logger = Logger.createLogger('LightBuffer', 2000);

  /**
   * Spot light shadow matrices — set externally by LightingSystem from ShadowRendererGPU.
   * Index i corresponds to spot light entity i (not atlas layer i).
   * Each mat4 is the light-space projection matrix for shadow sampling.
   */
  _spotShadowMatrices: (ArrayLike<number> | null)[] = [];

  /** True if there are any point or spot lights this frame */
  get hasMultiLights(): boolean {
    return this._numPointLights > 0 || this._numSpotLights > 0;
  }

  get numPointLights(): number { return this._numPointLights; }
  get numSpotLights(): number { return this._numSpotLights; }

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    // Create GPU buffers (pre-allocated to max size)
    this.lightCountsBuffer = ctx.device.createBuffer({
      label: 'light-counts-uniform',
      size: LIGHT_COUNTS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pointLightsBuffer = ctx.device.createBuffer({
      label: 'point-lights-storage',
      size: Math.max(POINT_LIGHT_STRIDE * MAX_POINT_LIGHTS, 32), // min 32 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.spotLightsBuffer = ctx.device.createBuffer({
      label: 'spot-lights-storage',
      size: Math.max(SPOT_LIGHT_STRIDE * MAX_SPOT_LIGHTS, 64), // min 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // CPU staging arrays
    this.pointLightsData = new Float32Array(MAX_POINT_LIGHTS * (POINT_LIGHT_STRIDE / 4));
    this.spotLightsData = new Float32Array(MAX_SPOT_LIGHTS * (SPOT_LIGHT_STRIDE / 4));
  }

  /**
   * Update GPU buffers from ECS light entities.
   * Called by LightingSystem each frame after computing derived values.
   *
   * @param pointEntities - Entities with enabled point lights
   * @param spotEntities - Entities with enabled spot lights
   */
  update(pointEntities: Entity[], spotEntities: Entity[]): void {
    // Pack point lights
    const numPoint = Math.min(pointEntities.length, MAX_POINT_LIGHTS);
    this._numPointLights = numPoint;

    for (let i = 0; i < numPoint; i++) {
      const entity = pointEntities[i];
      const light = entity.getComponent<LightComponent>('light')!;
      const transform = entity.getComponent<TransformComponent>('transform');

      const offset = i * (POINT_LIGHT_STRIDE / 4); // offset in float32 units
      // position
      this.pointLightsData[offset + 0] = transform?.position[0] ?? 0;
      this.pointLightsData[offset + 1] = transform?.position[1] ?? 0;
      this.pointLightsData[offset + 2] = transform?.position[2] ?? 0;
      // range
      this.pointLightsData[offset + 3] = light.range ?? 10;
      // color (pre-multiplied by intensity in effectiveColor? No — separate for shader flexibility)
      this.pointLightsData[offset + 4] = light.color[0];
      this.pointLightsData[offset + 5] = light.color[1];
      this.pointLightsData[offset + 6] = light.color[2];
      // intensity
      this.pointLightsData[offset + 7] = light.intensity;
    }

    // Pack spot lights
    const numSpot = Math.min(spotEntities.length, MAX_SPOT_LIGHTS);
    this._numSpotLights = numSpot;

    for (let i = 0; i < numSpot; i++) {
      const entity = spotEntities[i];
      const light = entity.getComponent<LightComponent>('light')!;
      const transform = entity.getComponent<TransformComponent>('transform');

      const offset = i * (SPOT_LIGHT_STRIDE / 4); // offset in float32 units
      // position
      this.spotLightsData[offset + 0] = transform?.position[0] ?? 0;
      this.spotLightsData[offset + 1] = transform?.position[1] ?? 0;
      this.spotLightsData[offset + 2] = transform?.position[2] ?? 0;
      // range
      this.spotLightsData[offset + 3] = light.range ?? 10;
      // direction (computed by LightingSystem for spot lights, or from transform forward)
      this.spotLightsData[offset + 4] = light.direction[0];
      this.spotLightsData[offset + 5] = light.direction[1];
      this.spotLightsData[offset + 6] = light.direction[2];
      // intensity
      this.spotLightsData[offset + 7] = light.intensity;
      // color
      this.spotLightsData[offset + 8] = light.color[0];
      this.spotLightsData[offset + 9] = light.color[1];
      this.spotLightsData[offset + 10] = light.color[2];
      // innerCos
      this.spotLightsData[offset + 11] = Math.cos(light.innerConeAngle ?? Math.PI / 6);
      // outerCos
      this.spotLightsData[offset + 12] = Math.cos(light.outerConeAngle ?? Math.PI / 4);
      // shadowAtlasIndex (as float — reinterpreted as i32 in shader via bitcast)
      const shadowView = new DataView(this.spotLightsData.buffer);
      shadowView.setInt32((offset + 13) * 4, light.shadowAtlasIndex, true);
      // cookieAtlasIndex
      shadowView.setInt32((offset + 14) * 4, light.cookieAtlasIndex, true);
      // cookieIntensity
      this.spotLightsData[offset + 15] = light.cookieIntensity;
      // lightSpaceMatrix (16 floats at offset 16..31)
      // Identity by default if no shadow renderer has set it
      // The matrix is written externally by LightingSystem via shadowRenderer.getSpotShadowMatrix()
      const shadowMat = this._spotShadowMatrices?.[i];
      if (shadowMat) {
        for (let m = 0; m < 16; m++) {
          this.spotLightsData[offset + 16 + m] = shadowMat[m];
        }
      } else {
        // Identity matrix
        for (let m = 0; m < 16; m++) {
          this.spotLightsData[offset + 16 + m] = (m % 5 === 0) ? 1.0 : 0.0;
        }
      }
    }

    // Update light counts
    this.lightCountsData[0] = numPoint;
    this.lightCountsData[1] = numSpot;
    this.lightCountsData[2] = 0;
    this.lightCountsData[3] = 0;

    // Upload to GPU
    this.ctx.queue.writeBuffer(this.lightCountsBuffer, 0, this.lightCountsData);
    if (numPoint > 0) {
      this.ctx.queue.writeBuffer(
        this.pointLightsBuffer, 0,
        this.pointLightsData.buffer, 0,
        numPoint * POINT_LIGHT_STRIDE,
      );
    }
    if (numSpot > 0) {
      this.ctx.queue.writeBuffer(
        this.spotLightsBuffer, 0,
        this.spotLightsData.buffer, 0,
        numSpot * SPOT_LIGHT_STRIDE,
      );
    }
  }

  /**
   * Get bind group entries for environment Group 3 bindings.
   * @param countBinding - binding index for light counts uniform
   * @param pointBinding - binding index for point lights storage
   * @param spotBinding - binding index for spot lights storage
   */
  getBindGroupEntries(
    countBinding: number,
    pointBinding: number,
    spotBinding: number,
  ): GPUBindGroupEntry[] {
    return [
      {
        binding: countBinding,
        resource: { buffer: this.lightCountsBuffer },
      },
      {
        binding: pointBinding,
        resource: { buffer: this.pointLightsBuffer },
      },
      {
        binding: spotBinding,
        resource: { buffer: this.spotLightsBuffer },
      },
    ];
  }

  /**
   * Get bind group layout entries for environment Group 3.
   */
  getBindGroupLayoutEntries(
    countBinding: number,
    pointBinding: number,
    spotBinding: number,
  ): GPUBindGroupLayoutEntry[] {
    return [
      {
        binding: countBinding,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' as GPUBufferBindingType },
      },
      {
        binding: pointBinding,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' as GPUBufferBindingType },
      },
      {
        binding: spotBinding,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' as GPUBufferBindingType },
      },
    ];
  }

  /**
   * Get the raw GPU buffers (for manual bind group construction).
   */
  getBuffers() {
    return {
      lightCountsBuffer: this.lightCountsBuffer,
      pointLightsBuffer: this.pointLightsBuffer,
      spotLightsBuffer: this.spotLightsBuffer,
    };
  }

  destroy(): void {
    this.lightCountsBuffer.destroy();
    this.pointLightsBuffer.destroy();
    this.spotLightsBuffer.destroy();
  }
}