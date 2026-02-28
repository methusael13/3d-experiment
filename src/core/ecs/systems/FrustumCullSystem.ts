/**
 * FrustumCullSystem — CPU-side frustum culling using the BVH scene graph.
 *
 * Each frame, extracts a frustum from the scene camera's VP matrix and queries
 * the BVH for visible entity AABBs. Populates a FrustumCullComponent with the
 * set of visible entity IDs. The VariantRenderer checks this set to skip
 * entities outside the frustum.
 *
 * Priority: 85 (after BoundsSystem updates worldBounds, before MeshRenderSystem/ShadowCasterSystem)
 *
 * The VP matrix is set externally by the Viewport each frame via `setViewProjectionMatrix()`.
 * This should be the scene camera VP (editor orbit or FPS cam) — NOT the debug camera.
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { FrustumCullComponent } from '../components/FrustumCullComponent';

export class FrustumCullSystem extends System {
  readonly name = 'frustum-cull';
  readonly requiredComponents: readonly ComponentType[] = ['frustum-cull'];
  priority = 85;

  /** Scene camera VP matrix, set by Viewport each frame before world.update(). */
  private vpMatrix: Float32Array | null = null;

  /**
   * Set the view-projection matrix for frustum extraction.
   * Call this each frame with the scene camera's VP matrix (not debug camera).
   */
  setViewProjectionMatrix(vp: Float32Array): void {
    this.vpMatrix = vp;
  }

  update(entities: Entity[], _deltaTime: number, context: SystemContext): void {
    // There should be exactly one entity with FrustumCullComponent
    for (const entity of entities) {
      const cull = entity.getComponent<FrustumCullComponent>('frustum-cull');
      if (!cull) continue;

      cull.visibleEntityIds.clear();

      if (!cull.enabled || !this.vpMatrix) {
        // Culling disabled or no VP matrix — mark all as visible (no culling)
        cull.culledCount = 0;
        cull.visibleCount = 0;
        cull.totalTested = 0;
        return;
      }

      // BVH-accelerated frustum query via World's scene graph
      const world = context.world;
      const visibleEntities = world.queryFrustum(this.vpMatrix);

      for (const e of visibleEntities) {
        cull.visibleEntityIds.add(e.id);
      }

      // Stats
      cull.visibleCount = cull.visibleEntityIds.size;
      cull.totalTested = world.entityCount;
      cull.culledCount = cull.totalTested - cull.visibleCount;
    }
  }
}