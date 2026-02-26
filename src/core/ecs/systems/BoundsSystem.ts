import { mat4, vec3 } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { World } from '../World';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { BoundsComponent } from '../components/BoundsComponent';
import type { AABB } from '../../sceneObjects/types';

/**
 * BoundsSystem — recomputes world-space AABBs when transform or bounds are dirty.
 *
 * Priority 10 (runs after TransformSystem).
 *
 * Only processes dirty entities. After computing worldBounds, syncs to the
 * World's sceneGraph (single source of truth). Tracks aggregate scene AABB
 * and fires `onSceneBoundsChanged` callback when it changes significantly.
 *
 * Performance: skips unchanged entities entirely. SceneGraph sync and aggregate
 * recomputation only happen when at least one entity's bounds changed.
 */
export class BoundsSystem extends System {
  readonly name = 'bounds';
  readonly requiredComponents: readonly ComponentType[] = [
    'transform',
    'bounds',
  ];
  priority = 10;

  /** Callback fired when the aggregate scene AABB changes */
  onSceneBoundsChanged: ((sceneBounds: AABB) => void) | null = null;

  /** Reference to World for sceneGraph sync. Set from Viewport constructor. */
  world: World | null = null;

  /** Previous frame's aggregate radius (for change detection) */
  private prevSceneRadius: number = 0;

  /** Whether any entity's bounds changed — gates aggregate recomputation */
  private anyBoundsChangedThisFrame: boolean = false;

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    this.anyBoundsChangedThisFrame = false;

    for (const entity of entities) {
      const bounds = entity.getComponent<BoundsComponent>('bounds');
      if (!bounds) continue;

      // Only process dirty bounds (transform changed, or localBounds/worldBounds set externally)
      if (!bounds.dirty) continue;

      const transform = entity.getComponent<TransformComponent>('transform');
      if (transform && bounds.localBounds) {
        bounds.worldBounds = transformAABB(
          bounds.localBounds,
          transform.modelMatrix,
        );
      }
      // If worldBounds was set directly (terrain/ocean), it's already there
      bounds.dirty = false;

      // Sync changed worldBounds to sceneGraph
      if (bounds.worldBounds && this.world) {
        this.world.setSceneGraphWorldBounds(entity.id, bounds.worldBounds);
      }

      this.anyBoundsChangedThisFrame = true;
    }

    // Only recompute aggregate and fire callback when something actually changed
    if (this.anyBoundsChangedThisFrame && this.onSceneBoundsChanged) {
      this.recomputeAggregate(entities);
    }
  }

  /**
   * Recompute aggregate scene AABB from all entities and fire callback if changed.
   */
  private recomputeAggregate(entities: Entity[]): void {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasAnyBounds = false;

    for (const entity of entities) {
      const bounds = entity.getComponent<BoundsComponent>('bounds');
      if (!bounds?.worldBounds) continue;

      const wb = bounds.worldBounds;
      if (wb.min[0] < minX) minX = wb.min[0];
      if (wb.min[1] < minY) minY = wb.min[1];
      if (wb.min[2] < minZ) minZ = wb.min[2];
      if (wb.max[0] > maxX) maxX = wb.max[0];
      if (wb.max[1] > maxY) maxY = wb.max[1];
      if (wb.max[2] > maxZ) maxZ = wb.max[2];
      hasAnyBounds = true;
    }

    if (!hasAnyBounds) return;

    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const radius = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) / 2;

    // Only fire if radius changed significantly (>1% or >0.5 units)
    const delta = Math.abs(radius - this.prevSceneRadius);
    if (delta > Math.max(0.5, this.prevSceneRadius * 0.01)) {
      this.prevSceneRadius = radius;
      this.onSceneBoundsChanged!({
        min: [minX, minY, minZ] as any,
        max: [maxX, maxY, maxZ] as any,
      });
    }
  }
}

/**
 * Transform a local-space AABB into world-space by applying a model matrix
 * to all 8 corners and computing a new axis-aligned enclosure.
 */
function transformAABB(local: AABB, modelMatrix: mat4): AABB {
  const { min, max } = local;

  const corners: [number, number, number][] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];

  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;

  const m = modelMatrix;

  for (const [cx, cy, cz] of corners) {
    const w = m[3] * cx + m[7] * cy + m[11] * cz + m[15];
    const tx = (m[0] * cx + m[4] * cy + m[8] * cz + m[12]) / w;
    const ty = (m[1] * cx + m[5] * cy + m[9] * cz + m[13]) / w;
    const tz = (m[2] * cx + m[6] * cy + m[10] * cz + m[14]) / w;

    if (tx < mnX) mnX = tx;
    if (ty < mnY) mnY = ty;
    if (tz < mnZ) mnZ = tz;
    if (tx > mxX) mxX = tx;
    if (ty > mxY) mxY = ty;
    if (tz > mxZ) mxZ = tz;
  }

  return {
    min: new Float32Array([mnX, mnY, mnZ]) as unknown as vec3,
    max: new Float32Array([mxX, mxY, mxZ]) as unknown as vec3,
  };
}