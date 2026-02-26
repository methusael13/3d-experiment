import { mat4, quat } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { World } from '../World';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { BoundsComponent } from '../components/BoundsComponent';
import type { AABB } from '../../sceneObjects/types';

/**
 * TransformSystem — recomputes model matrices for entities with dirty transforms.
 *
 * Priority 0 (runs first): all other systems depend on up-to-date transforms.
 *
 * Logic mirrors SceneObject.getModelMatrix():
 * - Translate by position
 * - Rotate by quaternion
 * - Scale
 * - Apply origin pivot offset if BoundsComponent is present
 */
export class TransformSystem extends System {
  readonly name = 'transform';
  readonly requiredComponents: readonly ComponentType[] = ['transform'];
  priority = 0;

  /** Reference to World for sceneGraph updates. Set by World during update. */
  world: World | null = null;

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!transform || !transform.dirty) continue;

      const m = transform.modelMatrix;
      mat4.identity(m);

      // Translate
      mat4.translate(m, m, transform.position);

      // Rotate via quaternion
      const rotMat = mat4.create();
      mat4.fromQuat(rotMat, transform.rotationQuat);
      mat4.multiply(m, m, rotMat);

      // Scale
      mat4.scale(m, m, transform.scale);

      // Apply origin pivot offset (same logic as SceneObject.getModelMatrix)
      if (transform.originPivot !== 'center') {
        const bounds = entity.getComponent<BoundsComponent>('bounds');
        if (bounds?.localBounds) {
          let yOffset = 0;
          if (transform.originPivot === 'bottom') {
            yOffset = -bounds.localBounds.min[1];
          } else if (transform.originPivot === 'top') {
            yOffset = -bounds.localBounds.max[1];
          }
          mat4.translate(m, m, [0, yOffset, 0]);
        }
      }

      transform.dirty = false;

      // Mark transform as updated this frame for MeshRenderSystem to pick up
      transform._updatedThisFrame = true;

      // Mark bounds as dirty if present (BoundsSystem will recompute worldBounds + sync sceneGraph)
      const boundsComp = entity.getComponent<BoundsComponent>('bounds');
      if (boundsComp) {
        boundsComp.dirty = true;
      }
    }
  }
}