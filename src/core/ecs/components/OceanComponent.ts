import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { OceanManager } from '../../ocean/OceanManager';
import type { AABB } from '../../sceneObjects/types';
import { WaterConfig } from '@/core/gpu/renderers';

/**
 * Ocean component — holds a reference to the OceanManager subsystem.
 *
 * The OceanManager owns the water renderer, FFT simulation, etc.
 * This component makes it discoverable via ECS queries.
 */
export class OceanComponent extends Component {
  readonly type: ComponentType = 'ocean';

  manager: OceanManager;
  waterLevel: number = 0.2;

  constructor(manager: OceanManager) {
    super();
    this.manager = manager;
  }

  /**
   * Compute world bounds from ocean grid config.
   * Ocean doesn't use transforms — its bounds are in world space.
   */
  computeWorldBounds(): AABB | null {
    const config = this.manager.getConfig();
    if (!config) return null;
    const halfX = (config.gridSizeX ?? 512) / 2;
    const halfZ = (config.gridSizeZ ?? 512) / 2;
    const cx = config.gridCenterX ?? 0;
    const cz = config.gridCenterZ ?? 0;
    const wl = config.waterLevel ?? this.waterLevel;
    return {
      min: [cx - halfX, wl - 1, cz - halfZ] as any,
      max: [cx + halfX, wl + 1, cz + halfZ] as any,
    };
  }

  getConfig(): WaterConfig {
    return this.manager.getConfig();
  }

  getWaterLevelWorld(heightScale: number): number {
    return this.manager.getWaterLevelWorld(heightScale);
  }

  destroy(): void {
    this.manager.destroy();
  }
}
