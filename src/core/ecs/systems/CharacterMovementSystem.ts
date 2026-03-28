/**
 * CharacterMovementSystem — Converts input direction into world-space movement.
 *
 * Reads PlayerComponent input state + CharacterPhysicsComponent, computes
 * camera-relative movement direction, applies speed, gravity, jump impulse,
 * friction/drag, and integrates position on TransformComponent.
 *
 * Supports two modes:
 * - FPS: Movement relative to player.yaw (existing behavior).
 * - TPS: Movement relative to CameraTargetComponent.orbitYaw with smooth
 *   character rotation to face movement direction.
 *
 * In TPS mode, the character mesh rotates independently of the camera —
 * the character faces where it's moving, not where the camera looks.
 * Analog stick values produce proportional speed (light tilt = slow walk,
 * full tilt = run speed). Keyboard produces binary 0/1.
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
import { CameraTargetComponent } from '../components/CameraTargetComponent';

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

      // Check for TPS mode via CameraTargetComponent
      const cameraTarget = entity.getComponent<CameraTargetComponent>('camera-target');
      const isTPS = cameraTarget?.mode === 'tps-orbit';

      if (isTPS) {
        this.updateTPS(entity, transform, player, physics, cameraTarget!, input, hasInput, deltaTime);
      } else {
        this.updateFPS(transform, player, physics, input, hasInput, deltaTime);
      }

      // Gravity — only when not grounded
      if (!physics.isGrounded) {
        physics.velocity[1] += physics.gravity * deltaTime;
      }

      // Jump — apply impulse if requested and grounded
      if (player.jumpRequested && physics.isGrounded) {
        physics.velocity[1] = player.jumpForce;
        physics.isGrounded = false;
        player.jumpRequested = false;
      }

      // Integrate position from velocity
      transform.position[0] += physics.velocity[0] * deltaTime;
      transform.position[1] += physics.velocity[1] * deltaTime;
      transform.position[2] += physics.velocity[2] * deltaTime;

      // Mark transform dirty so TransformSystem propagates to children
      transform.dirty = true;
    }
  }

  // ==================== FPS Mode ====================

  /**
   * FPS: movement relative to player.yaw, yaw/pitch written to transform rotation.
   * This is the original behavior — fully preserved.
   */
  private updateFPS(
    transform: TransformComponent,
    player: PlayerComponent,
    physics: CharacterPhysicsComponent,
    input: [number, number],
    hasInput: boolean,
    deltaTime: number,
  ): void {
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
      // Snap to zero below threshold to ensure clean stop
      const hSpeedSq = physics.velocity[0] ** 2 + physics.velocity[2] ** 2;
      if (hSpeedSq < 0.01 * 0.01) {
        physics.velocity[0] = 0;
        physics.velocity[2] = 0;
      }
    } else {
      // Air drag (slower deceleration when airborne)
      const drag = physics.airDrag * deltaTime;
      physics.velocity[0] *= Math.max(0, 1 - drag);
      physics.velocity[2] *= Math.max(0, 1 - drag);
    }

    // Write yaw/pitch to TransformComponent rotation (for FPS camera child entities)
    const yawQuat = quat.create();
    quat.setAxisAngle(yawQuat, [0, 1, 0], player.yaw);
    const pitchQuat = quat.create();
    quat.setAxisAngle(pitchQuat, [1, 0, 0], -player.pitch);
    quat.multiply(transform.rotationQuat, yawQuat, pitchQuat);
  }

  // ==================== TPS Mode ====================

  /**
   * TPS: movement relative to camera orbit yaw. Character mesh smoothly
   * rotates to face the movement direction. Analog input produces
   * proportional speed.
   */
  private updateTPS(
    _entity: Entity,
    transform: TransformComponent,
    player: PlayerComponent,
    physics: CharacterPhysicsComponent,
    cameraTarget: CameraTargetComponent,
    input: [number, number],
    hasInput: boolean,
    deltaTime: number,
  ): void {
    if (hasInput) {
      // Camera-relative movement: forward/right directions from orbit yaw
      const cameraYawRad = cameraTarget.orbitYaw * Math.PI / 180;
      const forwardX = Math.sin(cameraYawRad);
      const forwardZ = Math.cos(cameraYawRad);
      const rightX = -Math.cos(cameraYawRad);
      const rightZ = Math.sin(cameraYawRad);

      // input[0] = forward/back (analog), input[1] = right/left (analog)
      const moveX = input[0] * forwardX + input[1] * rightX;
      const moveZ = input[0] * forwardZ + input[1] * rightZ;

      // Normalize direction
      const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
      const normalizedX = len > 0 ? moveX / len : 0;
      const normalizedZ = len > 0 ? moveZ / len : 0;

      // Analog speed modulation: input magnitude determines speed blend
      // Light stick tilt → slow walk, full tilt → run (if sprinting) or walk speed
      const inputMagnitude = Math.sqrt(input[0] ** 2 + input[1] ** 2);
      const baseSpeed = player.isRunning ? player.runSpeed : player.moveSpeed;
      const speed = baseSpeed * Math.min(inputMagnitude, 1.0);

      physics.velocity[0] = normalizedX * speed;
      physics.velocity[2] = normalizedZ * speed;

      // Smoothly rotate character to face movement direction
      const targetYaw = Math.atan2(moveX, moveZ);
      let deltaYaw = targetYaw - player.yaw;

      // Shortest path rotation
      if (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      if (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;

      // Snap to target if very close (prevents micro-oscillation / jitter)
      if (Math.abs(deltaYaw) < 0.01) {
        player.yaw = targetYaw;
      } else {
        const maxRotation = (player.rotationSpeed * Math.PI / 180) * deltaTime;
        player.yaw += Math.max(-maxRotation, Math.min(maxRotation, deltaYaw));
      }

      // Normalize yaw
      while (player.yaw < 0) player.yaw += Math.PI * 2;
      while (player.yaw >= Math.PI * 2) player.yaw -= Math.PI * 2;
    } else if (physics.isGrounded) {
      // Decelerate via friction when grounded with no input
      const friction = physics.groundFriction * deltaTime;
      physics.velocity[0] *= Math.max(0, 1 - friction);
      physics.velocity[2] *= Math.max(0, 1 - friction);
      // Snap to zero below threshold to ensure clean stop (avoids asymptotic crawl)
      const hSpeedSq = physics.velocity[0] ** 2 + physics.velocity[2] ** 2;
      if (hSpeedSq < 0.01 * 0.01) { // < 0.01 units/s
        physics.velocity[0] = 0;
        physics.velocity[2] = 0;
      }
    } else {
      // Air drag
      const drag = physics.airDrag * deltaTime;
      physics.velocity[0] *= Math.max(0, 1 - drag);
      physics.velocity[2] *= Math.max(0, 1 - drag);
    }

    // Write character facing rotation to transform (yaw only, no pitch in TPS)
    const yawQuat = quat.create();
    quat.setAxisAngle(yawQuat, [0, 1, 0], player.yaw);
    quat.copy(transform.rotationQuat, yawQuat);
  }
}
