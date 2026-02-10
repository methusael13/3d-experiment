/**
 * TransformGizmoManager - Orchestrates transform gizmo modes
 * Provides the same API as the old createTransformGizmo() factory function
 * Supports both WebGL2 and WebGPU rendering backends
 */

import { mat4, quat } from 'gl-matrix';
import type { Vec3 } from '../../../core/types';
import { GizmoCamera, TransformChangeCallback, GizmoOrientation } from './BaseGizmo';
import { TranslateGizmo } from './TranslateGizmo';
import { RotateGizmo } from './RotateGizmo';
import { ScaleGizmo } from './ScaleGizmo';
import { UniformScaleGizmo } from './UniformScaleGizmo';
import type { GPUContext } from '../../../core/gpu/GPUContext';
import { GizmoRendererGPU } from '../../../core/gpu/renderers/GizmoRendererGPU';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
// GizmoOrientation is re-exported from BaseGizmo
export type { GizmoOrientation } from './BaseGizmo';

/**
 * Manager that holds all gizmo types and delegates to the active one
 */
export class TransformGizmoManager {
  private readonly _camera: GizmoCamera;
  
  private readonly translateGizmo: TranslateGizmo;
  private readonly rotateGizmo: RotateGizmo;
  private readonly scaleGizmo: ScaleGizmo;
  private readonly uniformScaleGizmo: UniformScaleGizmo;
  
  // WebGPU renderer (optional)
  private gpuContext: GPUContext | null = null;
  private gizmoRendererGPU: GizmoRendererGPU | null = null;
  
  private mode: GizmoMode = 'translate';
  private orientation: GizmoOrientation = 'world';
  private enabled = false;
  
  // Store current target for re-applying on mode change
  // rotationQuat is the authoritative source; rotation (Euler) kept for legacy
  private currentTarget: {
    position: [number, number, number];
    rotation: [number, number, number];
    rotationQuat: quat;
    scale: [number, number, number];
  } = {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    rotationQuat: quat.create(),
    scale: [1, 1, 1],
  };
  
  // Callbacks
  private onTransformChange: TransformChangeCallback | null = null;

  constructor(camera: GizmoCamera) {
    this._camera = camera;
    
    // Create all gizmo instances
    this.translateGizmo = new TranslateGizmo(camera);
    this.rotateGizmo = new RotateGizmo(camera);
    this.scaleGizmo = new ScaleGizmo(camera);
    this.uniformScaleGizmo = new UniformScaleGizmo(camera);
    
    // Wire up callbacks
    this.translateGizmo.setOnChange((type, value) => this.handleChange(type, value));
    this.rotateGizmo.setOnChange((type, value) => this.handleChange(type, value));
    this.scaleGizmo.setOnChange((type, value) => this.handleChange(type, value));
  }
  
