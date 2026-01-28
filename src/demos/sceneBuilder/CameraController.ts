/**
 * Camera Controller - manages camera state, orbit controls, and input handling
 * Uses CameraObject from core for camera state and matrix computation
 * Subscribes to InputManager for event routing
 */

import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../../core/types';
import { CameraObject, CameraState } from '../../core/sceneObjects/CameraObject';
import { raycastToGround } from '../../core/utils/raycastUtils';
import type { InputManager, InputEvent } from './InputManager';

// Re-export CameraState for external use
export type { CameraState } from '../../core/sceneObjects/CameraObject';

// ==================== Types ====================

export interface CameraControllerOptions {
  width: number;
  height: number;
  inputManager: InputManager;
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
  private readonly width: number;
  private readonly height: number;
  private readonly inputManager: InputManager;
  
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
  
  // Gizmo callbacks
  private onGizmoCheck: () => boolean = () => false;
  private onGizmoMouseDown: ((x: number, y: number) => boolean) | null = null;
  private onGizmoMouseMove: ((x: number, y: number) => void) | null = null;
  private onGizmoMouseUp: (() => void) | null = null;

  constructor(options: CameraControllerOptions) {
    this.width = options.width;
    this.height = options.height;
    this.inputManager = options.inputManager;
    
    // Create CameraObject
    this.camera = new CameraObject('ViewportCamera');
    this.camera.setAspectRatio(options.width, options.height);
    
    // Subscribe to InputManager 'editor' channel
    this.setupInputSubscriptions();
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

  // ==================== Input Subscriptions ====================

  /**
   * Set up event subscriptions via InputManager
   */
  private setupInputSubscriptions(): void {
    const im = this.inputManager;
    
    // Mouse events on 'editor' channel
    im.on('editor', 'mousedown', (e: InputEvent<MouseEvent>) => this.handleMouseDown(e));
    im.on('editor', 'mousemove', (e: InputEvent<MouseEvent>) => this.handleMouseMove(e));
    im.on('editor', 'mouseup', (e: InputEvent<MouseEvent>) => this.handleMouseUp(e));
    im.on('editor', 'mouseleave', () => this.handleMouseLeave());
    im.on('editor', 'wheel', (e: InputEvent<WheelEvent>) => this.handleWheel(e));
    im.on('editor', 'dblclick', (e: InputEvent<MouseEvent>) => this.handleDoubleClick(e));
  }

  /**
   * Set callbacks for gizmo integration and click handling.
   * Called by Viewport after construction.
   */
  setCallbacks(callbacks: CameraControllerCallbacks): void {
    this.onGizmoCheck = callbacks.onGizmoCheck ?? (() => false);
    this.onGizmoMouseDown = callbacks.onGizmoMouseDown ?? null;
    this.onGizmoMouseMove = callbacks.onGizmoMouseMove ?? null;
    this.onGizmoMouseUp = callbacks.onGizmoMouseUp ?? null;
    this.onClickCallback = callbacks.onClick ?? null;
    this.onViewModeChangeCallback = callbacks.onViewModeChange ?? null;
  }

  // ==================== Event Handlers ====================

  private handleMouseDown(e: InputEvent<MouseEvent>): void {
    // Check gizmo first
    if (e.button === 0 && this.onGizmoMouseDown?.(e.x, e.y)) {
      return;
    }
    
    if (e.button === 0) this.isDragging = true;
    else if (e.button === 2) this.isPanning = true;
    
    this.lastX = e.originalEvent.clientX;
    this.lastY = e.originalEvent.clientY;
    this.mouseDownX = e.originalEvent.clientX;
    this.mouseDownY = e.originalEvent.clientY;
    this.hasMoved = false;
  }

  private handleMouseMove(e: InputEvent<MouseEvent>): void {
    // Check gizmo dragging
    if (this.onGizmoCheck()) {
      this.onGizmoMouseMove?.(e.x, e.y);
      return;
    }
    
    const clientX = e.originalEvent.clientX;
    const clientY = e.originalEvent.clientY;
    
    const dx = clientX - this.lastX;
    const dy = clientY - this.lastY;
    this.lastX = clientX;
    this.lastY = clientY;
    
    if (Math.abs(clientX - this.mouseDownX) > 3 || Math.abs(clientY - this.mouseDownY) > 3) {
      this.hasMoved = true;
    }
    
    if (this.isDragging && this.hasMoved) {
      this.orbit(dx, dy);
    } else if (this.isPanning) {
      this.pan(dx, dy);
    }
  }

  private handleMouseUp(e: InputEvent<MouseEvent>): void {
    // Check gizmo
    if (this.onGizmoCheck()) {
      this.onGizmoMouseUp?.();
      return;
    }
    
    const clicked = e.button === 0 && !this.hasMoved;
    
    this.isDragging = false;
    this.isPanning = false;
    
    if (clicked) {
      this.onClickCallback?.(e.x, e.y, e.shiftKey || false);
    }
  }

  handleMouseLeave(): void {
    this.isDragging = false;
    this.isPanning = false;
  }

  private handleWheel(e: InputEvent<WheelEvent>): void {
    this.zoom(e.deltaY || 0);
  }

  private handleDoubleClick(e: InputEvent<MouseEvent>): void {
    this.setOriginFromScreenPos(e.x, e.y);
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
