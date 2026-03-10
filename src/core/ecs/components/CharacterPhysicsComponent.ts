import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * CharacterPhysicsComponent — Simple character physics state.
 *
 * Holds velocity, gravity, ground detection, and collision shape.
 * Not a full rigid body — just enough for terrain-walking gameplay.
 *
 * Processed by CharacterMovementSystem (applies velocity/gravity/jump)
 * and TerrainCollisionSystem (ground snapping + ground detection).
 */
export class CharacterPhysicsComponent extends Component {
  readonly type: ComponentType = 'character-physics';

  // ==================== Velocity ====================

  /** World-space velocity [x, y, z] in units/second */
  velocity: [number, number, number] = [0, 0, 0];

  // ==================== Gravity ====================

  /** Downward acceleration in units/s² (negative = down) */
  gravity = -20.0;

  // ==================== Ground State ====================

  /** True when character is on (or very near) the terrain surface */
  isGrounded = false;

  /** Terrain height at the character's current XZ position */
  groundHeight = 0;

  /** Terrain surface normal at the character's XZ position */
  groundNormal: [number, number, number] = [0, 1, 0];

  /**
   * Small distance threshold for ground detection (prevents jitter).
   * Character is considered grounded if Y - groundHeight < this value.
   */
  groundThreshold = 0.05;

  // ==================== Collision Shape (capsule approximation) ====================

  /** Horizontal collision radius */
  radius = 0.3;

  /** Character height (feet to head) */
  height = 1.8;

  // ==================== Damping ====================

  /** Deceleration multiplier when no input and on ground */
  groundFriction = 10.0;

  /** Horizontal deceleration multiplier when in air */
  airDrag = 0.5;

  constructor(options?: {
    gravity?: number;
    radius?: number;
    height?: number;
    groundFriction?: number;
    airDrag?: number;
    groundThreshold?: number;
  }) {
    super();
    if (options) {
      if (options.gravity !== undefined) this.gravity = options.gravity;
      if (options.radius !== undefined) this.radius = options.radius;
      if (options.height !== undefined) this.height = options.height;
      if (options.groundFriction !== undefined) this.groundFriction = options.groundFriction;
      if (options.airDrag !== undefined) this.airDrag = options.airDrag;
      if (options.groundThreshold !== undefined) this.groundThreshold = options.groundThreshold;
    }
  }

  /**
   * Reset velocity to zero (useful on respawn or mode change).
   */
  resetVelocity(): void {
    this.velocity[0] = 0;
    this.velocity[1] = 0;
    this.velocity[2] = 0;
  }
}