/**
 * PlayerSystem — ECS system for player input reading and play mode management.
 *
 * Reads action-based input from ActionInputManager and writes structured
 * input to PlayerComponent (inputDirection, isRunning, jumpRequested, yaw/pitch).
 * Does NOT directly modify position or apply physics — that's handled by
 * CharacterMovementSystem and TerrainCollisionSystem.
 *
 * Supports two modes:
 * - FPS: Pointer-locked mouse controls yaw/pitch directly on PlayerComponent.
 * - TPS: Merged camera axes (mouse + right stick) write to CameraTargetComponent
 *   orbit yaw/pitch. Character rotates independently based on movement direction.
 *
 * Also manages play mode enter/exit (pointer lock, activation state).
 *
 * If no CharacterPhysicsComponent is present on the entity, this system
 * falls back to the legacy inline movement behavior for backward compatibility.
 *
 * Priority: 5 (runs first — input must be read before movement/physics)
 */

import { quat } from 'gl-matrix';
import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { PlayerComponent } from '../components/PlayerComponent';
import { TransformComponent } from '../components/TransformComponent';
import { CharacterPhysicsComponent } from '../components/CharacterPhysicsComponent';
import { CameraTargetComponent } from '../components/CameraTargetComponent';
import { TerrainComponent } from '../components/TerrainComponent';
import type { InputManager, InputEvent } from '../../../demos/sceneBuilder/InputManager';
import type { ActionInputManager } from '../../input/ActionInputManager';
import { World } from '../World';

// Default grid bounds half-size (matches PlayerComponent default)
const DEFAULT_BOUNDS_HALF = 100;

export class PlayerSystem extends System {
  readonly name = 'player';
  readonly requiredComponents: readonly ComponentType[] = ['player'];
  priority = 5;

  private inputManager: InputManager;

  /** Action-based input manager (optional — if not set, falls back to legacy input) */
  private actionInput: ActionInputManager | null = null;

  // Bound handlers for cleanup (legacy FPS input)
  private boundPointerMove: ((e: InputEvent) => void) | null = null;
  private boundPointerLockChange: ((e: InputEvent) => void) | null = null;
  private boundKeyDown: ((e: InputEvent<KeyboardEvent>) => void) | null = null;
  private boundKeyUp: ((e: InputEvent<KeyboardEvent>) => void) | null = null;

  // Callbacks
  private onExitCallback: (() => void) | null = null;

  // Track the active player component and entity for input handlers
  private activePlayer: PlayerComponent | null = null;
  private activeEntity: Entity | null = null;

  /** Whether play mode is active (pointer locked, processing input) */
  private playing = false;

  constructor(inputManager: InputManager) {
    super();
    this.inputManager = inputManager;
  }

  /**
   * Set the action-based input manager. When set, the system uses
   * ActionInputManager for play mode input instead of raw key handlers.
   */
  setActionInputManager(actionInput: ActionInputManager): void {
    this.actionInput = actionInput;
  }

  // ==================== Lifecycle ====================

  initialize?(): void {
    this.setupInputSubscriptions();
  }

  destroy(): void {
    this.removeInputSubscriptions();
    this.activePlayer = null;
  }

  // ==================== Input Subscriptions (Legacy FPS) ====================

  private setupInputSubscriptions(): void {
    this.boundPointerMove = (e: InputEvent) => this.handlePointerMove(e);
    this.inputManager.on('fps', 'pointermove', this.boundPointerMove);

    this.boundPointerLockChange = (e: InputEvent) => this.handlePointerLockChange(e);
    this.inputManager.on('fps', 'pointerlockchange', this.boundPointerLockChange);

    this.boundKeyDown = (e: InputEvent<KeyboardEvent>) => this.handleKeyDown(e);
    this.boundKeyUp = (e: InputEvent<KeyboardEvent>) => this.handleKeyUp(e);
    this.inputManager.on('fps', 'keydown', this.boundKeyDown);
    this.inputManager.on('fps', 'keyup', this.boundKeyUp);
  }

