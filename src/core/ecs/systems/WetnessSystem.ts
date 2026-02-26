import { System } from '../System';
import type { Entity } from '../Entity';
import type { World } from '../World';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { BoundsComponent } from '../components/BoundsComponent';
import { WetnessComponent } from '../components/WetnessComponent';
import { LODComponent } from '../components/LODComponent';
import { OceanComponent } from '../components/OceanComponent';
import { TerrainComponent } from '../components/TerrainComponent';
import { evaluateGerstnerHeight } from '../../ocean/GerstnerWaves';

/**
 * WetnessSystem — computes per-entity wetness from ocean water interaction.
 *
 * Priority 55: runs after LODSystem (10) and WindSystem (50),
 * before MeshRenderSystem (100).
 *
 * For each entity with WetnessComponent + TransformComponent, determines the
 * water surface height at the entity's position and computes wetness parameters.
 *
 * Discovers the ocean configuration automatically by querying the World for
 * an entity with OceanComponent — no external config injection required.
 *
 * LOD-aware behavior:
 * - LOD 0: Full Gerstner wave evaluation for accurate wave-following wet line
 * - LOD 1: Flat base water level (simpler, no wave computation)
 * - LOD ≥ 2: Skip wetness entirely (set wetnessFactor to 0)
 *
 * Requires a World reference via `setWorld()` after registration.
 */
export class WetnessSystem extends System {
  readonly name = 'wetness';
  readonly requiredComponents: readonly ComponentType[] = [
    'transform',
    'wetness',
  ];
  priority = 55;

  /** World reference — used to query for the ocean entity */
  private _world: World | null = null;

  /**
   * Set the World reference so this system can query for ocean entities.
   * Called after adding the system to the world.
   */
  setWorld(world: World): void {
    this._world = world;
  }

  update(
    entities: Entity[],
    deltaTime: number,
    context: SystemContext,
  ): void {
    // Query for ocean entity to get water config
    const oceanConfig = this.getOceanConfig();

    // If no ocean active, evaporate all entities
    if (!oceanConfig) {
      for (const entity of entities) {
        const wetness = entity.getComponent<WetnessComponent>('wetness');
        if (!wetness) continue;
        if (wetness.wetnessFactor > 0) {
          wetness.wetnessFactor = Math.max(
            0,
            wetness.wetnessFactor - wetness.evaporationRate * deltaTime,
          );
        }
      }
      return;
    }

    const { waterLevelWorld, waveScale, wavelength } = oceanConfig;
    const time = context.time;

    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const wetness = entity.getComponent<WetnessComponent>('wetness');
      if (!transform || !wetness || !wetness.enabled) continue;

      const lod = entity.getComponent<LODComponent>('lod');
      const currentLOD = lod ? lod.currentLOD : 0;

      // LOD ≥ 2: skip wetness entirely
      if (currentLOD >= 2) {
        if (wetness.wetnessFactor > 0) {
          wetness.wetnessFactor = Math.max(
            0,
            wetness.wetnessFactor - wetness.evaporationRate * deltaTime,
          );
        }
        continue;
      }

      const entityX = transform.position[0];
      const entityY = transform.position[1];
      const entityZ = transform.position[2];

      let waterSurfaceY: number;

      if (currentLOD === 0) {
        // LOD 0: Full Gerstner wave evaluation for accurate wave-following wet line
        const gerstner = evaluateGerstnerHeight(
          entityX,
          entityZ,
          time,
          waveScale,
          wavelength,
        );
        waterSurfaceY = waterLevelWorld + gerstner.heightOffset;
      } else {
        // LOD 1: Flat base water level (no wave computation)
        waterSurfaceY = waterLevelWorld;
      }

      // --- AABB-based submersion depth ---
      const bounds = entity.getComponent<BoundsComponent>('bounds');
      const wb = bounds?.worldBounds;

      // If no bounds available, fall back to entity origin
      const boundsMinY = wb ? wb.min[1] : entityY;
      const boundsMaxY = wb ? wb.max[1] : entityY + 1;
      const objectHeight = Math.max(boundsMaxY - boundsMinY, 0.001);

      // Submersion depth: how much of the object (from base) is below water
      // Clamped to [0, objectHeight] — can't exceed the object's own height
      const submersionDepth = Math.min(
        Math.max(0, waterSurfaceY - boundsMinY),
        objectHeight,
      );

      // High water mark: ratchets up, slowly evaporates when not submerged
      wetness.highWaterMark = Math.max(wetness.highWaterMark, submersionDepth);

      if (submersionDepth < wetness.highWaterMark) {
        // Water has receded (or object lifted) — evaporate toward current submersion
        wetness.highWaterMark = Math.max(
          submersionDepth,
          wetness.highWaterMark - wetness.evaporationRate * deltaTime,
        );
      }

      // Convert to absolute world Y for shader
      wetness.waterLineY = boundsMinY + wetness.highWaterMark;

      // wetnessFactor: 1.0 while any wet area exists, 0 when fully dry
      wetness.wetnessFactor = wetness.highWaterMark > 0.001 ? 1.0 : 0.0;
    }
  }

  /**
   * Query the World for an ocean entity and extract water config from OceanManager.
   * Returns null if no ocean is present.
   */
  private getOceanConfig(): {
    waterLevelWorld: number;
    waveScale: number;
    wavelength: number;
  } | null {
    if (!this._world) return null;

    const oceanEntity = this._world.queryFirst('ocean');
    if (!oceanEntity) return null;

    const oceanComp = oceanEntity.getComponent<OceanComponent>('ocean');
    if (!oceanComp || !oceanComp.manager.isReady) return null;

    // Discover heightScale from terrain entity (same default as render pass: 50)
    const heightScale = this.getTerrainHeightScale();

    const config = oceanComp.getConfig();
    const waterLevelWorld = oceanComp.getWaterLevelWorld(heightScale);

    return {
      waterLevelWorld,
      waveScale: config.waveScale ?? 1,
      wavelength: config.wavelength ?? 20,
    };
  }

  /**
   * Query the World for a terrain entity and extract heightScale.
   * Falls back to 50 (same default as the render pass) if no terrain is present.
   */
  private getTerrainHeightScale(): number {
    if (!this._world) return 50;

    const terrainEntity = this._world.queryFirst('terrain');
    if (!terrainEntity) return 50;

    const terrainComp = terrainEntity.getComponent<TerrainComponent>('terrain');
    if (!terrainComp) return 50;

    const config = terrainComp.manager.getConfig();
    return config?.heightScale ?? 50;
  }
}
