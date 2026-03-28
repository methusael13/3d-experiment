/**
 * ActionInputManager — Polling-based action input manager.
 *
 * Merges data from all registered InputProviders each frame into
 * unified ActionState objects. Systems read actions by name, never
 * seeing raw hardware events.
 *
 * This sits alongside the existing channel-based InputManager (which
 * handles editor mode DOM events). In play mode, systems read from
 * ActionInputManager; in editor mode, the existing InputManager handles
 * orbit camera, gizmos, etc.
 */

import type { InputProvider } from './InputProvider';
import type { KeyboardMouseProvider } from './KeyboardMouseProvider';
import type {
  InputBinding,
  InputSource,
  ActionState,
  ActionDeactivateCondition,
} from './types';
import { NULL_ACTION_STATE, DEFAULT_BINDINGS } from './types';

/**
 * Get a unique string key for an input source (used for toggle/prev tracking).
 */
function sourceKey(source: InputSource): string {
  if (source.device === 'keyboard') return `kb:${source.key}`;
  if (source.device === 'mouse') return `mouse:${source.button}`;
  if (source.device === 'gamepad' && source.kind === 'button') return `gp:btn:${source.button}`;
  if (source.device === 'gamepad' && source.kind === 'axis') return `gp:axis:${source.axis}:${source.direction}`;
  return 'unknown';
}

/**
 * Get the activation mode for a source.
 */
function getSourceMode(source: InputSource): 'held' | 'pressed' | 'toggle' {
  if (source.device === 'gamepad' && 'kind' in source && source.kind === 'axis') {
    return 'held'; // Axes are always analog/held
  }
  if ('mode' in source && source.mode) {
    return source.mode;
  }
  // Defaults
  if (source.device === 'keyboard') return 'held';
  if (source.device === 'mouse') return 'held';
  return 'held';
}

export class ActionInputManager {
  private providers: InputProvider[] = [];
  private actionStates: Map<string, ActionState> = new Map();
  private bindings: InputBinding[] = [...DEFAULT_BINDINGS];

  // Toggle state tracking
  private toggleStates: Map<string, boolean> = new Map();

  // Previous frame source values (for edge detection on toggle/pressed)
  private prevSourceValues: Map<string, number> = new Map();

  // Runtime variables for auto-deactivation conditions (e.g., speed)
  private runtimeVars: Map<string, number> = new Map();

  // ==================== Provider Management ====================

  addProvider(provider: InputProvider): void {
    // Prevent duplicate registration
    if (this.providers.some(p => p.id === provider.id)) return;
    this.providers.push(provider);
    console.log(`[ActionInputManager] Added provider: ${provider.name}`);
  }

