import { vec3 } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { ShadowComponent } from '../components/ShadowComponent';
import { VisibilityComponent } from '../components/VisibilityComponent';

/**
 * ShadowCasterSystem — collects entities that should cast shadows this frame.
 *
 * Priority 90: runs after logic systems, before MeshRenderSystem (100).
 *
 * Filters entities based on:
 * - ShadowComponent.castsShadow === true
 * - VisibilityComponent.visible !== false
 * - ShadowComponent.maxShadowDistance (distance from camera)
 *
 * The output list is consumed by the shadow render pass.
 */
export class ShadowCasterSystem extends System {
  readonly name = 'shadow-caster';
  readonly requiredComponents: readonly ComponentType[] = [
    'transform',
    'shadow',
  ];
  priority = 90;

  /** Entities that should cast shadows this frame */
  private _shadowCasters: Entity[] = [];

  /** Camera position — set externally by pipeline before world.update() */
  cameraPosition: [number, number, number] = [0, 0, 0];

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    this._shadowCasters = [];

    for (const entity of entities) {
      const shadow = entity.getComponent<ShadowComponent>('shadow');
      if (!shadow || !shadow.castsShadow) continue;

      // Skip invisible entities
      const visibility = entity.getComponent<VisibilityComponent>('visibility');
      if (visibility && !visibility.visible) continue;

      // Distance-based shadow culling
      if (shadow.maxShadowDistance !== Infinity) {
        const transform = entity.getComponent<TransformComponent>('transform');
        if (transform) {
          const dx = transform.position[0] - this.cameraPosition[0];
          const dy = transform.position[1] - this.cameraPosition[1];
          const dz = transform.position[2] - this.cameraPosition[2];
          const distSq = dx * dx + dy * dy + dz * dz;
          const maxDistSq = shadow.maxShadowDistance * shadow.maxShadowDistance;
          if (distSq > maxDistSq) continue;
        }
      }

      this._shadowCasters.push(entity);
    }
  }

  /**
   * Get entities that should cast shadows this frame.
   * Consumed by the shadow render pass.
   */
  getShadowCasters(): readonly Entity[] {
    return this._shadowCasters;
  }
}