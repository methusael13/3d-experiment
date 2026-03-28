/**
 * GenericGamepadProvider — Web Gamepad API fallback for standard controllers.
 *
 * Uses `navigator.getGamepads()` to poll any connected standard gamepad.
 * Maps the Standard Gamepad layout buttons/axes to the abstract input source names.
 *
 * This is a fallback provider — for specialized controllers (DualSense),
 * a dedicated provider can be used instead.
 */

import type { InputProvider } from './InputProvider';
import type { InputSource } from './types';

// Standard Gamepad Layout button indices
// https://w3c.github.io/gamepad/#remapping
const BUTTON_MAP: Record<string, number> = {
  cross: 0,      // A / Cross
  circle: 1,     // B / Circle
  square: 2,     // X / Square
  triangle: 3,   // Y / Triangle
  L1: 4,         // Left Bumper
  R1: 5,         // Right Bumper
  L2: 6,         // Left Trigger
  R2: 7,         // Right Trigger
  share: 8,      // Select / Share
  options: 9,    // Start / Options
  L3: 10,        // Left Stick Click
  R3: 11,        // Right Stick Click
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  ps: 16,        // Home / PS button
  touchpad: 17,  // Touchpad (if available)
};

// Standard Gamepad Layout axis indices
const AXIS_MAP: Record<string, number> = {
  leftStickX: 0,
  leftStickY: 1,
  rightStickX: 2,
  rightStickY: 3,
};

const DEFAULT_DEADZONE = 0.15;

export class GenericGamepadProvider implements InputProvider {
  readonly id: string;
  readonly name: string;

  /** Gamepad index in navigator.getGamepads() */
  private gamepadIndex: number;

  /** Cached gamepad reference (refreshed each poll) */
  private gamepad: Gamepad | null = null;

  constructor(gamepadIndex = 0) {
    this.gamepadIndex = gamepadIndex;
    this.id = `gamepad-${gamepadIndex}`;
    this.name = `Gamepad ${gamepadIndex}`;
  }

  isConnected(): boolean {
    try {
      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.gamepadIndex];
      return gp !== null && gp !== undefined && gp.connected;
    } catch {
      return false;
    }
  }

  poll(): void {
    try {
      const gamepads = navigator.getGamepads();
      this.gamepad = gamepads[this.gamepadIndex] ?? null;
    } catch {
      this.gamepad = null;
    }
  }

  readSource(source: InputSource): number {
    if (source.device !== 'gamepad' || !this.gamepad) return 0;

    if (source.kind === 'button') {
      const idx = BUTTON_MAP[source.button];
      if (idx === undefined) return 0;
      if (idx >= this.gamepad.buttons.length) return 0;
      return this.gamepad.buttons[idx].value; // 0.0 to 1.0 (analog triggers)
    }

    if (source.kind === 'axis') {
      const idx = AXIS_MAP[source.axis];
      if (idx === undefined) return 0;
      if (idx >= this.gamepad.axes.length) return 0;

      const raw = this.gamepad.axes[idx];
      const deadzone = source.deadzone ?? DEFAULT_DEADZONE;

      // Apply deadzone
      if (Math.abs(raw) < deadzone) return 0;

      // Remap from deadzone..1 to 0..1
      const sign = raw > 0 ? 1 : -1;
      const remapped = (Math.abs(raw) - deadzone) / (1 - deadzone);

      if (source.direction === 'positive') {
        return sign > 0 ? remapped : 0;
      }
      if (source.direction === 'negative') {
        return sign < 0 ? remapped : 0;
      }

      return 0;
    }

    return 0;
  }

  readCameraAxis(): { deltaX: number; deltaY: number } {
    if (!this.gamepad) return { deltaX: 0, deltaY: 0 };

    const rxIdx = AXIS_MAP.rightStickX;
    const ryIdx = AXIS_MAP.rightStickY;

    if (rxIdx >= this.gamepad.axes.length || ryIdx >= this.gamepad.axes.length) {
      return { deltaX: 0, deltaY: 0 };
    }

    const rx = this.gamepad.axes[rxIdx];
    const ry = this.gamepad.axes[ryIdx];
    const deadzone = 0.1;

    return {
      deltaX: Math.abs(rx) > deadzone ? rx * 3.0 : 0,
      deltaY: Math.abs(ry) > deadzone ? ry * 3.0 : 0,
    };
  }

  destroy(): void {
    this.gamepad = null;
  }
}
