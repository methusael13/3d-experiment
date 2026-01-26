/**
 * TransformGizmoManager - Orchestrates transform gizmo modes
 * Provides the same API as the old createTransformGizmo() factory function
 */

import { mat4 } from 'gl-matrix';
import type { Vec3 } from '../../../core/types';
import { GizmoCamera, TransformChangeCallback, GizmoOrientation } from './BaseGizmo';
import { TranslateGizmo } from './TranslateGizmo';
import { RotateGizmo } from './RotateGizmo';
import { ScaleGizmo } from './ScaleGizmo';
import { UniformScaleGizmo } from './UniformScaleGizmo';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
// GizmoOrientation is re-exported from BaseGizmo
export type { GizmoOrientation } from './BaseGizmo';

/**
 * Manager that holds all gizmo types and delegates to the active one
 */
export class TransformGizmoManager {
  // Note: gl and camera stored for potential future use / debugging
  private readonly _gl: WebGL2RenderingContext;
  private readonly _camera: GizmoCamera;
  
  private readonly translateGizmo: TranslateGizmo;
  private readonly rotateGizmo: RotateGizmo;
  private readonly scaleGizmo: ScaleGizmo;
  private readonly uniformScaleGizmo: UniformScaleGizmo;
  
  private mode: GizmoMode = 'translate';
  private orientation: GizmoOrientation = 'world';
  private enabled = false;
  
  // Store current target for re-applying on mode change
  private currentTarget: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  } = {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  
  // Callbacks
  private onTransformChange: TransformChangeCallback | null = null;

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    this._gl = gl;
    this._camera = camera;
    
    // Create all gizmo instances
    this.translateGizmo = new TranslateGizmo(gl, camera);
    this.rotateGizmo = new RotateGizmo(gl, camera);
    this.scaleGizmo = new ScaleGizmo(gl, camera);
    this.uniformScaleGizmo = new UniformScaleGizmo(gl, camera);
    
    // Wire up callbacks
    this.translateGizmo.setOnChange((type, value) => this.handleChange(type, value));
    this.rotateGizmo.setOnChange((type, value) => this.handleChange(type, value));
    this.scaleGizmo.setOnChange((type, value) => this.handleChange(type, value));
  }
  
  private handleChange(type: 'position' | 'rotation' | 'scale', value: [number, number, number]): void {
    if (this.onTransformChange) {
      this.onTransformChange(type, value);
    }
  }
  
  private getActiveGizmo() {
    switch (this.mode) {
      case 'translate': return this.translateGizmo;
      case 'rotate': return this.rotateGizmo;
      case 'scale': return this.scaleGizmo;
    }
  }
  
  // ==================== Public API (matches old createTransformGizmo) ====================
  
  render(vpMatrix: mat4): void {
    if (!this.enabled) return;
    
    this.getActiveGizmo().render(vpMatrix);
    
    // Always render uniform scale overlay if active
    this.uniformScaleGizmo.render(vpMatrix);
  }
  
  setMode(newMode: GizmoMode): void {
    this.mode = newMode;
    // Re-apply target to active gizmo on mode change (fixes issue #3)
    const target = this.currentTarget;
    this.getActiveGizmo().setTarget(target.position, target.rotation, target.scale);
  }
  
  setOrientation(newOrientation: GizmoOrientation): void {
    this.orientation = newOrientation;
    // Pass to all gizmos
    this.translateGizmo.setOrientation(newOrientation);
    this.rotateGizmo.setOrientation(newOrientation);
    this.scaleGizmo.setOrientation(newOrientation);
  }
  
  setTarget(position: Vec3, rotation: Vec3, scale: Vec3): void {
    // Store current target for re-applying on mode change
    this.currentTarget = { position: [...position], rotation: [...rotation], scale: [...scale] };
    
    this.translateGizmo.setTarget(position, rotation, scale);
    this.rotateGizmo.setTarget(position, rotation, scale);
    this.scaleGizmo.setTarget(position, rotation, scale);
    this.uniformScaleGizmo.setTarget(position, rotation, scale);
  }
  
  /**
   * Set target position and scale only, preserving gizmos' internal rotation quaternion.
   * Used after drag end to avoid Euler→Quat conversion drift.
   */
  setTargetPositionAndScale(position: Vec3, scale: Vec3): void {
    // Update stored target (rotation not changed)
    this.currentTarget.position = [...position];
    this.currentTarget.scale = [...scale];
    
    this.translateGizmo.setTargetPositionAndScale(position, scale);
    this.rotateGizmo.setTargetPositionAndScale(position, scale);
    this.scaleGizmo.setTargetPositionAndScale(position, scale);
    this.uniformScaleGizmo.setTargetPositionAndScale(position, scale);
  }
  
  setEnabled(value: boolean): void {
    this.enabled = value;
    this.translateGizmo.setEnabled(value);
    this.rotateGizmo.setEnabled(value);
    this.scaleGizmo.setEnabled(value);
    this.uniformScaleGizmo.setEnabled(value);
  }
  
  setOnChange(callback: TransformChangeCallback | null): void {
    this.onTransformChange = callback;
  }
  
  setCanvasSize(width: number, height: number): void {
    this.translateGizmo.setCanvasSize(width, height);
    this.rotateGizmo.setCanvasSize(width, height);
    this.scaleGizmo.setCanvasSize(width, height);
    this.uniformScaleGizmo.setCanvasSize(width, height);
  }
  
  setOverlayContainer(container: HTMLElement): void {
    this.uniformScaleGizmo.setOverlayContainer(container);
  }
  
  handleMouseDown(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): boolean {
    // Check uniform scale first
    if (this.uniformScaleGizmo.isActive) {
      this.uniformScaleGizmo.commitUniformScale();
      return true;
    }
    
    // Store canvas size for the active gizmo
    this.setCanvasSize(canvasWidth, canvasHeight);
    
    return this.getActiveGizmo().handleMouseDown(screenX, screenY);
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    // Check uniform scale first
    if (this.uniformScaleGizmo.isActive) {
      this.uniformScaleGizmo.handleMouseMove(screenX, screenY);
      return true;
    }
    
    return this.getActiveGizmo().handleMouseMove(screenX, screenY);
  }
  
  handleMouseUp(): void {
    this.getActiveGizmo().handleMouseUp();
  }
  
  // ==================== Uniform Scale API ====================
  
  startUniformScale(startScale: Vec3, objectScreenPos: [number, number], mousePos: [number, number]): boolean {
    return this.uniformScaleGizmo.startUniformScale(startScale, objectScreenPos, mousePos);
  }
  
  updateUniformScale(mouseX: number, mouseY: number): Vec3 | null {
    return this.uniformScaleGizmo.updateUniformScale(mouseX, mouseY);
  }
  
  commitUniformScale(): void {
    this.uniformScaleGizmo.commitUniformScale();
  }
  
  cancelUniformScale(): Vec3 {
    return this.uniformScaleGizmo.cancelUniformScale();
  }
  
  setOnUniformScaleChange(callback: ((newScale: Vec3) => void) | null): void {
    this.uniformScaleGizmo.setOnUniformScaleChange(callback);
  }
  
  // ==================== State Getters ====================
  
  get isDragging(): boolean {
    return this.getActiveGizmo().isDragging;
  }
  
  get currentMode(): GizmoMode {
    return this.mode;
  }
  
  get isUniformScaleActive(): boolean {
    return this.uniformScaleGizmo.isActive;
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.translateGizmo.destroy();
    this.rotateGizmo.destroy();
    this.scaleGizmo.destroy();
    this.uniformScaleGizmo.destroy();
  }
}

