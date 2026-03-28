/**
 * ScriptComponent — Holds references to attached script instances.
 *
 * Each script instance points to a .ts file under public/scripts/ and carries
 * user-configured parameter values from the Script Node UI. Multiple scripts
 * can be attached to a single entity (multiple Script Nodes in the graph).
 *
 * The ScriptSystem reads this component at runtime, lazy-loads the script
 * modules via dynamic import(), and calls their lifecycle functions
 * (setup/update/teardown) each frame during Play Mode.
 */

import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { ScriptInstance } from '../../scripting/types';

export class ScriptComponent extends Component {
  readonly type: ComponentType = 'script';

  /** Loaded script instances (multiple scripts can be attached) */
  scripts: ScriptInstance[] = [];

  /**
   * Add a script instance. If a script with the same path already exists,
   * it is replaced (updates params, keeps module reference if already loaded).
   */
  addScript(instance: ScriptInstance): void {
    const existing = this.scripts.findIndex(s => s.path === instance.path);
    if (existing >= 0) {
      // Preserve loaded module if path didn't change
      const prev = this.scripts[existing];
      instance._module = prev._module;
      instance._initialized = prev._initialized;
      instance._loadFailed = prev._loadFailed;
      this.scripts[existing] = instance;
    } else {
      this.scripts.push(instance);
    }
  }

  /**
   * Remove a script instance by path.
   */
  removeScript(path: string): void {
    this.scripts = this.scripts.filter(s => s.path !== path);
  }

  /**
   * Clear all script instances and reset their state.
   */
  clearAll(): void {
    for (const s of this.scripts) {
      s._module = null;
      s._initialized = false;
    }
    this.scripts = [];
  }

  destroy(): void {
    this.clearAll();
  }
}
