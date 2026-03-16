/**
 * CameraSystem — ECS system for computing camera view/projection matrices.
 *
 * Reads TransformComponent position and PlayerComponent yaw/pitch (if present)
 * to compute view/projection/VP matrices on CameraComponent.
 *
 * If no PlayerComponent is present on the entity, the camera could derive
 * orientation from TransformComponent rotation (future: orbit cam, cutscene cam).
 *
 * Priority: 30 (runs after PlayerSystem(5), CharacterMovementSystem(20),
 * and TerrainCollisionSystem(25) so the view matrix is computed from the
 * final post-movement, post-collision position each frame.  Running before
 * movement/collision caused the view matrix to embed a stale eye position
 * while the adapter's getPosition() returned the updated one, leading to
 * inconsistent inverseViewProj ↔ cameraPosition in the cloud ray marcher
 * and radial cloud-stretching artifacts during camera translation.)
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
  priority = 30;

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