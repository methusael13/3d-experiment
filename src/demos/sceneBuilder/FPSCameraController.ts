/**
 * FPSCameraController - First-person camera controller for terrain exploration
 * 
 * Features:
 * - Mouse look with pointer lock (no vertical inversion)
 * - WASD movement relative to camera direction
 * - Height sampling from terrain (always 1.8m above ground)
 * - Bounds clamping to terrain area
 * - Gimbal lock prevention via pitch clamping
 * 
 * Uses InputManager for ALL input - no direct DOM access.
 */

import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../../core/types';
import type { TerrainManager } from '../../core/terrain/TerrainManager';
import type { InputManager, InputEvent } from './InputManager';

// ==================== Constants ====================

const PLAYER_HEIGHT = 1.8; // Meters above terrain
const MOVE_SPEED = 5.0;    // Units per second
const SPRINT_MULTIPLIER = 2.0; // Sprint speed multiplier
const MOUSE_SENSITIVITY = 0.002;
const MAX_PITCH = Math.PI / 2 - 0.01; // ~89 degrees to prevent gimbal lock
const MIN_PITCH = -MAX_PITCH;

// ==================== Reversed-Z Perspective ====================

/**
 * Create a reversed-Z perspective projection matrix.
 * Reversed-Z maps near plane to depth 1 and far plane to depth 0,
 * which provides better depth precision for large scenes.
 * 
 * This matches the WebGPU terrain renderer which uses depthCompare: 'greater'.
 */
function perspectiveReversedZ(out: mat4, fovy: number, aspect: number, near: number, far: number): mat4 {
  const f = 1.0 / Math.tan(fovy / 2);
  
  // Clear matrix
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 0; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 0;
  
  // Build reversed-Z perspective matrix for WebGPU [0,1] depth range
  // Maps: z_view = -near → z_ndc = 1 (near plane)
  //       z_view = -far  → z_ndc = 0 (far plane)
  // Formula: z_ndc = (A * z_view + B) / (-z_view)
  // where A = near / (far - near), B = (near * far) / (far - near)
  out[0] = f / aspect;
  out[5] = f;
  out[10] = near / (far - near);           // Reversed-Z depth coefficient
  out[11] = -1;                             // W = -z_view (standard perspective divide)
  out[14] = (near * far) / (far - near);   // Reversed-Z depth offset
  
  return out;
}

// ==================== Types ====================

export interface FPSCameraState {
  position: Vec3;
  yaw: number;   // Rotation around Y axis (left/right)
  pitch: number; // Rotation around X axis (up/down)
}

export interface FPSCameraCallbacks {
  onExit?: () => void;
}

// ==================== FPSCameraController Class ====================

export class FPSCameraController {
  private position: Vec3 = [0, 0, 0];
  private yaw = 0;   // Horizontal rotation (radians)
  private pitch = 0; // Vertical rotation (radians)
  