  private handleChange(type: 'position' | 'rotation' | 'scale', value: Vec3 | quat): void {
    // Keep currentTarget in sync with gizmo changes
    // so mode switches use the latest values
    if (type === 'position') {
      const pos = value as Vec3;
      this.currentTarget.position = [...pos];
    } else if (type === 'rotation') {
      // Rotation is now quat
      quat.copy(this.currentTarget.rotationQuat, value as quat);
    } else if (type === 'scale') {
      const scl = value as Vec3;
      this.currentTarget.scale = [...scl];
    }
    
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
  
  // ==================== WebGPU Rendering ====================
  
  /**
   * Initialize WebGPU gizmo renderer
   * Call this when switching to WebGPU mode
   */
  initGPURenderer(ctx: GPUContext): void {
    if (this.gizmoRendererGPU) {
      this.gizmoRendererGPU.destroy();
    }
    this.gpuContext = ctx;
    this.gizmoRendererGPU = new GizmoRendererGPU(ctx);
    console.log('[TransformGizmoManager] WebGPU renderer initialized');
  }
  
  /**
   * Check if WebGPU renderer is available
   */
  hasGPURenderer(): boolean {
    return this.gizmoRendererGPU !== null;
  }
  
  /**
   * Render gizmo using WebGPU
   * Delegates to the active gizmo's renderGPU method so that each gizmo
   * can use its own internal state (orientation, rotation, etc.)
   * @param passEncoder - Active render pass encoder
   * @param vpMatrix - View-projection matrix (from camera)
   */
  renderGPU(passEncoder: GPURenderPassEncoder, vpMatrix: mat4 | Float32Array): void {
    if (!this.enabled || !this.gizmoRendererGPU) return;
    
    // Delegate to active gizmo's renderGPU method
    // This ensures proper local/world orientation handling
    this.getActiveGizmo().renderGPU(passEncoder, vpMatrix, this.gizmoRendererGPU);
    
    // Always render uniform scale 2D overlay if active
    // This uses HTML canvas overlay, not WebGPU, but must be called from here
    // to ensure the overlay is rendered during WebGPU mode
    this.uniformScaleGizmo.render(vpMatrix as mat4);
  }
  
  setMode(newMode: GizmoMode): void {
    this.mode = newMode;
    // Re-apply target to active gizmo on mode change using quaternion directly
    // This avoids Euler→Quat conversion drift when switching modes
    const target = this.currentTarget;
    this.getActiveGizmo().setTargetWithQuat(target.position, target.rotationQuat, target.scale);
  }

  getActiveMode(): GizmoMode {
    return this.mode;
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
    // Also convert Euler to quat for authoritative storage
    this.currentTarget.position = [...position];
    this.currentTarget.rotation = [...rotation];
    this.currentTarget.scale = [...scale];
    // Convert and store quat
    this.currentTarget.rotationQuat = this.rotateGizmo['eulerToQuat'](rotation);
    
    this.translateGizmo.setTarget(position, rotation, scale);
    this.rotateGizmo.setTarget(position, rotation, scale);
    this.scaleGizmo.setTarget(position, rotation, scale);
    this.uniformScaleGizmo.setTarget(position, rotation, scale);
  }
  
  /**
   * Set target with quaternion rotation directly.
   * Avoids Euler→Quat conversion for better precision on selection changes.
   */
  setTargetWithQuat(position: Vec3, rotationQuat: quat, scale: Vec3): void {
    // Store quat directly as the authoritative source
    this.currentTarget.position = [...position];
    this.currentTarget.scale = [...scale];
    quat.copy(this.currentTarget.rotationQuat, rotationQuat);
    // Store Euler for legacy (approximate)
    this.currentTarget.rotation = [...this.rotateGizmo['quatToEuler'](rotationQuat)];
    
    // Pass quat directly to avoid conversion
    this.translateGizmo.setTargetWithQuat(position, rotationQuat, scale);
    this.rotateGizmo.setTargetWithQuat(position, rotationQuat, scale);
    this.scaleGizmo.setTargetWithQuat(position, rotationQuat, scale);
    this.uniformScaleGizmo.setTargetWithQuat(position, rotationQuat, scale);
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
  
  /**
   * Check if gizmo is enabled
   */
  get isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Get current gizmo mode
   */
  getMode(): GizmoMode {
    return this.mode;
  }
  
  /**
   * Get current target transform data
   */
  getTarget(): { position: Vec3; rotation: Vec3; scale: Vec3 } | null {
    if (!this.enabled) return null;
    return {
      position: [...this.currentTarget.position] as Vec3,
      rotation: [...this.currentTarget.rotation] as Vec3,
      scale: [...this.currentTarget.scale] as Vec3,
    };
  }
  
  /**
   * Get currently hovered axis (0=X, 1=Y, 2=Z) or null if none
   */
  getHoveredAxis(): number | null {
    const active = this.getActiveGizmo();
    // Access internal hoveredAxis property if available
    if ('hoveredAxis' in active && typeof (active as any).hoveredAxis === 'number') {
      const axis = (active as any).hoveredAxis;
      return axis >= 0 ? axis : null;
    }
    return null;
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    this.translateGizmo.destroy();
    this.rotateGizmo.destroy();
    this.scaleGizmo.destroy();
    this.uniformScaleGizmo.destroy();
    this.gizmoRendererGPU?.destroy();
    this.gizmoRendererGPU = null;
    this.gpuContext = null;
  }
}
