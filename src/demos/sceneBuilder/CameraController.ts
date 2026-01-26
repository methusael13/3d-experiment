/**
 * Camera Controller - manages camera state, orbit controls, and input handling
 * Uses CameraObject from core for camera state and matrix computation
 */

import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../../core/types';
import { CameraObject, CameraState } from '../../core/sceneObjects/CameraObject';
import { raycastToGround } from '../../core/utils/raycastUtils';

// Re-export CameraState for external use
export type { CameraState } from '../../core/sceneObjects/CameraObject';

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
  
  /** The camera object (from core) */
  private readonly camera: CameraObject;
  
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
    
    // Create CameraObject
    this.camera = new CameraObject('ViewportCamera');
    this.camera.setAspectRatio(options.width, options.height);
  }

  // ==================== Orbit Controls ====================

  orbit(dx: number, dy: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    // Convert pixel delta to radians
    this.camera.orbitBy(dx * 0.01, dy * 0.01);
    this.saveHomeState();
  }

  pan(dx: number, dy: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    this.camera.panBy(dx, dy);
    this.saveHomeState();
  }

  zoom(delta: number): void {
    if (this.currentViewMode !== 'free') {
      this.saveHomeState();
      this.currentViewMode = 'free';
      this.onViewModeChangeCallback?.(this.currentViewMode);
    }
    
    this.camera.zoomBy(delta);
    this.saveHomeState();
  }

  // ==================== Origin Control ====================

  setOriginFromScreenPos(screenX: number, screenY: number): void {
    const hit = raycastToGround(screenX, screenY, this.camera as any, this.width, this.height, this.GRID_BOUNDS);
    if (hit) {
      const newOrigin: Vec3 = [hit[0], 0, hit[1]];
      this.camera.setOriginPosition(newOrigin);
    }
  }

  resetOrigin(): void {
    this.camera.resetOrigin();
  }

  getOriginPosition(): vec3 {
    return vec3.clone(this.camera.origin);
  }

  // ==================== View Presets ====================

  private saveHomeState(): void {
    const state = this.camera.getOrbitState();
    this.savedHomeState = {
      angleX: state.angleX,
      angleY: state.angleY,
      distance: state.distance,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
      offsetZ: state.offsetZ,
    };
  }

  setView(view: ViewMode | string): void {
    if (view === 'home') {
      if (this.savedHomeState) {
        this.camera.setOrbitState({
          angleX: this.savedHomeState.angleX,
          angleY: this.savedHomeState.angleY,
          distance: this.savedHomeState.distance,
          offsetX: this.savedHomeState.offsetX,
          offsetY: this.savedHomeState.offsetY,
          offsetZ: this.savedHomeState.offsetZ,
        });
        this.currentViewMode = 'free';
      }
      return;
    }
    
    if (this.currentViewMode === 'free') this.saveHomeState();
    
    // Reset offsets for preset views
    this.camera.setOrbitState({
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
    });
    
    switch (view) {
      case 'front':
        this.camera.angleX = 0;
        this.camera.angleY = 0;
        break;
      case 'side':
        this.camera.angleX = Math.PI / 2;
        this.camera.angleY = 0;
        break;
      case 'top':
        this.camera.angleX = 0;
        this.camera.angleY = Math.PI / 2 - 0.001;
        break;
    }
    
    this.camera.updatePositionFromOrbit();
    this.currentViewMode = view as ViewMode;
    this.onViewModeChangeCallback?.(this.currentViewMode);
  }

  // ==================== Serialization ====================

  serialize(): CameraState {
    return this.camera.getOrbitState();
  }

  deserialize(state: Partial<CameraState> | null | unknown): void {
    if (!state || typeof state !== 'object') return;
    this.camera.setOrbitState(state as Partial<CameraState>);
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

  getCamera(): CameraObject {
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
