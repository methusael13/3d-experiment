/**
 * Camera Controller - manages camera state, orbit controls, and input handling
 */

import { mat4 } from 'gl-matrix';
import type { Vec3 } from '../../core/types';
import { createCamera } from '../../core/camera';
import { raycastToGround } from '../../core/utils/raycastUtils';

// ==================== Types ====================

export interface CameraControllerOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface CameraControllerCallbacks {
  onGizmoCheck?: () => boolean;
  onGizmoMouseDown?: (x: number, y: number) => boolean;
  onGizmoMouseMove?: (x: number, y: number) => void;
  onGizmoMouseUp?: () => void;
  onClick?: (x: number, y: number, shiftKey: boolean) => void;
  onViewModeChange?: (mode: string) => void;
}

export interface CameraState {
  angleX: number;
  angleY: number;
  distance: number;
  originX: number;
  originY: number;
  originZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export type ViewMode = 'free' | 'front' | 'side' | 'top' | 'home';

interface HomeState {
  angleX: number;
  angleY: number;
  distance: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

// ==================== CameraController Class ====================

export class CameraController {
  private readonly canvas: HTMLCanvasElement;
  private readonly width: number;
  private readonly height: number;
  private readonly camera: ReturnType<typeof createCamera>;
  
  // Orbit state
  private angleX = 0.5;
  private angleY = 0.3;
  private distance = 5;
  
  // Pan offsets
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  
  // Origin position
  private originPos: Vec3 = [0, 0, 0];
  
  // Grid bounds for raycast
  private readonly GRID_BOUNDS = 10;
  
  // View mode tracking
  private savedHomeState: HomeState | null = null;
  private currentViewMode: ViewMode = 'free';
  
  // Input state
  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;
  private mouseDownX = 0;
  private mouseDownY = 0;
  private hasMoved = false;
  
  // Callbacks
  private onClickCallback: ((x: number, y: number, shiftKey: boolean) => void) | null = null;
  private onViewModeChangeCallback: ((mode: string) => void) | null = null;

  constructor(options: CameraControllerOptions) {
    this.canvas = options.canvas;
    this.width = options.width;
    this.height = options.height;
    
    this.camera = createCamera({
      aspectRatio: options.width / options.height,
      fov: 45,
      near: 0.1,
      far: 100,
    });
    
    this.updatePosition();
  }

  // ==================== Position Calculation ====================

  private updatePosition(): void {
    const targetX = this.originPos[0] + this.offsetX;
    const targetY = this.originPos[1] + this.offsetY;
    const targetZ = this.originPos[2] + this.offsetZ;
    
    const x = Math.sin(this.angleX) * Math.cos(this.angleY) * this.distance;
    const y = Math.sin(this.angleY) * this.distance;
    const z = Math.cos(this.angleX) * Math.cos(this.angleY) * this.distance;
    
    this.camera.setPosition(x + targetX, y + targetY, z + targetZ);
    this.camera.setTarget(targetX, targetY, targetZ);
  }

  // ==================== Orbit Controls ====================

  orbit(dx: number, dy: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    this.angleX -= dx * 0.01;
    this.angleY += dy * 0.01;
    this.angleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.angleY));
    this.updatePosition();
    this.saveHomeState();
  }

  pan(dx: number, dy: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    const rightX = Math.cos(this.angleX);
    const rightZ = -Math.sin(this.angleX);
    const upX = -Math.sin(this.angleX) * Math.sin(this.angleY);
    const upY = Math.cos(this.angleY);
    const upZ = -Math.cos(this.angleX) * Math.sin(this.angleY);
    
    const panSpeed = 0.01 * this.distance * 0.5;
    this.offsetX -= (dx * rightX - dy * upX) * panSpeed;
    this.offsetY += dy * upY * panSpeed;
    this.offsetZ -= (dx * rightZ - dy * upZ) * panSpeed;
    
    this.updatePosition();
    this.saveHomeState();
  }

  zoom(delta: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    this.distance += delta * 0.01;
    this.distance = Math.max(1, Math.min(20, this.distance));
    this.updatePosition();
    this.saveHomeState();
  }

  // ==================== Origin Control ====================

  setOriginFromScreenPos(screenX: number, screenY: number): void {
    const hit = raycastToGround(screenX, screenY, this.camera as any, this.width, this.height, this.GRID_BOUNDS);
    if (hit) {
      const camPos = this.camera.getPosition();
      const newOrigin: Vec3 = [hit[0], 0, hit[1]];
      
      const dx = camPos[0] - newOrigin[0];
      const dy = camPos[1] - newOrigin[1];
      const dz = camPos[2] - newOrigin[2];
      
      const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const newAngleY = Math.atan2(dy, horizontalDist);
      const newAngleX = Math.atan2(dx, dz);
      
      this.originPos = newOrigin;
      this.angleX = newAngleX;
      this.angleY = newAngleY;
      this.distance = newDistance;
      this.offsetX = 0;
      this.offsetY = 0;
      this.offsetZ = 0;
      
      this.updatePosition();
    }
  }

  resetOrigin(): void {
    const camPos = this.camera.getPosition();
    const newOrigin: Vec3 = [0, 0, 0];
    
    const dx = camPos[0] - newOrigin[0];
    const dy = camPos[1] - newOrigin[1];
    const dz = camPos[2] - newOrigin[2];
    
    const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const newAngleY = Math.atan2(dy, horizontalDist);
    const newAngleX = Math.atan2(dx, dz);
    
    this.originPos = newOrigin;
    this.angleX = newAngleX;
    this.angleY = newAngleY;
    this.distance = newDistance;
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    
    this.updatePosition();
  }