  private removeInputSubscriptions(): void {
    if (this.boundPointerMove) {
      this.inputManager.off('fps', 'pointermove', this.boundPointerMove);
    }
    if (this.boundPointerLockChange) {
      this.inputManager.off('fps', 'pointerlockchange', this.boundPointerLockChange);
    }
    if (this.boundKeyDown) {
      this.inputManager.off('fps', 'keydown', this.boundKeyDown);
    }
    if (this.boundKeyUp) {
      this.inputManager.off('fps', 'keyup', this.boundKeyUp);
    }

    this.boundPointerMove = null;
    this.boundPointerLockChange = null;
    this.boundKeyDown = null;
    this.boundKeyUp = null;
  }

  // ==================== Legacy FPS Input Handlers ====================

  private handlePointerMove(e: InputEvent): void {
    const player = this.activePlayer;
    if (!player || !player.active) return;

    // When ActionInputManager is active, it handles camera axes via getCameraAxes().
    // Skip legacy pointer move to avoid double-processing / writing to wrong target.
    if (this.actionInput) return;

    const mx = e.movementX || 0;
    const my = e.movementY || 0;

    // Check for TPS orbit mode — write to CameraTargetComponent instead of player yaw/pitch
    if (this.activeEntity) {
      const ct = this.activeEntity.getComponent<CameraTargetComponent>('camera-target');
      if (ct?.mode === 'tps-orbit') {
        ct.orbitYaw -= mx * ct.yawSensitivity;
        ct.orbitPitch += my * ct.pitchSensitivity;
        ct.orbitPitch = Math.max(ct.minPitch, Math.min(ct.maxPitch, ct.orbitPitch));
        return;
      }
    }

    // FPS mode: write to player yaw/pitch directly
    player.yaw -= mx * player.mouseSensitivity;
    player.pitch -= my * player.mouseSensitivity;

    // Clamp pitch
    player.pitch = Math.max(player.minPitch, Math.min(player.maxPitch, player.pitch));

    // Normalize yaw
    while (player.yaw < 0) player.yaw += Math.PI * 2;
    while (player.yaw >= Math.PI * 2) player.yaw -= Math.PI * 2;
  }

  private handlePointerLockChange(e: InputEvent): void {
    const player = this.activePlayer;
    if (!player || !player.active) return;

    // If pointer lock was released externally, exit play mode
    if (e.locked === false) {
      this.exit();
    }
  }

  private handleKeyDown(e: InputEvent<KeyboardEvent>): void {
    const player = this.activePlayer;
    if (!player || !player.active) return;

    const key = e.key?.toLowerCase();
    switch (key) {
      case 'w':
        player.forward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 's':
        player.backward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'a':
        player.left = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'd':
        player.right = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'shift':
        player.sprint = true;
        e.originalEvent.stopPropagation();
        break;
      case ' ':
        player.jumpRequested = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'escape':
        this.exit();
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
    }
  }

  private handleKeyUp(e: InputEvent<KeyboardEvent>): void {
    const player = this.activePlayer;
    if (!player || !player.active) return;

    const key = e.key?.toLowerCase();
    switch (key) {
      case 'w': player.forward = false; break;
      case 's': player.backward = false; break;
      case 'a': player.left = false; break;
      case 'd': player.right = false; break;
      case 'shift': player.sprint = false; break;
    }
  }

  // ==================== Enter / Exit Play Mode ====================

  /**
   * Set the callback invoked when play mode exits (e.g., to update UI signals).
   */
  setOnExitCallback(cb: (() => void) | null): void {
    this.onExitCallback = cb;
  }

