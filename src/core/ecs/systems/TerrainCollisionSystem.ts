/**
 * TerrainCollisionSystem — Samples terrain heightmap at character XZ position.
 *
 * Snaps the character to the ground when falling, sets isGrounded flag,
 * reads terrain normal for slope handling, and updates movement bounds.
 *
 * Priority: 25 (after CharacterMovementSystem at 20, before TransformSystem)
 *
 * Required components: ['transform', 'character-physics']
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { CharacterPhysicsComponent } from '../components/CharacterPhysicsComponent';
import { PlayerComponent } from '../components/PlayerComponent';
import { TerrainComponent } from '../components/TerrainComponent';

// Default grid bounds half-size when no terrain is present
const DEFAULT_BOUNDS_HALF = 100;

export class TerrainCollisionSystem extends System {
  readonly name = 'terrain-collision';
  readonly requiredComponents: readonly ComponentType[] = ['transform', 'character-physics'];
  priority = 25;

  update(entities: Entity[], _deltaTime: number, context: SystemContext): void {
    const world = context.world;

    // Find the terrain entity to sample heightmap
    const terrainEntity = world.queryFirst('terrain');

    let hasTerrain = false;
    let terrainManager: any = null;
    let hasCPUHeight = false;
    let boundsMinX = -DEFAULT_BOUNDS_HALF;
    let boundsMaxX = DEFAULT_BOUNDS_HALF;
    let boundsMinZ = -DEFAULT_BOUNDS_HALF;
    let boundsMaxZ = DEFAULT_BOUNDS_HALF;

    if (terrainEntity) {
      const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrain?.manager) {
        terrainManager = terrain.manager;
        hasTerrain = true;

        // Get bounds from terrain
        if (typeof terrainManager.getWorldBounds === 'function') {
          const wb = terrainManager.getWorldBounds();
          boundsMinX = wb.minX;
          boundsMaxX = wb.maxX;
          boundsMinZ = wb.minZ;
          boundsMaxZ = wb.maxZ;
        }

        hasCPUHeight = typeof terrainManager.hasCPUHeightfield === 'function'
          && terrainManager.hasCPUHeightfield();
      }
    }

    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (!transform || !physics) continue;

      // Sample terrain height at character's XZ position
      let groundHeight = 0;
      if (hasCPUHeight && terrainManager) {
        groundHeight = terrainManager.sampleHeightAt(
          transform.position[0],
          transform.position[2],
        );
      }

      // Sample terrain normal if available
      if (terrainManager && typeof terrainManager.sampleNormal === 'function') {
        const normal = terrainManager.sampleNormal(
          transform.position[0],
          transform.position[2],
        );
        if (normal) {
          physics.groundNormal = [normal[0], normal[1], normal[2]];
        }
      } else {
        physics.groundNormal = [0, 1, 0];
      }

      physics.groundHeight = groundHeight;

      // The effective ground position accounts for character height:
      // In FPS mode, Y represents the eye position (ground + playerHeight).
      // The physics component has its own height field.
      // We'll compute the foot position and compare against terrain.
      const footY = transform.position[1] - physics.height;

      // Ground snapping: if feet are at or below terrain, snap to ground
      if (footY <= groundHeight) {
        transform.position[1] = groundHeight + physics.height;
        physics.velocity[1] = 0;
        physics.isGrounded = true;
      } else {
        // Small tolerance for ground detection (prevents jitter)
        physics.isGrounded = (footY - groundHeight) < physics.groundThreshold;
      }

      // Clamp position to bounds
      transform.position[0] = Math.max(boundsMinX, Math.min(boundsMaxX, transform.position[0]));
      transform.position[2] = Math.max(boundsMinZ, Math.min(boundsMaxZ, transform.position[2]));

      // Update stored bounds on the PlayerComponent if present
      const player = entity.getComponent<PlayerComponent>('player');
      if (player) {
        player.boundsMinX = boundsMinX;
        player.boundsMaxX = boundsMaxX;
        player.boundsMinZ = boundsMinZ;
        player.boundsMaxZ = boundsMaxZ;
      }

      transform.dirty = true;
    }
  }
}