  getOriginPosition(): number[] {
    return [...this.originPos];
  }

  // ==================== View Presets ====================

  private saveHomeState(): void {
    this.savedHomeState = {
      angleX: this.angleX,
      angleY: this.angleY,
      distance: this.distance,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      offsetZ: this.offsetZ,
    };
  }

  setView(view: ViewMode | string): void {
    if (view === 'home') {
      if (this.savedHomeState) {
        this.angleX = this.savedHomeState.angleX;
        this.angleY = this.savedHomeState.angleY;
        this.distance = this.savedHomeState.distance;
        this.offsetX = this.savedHomeState.offsetX;
        this.offsetY = this.savedHomeState.offsetY;
        this.offsetZ = this.savedHomeState.offsetZ;
        this.currentViewMode = 'free';
        this.updatePosition();
      }
      return;
    }
    
    if (this.currentViewMode === 'free') this.saveHomeState();
    
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    
    switch (view) {
      case 'front': this.angleX = 0; this.angleY = 0; break;
      case 'side': this.angleX = Math.PI / 2; this.angleY = 0; break;
      case 'top': this.angleX = 0; this.angleY = Math.PI / 2 - 0.001; break;
    }
    
    this.currentViewMode = view as ViewMode;
    this.updatePosition();
    this.onViewModeChangeCallback?.(this.currentViewMode);
  }

  // ==================== Serialization ====================

  serialize(): CameraState {
    return {
      angleX: this.angleX,
      angleY: this.angleY,
      distance: this.distance,
      originX: this.originPos[0],
      originY: this.originPos[1],
      originZ: this.originPos[2],
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      offsetZ: this.offsetZ,
    };
  }

  deserialize(state: Partial<CameraState> | null | unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Partial<CameraState>;
    
    this.angleX = s.angleX ?? 0.5;
    this.angleY = s.angleY ?? 0.3;
    this.distance = s.distance ?? 5;
    this.originPos = [s.originX ?? 0, s.originY ?? 0, s.originZ ?? 0];
    this.offsetX = s.offsetX ?? 0;
    this.offsetY = s.offsetY ?? 0;
    this.offsetZ = s.offsetZ ?? 0;
    this.updatePosition();
  }

  // ==================== Event Listeners ====================

  setupEventListeners(callbacks: CameraControllerCallbacks = {}): void {
    const { onGizmoCheck = () => false, onGizmoMouseDown, onGizmoMouseMove, onGizmoMouseUp } = callbacks;
    this.onClickCallback = callbacks.onClick || null;
    this.onViewModeChangeCallback = callbacks.onViewModeChange || null;
    
    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (e.button === 0 && onGizmoMouseDown?.(x, y)) {
        return;
      }
      
      this.handleMouseDownInternal(e);
    });
    
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (onGizmoCheck()) {
        onGizmoMouseMove?.(x, y);
        return;
      }
      
      this.handleMouseMoveInternal(e);
    });
    
    this.canvas.addEventListener('mouseup', (e) => {
      if (onGizmoCheck()) {
        onGizmoMouseUp?.();
        return;
      }
      
      this.handleMouseUpInternal(e);
    });
    
    this.canvas.addEventListener('mouseleave', () => this.handleMouseLeave());
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handleMouseDownInternal(e: MouseEvent): void {
    if (e.button === 0) this.isDragging = true;
    else if (e.button === 2) this.isPanning = true;
    
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
    this.hasMoved = false;
  }

  private handleMouseMoveInternal(e: MouseEvent): void {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    
    if (Math.abs(e.clientX - this.mouseDownX) > 3 || Math.abs(e.clientY - this.mouseDownY) > 3) {
      this.hasMoved = true;
    }
    
    if (this.isDragging && this.hasMoved) {
      this.orbit(dx, dy);
    } else if (this.isPanning) {
      this.pan(dx, dy);
    }
  }

  private handleMouseUpInternal(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const clicked = e.button === 0 && !this.hasMoved;
    
    this.isDragging = false;
    this.isPanning = false;
    
    if (clicked) {
      this.onClickCallback?.(x, y, e.shiftKey);
    }
  }

  handleMouseLeave(): void {
    this.isDragging = false;
    this.isPanning = false;
  }

  handleWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoom(e.deltaY);
  }

  handleDoubleClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.setOriginFromScreenPos(e.clientX - rect.left, e.clientY - rect.top);
  }

  // ==================== Public Accessors ====================

  getCamera(): ReturnType<typeof createCamera> {
    return this.camera;
  }

  getViewProjectionMatrix(): mat4 {
    return this.camera.getViewProjectionMatrix();
  }

  getCurrentViewMode(): ViewMode {
    return this.currentViewMode;
  }

  set onClick(fn: ((x: number, y: number, shiftKey: boolean) => void) | null) {
    this.onClickCallback = fn;
  }

  set onViewModeChange(fn: ((mode: string) => void) | null) {
    this.onViewModeChangeCallback = fn;
  }
}

// ==================== Factory Function ====================

/**
 * Create a new CameraController instance
 * @deprecated Use `new CameraController()` directly
 */
export function createCameraController(options: CameraControllerOptions): CameraController {
  return new CameraController(options);
}
