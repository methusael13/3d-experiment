/**
 * Script System Types — Interfaces for the per-frame scripting runtime.
 *
 * Scripts are TypeScript modules stored under `public/scripts/` that the
 * engine hot-loads and executes each frame during Play Mode. They provide
 * an escape hatch for custom per-frame behavior that the predefined nodes
 * can't express.
 *
 * Each script exports `setup()`, `update()`, and optionally `teardown()`.
 * The engine builds a ScriptContext each frame and passes it to `update()`.
 */

import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { CharacterVarsComponent } from '../ecs/components/CharacterVarsComponent';

// ============================================================================
// Script Module — What a script file exports
// ============================================================================

export interface ScriptModule {
  /** Called once when Play Mode starts (or when the script is hot-reloaded) */
  setup?: (ctx: ScriptContext) => void;

  /** Called every frame during Play Mode */
  update: (ctx: ScriptContext) => void;

  /** Called when Play Mode exits or the script is about to be hot-reloaded */
  teardown?: (ctx: ScriptContext) => void;
}

// ============================================================================
// Script Context — Passed to script functions each frame
// ============================================================================

export interface ScriptContext {
  /** The entity this script is attached to */
  entity: Entity;

  /** Frame delta time in seconds */
  deltaTime: number;

  /** Total elapsed time since Play Mode started (seconds) */
  time: number;

  /** The ECS world — for querying other entities */
  world: World;

  /** User-configured parameters from the Script Node UI */
  params: Record<string, number | boolean | string>;

  /** Character runtime variables (read/write). Same object as CharacterVarsComponent. */
  vars: CharacterVarsComponent;

  /** Input state — check if actions are pressed/held */
  input: {
    isActionHeld(action: string): boolean;
    isActionPressed(action: string): boolean; // True for one frame
  };
}

// ============================================================================
// Script Param — Declared in script files for auto-generated UI
// ============================================================================

export interface ScriptParamDef {
  type: 'number' | 'boolean' | 'string';
  default: number | boolean | string;
  /** For numbers: min value for the slider UI */
  min?: number;
  /** For numbers: max value for the slider UI */
  max?: number;
  /** For numbers: step for the slider UI */
  step?: number;
}

/**
 * Script Instance — Runtime state for a single attached script.
 * Stored in ScriptComponent.scripts[].
 */
export interface ScriptInstance {
  /** Asset path to the script file (relative to public/scripts/) */
  path: string;

  /** User-configured parameter values */
  params: Record<string, number | boolean | string>;

  /** Whether to run only in Play Mode */
  playModeOnly: boolean;

  /** Human-readable label (from Script Node) */
  label: string;

  /** Loaded module reference (set by ScriptSystem at runtime) */
  _module: ScriptModule | null;

  /** Whether setup() has been called */
  _initialized: boolean;

  /** Loading state */
  _loadFailed: boolean;
}
