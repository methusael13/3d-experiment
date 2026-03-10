/**
 * CharacterMovementSystem — Converts input direction into world-space movement.
 *
 * Reads PlayerComponent input state + CharacterPhysicsComponent, computes
 * camera-relative movement direction, applies speed, gravity, jump impulse,
 * friction/drag, and integrates position on TransformComponent.
 *
 * Priority: 20 (after PlayerSystem/InputSystem at 5, before TerrainCollisionSystem at 25)
 *
 * Required components: ['transform', 'player', 'character-physics']
 */

import { quat } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { PlayerComponent } from '../components/PlayerComponent';
import { CharacterPhysicsComponent } from '../components/CharacterPhysicsComponent';

export class CharacterMovementSystem extends System {
  readonly name = 'character-movement';
  readonly requiredComponents: readonly ComponentType[] = ['transform', 'player', 'character-physics'];
  priority = 20;

  update(entities: Entity[], deltaTime: number, _context: SystemContext): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const player = entity.getComponent<PlayerComponent>('player');
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (!transform || !player || !physics || !player.active) continue;

      const input = player.inputDirection;
      const hasInput = input[0] !== 0 || input[1] !== 0;

      // 1. Compute world-space movement direction from yaw + input
      //    In FPS mode, movement is relative to the player's yaw orientation.
      //    inputDirection[0] = forward/back, inputDirection[1] = left/right
      if (hasInput) {
        const forwardX = Math.sin(player.yaw);
        const forwardZ = Math.cos(player.yaw);
        const rightX = -Math.cos(player.yaw);
        const rightZ = Math.sin(player.yaw);

        const moveX = input[0] * forwardX + input[1] * rightX;
        const moveZ = input[0] * forwardZ + input[1] * rightZ;

        // Normalize
        const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
        const normalizedX = len > 0 ? moveX / len : 0;
        const normalizedZ = len > 0 ? moveZ / len : 0;

        // Apply speed — use runSpeed when sprinting, else moveSpeed
        const speed = player.isRunning ? player.runSpeed : player.moveSpeed;
        physics.velocity[0] = normalizedX * speed;
        physics.velocity[2] = normalizedZ * speed;
      } else if (physics.isGrounded) {
        // Decelerate via friction when grounded with no input
        const friction = physics.groundFriction * deltaTime;
        physics.velocity[0] *= Math.max(0, 1 - friction);
        physics.velocity[2] *= Math.max(0, 1 - friction);
      } else {
        // Air drag (slower deceleration when airborne)
        const drag = physics.airDrag * deltaTime;
        physics.velocity[0] *= Math.max(0, 1 - drag);
        physics.velocity[2] *= Math.max(0, 1 - drag);
      }

      // 2. Gravity — only when not grounded
      if (!physics.isGrounded) {
        physics.velocity[1] += physics.gravity * deltaTime;
      }

      // 3. Jump — apply impulse if requested and grounded
      if (player.jumpRequested && physics.isGrounded) {
        physics.velocity[1] = player.jumpForce;
        physics.isGrounded = false;
        player.jumpRequested = false;
      }

      // 4. Integrate position from velocity
      transform.position[0] += physics.velocity[0] * deltaTime;
      transform.position[1] += physics.velocity[1] * deltaTime;
      transform.position[2] += physics.velocity[2] * deltaTime;

      // 5. Write yaw/pitch to TransformComponent rotation so children inherit orientation
      //    (Same as the original PlayerSystem — for FPS camera child entities)
      const yawQuat = quat.create();
      quat.setAxisAngle(yawQuat, [0, 1, 0], player.yaw);
      const pitchQuat = quat.create();
      quat.setAxisAngle(pitchQuat, [1, 0, 0], -player.pitch);
      quat.multiply(transform.rotationQuat, yawQuat, pitchQuat);

      // 6. Mark transform dirty so TransformSystem propagates to children
      transform.dirty = true;
    }
  }
}