  /**
   * Enter play mode — find the active PlayerComponent in the world,
   * lock the pointer (FPS) or hide cursor (TPS), and start processing input.
   * Returns true if an active player was found, false otherwise (no-op).
   */
  enter(world: World): boolean {
    // Find an entity with an active player component
    const entities = world.query('player');
    let targetPlayer: PlayerComponent | null = null;
    let targetEntity: Entity | null = null;
    for (const entity of entities) {
      const player = entity.getComponent<PlayerComponent>('player');
      if (player?.active) {
        targetPlayer = player;
        targetEntity = entity;
        break;
      }
    }

    if (!targetPlayer || !targetEntity) {
      console.warn('[PlayerSystem] No active Player component found in the world');
      return false;
    }

    this.activePlayer = targetPlayer;
    this.activeEntity = targetEntity;
    this.playing = true;

    // Flush any stale input state accumulated while in editor mode (scroll deltas,
    // mouse movement, key states). Without this, the first play-mode frame would
    // apply all scroll events from editor zooming to the TPS orbit distance.
    this.actionInput?.resetAll();
    // Also flush the raw scroll/mouse deltas from the KeyboardMouseProvider
    const kbm = this.actionInput?.getKeyboardMouseProvider();
    if (kbm) {
      kbm.readScrollDelta();   // Consume and discard stale scroll
      kbm.readCameraAxis();    // Consume and discard stale mouse deltas
    }

    // Both FPS and TPS modes use pointer lock for mouse movement deltas.
    // Pointer lock is required because movementX/movementY are only available
    // when the pointer is locked. In TPS mode the orbit camera reads these deltas.
    this.inputManager.requestPointerLock();

    const cameraTarget = targetEntity.getComponent<CameraTargetComponent>('camera-target');
    const modeLabel = cameraTarget?.mode === 'tps-orbit' ? 'TPS orbit' : 'FPS';
    console.log(`[PlayerSystem] Entered play mode (${modeLabel})`);

    return true;
  }

  /**
   * Exit play mode — release pointer lock, stop processing input.
   * Does NOT remove the entity or deactivate the component — the component
   * persists in the world for re-entry.
   */
  exit(): void {
    if (this.activePlayer) {
      this.activePlayer.resetKeys();
    }
    this.activePlayer = null;
    this.playing = false;
    this.inputManager.exitPointerLock();
    this.actionInput?.resetAll();
    this.onExitCallback?.();
    console.log('[PlayerSystem] Exited play mode');
  }

  /** Whether the system is currently in play mode */
  get isPlaying(): boolean {
    return this.playing;
  }

  // ==================== Spawn ====================

  /**
   * Position the player at spawn point based on terrain or ground plane.
   * Called once on first update when needsSpawn is true.
   * Writes position to TransformComponent (single source of truth).
   */
  private spawnPlayer(player: PlayerComponent, transform: TransformComponent, context: SystemContext): void {
    const world = context.world;
    const terrainEntity = world.queryFirst('terrain');

    let groundHeight = 0;
    let boundsMinX = -DEFAULT_BOUNDS_HALF;
    let boundsMaxX = DEFAULT_BOUNDS_HALF;
    let boundsMinZ = -DEFAULT_BOUNDS_HALF;
    let boundsMaxZ = DEFAULT_BOUNDS_HALF;

    if (terrainEntity) {
      const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrain?.manager) {
        const manager = terrain.manager;

        if (typeof manager.getWorldBounds === 'function') {
          const wb = manager.getWorldBounds();
          boundsMinX = wb.minX;
          boundsMaxX = wb.maxX;
          boundsMinZ = wb.minZ;
          boundsMaxZ = wb.maxZ;
        }

        if (typeof manager.hasCPUHeightfield === 'function' && manager.hasCPUHeightfield()) {
          groundHeight = manager.sampleHeightAt(transform.position[0], transform.position[2]);
        }
      }
    }

    // Set initial bounds
    player.boundsMinX = boundsMinX;
    player.boundsMaxX = boundsMaxX;
    player.boundsMinZ = boundsMinZ;
    player.boundsMaxZ = boundsMaxZ;

    // Clamp spawn XZ to bounds
    transform.position[0] = Math.max(boundsMinX, Math.min(boundsMaxX, transform.position[0]));
    transform.position[2] = Math.max(boundsMinZ, Math.min(boundsMaxZ, transform.position[2]));

    // Set Y from ground + player height
    transform.position[1] = groundHeight + player.playerHeight;

    // Reset orientation
    player.yaw = 0;
    player.pitch = 0;

    // Mark transform dirty so TransformSystem propagates to children
    transform.dirty = true;

