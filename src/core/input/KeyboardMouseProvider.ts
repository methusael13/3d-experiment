/**
 * KeyboardMouseProvider — DOM event-based keyboard + mouse input provider.
 *
 * Always connected. Tracks key states, mouse button states, and mouse movement
 * deltas. Mouse movement deltas are accumulated between polls and reset on read.
 */

import type { InputProvider } from './InputProvider';
import type { InputSource } from './types';

export class KeyboardMouseProvider implements InputProvider {
  readonly id = 'keyboard-mouse';
  readonly name = 'Keyboard & Mouse';

  // Key state: key code → pressed
  private keys = new Set<string>();

  // Mouse button state: button index → pressed
  private mouseButtons = new Set<number>();

  // Accumulated mouse movement deltas since last readCameraAxis()
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;

  // Scroll delta accumulated since last readScroll()
  private scrollDelta = 0;

  // Bound handlers for cleanup
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundBlur: () => void;

  /** Whether to listen to mouse move on document (for pointer lock / TPS) */
  private documentMouseMove = true;

  constructor() {
    this.boundKeyDown = this.onKeyDown.bind(this);
    this.boundKeyUp = this.onKeyUp.bind(this);
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundBlur = this.onBlur.bind(this);

    document.addEventListener('keydown', this.boundKeyDown);
    document.addEventListener('keyup', this.boundKeyUp);
    document.addEventListener('mousedown', this.boundMouseDown);
    document.addEventListener('mouseup', this.boundMouseUp);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('wheel', this.boundWheel, { passive: true });
    window.addEventListener('blur', this.boundBlur);
  }

  isConnected(): boolean {
    return true; // Always connected
  }

  poll(): void {
    // DOM events are already processed asynchronously.
    // Nothing to poll — state is maintained by event handlers.
  }

  readSource(source: InputSource): number {
    if (source.device === 'keyboard') {
      return this.keys.has(source.key) ? 1.0 : 0.0;
    }
    if (source.device === 'mouse') {
      return this.mouseButtons.has(source.button) ? 1.0 : 0.0;
    }
    return 0;
  }

  readCameraAxis(): { deltaX: number; deltaY: number } {
    const dx = this.mouseDeltaX;
    const dy = this.mouseDeltaY;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { deltaX: dx, deltaY: dy };
  }

  /**
   * Read accumulated scroll delta since last call. Resets after reading.
   */
  readScrollDelta(): number {
    const d = this.scrollDelta;
    this.scrollDelta = 0;
    return d;
  }

  /**
   * Check if a specific key code is currently pressed.
   * Useful for the existing InputManager to check Escape etc.
   */
  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.boundKeyDown);
    document.removeEventListener('keyup', this.boundKeyUp);
    document.removeEventListener('mousedown', this.boundMouseDown);
    document.removeEventListener('mouseup', this.boundMouseUp);
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('wheel', this.boundWheel);
    window.removeEventListener('blur', this.boundBlur);

    this.keys.clear();
    this.mouseButtons.clear();
  }

  // ==================== Event Handlers ====================

  private onKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }

  private onMouseDown(e: MouseEvent): void {
    this.mouseButtons.add(e.button);
  }

  private onMouseUp(e: MouseEvent): void {
    this.mouseButtons.delete(e.button);
  }

  private onMouseMove(e: MouseEvent): void {
    // Accumulate movement deltas (works in both pointer-locked and free modes)
    this.mouseDeltaX += e.movementX;
    this.mouseDeltaY += e.movementY;
  }

  private onWheel(e: WheelEvent): void {
    this.scrollDelta += e.deltaY;
  }

  private onBlur(): void {
    // Release all keys/buttons when window loses focus
    this.keys.clear();
    this.mouseButtons.clear();
  }
}
