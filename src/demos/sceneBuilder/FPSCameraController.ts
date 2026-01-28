/**
 * FPSCameraController - First-person camera controller for terrain exploration
 * 
 * Features:
 * - Mouse look with pointer lock (no vertical inversion)
 * - WASD movement relative to camera direction
 * - Height sampling from terrain (always 1.8m above ground)
 * - Bounds clamping to terrain area
 * - Gimbal lock prevention via pitch clamping
 */

import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../../core/types';
import type { TerrainObject } from '../../core/sceneObjects';

// ==================== Constants ====================

const PLAYER_HEIGHT = 1.8; // Meters above terrain
const MOVE_SPEED = 5.0;    // Units per second
const MOUSE_SENSITIVITY = 0.002;
const MAX_PITCH = Math.PI / 2 - 0.01; // ~89 degrees to prevent gimbal lock
const MIN_PITCH = -MAX_PITCH;

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
  };
  
  // Cached matrices
  private viewMatrix = mat4.create();
  private projMatrix = mat4.create();
  private vpMatrix = mat4.create();
  
  // Terrain reference for height sampling and bounds
  private terrain: TerrainObject | null = null;
  private terrainBounds = {
    minX: 0, maxX: 0,
    minZ: 0, maxZ: 0,
  };
  
  // Canvas reference for pointer lock
  private canvas: HTMLCanvasElement | null = null;
  private isActive = false;
  
  // Callbacks
  private onExitCallback: (() => void) | null = null;
  
  // Event handler references for cleanup
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private boundPointerLockChange: (() => void) | null = null;
  
  constructor() {
    // Initialize projection matrix with typical FPS FOV
    mat4.perspective(this.projMatrix, Math.PI / 3, 16/9, 0.1, 1000);
  }
  
  // ==================== Activation ====================
  
  /**
   * Activate FPS mode on a terrain
   */
  activate(
    canvas: HTMLCanvasElement,
    terrain: TerrainObject,
    callbacks: FPSCameraCallbacks = {}
  ): boolean {
    if (this.isActive) return false;
    
    this.canvas = canvas;
    this.terrain = terrain;
    this.onExitCallback = callbacks.onExit || null;
    
    // Calculate terrain bounds
    const params = terrain.params;
    const halfSize = params.worldSize / 2;
    const modelMatrix = terrain.getWorldMatrix?.() || mat4.create();
    const centerX = modelMatrix[12];
    const centerZ = modelMatrix[14];
    
    this.terrainBounds = {
      minX: centerX - halfSize,
      maxX: centerX + halfSize,
      minZ: centerZ - halfSize,
      maxZ: centerZ + halfSize,
    };
    
    // Teleport to terrain center
    const startX = centerX;
    const startZ = centerZ;
    const startY = this.sampleHeight(startX, startZ) + PLAYER_HEIGHT;
    
    this.position = [startX, startY, startZ];
    this.yaw = 0;
    this.pitch = 0;
    
    // Reset movement keys
    this.keys = { forward: false, backward: false, left: false, right: false };
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Request pointer lock
    canvas.requestPointerLock();
    
    this.isActive = true;
    return true;
  }
  
  /**
   * Deactivate FPS mode
   */
  deactivate(): void {
    if (!this.isActive) return;
    
    this.removeEventListeners();
    
    // Exit pointer lock
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
    
    this.isActive = false;
    this.terrain = null;
    this.canvas = null;
  }
  
  // ==================== Event Handling ====================
  
  private setupEventListeners(): void {
    this.boundMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
    this.boundKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
    this.boundKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
    this.boundPointerLockChange = () => this.handlePointerLockChange();
    
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    document.addEventListener('pointerlockchange', this.boundPointerLockChange);
  }
  
  private removeEventListeners(): void {
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundKeyDown) {
      document.removeEventListener('keydown', this.boundKeyDown);
    }
    if (this.boundKeyUp) {
      document.removeEventListener('keyup', this.boundKeyUp);
    }
    if (this.boundPointerLockChange) {
      document.removeEventListener('pointerlockchange', this.boundPointerLockChange);
    }
    
    this.boundMouseMove = null;
    this.boundKeyDown = null;
    this.boundKeyUp = null;
    this.boundPointerLockChange = null;
  }
  
  private handleMouseMove(e: MouseEvent): void {
    if (!this.isActive) return;
    if (document.pointerLockElement !== this.canvas) return;
    
    // Update yaw (horizontal) and pitch (vertical)
    // No vertical inversion: positive movementY = look down
    this.yaw -= e.movementX * MOUSE_SENSITIVITY;
    this.pitch -= e.movementY * MOUSE_SENSITIVITY;
    
    // Clamp pitch to prevent gimbal lock
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch));
    
    // Normalize yaw to 0-2π range
    while (this.yaw < 0) this.yaw += Math.PI * 2;
    while (this.yaw >= Math.PI * 2) this.yaw -= Math.PI * 2;
  }
  
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isActive) return;
    
    // Prevent default for movement keys
    const key = e.key.toLowerCase();
    
    switch (key) {
      case 'w':
        this.keys.forward = true;
        e.preventDefault();
        break;
      case 's':
        this.keys.backward = true;
        e.preventDefault();
        break;
      case 'a':
        this.keys.left = true;
        e.preventDefault();
        break;
      case 'd':
        this.keys.right = true;
        e.preventDefault();
        break;
      case 'escape':
        this.exit();
        e.preventDefault();
        break;
    }
  }
  
  private handleKeyUp(e: KeyboardEvent): void {
    if (!this.isActive) return;
    
    const key = e.key.toLowerCase();
    
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
    }
  }
  
  private handlePointerLockChange(): void {
    // If pointer lock was released externally (e.g., clicking outside), exit FPS mode
    if (this.isActive && document.pointerLockElement !== this.canvas) {
      this.exit();
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
    
    const right: Vec3 = [
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw),
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
      const speed = MOVE_SPEED * deltaTime;
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
   */
  private sampleHeight(worldX: number, worldZ: number): number {
    if (!this.terrain) return 0;
    
    // Use terrain's CPU-side heightfield if available
    const heightfield = this.terrain.getHeightfield?.();
    if (!heightfield) return 0;
    
    const params = this.terrain.params;
    const modelMatrix = this.terrain.getWorldMatrix?.() || mat4.create();
    const terrainCenterX = modelMatrix[12];
    const terrainCenterZ = modelMatrix[14];
    
    // Convert world position to terrain-local UV coordinates
    const halfSize = params.worldSize / 2;
    const localX = worldX - (terrainCenterX - halfSize);
    const localZ = worldZ - (terrainCenterZ - halfSize);
    
    const u = localX / params.worldSize;
    const v = localZ / params.worldSize;
    
    // Clamp UV to valid range
    const clampedU = Math.max(0, Math.min(1, u));
    const clampedV = Math.max(0, Math.min(1, v));
    
    // Sample from heightfield with bilinear interpolation
    const resolution = params.resolution;
    const fx = clampedU * (resolution - 1);
    const fz = clampedV * (resolution - 1);
    
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const fracX = fx - ix;
    const fracZ = fz - iz;
    
    const ix1 = Math.min(ix + 1, resolution - 1);
    const iz1 = Math.min(iz + 1, resolution - 1);
    
    // Get four corner heights
    const h00 = heightfield[iz * resolution + ix] || 0;
    const h10 = heightfield[iz * resolution + ix1] || 0;
    const h01 = heightfield[iz1 * resolution + ix] || 0;
    const h11 = heightfield[iz1 * resolution + ix1] || 0;
    
    // Bilinear interpolation
    const h0 = h00 * (1 - fracX) + h10 * fracX;
    const h1 = h01 * (1 - fracX) + h11 * fracX;
    const height = h0 * (1 - fracZ) + h1 * fracZ;
    
    return height;
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
   * Set aspect ratio for projection matrix
   */
  setAspectRatio(width: number, height: number): void {
    mat4.perspective(this.projMatrix, Math.PI / 3, width / height, 0.1, 1000);
  }
  
  /**
   * Get near and far planes
   */
  get near(): number { return 0.1; }
  get far(): number { return 1000; }
}
