import { mat4, quat } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { World } from '../World';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { BoundsComponent } from '../components/BoundsComponent';
import type { AABB } from '../../sceneObjects/types';

/**
 * TransformSystem — recomputes local and world matrices for entities with dirty transforms.
 *
 * Priority 0 (runs first): all other systems depend on up-to-date transforms.
 *
 * Hierarchy-aware: processes entities in topological order (parents before children)
 * so that a child's world matrix = parent.worldMatrix × child.localMatrix.
 *
 * For root entities (no parent), localMatrix === modelMatrix (world matrix).
 */
export class TransformSystem extends System {
  readonly name = 'transform';
  readonly requiredComponents: readonly ComponentType[] = ['transform'];
  priority = 0;

  /** Reference to World for sceneGraph updates. Set by World during update. */
  world: World | null = null;

  update(_entities: Entity[], _deltaTime: number, context: SystemContext): void {
    const world = context.world;

    // Process ALL entities in hierarchy order (parents before children).
    // Option A: always process full hierarchy each frame for simplicity.
    const ordered = world.getHierarchyOrder();

    for (const entity of ordered) {
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!transform) continue;

      // Propagate dirty from parent to child: if a parent was dirty/updated,
      // the child's world matrix will change too even if its local TRS didn't.
      if (!transform.dirty && entity.parentId !== null) {
        const parent = world.getParent(entity.id);
        if (parent) {
          const parentTransform = parent.getComponent<TransformComponent>('transform');
          if (parentTransform && parentTransform._updatedThisFrame) {
            transform.dirty = true;
          }
        }
      }

      if (!transform.dirty) continue;

      // Recompute local matrix from TRS
      this._computeLocalMatrix(entity, transform);

      // Compute world matrix
      if (entity.parentId !== null) {
        const parent = world.getParent(entity.id);
        if (parent) {
          const parentTransform = parent.getComponent<TransformComponent>('transform');
          if (parentTransform) {
            // worldMatrix = parentWorldMatrix × localMatrix
            mat4.multiply(transform.modelMatrix, parentTransform.modelMatrix, transform.localMatrix);
          } else {
            // Parent has no transform — local = world
            mat4.copy(transform.modelMatrix, transform.localMatrix);
          }
        } else {
          mat4.copy(transform.modelMatrix, transform.localMatrix);
        }
      } else {
        // Root entity: world = local
        mat4.copy(transform.modelMatrix, transform.localMatrix);
      }

      // Mark transform as updated this frame for MeshRenderSystem to pick up
      transform._updatedThisFrame = true;
      transform.dirty = false;

      // Mark bounds as dirty if present (BoundsSystem will recompute worldBounds + sync sceneGraph)
      const boundsComp = entity.getComponent<BoundsComponent>('bounds');
      if (boundsComp) {
        boundsComp.dirty = true;
      }
    }
  }

  /**
   * Compute the local matrix from position/rotation/scale + origin pivot.
   * This is the TRS matrix in local space.
   */
  private _computeLocalMatrix(entity: Entity, transform: TransformComponent): void {
    const m = transform.localMatrix;
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
  }
}