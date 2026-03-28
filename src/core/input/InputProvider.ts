/**
 * InputProvider — Abstract interface for hardware input sources.
 *
 * Each provider wraps a specific input device (keyboard+mouse, gamepad, DualSense)
 * and exposes a unified polling API. The InputManager merges data from all
 * connected providers each frame.
 */

import type { InputSource } from './types';

export interface InputProvider {
  /** Unique device identifier (e.g., 'keyboard-mouse', 'gamepad-0') */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether this provider is currently connected */
  isConnected(): boolean;

  /** Called each frame to poll hardware state */
  poll(): void;

  /**
   * Read the current value of a source. Returns 0 if not applicable to this provider.
   * Value range: 0.0 to 1.0 (binary for buttons/keys, continuous for axes).
   */
  readSource(source: InputSource): number;

  /** Read camera axis deltas (mouse movement / right stick) */
  readCameraAxis(): { deltaX: number; deltaY: number };

  /** Cleanup resources (event listeners, etc.) */
  destroy(): void;
}