  // Movement keys state
  private keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
  };
  
  // Cached matrices
  private viewMatrix = mat4.create();
  private projMatrix = mat4.create();
  private vpMatrix = mat4.create();
  
  // Terrain reference for height sampling and bounds
  private terrainManager: TerrainManager | null = null;
  private terrainBounds = {
    minX: 0, maxX: 0,
    minZ: 0, maxZ: 0,
  };
  
  // InputManager reference (owns pointer lock)
  private inputManager: InputManager | null = null;
  private isActive = false;
  
  // Callbacks
  private onExitCallback: (() => void) | null = null;
  
  // Bound handlers for cleanup
  private boundPointerMove: ((e: InputEvent) => void) | null = null;
  private boundPointerLockChange: ((e: InputEvent) => void) | null = null;
  private boundKeyDown: ((e: InputEvent<KeyboardEvent>) => void) | null = null;
  private boundKeyUp: ((e: InputEvent<KeyboardEvent>) => void) | null = null;
  
  constructor() {
    // Initialize projection matrix with typical FPS FOV (reversed-Z for WebGPU)
    perspectiveReversedZ(this.projMatrix, Math.PI / 3, 16/9, 0.1, 1000);
  }
  
  // ==================== Activation ====================
  
  /**
   * Activate FPS mode on a terrain managed by TerrainManager
   */
  activate(
    canvas: HTMLCanvasElement, // Only used for aspect ratio
    terrainManager: TerrainManager,
    inputManager: InputManager,
    callbacks: FPSCameraCallbacks = {}
  ): boolean {
    if (this.isActive) return false;
    
    // Verify terrain has CPU heightfield ready
    if (!terrainManager.hasCPUHeightfield()) {
      console.warn('[FPSCameraController] Terrain CPU heightfield not ready - cannot activate FPS mode');
      return false;
    }
    
    this.terrainManager = terrainManager;
    this.inputManager = inputManager;
    this.onExitCallback = callbacks.onExit || null;
    
    // Update projection for canvas aspect ratio (reversed-Z for WebGPU)
    const aspectRatio = canvas.width / canvas.height;
    perspectiveReversedZ(this.projMatrix, Math.PI / 3, aspectRatio, 0.1, 1000);
    
    // Get terrain bounds from TerrainManager (terrain centered at origin)
    const bounds = terrainManager.getWorldBounds();
    this.terrainBounds = bounds;
    
    // Teleport to terrain center (origin for GPU terrain)
    const startX = 0;
    const startZ = 0;
    const terrainHeight = this.sampleHeight(startX, startZ);
    const startY = terrainHeight + PLAYER_HEIGHT;
    
    this.position = [startX, startY, startZ];
    this.yaw = 0;
    this.pitch = 0;
    
    console.log(`[FPSCameraController] Spawning at (${startX.toFixed(1)}, ${startY.toFixed(1)}, ${startZ.toFixed(1)}), terrain height: ${terrainHeight.toFixed(1)}`);
    
    // Reset movement keys
    this.keys = { forward: false, backward: false, left: false, right: false, sprint: false };
    
    // Initialize view matrix immediately (before first update() call)
    this.updateMatrices();
    
    // Set up InputManager event subscriptions
    this.setupInputSubscriptions();
    
    // Request pointer lock via InputManager
    inputManager.requestPointerLock();
    
    this.isActive = true;
    return true;
  }
  
  /**
   * Deactivate FPS mode
   */
  deactivate(): void {
    if (!this.isActive) return;
    
    this.removeInputSubscriptions();
    
    // Exit pointer lock via InputManager
    this.inputManager?.exitPointerLock();
    
    this.isActive = false;
    this.terrainManager = null;
    this.inputManager = null;
  }
  
  // ==================== Input Subscriptions ====================
  
  private setupInputSubscriptions(): void {
    if (!this.inputManager) return;
    
    // Pointer-locked mouse movement
    this.boundPointerMove = (e: InputEvent) => this.handlePointerMove(e);
    this.inputManager.on('fps', 'pointermove', this.boundPointerMove);
    
    // Pointer lock state changes
    this.boundPointerLockChange = (e: InputEvent) => this.handlePointerLockChange(e);
    this.inputManager.on('fps', 'pointerlockchange', this.boundPointerLockChange);
    
    // Keyboard events
    this.boundKeyDown = (e: InputEvent<KeyboardEvent>) => this.handleKeyDown(e);
    this.boundKeyUp = (e: InputEvent<KeyboardEvent>) => this.handleKeyUp(e);
    this.inputManager.on('fps', 'keydown', this.boundKeyDown);
    this.inputManager.on('fps', 'keyup', this.boundKeyUp);
  }
  
  private removeInputSubscriptions(): void {
    if (!this.inputManager) return;
    
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
  
  // ==================== Event Handlers ====================
  
  private handlePointerMove(e: InputEvent): void {
    if (!this.isActive) return;
    
    // Update yaw (horizontal) and pitch (vertical)
    // No vertical inversion: positive movementY = look down
    this.yaw -= (e.movementX || 0) * MOUSE_SENSITIVITY;
    this.pitch -= (e.movementY || 0) * MOUSE_SENSITIVITY;
    
    // Clamp pitch to prevent gimbal lock
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
    
    // Normalize yaw to 0-2π range
    while (this.yaw < 0) this.yaw += Math.PI * 2;
    while (this.yaw >= Math.PI * 2) this.yaw -= Math.PI * 2;
  }
  
  private handlePointerLockChange(e: InputEvent): void {
    // If pointer lock was released externally, exit FPS mode
    if (this.isActive && e.locked === false) {
      this.exit();
    }
  }
  
  private handleKeyDown(e: InputEvent<KeyboardEvent>): void {
    if (!this.isActive) return;
    
    const key = e.key?.toLowerCase();
    
    switch (key) {
      case 'w':
        this.keys.forward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 's':
        this.keys.backward = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'a':
        this.keys.left = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'd':
        this.keys.right = true;
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();
        break;
      case 'shift':
        this.keys.sprint = true;
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
    if (!this.isActive) return;
    
    const key = e.key?.toLowerCase();
    
    switch (key) {
      case 'w':
        this.keys.forward = false;
        break;
      case 's':
        this.keys.backward = false;
        break;
      case 'a':
        this.keys.left = false;
        break;
      case 'd':
        this.keys.right = false;
        break;
      case 'shift':
        this.keys.sprint = false;
        break;
    }
  }
  
  // ==================== Update Loop ====================
  
  /**
   * Update camera position and matrices (call every frame)
   */
  update(deltaTime: number): void {
    if (!this.isActive) return;
    
    // Calculate movement direction based on yaw
    const forward: Vec3 = [
      Math.sin(this.yaw),
      0,
      Math.cos(this.yaw),
    ];
    
    // Right = forward × up (cross product)
    // forward = [sin(yaw), 0, cos(yaw)], up = [0, 1, 0]
    // right = [-cos(yaw), 0, sin(yaw)]
    const right: Vec3 = [
      -Math.cos(this.yaw),
      0,
      Math.sin(this.yaw),
    ];
    
    // Calculate movement delta
    let dx = 0;
    let dz = 0;
    
    if (this.keys.forward) {
      dx += forward[0];
      dz += forward[2];
    }
    if (this.keys.backward) {
      dx -= forward[0];
      dz -= forward[2];
    }
    if (this.keys.left) {
      dx -= right[0];
      dz -= right[2];
    }
    if (this.keys.right) {
      dx += right[0];
      dz += right[2];
    }
    
    // Normalize and apply speed
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 0) {
      const baseSpeed = MOVE_SPEED * deltaTime;
      const speed = this.keys.sprint ? baseSpeed * SPRINT_MULTIPLIER : baseSpeed;
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;
      
      // Apply movement
      let newX = this.position[0] + dx;
      let newZ = this.position[2] + dz;
      
      // Clamp to terrain bounds
      newX = Math.max(this.terrainBounds.minX, Math.min(this.terrainBounds.maxX, newX));
      newZ = Math.max(this.terrainBounds.minZ, Math.min(this.terrainBounds.maxZ, newZ));
      
      this.position[0] = newX;
      this.position[2] = newZ;
    }
    
    // Update height from terrain
    const terrainY = this.sampleHeight(this.position[0], this.position[2]);
    this.position[1] = terrainY + PLAYER_HEIGHT;
    
    // Update matrices
    this.updateMatrices();
  }
  
  // ==================== Height Sampling ====================
  
  /**
   * Sample terrain height at world XZ position
   * Delegates to TerrainManager's CPU heightfield sampling
   */
  private sampleHeight(worldX: number, worldZ: number): number {
    if (!this.terrainManager) return 0;
    return this.terrainManager.sampleHeightAt(worldX, worldZ);
  }
  
  // ==================== Matrix Computation ====================
  
  private updateMatrices(): void {
    // Calculate look direction from yaw and pitch
    const lookDir: Vec3 = [
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
    
    // Calculate target position
    const target: Vec3 = [
      this.position[0] + lookDir[0],
      this.position[1] + lookDir[1],
      this.position[2] + lookDir[2],
    ];
    
    // Create view matrix
    mat4.lookAt(
      this.viewMatrix,
      this.position as vec3,
      target as vec3,
      [0, 1, 0]
    );
    
    // Update VP matrix
    mat4.multiply(this.vpMatrix, this.projMatrix, this.viewMatrix);
  }
  
  // ==================== Public API ====================
  
  /**
   * Exit FPS mode
   */
  exit(): void {
    if (!this.isActive) return;
    
    this.deactivate();
    this.onExitCallback?.();
  }
  
  /**
   * Check if FPS mode is active
   */
  getIsActive(): boolean {
    return this.isActive;
  }
  
  /**
   * Get current camera state
   */
  getState(): FPSCameraState {
    return {
      position: [...this.position],
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
  
  /**
   * Get camera position
   */
  getPosition(): Vec3 {
    return [...this.position];
  }
  
  /**
   * Get view matrix
   */
  getViewMatrix(): mat4 {
    return this.viewMatrix;
  }
  
  /**
   * Get projection matrix
   */
  getProjectionMatrix(): mat4 {
    return this.projMatrix;
  }
  
  /**
   * Get combined view-projection matrix
   */
  getViewProjectionMatrix(): mat4 {
    return this.vpMatrix;
  }
  
  /**
   * Set aspect ratio for projection matrix (reversed-Z for WebGPU)
   */
  setAspectRatio(width: number, height: number): void {
    perspectiveReversedZ(this.projMatrix, Math.PI / 3, width / height, 0.1, 1000);
  }
  
  /**
   * Get near and far planes
   */
  get near(): number { return 0.1; }
  get far(): number { return 1000; }
}
