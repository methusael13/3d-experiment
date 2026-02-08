/**
 * UniformScaleGizmo - 2D overlay for uniform scaling
 * Uses a canvas overlay to show scale feedback
 */

import { mat4 } from 'gl-matrix';
import { BaseGizmo, GizmoCamera } from './BaseGizmo';
import type { GizmoRendererGPU } from '../../../core/gpu/renderers/GizmoRendererGPU';

export class UniformScaleGizmo extends BaseGizmo {
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private overlayContainer: HTMLElement | null = null;
  
  private uniformScaleActive = false;
  private uniformScaleStartScale: [number, number, number] = [1, 1, 1];
  private uniformScaleStartDistance = 0;
  private uniformScaleMousePos: [number, number] = [0, 0];
  private uniformScaleObjectScreenPos: [number, number] = [0, 0];
  private uniformScaleStartMousePos: [number, number] = [0, 0];
  
  private onUniformScaleChange: ((newScale: [number, number, number]) => void) | null = null;

  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    super(gl, camera);
  }
  
  private ensureOverlayCanvas(): void {
    if (!this.overlayCanvas) {
      this.overlayCanvas = document.createElement('canvas');
      this.overlayCanvas.width = this.canvasWidth;
      this.overlayCanvas.height = this.canvasHeight;
      this.overlayCanvas.style.cssText = 'position: absolute; pointer-events: none; top: 0; left: 0; background: transparent;';
      this.overlayCtx = this.overlayCanvas.getContext('2d');
    }
  }
  
  setOverlayContainer(container: HTMLElement): void {
    this.overlayContainer = container;
  }
  
  setOnUniformScaleChange(callback: ((newScale: [number, number, number]) => void) | null): void {
    this.onUniformScaleChange = callback;
  }
  
  override setCanvasSize(width: number, height: number): void {
    super.setCanvasSize(width, height);
    if (this.overlayCanvas) {
      this.overlayCanvas.width = width;
      this.overlayCanvas.height = height;
    }
  }
  
  startUniformScale(startScale: [number, number, number], objectScreenPos: [number, number], mousePos: [number, number]): boolean {
    if (!this.enabled) return false;
    
    this.uniformScaleActive = true;
    this.uniformScaleStartScale = [...startScale];
    this.uniformScaleObjectScreenPos = [...objectScreenPos];
    this.uniformScaleStartMousePos = [...mousePos];
    this.uniformScaleMousePos = [...mousePos];
    
    const dx = this.uniformScaleStartMousePos[0] - this.uniformScaleObjectScreenPos[0];
    const dy = this.uniformScaleStartMousePos[1] - this.uniformScaleObjectScreenPos[1];
    this.uniformScaleStartDistance = Math.sqrt(dx * dx + dy * dy);
    if (this.uniformScaleStartDistance < 10) this.uniformScaleStartDistance = 100;
    
    this.ensureOverlayCanvas();
    return true;
  }
  
  updateUniformScale(mouseX: number, mouseY: number): [number, number, number] | null {
    if (!this.uniformScaleActive) return null;
    
    this.uniformScaleMousePos = [mouseX, mouseY];
    
    const dx = mouseX - this.uniformScaleObjectScreenPos[0];
    const dy = mouseY - this.uniformScaleObjectScreenPos[1];
    const scaleFactor = Math.sqrt(dx * dx + dy * dy) / this.uniformScaleStartDistance;
    
    const newScale: [number, number, number] = [
      Math.max(0.01, this.uniformScaleStartScale[0] * scaleFactor),
      Math.max(0.01, this.uniformScaleStartScale[1] * scaleFactor),
      Math.max(0.01, this.uniformScaleStartScale[2] * scaleFactor),
    ];
    
    if (this.onUniformScaleChange) {
      this.onUniformScaleChange(newScale);
    }
    
    return newScale;
  }
  
  commitUniformScale(): void {
    this.uniformScaleActive = false;
  }
  
  cancelUniformScale(): [number, number, number] {
    const originalScale: [number, number, number] = [...this.uniformScaleStartScale];
    this.uniformScaleActive = false;
    return originalScale;
  }
  
  get isActive(): boolean {
    return this.uniformScaleActive;
  }

  render(vpMatrix: mat4): void {
    // Render 2D overlay
    if (!this.overlayCanvas || !this.overlayCtx) return;
    
    this.overlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    
    if (!this.uniformScaleActive) {
      if (this.overlayCanvas.parentNode) {
        this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
      }
      return;
    }
    
    if (this.overlayContainer && !this.overlayCanvas.parentNode) {
      this.overlayContainer.appendChild(this.overlayCanvas);
    }
    
    this.overlayCtx.save();
    this.overlayCtx.strokeStyle = '#ffff00';
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.setLineDash([8, 8]);
    this.overlayCtx.beginPath();
    this.overlayCtx.moveTo(this.uniformScaleObjectScreenPos[0], this.uniformScaleObjectScreenPos[1]);
    this.overlayCtx.lineTo(this.uniformScaleMousePos[0], this.uniformScaleMousePos[1]);
    this.overlayCtx.stroke();
    
    this.overlayCtx.fillStyle = '#ffff00';
    this.overlayCtx.beginPath();
    this.overlayCtx.arc(this.uniformScaleObjectScreenPos[0], this.uniformScaleObjectScreenPos[1], 6, 0, Math.PI * 2);
    this.overlayCtx.fill();
    
    this.overlayCtx.fillStyle = '#ffffff';
    this.overlayCtx.font = '12px monospace';
    this.overlayCtx.fillText('Uniform Scale - Click to commit, Esc to cancel', 10, 20);
    this.overlayCtx.restore();
  }
  
  handleMouseDown(screenX: number, screenY: number): boolean {
    if (this.uniformScaleActive) {
      this.commitUniformScale();
      return true;
    }
    return false;
  }
  
  handleMouseMove(screenX: number, screenY: number): boolean {
    if (this.uniformScaleActive) {
      this.updateUniformScale(screenX, screenY);
      return true;
    }
    return false;
  }
  
  handleMouseUp(): void {
    // Nothing needed
  }
  
  // ==================== WebGPU Rendering ====================
  
  /**
   * UniformScaleGizmo uses 2D canvas overlay, not WebGPU rendering.
   * This is a no-op implementation to satisfy the abstract method.
   */
  renderGPU(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU
  ): void {
    // UniformScaleGizmo renders via 2D canvas overlay, not WebGPU
    // The overlay is rendered in the regular render() method
  }
  
  destroy(): void {
    if (this.overlayCanvas?.parentNode) {
      this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
    }
    this.overlayCanvas = null;
    this.overlayCtx = null;
    super.destroy();
  }
}
