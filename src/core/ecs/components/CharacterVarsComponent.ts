/**
 * CharacterVarsComponent — Runtime variables for animation transition conditions.
 *
 * Holds built-in derived variables (speed, grounded, velY, etc.) that are
 * automatically written by AnimationSystem each frame, plus custom variables
 * that Script Nodes can write to.
 *
 * Transition conditions in the animation state machine reference these
 * variables by name to determine when to switch states.
 *
 * Built-in variables:
 * - speed / horizontalSpeed: horizontal velocity magnitude
 * - velY: vertical velocity
 * - grounded: whether character is on ground
 * - airTime: seconds since last grounded
 * - currentStateTime: seconds in current animation state
 *
 * Custom variables can be set by Script Nodes or gameplay code.
 */

import { Component } from '../Component';
import type { ComponentType } from '../types';

export class CharacterVarsComponent extends Component {
  readonly type: ComponentType = 'character-vars';

  // ==================== Custom Variables ====================

  /** Float variables (e.g., 'stamina', 'health') */
  floats: Map<string, number> = new Map();

  /** Boolean variables (e.g., 'exhausted', 'isAttacking') */
  bools: Map<string, boolean> = new Map();

  // ==================== Built-in Derived Variables ====================
  // Written by AnimationSystem each frame from CharacterPhysicsComponent

  /** Horizontal speed magnitude (sqrt(vx² + vz²)) */
  speed = 0;

  /** Alias for speed */
  horizontalSpeed = 0;

  /** Vertical velocity */
  velY = 0;

  /** Whether character is on ground */
  grounded = false;

  /** Seconds since last grounded */
  airTime = 0;

  /** Seconds in current animation state */
  currentStateTime = 0;
}