  removeProvider(id: string): void {
    const idx = this.providers.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.providers[idx].destroy();
      this.providers.splice(idx, 1);
    }
  }

  getProvider(id: string): InputProvider | undefined {
    return this.providers.find(p => p.id === id);
  }

  /**
   * Get the KeyboardMouseProvider (convenience accessor).
   */
  getKeyboardMouseProvider(): KeyboardMouseProvider | undefined {
    return this.providers.find(p => p.id === 'keyboard-mouse') as KeyboardMouseProvider | undefined;
  }

  // ==================== Binding Management ====================

  setBindings(bindings: InputBinding[]): void {
    this.bindings = bindings;
    // Reset toggle states when bindings change
    this.toggleStates.clear();
    this.prevSourceValues.clear();
  }

  getBindings(): readonly InputBinding[] {
    return this.bindings;
  }

  // ==================== Runtime Variables ====================

  /**
   * Set a runtime variable (e.g., 'speed') that can be used in
   * auto-deactivation conditions for toggle actions.
   */
  setRuntimeVar(name: string, value: number): void {
    this.runtimeVars.set(name, value);
  }

  // ==================== Per-Frame Polling ====================

  /**
   * Called once per frame, before PlayerSystem.
   * Polls all providers and computes ActionState for each binding.
   */
  pollAll(): void {
    // 1. Poll all providers
    for (const p of this.providers) {
      p.poll();
    }

    // 2. Process each binding
    for (const binding of this.bindings) {
      const prev = this.actionStates.get(binding.action);
      const wasActive = prev?.active ?? false;

      let maxHeldValue = 0;
      let anyPressedTriggered = false;
      let anyToggleJustPressed = false;

      for (const source of binding.sources) {
        const mode = getSourceMode(source);
        const sk = sourceKey(source);

        // Read current raw value from all providers (take max)
        let rawValue = 0;
        for (const provider of this.providers) {
          rawValue = Math.max(rawValue, provider.readSource(source));
        }

        const prevValue = this.prevSourceValues.get(sk) ?? 0;
        const justPressed = rawValue > 0 && prevValue === 0;
        this.prevSourceValues.set(sk, rawValue);

        switch (mode) {
          case 'held':
            maxHeldValue = Math.max(maxHeldValue, rawValue);
            break;

          case 'pressed':
            if (justPressed) {
              anyPressedTriggered = true;
            }
            break;

          case 'toggle':
            if (justPressed) {
              anyToggleJustPressed = true;
            }
            break;
        }
      }

      // Flip toggle state on press
      if (anyToggleJustPressed) {
        const current = this.toggleStates.get(binding.action) ?? false;
        this.toggleStates.set(binding.action, !current);
      }

      // Check auto-deactivation for active toggles
      const toggleActive = this.toggleStates.get(binding.action) ?? false;
      if (toggleActive && binding.autoDeactivateWhen) {
        if (this.evaluateDeactivateCondition(binding.autoDeactivateWhen)) {
          this.toggleStates.set(binding.action, false);
        }
      }

      // Compute final state
      const finalToggleActive = this.toggleStates.get(binding.action) ?? false;
      const heldActive = maxHeldValue > 0;
      const active = heldActive || finalToggleActive || anyPressedTriggered;
      const value = finalToggleActive ? 1.0 : Math.max(maxHeldValue, anyPressedTriggered ? 1.0 : 0);

      this.actionStates.set(binding.action, {
        active,
        value,
        justPressed: active && !wasActive,
        justReleased: !active && wasActive,
      });
    }
  }

  // ==================== Reading Actions ====================

  /**
   * Read merged action state. Returns NULL_ACTION_STATE if action is not bound.
   */
  getAction(action: string): Readonly<ActionState> {
    return this.actionStates.get(action) ?? NULL_ACTION_STATE;
  }

  /**
   * Read merged camera axes from all providers (mouse delta + right stick).
   */
  getCameraAxes(): { deltaX: number; deltaY: number } {
    let dx = 0;
    let dy = 0;
    for (const p of this.providers) {
      const axes = p.readCameraAxis();
      dx += axes.deltaX;
      dy += axes.deltaY;
    }
    return { deltaX: dx, deltaY: dy };
  }

  /**
   * Read scroll wheel delta from KeyboardMouseProvider.
   */
  getScrollDelta(): number {
    const kbm = this.getKeyboardMouseProvider();
    return kbm?.readScrollDelta() ?? 0;
  }

  /**
   * Check if a specific key code is down (for non-action checks like Escape).
   */
  isKeyDown(code: string): boolean {
    const kbm = this.getKeyboardMouseProvider();
    return kbm?.isKeyDown(code) ?? false;
  }

  // ==================== Auto-Deactivation ====================

  private evaluateDeactivateCondition(cond: ActionDeactivateCondition): boolean {
    switch (cond.type) {
      case 'variable': {
        const val = this.runtimeVars.get(cond.variable) ?? 0;
        switch (cond.operator) {
          case '<':  return val < cond.value;
          case '<=': return val <= cond.value;
          case '==': return val === cond.value;
          case '>':  return val > cond.value;
          case '>=': return val >= cond.value;
        }
        return false;
      }
      case 'actionInactive': {
        const other = this.actionStates.get(cond.action);
        return !other?.active;
      }
    }
  }

  // ==================== Cleanup ====================

  /**
   * Reset all action states (useful when exiting play mode).
   */
  resetAll(): void {
    this.actionStates.clear();
    this.toggleStates.clear();
    this.prevSourceValues.clear();
    this.runtimeVars.clear();
  }

  destroy(): void {
    for (const p of this.providers) {
      p.destroy();
    }
    this.providers = [];
    this.resetAll();
  }
}
