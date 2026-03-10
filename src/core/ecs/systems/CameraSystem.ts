/**
 * CameraSystem — ECS system for computing camera view/projection matrices.
 *
 * Reads TransformComponent position and PlayerComponent yaw/pitch (if present)
 * to compute view/projection/VP matrices on CameraComponent.
 *
 * If no PlayerComponent is present on the entity, the camera could derive
 * orientation from TransformComponent rotation (future: orbit cam, cutscene cam).
 *
 * Priority: 6 (runs after PlayerSystem at priority 5, before other systems)
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { CameraComponent } from '../components/CameraComponent';
import { PlayerComponent } from '../components/PlayerComponent';
import { TransformComponent } from '../components/TransformComponent';

export class CameraSystem extends System {
  readonly name = 'camera';
  readonly requiredComponents: readonly ComponentType[] = ['camera'];
  priority = 6;

  // ==================== Update ====================

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    for (const entity of entities) {
      const cam = entity.getComponent<CameraComponent>('camera');
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!cam || !transform) continue;

      // Get yaw/pitch from PlayerComponent if present, otherwise default to 0
      const player = entity.getComponent<PlayerComponent>('player');
      const yaw = player?.yaw ?? 0;
      const pitch = player?.pitch ?? 0;

      // Update view/VP matrices from position + orientation
      cam.updateMatrices(transform.position as [number, number, number], yaw, pitch);
    }
  }
}