/**
 * Factory function for backward compatibility with existing code
 */
export function createTransformGizmo(gl: WebGL2RenderingContext, camera: GizmoCamera) {
  const manager = new TransformGizmoManager(gl, camera);
  
  // Return object with same interface as old createTransformGizmo
  return {
    render: (vpMatrix: mat4) => manager.render(vpMatrix),
    setMode: (mode: GizmoMode) => manager.setMode(mode),
    setOrientation: (orientation: GizmoOrientation) => manager.setOrientation(orientation),
    setTarget: (position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]) => 
      manager.setTarget(position, rotation, scale),
    setEnabled: (value: boolean) => manager.setEnabled(value),
    setOnChange: (callback: TransformChangeCallback | null) => manager.setOnChange(callback),
    setCanvasSize: (width: number, height: number) => manager.setCanvasSize(width, height),
    setOverlayContainer: (container: HTMLElement) => manager.setOverlayContainer(container),
    handleMouseDown: (x: number, y: number, cw: number, ch: number) => manager.handleMouseDown(x, y, cw, ch),
    handleMouseMove: (x: number, y: number) => manager.handleMouseMove(x, y),
    handleMouseUp: () => manager.handleMouseUp(),
    startUniformScale: (startScale: number[], objectScreenPos: number[], mousePos: number[]) => 
      manager.startUniformScale(startScale as [number, number, number], objectScreenPos as [number, number], mousePos as [number, number]),
    updateUniformScale: (x: number, y: number) => manager.updateUniformScale(x, y),
    commitUniformScale: () => manager.commitUniformScale(),
    cancelUniformScale: () => manager.cancelUniformScale(),
    destroy: () => manager.destroy(),
    get isDragging() { return manager.isDragging; },
    get mode() { return manager.currentMode; },
    get isUniformScaleActive() { return manager.isUniformScaleActive; },
  };
}
