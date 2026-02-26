import { mat4, vec3 } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { TerrainManager } from '../../terrain/TerrainManager';
import type { AABB } from '../../sceneObjects/types';

/**
 * Terrain component — holds a reference to the TerrainManager subsystem.
 *
 * The TerrainManager owns the CDLOD renderer, heightmap, erosion state, etc.
 * This component makes it discoverable via ECS queries.
 */
export class TerrainComponent extends Component {
  readonly type: ComponentType = 'terrain';

  manager: TerrainManager;
  canCastShadows: boolean = true;

  constructor(manager: TerrainManager) {
    super();
    this.manager = manager;
  }

  /**
   * Compute world bounds directly from terrain config.
   * Terrain doesn't use transforms — its bounds are in world space.
   */
  computeWorldBounds(): AABB | null {
    const config = this.manager.getConfig();
    if (!config) return null;
    const halfSize = config.worldSize / 2;
    const halfHeight = config.heightScale / 2;
    return {
      min: [-halfSize, -halfHeight, -halfSize] as any,
      max: [halfSize, halfHeight, halfSize] as any,
    };
  }

  // ==================== Shadow Casting ====================

  /**
   * Whether terrain can currently cast shadows.
   */
  get isShadowReady(): boolean {
    return this.canCastShadows && (this.manager?.isReady ?? false);
  }

  /**
   * Pre-write shadow uniforms for all passes (CSM cascades + single map).
   * Delegates to CDLODRenderer + VegetationManager.
   */
  prepareShadowPasses(matrices: { lightSpaceMatrix: mat4; lightPosition: [number, number, number] }[]): void {
    if (!this.isShadowReady) return;

    const renderer = this.manager.getRenderer();
    const config = this.manager.getConfig();
    if (renderer) {
      renderer.writeShadowUniforms(matrices, config.worldSize, config.heightScale);
    }

    const vegManager = this.manager.getVegetationManager();
    if (vegManager) {
      const vegMatrices = matrices.map(m => ({
        lightSpaceMatrix: m.lightSpaceMatrix as Float32Array,
        lightPosition: m.lightPosition,
      }));
      vegManager.prepareShadowPasses(vegMatrices);
    }
  }

  /**
   * Render terrain + vegetation depth into a shadow map pass.
   * @returns number of draw calls emitted
   */
  renderDepthOnly(
    passEncoder: GPURenderPassEncoder,
    slotIndex: number,
    lightSpaceMatrix: mat4 | Float32Array,
    lightPosition: [number, number, number],
  ): number {
    if (!this.isShadowReady) return 0;

    let drawCalls = 0;
    const renderer = this.manager.getRenderer();
    if (renderer) {
      renderer.renderShadowPass(
        passEncoder,
        slotIndex,
        lightSpaceMatrix,
        lightPosition,
        this.manager.getHeightmapTexture() ?? undefined,
      );
      drawCalls++;
    }

    const vegManager = this.manager.getVegetationManager();
    if (vegManager) {
      vegManager.renderDepthOnly(passEncoder, slotIndex);
      drawCalls++;
    }

    return drawCalls;
  }

  destroy(): void {
    this.manager.destroy();
  }
}
