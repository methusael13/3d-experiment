/**
 * FPSCameraSystem — ECS system for first-person camera exploration.
 *
 * Reads input from InputManager, moves the camera with WASD,
 * samples terrain height (or falls back to Y=0 ground plane),
 * and updates the FPSCameraComponent matrices each frame.
 *
 * Priority: 5 (runs early, before other systems)
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { FPSCameraComponent } from '../components/FPSCameraComponent';
import { TerrainComponent } from '../components/TerrainComponent';
import type { InputManager, InputEvent } from '../../../demos/sceneBuilder/InputManager';

// Default grid bounds half-size (matches FPSCameraComponent default)
const DEFAULT_BOUNDS_HALF = 100;

export class FPSCameraSystem extends System {
  readonly name = 'fps-camera';
  readonly requiredComponents: readonly ComponentType[] = ['fps-camera'];
  priority = 5;

  private inputManager: InputManager;

  // Bound handlers for cleanup
  private boundPointerMove: ((e: InputEvent) => void) | null = null;
  private boundPointerLockChange: ((e: InputEvent) => void) | null = null;
  private boundKeyDown: ((e: InputEvent<KeyboardEvent>) => void) | null = null;
  private boundKeyUp: ((e: InputEvent<KeyboardEvent>) => void) | null = null;

  // Callbacks
  private onExitCallback: (() => void) | null = null;

  // Track the FPS camera component for input handlers
  private activeCam: FPSCameraComponent | null = null;

  constructor(inputManager: InputManager, onExit?: () => void) {
    super();
    this.inputManager = inputManager;
    this.onExitCallback = onExit ?? null;
  }

  // ==================== Lifecycle ====================

  initialize?(): void {
    this.setupInputSubscriptions();
  }

  destroy(): void {
    this.removeInputSubscriptions();
    this.activeCam = null;
  }

  // ==================== Input Subscriptions ====================

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

  // ==================== Input Handlers ====================

  private handlePointerMove(e: InputEvent): void {
    const cam = this.activeCam;
    if (!cam || !cam.active) return;

    cam.yaw -= (e.movementX || 0) * cam.mouseSensitivity;
    cam.pitch -= (e.movementY || 0) * cam.mouseSensitivity;

    // Clamp pitch
    cam.pitch = Math.max(cam.minPitch, Math.min(cam.maxPitch, cam.pitch));

    // Normalize yaw
    while (cam.yaw < 0) cam.yaw += Math.PI * 2;
    while (cam.yaw >= Math.PI * 2) cam.yaw -= Math.PI * 2;
  }

  private handlePointerLockChange(e: InputEvent): void {
    const cam = this.activeCam;
    if (!cam || !cam.active) return;

    // If pointer lock was released externally, exit FPS mode
    if (e.locked === false) {
      this.exit();
    }
  }

  private handleKeyDown(e: InputEvent<KeyboardEvent>): void {
    const cam = this.activeCam;
    if (!cam || !cam.active) return;

    const key = e.key?.toLowerCase();
    switch (key) {
      case 'w':
        cam.forward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 's':
        cam.backward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'a':
        cam.left = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'd':
        cam.right = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'shift':
        cam.sprint = true;
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
    const cam = this.activeCam;
    if (!cam || !cam.active) return;

    const key = e.key?.toLowerCase();
    switch (key) {
      case 'w': cam.forward = false; break;
      case 's': cam.backward = false; break;
      case 'a': cam.left = false; break;
      case 'd': cam.right = false; break;
      case 'shift': cam.sprint = false; break;
    }
  }

  // ==================== Exit ====================

  /**
   * Exit FPS mode — deactivates camera and calls exit callback.
   */
  exit(): void {
    if (this.activeCam) {
      this.activeCam.active = false;
      this.activeCam.resetKeys();
    }
    this.inputManager.exitPointerLock();
    this.onExitCallback?.();
  }

  // ==================== Spawn ====================

  /**
   * Position the camera at spawn point based on terrain or ground plane.
   * Called once on first update when needsSpawn is true.
   */
  private spawnCamera(cam: FPSCameraComponent, context: SystemContext): void {
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
          groundHeight = manager.sampleHeightAt(cam.position[0], cam.position[2]);
        }
      }
    }

    // Set initial bounds
    cam.boundsMinX = boundsMinX;
    cam.boundsMaxX = boundsMaxX;
    cam.boundsMinZ = boundsMinZ;
    cam.boundsMaxZ = boundsMaxZ;

    // Clamp spawn XZ to bounds
    cam.position[0] = Math.max(boundsMinX, Math.min(boundsMaxX, cam.position[0]));
    cam.position[2] = Math.max(boundsMinZ, Math.min(boundsMaxZ, cam.position[2]));

    // Set Y from ground + player height
    cam.position[1] = groundHeight + cam.playerHeight;

    // Reset orientation
    cam.yaw = 0;
    cam.pitch = 0;

    // Compute initial matrices
    cam.updateMatrices();

    console.log(`[FPSCameraSystem] Spawned at (${cam.position[0].toFixed(1)}, ${cam.position[1].toFixed(1)}, ${cam.position[2].toFixed(1)}), ground: ${groundHeight.toFixed(1)}`);
  }

  // ==================== Update ====================

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    for (const entity of entities) {
      const cam = entity.getComponent<FPSCameraComponent>('fps-camera');
      if (!cam || !cam.active) continue;

      // Cache active cam for input handlers
      this.activeCam = cam;

      // 0. Handle initial spawn: query terrain/ground and set starting position
      if (cam.needsSpawn) {
        this.spawnCamera(cam, context);
        cam.needsSpawn = false;
      }

      // 1. Compute movement direction from yaw
      const forwardX = Math.sin(cam.yaw);
      const forwardZ = Math.cos(cam.yaw);
      const rightX = -Math.cos(cam.yaw);
      const rightZ = Math.sin(cam.yaw);

      let dx = 0;
      let dz = 0;

      if (cam.forward) { dx += forwardX; dz += forwardZ; }
      if (cam.backward) { dx -= forwardX; dz -= forwardZ; }
      if (cam.left) { dx -= rightX; dz -= rightZ; }
      if (cam.right) { dx += rightX; dz += rightZ; }

      // Normalize and apply speed
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0) {
        const baseSpeed = cam.moveSpeed * deltaTime;
        const speed = cam.sprint ? baseSpeed * cam.sprintMultiplier : baseSpeed;
        dx = (dx / len) * speed;
        dz = (dz / len) * speed;

        cam.position[0] += dx;
        cam.position[2] += dz;
      }

      // 2. Query terrain for height and bounds, or fallback to ground plane
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

          // Get bounds from terrain
          if (typeof manager.getWorldBounds === 'function') {
            const wb = manager.getWorldBounds();
            boundsMinX = wb.minX;
            boundsMaxX = wb.maxX;
            boundsMinZ = wb.minZ;
            boundsMaxZ = wb.maxZ;
          }

          // Sample height from terrain
          if (typeof manager.hasCPUHeightfield === 'function' && manager.hasCPUHeightfield()) {
            groundHeight = manager.sampleHeightAt(cam.position[0], cam.position[2]);
          }
        }
      }

      // 3. Clamp position to bounds
      cam.position[0] = Math.max(boundsMinX, Math.min(boundsMaxX, cam.position[0]));
      cam.position[2] = Math.max(boundsMinZ, Math.min(boundsMaxZ, cam.position[2]));

      // Update stored bounds for reference
      cam.boundsMinX = boundsMinX;
      cam.boundsMaxX = boundsMaxX;
      cam.boundsMinZ = boundsMinZ;
      cam.boundsMaxZ = boundsMaxZ;

      // 4. Set Y from ground height + player height
      cam.position[1] = groundHeight + cam.playerHeight;

      // 5. Update matrices
      cam.updateMatrices();
    }
  }
}