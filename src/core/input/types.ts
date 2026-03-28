/**
 * Input System Types — Action-based multi-device input abstraction.
 *
 * The entire character controller pipeline (PlayerSystem, CharacterMovementSystem,
 * transition conditions) never sees key codes or button IDs — only action names
 * and analog values. This enables seamless keyboard + controller support from
 * a single Input Node configuration.
 */

// ============================================================================
// Input Sources — Hardware-level binding descriptors
// ============================================================================

export interface KeyboardSource {
  device: 'keyboard';
  key: string; // DOM key code: 'KeyW', 'ShiftLeft', 'Space'
  /** How this source activates the action — default 'held' */
  mode?: 'held' | 'pressed' | 'toggle';
}

export interface MouseButtonSource {
  device: 'mouse';
  button: number; // 0 = left, 1 = middle, 2 = right
  mode?: 'held' | 'pressed' | 'toggle';
}

export interface GamepadAxisSource {
  device: 'gamepad';
  kind: 'axis';
  axis: 'leftStickX' | 'leftStickY' | 'rightStickX' | 'rightStickY' | 'L2' | 'R2';
  direction: 'positive' | 'negative';
  deadzone?: number; // Default 0.15
  /** Axes are always 'held' (analog) — mode is not applicable */
}

export interface GamepadButtonSource {
  device: 'gamepad';
  kind: 'button';
  button:
    | 'cross' | 'circle' | 'square' | 'triangle'
    | 'L1' | 'R1' | 'L2' | 'R2' | 'L3' | 'R3'
    | 'dpadUp' | 'dpadDown' | 'dpadLeft' | 'dpadRight'
    | 'options' | 'share' | 'ps' | 'touchpad';
  /** How this source activates the action — default 'pressed' for buttons */
  mode?: 'held' | 'pressed' | 'toggle';
}

export type InputSource =
  | KeyboardSource
  | MouseButtonSource
  | GamepadAxisSource
  | GamepadButtonSource;

// ============================================================================
// Action Deactivation Conditions (for toggle mode)
// ============================================================================

/**
 * Conditions that auto-deactivate a toggled action.
 */
export type ActionDeactivateCondition =
  | { type: 'variable'; variable: string; operator: '<' | '<=' | '==' | '>' | '>='; value: number }
  | { type: 'actionInactive'; action: string };

// ============================================================================
// Input Binding — Maps an action to one or more hardware sources
// ============================================================================

export interface InputBinding {
  /** Abstract action name (e.g., 'forward', 'jump', 'attack') */
  action: string;

  /** Multiple hardware sources can trigger the same action */
  sources: InputSource[];

  /**
   * Optional auto-deactivation condition for toggle sources.
   * When a toggle-mode source activates this action, it stays active until
   * this condition evaluates to true, at which point it auto-deactivates.
   */
  autoDeactivateWhen?: ActionDeactivateCondition;
}

// ============================================================================
// Action State — Runtime state of an abstract action
// ============================================================================

export interface ActionState {
  /** Whether the action is active (pressed/held) — binary threshold */
  active: boolean;

  /** Analog value 0.0–1.0 (keyboard = 0 or 1, stick = continuous) */
  value: number;

  /** True for exactly one frame when action activates */
  justPressed: boolean;

  /** True for exactly one frame when action deactivates */
  justReleased: boolean;
}

/** A null/default action state for when no binding exists */
export const NULL_ACTION_STATE: Readonly<ActionState> = Object.freeze({
  active: false,
  value: 0,
  justPressed: false,
  justReleased: false,
});

// ============================================================================
// Camera Axes Configuration
// ============================================================================

export interface CameraAxesConfig {
  sources: CameraAxisSource[];
}

export type CameraAxisSource =
  | { device: 'mouse'; sensitivity: number }
  | { device: 'gamepad'; stick: 'rightStick'; sensitivity: number; deadzone: number };

// ============================================================================
// Default Bindings
// ============================================================================

export const DEFAULT_BINDINGS: InputBinding[] = [
  {
    action: 'forward',
    sources: [
      { device: 'keyboard', key: 'KeyW', mode: 'held' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickY', direction: 'negative', deadzone: 0.15 },
    ],
  },
  {
    action: 'backward',
    sources: [
      { device: 'keyboard', key: 'KeyS', mode: 'held' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickY', direction: 'positive', deadzone: 0.15 },
    ],
  },
  {
    action: 'left',
    sources: [
      { device: 'keyboard', key: 'KeyA', mode: 'held' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickX', direction: 'negative', deadzone: 0.15 },
    ],
  },
  {
    action: 'right',
    sources: [
      { device: 'keyboard', key: 'KeyD', mode: 'held' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickX', direction: 'positive', deadzone: 0.15 },
    ],
  },
  {
    action: 'jump',
    sources: [
      { device: 'keyboard', key: 'Space', mode: 'pressed' },
      { device: 'gamepad', kind: 'button', button: 'cross', mode: 'pressed' },
    ],
  },
  {
    action: 'sprint',
    sources: [
      { device: 'keyboard', key: 'ShiftLeft', mode: 'held' },
      { device: 'gamepad', kind: 'button', button: 'L3', mode: 'toggle' },
    ],
    autoDeactivateWhen: {
      type: 'variable',
      variable: 'speed',
      operator: '<',
      value: 0.1,
    },
  },
  {
    action: 'attack',
    sources: [
      { device: 'mouse', button: 0, mode: 'pressed' },
      { device: 'gamepad', kind: 'button', button: 'R1', mode: 'pressed' },
    ],
  },
];
