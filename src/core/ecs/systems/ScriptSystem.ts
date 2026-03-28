/**
 * ScriptSystem — Per-frame script execution with setup/update/teardown lifecycle.
 *
 * Runs at priority 96 (after AnimationSystem at 95, before MeshRenderSystem at 100).
 * Lazy-loads script modules via dynamic import() from public/scripts/.
 *
 * Lifecycle:
 * - `setup()` is called once on Play Mode enter (or first frame the script is encountered)
 * - `update()` is called every frame during Play Mode
 * - `teardown()` is called when Play Mode exits
 *
 * Scripts read/write ECS components through the ScriptContext, which provides
 * access to the entity, world, deltaTime, user params, character vars, and input state.
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import type { ScriptComponent } from '../components/ScriptComponent';
import { CharacterVarsComponent } from '../components/CharacterVarsComponent';
import type { ScriptContext, ScriptModule, ScriptInstance } from '../../scripting/types';

export class ScriptSystem extends System {
  readonly name = 'script';
  readonly requiredComponents: readonly ComponentType[] = ['script'];
  priority = 96; // After AnimationSystem (95), before MeshRenderSystem (100)

  private _isPlayMode = false;
  private _elapsedTime = 0;

  /** Cache of loaded modules keyed by script path */
  private _moduleCache: Map<string, ScriptModule | null> = new Map();

  /** Pending async loads — prevents duplicate import() calls */
  private _pendingLoads: Map<string, Promise<ScriptModule | null>> = new Map();

  // ==================== Play Mode Lifecycle ====================

  /**
   * Enter Play Mode — resets elapsed time. setup() is called lazily
   * on first update for each script (not here).
   */
  enterPlayMode(): void {
    this._isPlayMode = true;
    this._elapsedTime = 0;
  }

  /**
   * Exit Play Mode — calls teardown() on all initialized scripts and
   * resets their initialization state.
   */
  exitPlayMode(entities: Entity[]): void {
    for (const entity of entities) {
      const scriptComp = entity.getComponent<ScriptComponent>('script');
      if (!scriptComp) continue;

      const vars = entity.getComponent<CharacterVarsComponent>('character-vars')
        ?? new CharacterVarsComponent();

      for (const instance of scriptComp.scripts) {
        if (instance._module?.teardown && instance._initialized) {
          try {
            const ctx = this.buildContext(entity, instance, 0, { world: null as any } as SystemContext, vars);
            instance._module.teardown(ctx);
          } catch (err) {
            console.error(`[ScriptSystem] Error in teardown for ${instance.path}:`, err);
          }
        }
        instance._initialized = false;
      }
    }
    this._isPlayMode = false;
  }

  get isPlayMode(): boolean {
    return this._isPlayMode;
  }

  // ==================== Per-Frame Update ====================

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    if (!this._isPlayMode) return;

    this._elapsedTime += deltaTime;

    for (const entity of entities) {
      const scriptComp = entity.getComponent<ScriptComponent>('script');
      if (!scriptComp) continue;

      const vars = entity.getComponent<CharacterVarsComponent>('character-vars')
        ?? new CharacterVarsComponent();

      for (const instance of scriptComp.scripts) {
        // Skip play-mode-only scripts when not playing (redundant since we check _isPlayMode above)
        if (instance.playModeOnly && !this._isPlayMode) continue;

        // Lazy-load the module
        if (!instance._module && !instance._loadFailed) {
          this.loadScriptModule(instance);
          continue; // Skip this frame while loading
        }
        if (!instance._module) continue;

        // Build context
        const ctx = this.buildContext(entity, instance, deltaTime, context, vars);

        // Call setup() once
        if (!instance._initialized) {
          try {
            instance._module.setup?.(ctx);
          } catch (err) {
            console.error(`[ScriptSystem] Error in setup for ${instance.path}:`, err);
          }
          instance._initialized = true;
        }

        // Call update() every frame
        try {
          instance._module.update(ctx);
        } catch (err) {
          console.error(`[ScriptSystem] Error in update for ${instance.path}:`, err);
        }
      }
    }
  }

  // ==================== Module Loading ====================

  /**
   * Load a script module via dynamic import().
   * Uses Vite's module resolution for .ts files in public/scripts/.
   * The result is cached so subsequent scripts referencing the same file
   * share the module reference.
   */
  private loadScriptModule(instance: ScriptInstance): void {
    const path = instance.path;

    // Check cache first
    if (this._moduleCache.has(path)) {
      instance._module = this._moduleCache.get(path) ?? null;
      if (!instance._module) instance._loadFailed = true;
      return;
    }

    // Check if already loading
    if (this._pendingLoads.has(path)) return;

    // Start async load
    const loadPromise = this.doLoadModule(path);
    this._pendingLoads.set(path, loadPromise);

    loadPromise.then((mod) => {
      this._moduleCache.set(path, mod);
      this._pendingLoads.delete(path);

      if (mod) {
        instance._module = mod;
      } else {
        instance._loadFailed = true;
      }
    });
  }

  private async doLoadModule(scriptPath: string): Promise<ScriptModule | null> {
    try {
      // Vite resolves /scripts/... paths at dev time from public/
      // In production, these would be bundled or served as static assets
      const mod = await import(/* @vite-ignore */ `/scripts/${scriptPath}`);
      const scriptModule: ScriptModule = {
        setup: typeof mod.setup === 'function' ? mod.setup : undefined,
        update: typeof mod.update === 'function' ? mod.update : undefined as any,
        teardown: typeof mod.teardown === 'function' ? mod.teardown : undefined,
      };

      if (!scriptModule.update) {
        console.warn(`[ScriptSystem] Script "${scriptPath}" does not export an update() function — skipping.`);
        return null;
      }

      console.log(`[ScriptSystem] Loaded script: ${scriptPath}`);
      return scriptModule;
    } catch (err) {
      console.warn(`[ScriptSystem] Failed to load script: ${scriptPath}`, err);
      return null;
    }
  }

  /**
   * Force reload a script module (e.g., after hot-reload).
   * Clears the cached module and resets initialization for all instances using it.
   */
  reloadScript(scriptPath: string, entities: Entity[]): void {
    this._moduleCache.delete(scriptPath);
    this._pendingLoads.delete(scriptPath);

    for (const entity of entities) {
      const scriptComp = entity.getComponent<ScriptComponent>('script');
      if (!scriptComp) continue;

      for (const instance of scriptComp.scripts) {
        if (instance.path === scriptPath) {
          instance._module = null;
          instance._initialized = false;
          instance._loadFailed = false;
        }
      }
    }
  }

  // ==================== Context Building ====================

  private buildContext(
    entity: Entity,
    instance: ScriptInstance,
    deltaTime: number,
    context: SystemContext,
    vars: CharacterVarsComponent,
  ): ScriptContext {
    return {
      entity,
      deltaTime,
      time: this._elapsedTime,
      world: context.world,
      params: instance.params,
      vars,
      input: this.buildInputAccessor(vars),
    };
  }

  private buildInputAccessor(vars: CharacterVarsComponent): ScriptContext['input'] {
    return {
      isActionHeld: (action: string) => vars.bools.get(`input_${action}_held`) === true,
      isActionPressed: (action: string) => vars.bools.get(`input_${action}`) === true,
    };
  }

  // ==================== Cleanup ====================

  destroy(): void {
    this._moduleCache.clear();
    this._pendingLoads.clear();
  }
}
