/**
 * CameraSystem — ECS system for computing camera view/projection matrices.
 *
 * Supports two modes:
 * - FPS: Reads TransformComponent position + PlayerComponent yaw/pitch to
 *   compute a first-person view matrix. (Original behavior, fully preserved.)
 * - TPS Orbit: Reads CameraTargetComponent orbit params, computes a
 *   smoothly-interpolated orbit camera with terrain collision and optional
 *   velocity-driven sway/bob.
 *
 * Mode is determined by the presence and mode of CameraTargetComponent.
 *
 * Priority: 30 (runs after PlayerSystem(5), CharacterMovementSystem(20),
 * and TerrainCollisionSystem(25) so the view matrix is computed from the
 * final post-movement, post-collision position each frame.)
 */

import { mat4 } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { CameraComponent } from '../components/CameraComponent';
import { PlayerComponent } from '../components/PlayerComponent';
import { TransformComponent } from '../components/TransformComponent';
import { CameraTargetComponent } from '../components/CameraTargetComponent';
import { CharacterPhysicsComponent } from '../components/CharacterPhysicsComponent';
import { TerrainComponent } from '../components/TerrainComponent';

export class CameraSystem extends System {
  readonly name = 'camera';
  readonly requiredComponents: readonly ComponentType[] = ['camera'];
  priority = 30;

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    for (const entity of entities) {
      const cam = entity.getComponent<CameraComponent>('camera');
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!cam || !transform) continue;

      const cameraTarget = entity.getComponent<CameraTargetComponent>('camera-target');

      if (cameraTarget?.mode === 'tps-orbit') {
        // TPS: orbit camera around character
        this.updateTPSOrbitCamera(entity, cam, transform, cameraTarget, deltaTime, context);
      } else {
        // FPS: existing behavior — yaw/pitch from PlayerComponent
        const player = entity.getComponent<PlayerComponent>('player');
        const yaw = player?.yaw ?? 0;
        const pitch = player?.pitch ?? 0;
        cam.updateMatrices(transform.position as [number, number, number], yaw, pitch);
      }
    }
  }

  // ==================== TPS Orbit Camera ====================

  /**
   * Compute TPS orbit camera:
   * 1. Target look-at point = character position + lookAtOffset
   * 2. Camera position = orbit sphere around look-at point
   * 3. Terrain collision: prevent camera going below terrain
   * 4. Camera sway: velocity-driven subtle displacement
   * 5. Smooth interpolation to target position/look-at
   * 6. Compute view/VP matrix
   */
  private updateTPSOrbitCamera(
    entity: Entity,
    cam: CameraComponent,
    transform: TransformComponent,
    ct: CameraTargetComponent,
    dt: number,
    context: SystemContext,
  ): void {
    // 1. Compute target look-at point (character position + offset)
    // The lookAtOffset is rotated by the camera orbit yaw so that horizontal
    // offsets (e.g., over-the-shoulder X shift) stay screen-relative regardless
    // of orbit angle. Y offset is always world-space (height above feet).
    const yawRad = (ct.orbitYaw + ct.initialYawOffset) * Math.PI / 180;
    const cosYaw = Math.cos(yawRad);
    const sinYaw = Math.sin(yawRad);

    // Rotate lookAtOffset X/Z by orbit yaw (Y stays as-is)
    const rotatedOffsetX = ct.lookAtOffset[0] * cosYaw + ct.lookAtOffset[2] * sinYaw;
    const rotatedOffsetZ = -ct.lookAtOffset[0] * sinYaw + ct.lookAtOffset[2] * cosYaw;

    const targetLookAt: [number, number, number] = [
      transform.position[0] + rotatedOffsetX,
      transform.position[1] + ct.lookAtOffset[1],
      transform.position[2] + rotatedOffsetZ,
    ];

    // 2. Compute target camera position (orbit around look-at)
    // Camera is BEHIND the character: when yaw=0, camera is at -Z looking toward +Z
    // (character faces +Z by default, camera orbits behind)
    const pitchRad = ct.orbitPitch * Math.PI / 180;

    const targetPos: [number, number, number] = [
      targetLookAt[0] - Math.sin(yawRad) * Math.cos(pitchRad) * ct.orbitDistance,
      targetLookAt[1] + Math.sin(pitchRad) * ct.orbitDistance,
      targetLookAt[2] - Math.cos(yawRad) * Math.cos(pitchRad) * ct.orbitDistance,
    ];

    // 3. Terrain collision: prevent camera below terrain
    if (ct.collisionEnabled) {
      const terrainEntity = context.world.queryFirst('terrain');
      if (terrainEntity) {
        const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
        if (terrain?.manager?.hasCPUHeightfield?.()) {
          const terrainHeight = terrain.manager.sampleHeightAt(targetPos[0], targetPos[2]);
          const minCamY = terrainHeight + ct.collisionRadius;
          if (targetPos[1] < minCamY) {
            targetPos[1] = minCamY;
          }
        }
      }
    }

    // 4. Camera sway (velocity-driven)
    if (ct.swayEnabled) {
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (physics) {
        const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
        const swayTime = performance.now() * 0.001;
        const swayX = Math.sin(swayTime * ct.swayFrequency * Math.PI * 2) * ct.swayAmplitude * hSpeed;
        const swayY = Math.abs(Math.sin(swayTime * ct.swayFrequency * Math.PI * 2 * 2)) * ct.bobIntensity * hSpeed;
        targetLookAt[0] += swayX;
        targetLookAt[1] += swayY;
      }
    }

    // 5. Smooth interpolation
    // Camera position is smoothed for a cinematic feel.
    // Look-at point snaps to the character to prevent horizontal micro-jitter
    // caused by the camera lagging behind character position by a fraction of a frame.
    if (!ct._initialized) {
      ct._currentPosition[0] = targetPos[0];
      ct._currentPosition[1] = targetPos[1];
      ct._currentPosition[2] = targetPos[2];
      ct._initialized = true;
    } else {
      const posLerp = 1 - Math.exp(-ct.positionSmoothSpeed * dt);
      ct._currentPosition[0] += (targetPos[0] - ct._currentPosition[0]) * posLerp;
      ct._currentPosition[1] += (targetPos[1] - ct._currentPosition[1]) * posLerp;
      ct._currentPosition[2] += (targetPos[2] - ct._currentPosition[2]) * posLerp;
    }

    // Look-at always snaps to target (no smoothing) — prevents character jitter
    ct._currentLookAt[0] = targetLookAt[0];
    ct._currentLookAt[1] = targetLookAt[1];
    ct._currentLookAt[2] = targetLookAt[2];

    // 6. Compute view matrix from smoothed position + lookAt
    mat4.lookAt(cam.viewMatrix, ct._currentPosition, ct._currentLookAt, [0, 1, 0]);
    mat4.multiply(cam.vpMatrix, cam.projMatrix, cam.viewMatrix);
  }
}
