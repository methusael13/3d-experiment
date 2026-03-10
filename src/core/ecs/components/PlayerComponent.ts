import { Component } from '../Component';
import type { ComponentType } from '../types';

// ==================== Constants ====================

const DEFAULT_PLAYER_HEIGHT = 1.8;
const DEFAULT_MOVE_SPEED = 5.0;
const DEFAULT_RUN_SPEED = 10.0;
const DEFAULT_SPRINT_MULTIPLIER = 2.0;
const DEFAULT_MOUSE_SENSITIVITY = 0.002;
const DEFAULT_JUMP_FORCE = 8.0;
const DEFAULT_ROTATION_SPEED = 720;
const MAX_PITCH = Math.PI / 2 - 0.01;
const MIN_PITCH = -MAX_PITCH;

// Default grid bounds when no terrain is present
const DEFAULT_BOUNDS_HALF = 100;

/**
 * PlayerComponent — Player controller state.
 *
 * Holds movement config, orientation (yaw/pitch), structured input state, and bounds.
 * Position lives on TransformComponent (single source of truth).
 * Physics state lives on CharacterPhysicsComponent (velocity, gravity, grounding).
 *
 * Processed by PlayerSystem (input reading) and CharacterMovementSystem (movement).
 *
 * A player can exist without a camera (NPC).
 * A camera can exist without a player (orbit cam, cutscene cam).
 */
export class PlayerComponent extends Component {
  readonly type: ComponentType = 'player';

  // ==================== Orientation ====================

  yaw = 0;   // Horizontal rotation (radians)
  pitch = 0; // Vertical rotation (radians)

  // ==================== Movement Parameters ====================

  playerHeight = DEFAULT_PLAYER_HEIGHT;
  moveSpeed = DEFAULT_MOVE_SPEED;
  runSpeed = DEFAULT_RUN_SPEED;
  sprintMultiplier = DEFAULT_SPRINT_MULTIPLIER;
  mouseSensitivity = DEFAULT_MOUSE_SENSITIVITY;

  /** Upward impulse on jump (units/second) */
  jumpForce = DEFAULT_JUMP_FORCE;

  /** Character turn speed (degrees/second) — used for 3rd-person smooth rotation */
  rotationSpeed = DEFAULT_ROTATION_SPEED;

  // Pitch limits (gimbal lock prevention)
  maxPitch = MAX_PITCH;
  minPitch = MIN_PITCH;

  // ==================== Structured Input State ====================
  // Written by PlayerSystem from InputManager events.
  // These provide a normalized, processed representation of user intention.

  /**
   * Normalized movement direction [forward/back, left/right].
   * Range: -1 to 1 per axis, normalized for diagonal movement.
   * Written by PlayerSystem each frame from WASD key state.
   */
  inputDirection: [number, number] = [0, 0];

  /** Whether the player is requesting sprint (Shift held) */
  isRunning = false;

  /** Whether a jump was requested this frame (Space pressed) */
  jumpRequested = false;

  // ==================== Legacy Movement Key State ====================
  // Still written by PlayerSystem for backward compat.
  // inputDirection is derived from these each frame.

  forward = false;
  backward = false;
  left = false;
  right = false;
  sprint = false;

  // ==================== Bounds ====================
  // Updated by TerrainCollisionSystem based on terrain or default grid

  boundsMinX = -DEFAULT_BOUNDS_HALF;
  boundsMaxX = DEFAULT_BOUNDS_HALF;
  boundsMinZ = -DEFAULT_BOUNDS_HALF;
  boundsMaxZ = DEFAULT_BOUNDS_HALF;

  // ==================== Activation State ====================

  /** Whether the player controller is currently active */
  active = false;

  /** Whether the player needs initial spawn positioning (set Y from terrain/ground) */
  needsSpawn = true;

  constructor(options?: {
    playerHeight?: number;
    moveSpeed?: number;
    runSpeed?: number;
    sprintMultiplier?: number;
    mouseSensitivity?: number;
    jumpForce?: number;
    rotationSpeed?: number;
  }) {
    super();
    if (options) {
      if (options.playerHeight !== undefined) this.playerHeight = options.playerHeight;
      if (options.moveSpeed !== undefined) this.moveSpeed = options.moveSpeed;
      if (options.runSpeed !== undefined) this.runSpeed = options.runSpeed;
      if (options.sprintMultiplier !== undefined) this.sprintMultiplier = options.sprintMultiplier;
      if (options.mouseSensitivity !== undefined) this.mouseSensitivity = options.mouseSensitivity;
      if (options.jumpForce !== undefined) this.jumpForce = options.jumpForce;
      if (options.rotationSpeed !== undefined) this.rotationSpeed = options.rotationSpeed;
    }
  }

  /**
   * Reset all input state (useful on deactivation to prevent stuck keys).
   */
  resetKeys(): void {
    this.forward = false;
    this.backward = false;
    this.left = false;
    this.right = false;
    this.sprint = false;
    this.isRunning = false;
    this.jumpRequested = false;
    this.inputDirection[0] = 0;
    this.inputDirection[1] = 0;
  }
}