    console.log(`[PlayerSystem] Spawned at (${transform.position[0].toFixed(1)}, ${transform.position[1].toFixed(1)}, ${transform.position[2].toFixed(1)}), ground: ${groundHeight.toFixed(1)}`);
  }

  // ==================== Update ====================

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    if (!this.playing) return;

    // Poll action input if available
    if (this.actionInput) {
      this.actionInput.pollAll();
    }

    for (const entity of entities) {
      const player = entity.getComponent<PlayerComponent>('player');
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!player || !player.active || !transform) continue;

      // Cache active player for input handlers
      this.activePlayer = player;

      // 0. Handle initial spawn: query terrain/ground and set starting position
      if (player.needsSpawn) {
        this.spawnPlayer(player, transform, context);
        player.needsSpawn = false;
      }

      // Check for CameraTargetComponent to determine input mode
      const cameraTarget = entity.getComponent<CameraTargetComponent>('camera-target');

      if (this.actionInput && cameraTarget) {
        // Action-Based Input (TPS or FPS with ActionInputManager)
        this.processActionInput(entity, player, cameraTarget);
      } else {
        // Legacy Input (FPS pointer-locked)
        this.processLegacyInput(player);
      }

      // 2. Check for Escape key (works in both modes)
      if (this.actionInput?.isKeyDown('Escape')) {
        this.exit();
        return;
      }

      // 3. Check if CharacterPhysicsComponent is present
      //    If yes, CharacterMovementSystem + TerrainCollisionSystem handle movement.
      //    If no, fall back to legacy inline movement for backward compatibility.
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (!physics) {
        this.legacyMovement(player, transform, deltaTime, context);
      }
    }
  }

  // ==================== Action-Based Input Processing ====================

  /**
   * Process input from ActionInputManager. Supports both FPS and TPS modes.
   */
  private processActionInput(
    entity: Entity,
    player: PlayerComponent,
    cameraTarget: CameraTargetComponent,
  ): void {
    const ai = this.actionInput!;

    // Read movement actions (analog-aware)
    const forward = ai.getAction('forward');
    const backward = ai.getAction('backward');
    const left = ai.getAction('left');
    const right = ai.getAction('right');
    const jump = ai.getAction('jump');
    const sprint = ai.getAction('sprint');

    // Compute input direction (analog for sticks, binary for keyboard)
    player.inputDirection[0] = forward.value - backward.value;
    player.inputDirection[1] = right.value - left.value;

    // Normalize diagonal
    const len = Math.sqrt(
      player.inputDirection[0] ** 2 + player.inputDirection[1] ** 2,
    );
    if (len > 1) {
      player.inputDirection[0] /= len;
      player.inputDirection[1] /= len;
    }

    // Sprint + jump
    player.isRunning = sprint.active;
    player.jumpRequested = jump.justPressed;

    // Update runtime variables for auto-deactivation conditions
    const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (physics) {
      const speed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
      ai.setRuntimeVar('speed', speed);
    }

    // Camera control — differs by mode
    if (cameraTarget.mode === 'tps-orbit') {
      // TPS: camera axes control orbit yaw/pitch
      const camAxes = ai.getCameraAxes();
      cameraTarget.orbitYaw -= camAxes.deltaX * cameraTarget.yawSensitivity;
      cameraTarget.orbitPitch += camAxes.deltaY * cameraTarget.pitchSensitivity;

      // Clamp pitch
      cameraTarget.orbitPitch = Math.max(
        cameraTarget.minPitch,
        Math.min(cameraTarget.maxPitch, cameraTarget.orbitPitch),
      );

      // Scroll wheel → zoom
      const scroll = ai.getScrollDelta();
      if (scroll !== 0) {
        cameraTarget.orbitDistance -= scroll * cameraTarget.zoomSensitivity * 0.01;
        cameraTarget.orbitDistance = Math.max(
          cameraTarget.minDistance,
          Math.min(cameraTarget.maxDistance, cameraTarget.orbitDistance),
        );
      }
    } else {
      // FPS: camera axes control player yaw/pitch directly
      const camAxes = ai.getCameraAxes();
      player.yaw -= camAxes.deltaX * player.mouseSensitivity;
      player.pitch -= camAxes.deltaY * player.mouseSensitivity;

      // Clamp
      player.pitch = Math.max(player.minPitch, Math.min(player.maxPitch, player.pitch));
      while (player.yaw < 0) player.yaw += Math.PI * 2;
      while (player.yaw >= Math.PI * 2) player.yaw -= Math.PI * 2;
    }

    // Sync legacy key booleans for backward compat
    player.forward = forward.active;
    player.backward = backward.active;
    player.left = left.active;
    player.right = right.active;
    player.sprint = sprint.active;
  }

  // ==================== Legacy Input Processing ====================

  /**
   * Process legacy key-based input (FPS mode without ActionInputManager).
   */
  private processLegacyInput(player: PlayerComponent): void {
    let forward = 0;
    let right = 0;
    if (player.forward) forward += 1;
    if (player.backward) forward -= 1;
    if (player.left) right -= 1;
    if (player.right) right += 1;

    // Normalize diagonal movement
    const len = Math.sqrt(forward * forward + right * right);
    if (len > 0) {
      player.inputDirection[0] = forward / len;
      player.inputDirection[1] = right / len;
    } else {
      player.inputDirection[0] = 0;
      player.inputDirection[1] = 0;
    }

    // Sync sprint → isRunning
    player.isRunning = player.sprint;
  }

  // ==================== Legacy Movement (no CharacterPhysicsComponent) ====================

  /**
   * Original inline movement logic for entities without CharacterPhysicsComponent.
   * Preserves full backward compatibility with the pre-refactor behavior.
   */
  private legacyMovement(
    player: PlayerComponent,
    transform: TransformComponent,
    deltaTime: number,
    context: SystemContext,
  ): void {
    // Compute movement direction from yaw
    const forwardX = Math.sin(player.yaw);
    const forwardZ = Math.cos(player.yaw);
    const rightX = -Math.cos(player.yaw);
    const rightZ = Math.sin(player.yaw);

    let dx = 0;
    let dz = 0;

    if (player.forward) { dx += forwardX; dz += forwardZ; }
    if (player.backward) { dx -= forwardX; dz -= forwardZ; }
    if (player.left) { dx -= rightX; dz -= rightZ; }
    if (player.right) { dx += rightX; dz += rightZ; }

    // Normalize and apply speed
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0) {
      const baseSpeed = player.moveSpeed * deltaTime;
      const speed = player.sprint ? baseSpeed * player.sprintMultiplier : baseSpeed;
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;

      transform.position[0] += dx;
      transform.position[2] += dz;
    }

    // Query terrain for height and bounds, or fallback to ground plane
    let groundHeight = 0;
    let boundsMinX = -DEFAULT_BOUNDS_HALF;
    let boundsMaxX = DEFAULT_BOUNDS_HALF;
    let boundsMinZ = -DEFAULT_BOUNDS_HALF;
    let boundsMaxZ = DEFAULT_BOUNDS_HALF;

    const world = context.world;
    const terrainEntity = world.queryFirst('terrain');
    if (terrainEntity) {
      const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrain?.manager) {
        const manager = terrain.manager;

        if (typeof manager.getWorldBounds === 'function') {
          const wb = manager.getWorldBounds();
          boundsMinX = wb.minX;
          boundsMaxX = wb.maxX;
          boundsMinZ = wb.minZ;
          boundsMaxZ = wb.maxZ;
        }

        if (typeof manager.hasCPUHeightfield === 'function' && manager.hasCPUHeightfield()) {
          groundHeight = manager.sampleHeightAt(transform.position[0], transform.position[2]);
        }
      }
    }

    // Clamp position to bounds
    transform.position[0] = Math.max(boundsMinX, Math.min(boundsMaxX, transform.position[0]));
    transform.position[2] = Math.max(boundsMinZ, Math.min(boundsMaxZ, transform.position[2]));

    // Update stored bounds
    player.boundsMinX = boundsMinX;
    player.boundsMaxX = boundsMaxX;
    player.boundsMinZ = boundsMinZ;
    player.boundsMaxZ = boundsMaxZ;

    // Set Y from ground height + player height
    transform.position[1] = groundHeight + player.playerHeight;

    // Write yaw/pitch to TransformComponent rotation
    const yawQuat = quat.create();
    quat.setAxisAngle(yawQuat, [0, 1, 0], player.yaw);
    const pitchQuat = quat.create();
    quat.setAxisAngle(pitchQuat, [1, 0, 0], -player.pitch);
    quat.multiply(transform.rotationQuat, yawQuat, pitchQuat);

    // Mark transform dirty
    transform.dirty = true;
  }
}
