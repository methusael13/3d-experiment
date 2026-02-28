/**
 * SSRSystem - Manages per-entity SSR state based on LOD level.
 *
 * Runs before MeshRenderSystem (priority 95) to update SSRComponent.enabled
 * based on the entity's current LOD level. SSR is only active at LOD 0
 * (highest detail / closest to camera).
 *
 * MeshRenderSystem then simply reads SSRComponent.enabled to decide
 * whether to include the 'ssr' shader feature for a given entity.
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { SSRComponent } from '../components/SSRComponent';
import { LODComponent } from '../components/LODComponent';

export class SSRSystem extends System {
  readonly name = 'ssr';
  readonly priority = 95; // After LODSystem (10), before MeshRenderSystem (100)
  // SSRSystem only needs to run when SSRComponent entities exist
  readonly requiredComponents: readonly ComponentType[] = ['ssr'];

  /**
   * Whether SSR is globally enabled (set from pipeline/UI).
   * When false, all SSRComponents are disabled regardless of LOD.
   */
  ssrGloballyEnabled: boolean = false;

  /**
   * Whether any SSR consumers exist in the scene this frame.
   * True if any SSR-enabled opaque entity exists (ocean does its own inline SSR).
   * Read by SSRPass to skip the fullscreen ray march when there are no consumers.
   */
  hasConsumers: boolean = false;

  update(entities: Entity[], deltaTime: number, _ctx: SystemContext): void {
    let anyEnabled = false;

    // Process entities that have SSRComponent (LOD gating)
    for (const entity of entities) {
      const ssr = entity.getComponent<SSRComponent>('ssr');
      if (!ssr) continue; // Skip entities without SSR component

      // If SSR is globally disabled, disable per-entity
      if (!this.ssrGloballyEnabled) {
        ssr.enabled = false;
        continue;
      }

      // Check LOD level — only enable SSR at LOD 0
      const lod = entity.getComponent<LODComponent>('lod');
      const currentLOD = lod?.currentLOD ?? 0; // No LODComponent = always LOD 0

      // SSR only at LOD 0 (highest detail / closest to camera)
      ssr.enabled = currentLOD === 0;

      if (ssr.enabled) {
        anyEnabled = true;
      }
    }

    // SSR pass should run if there's at least one opaque SSR-enabled entity
    // (ocean/water does its own inline SSR ray march, not dependent on SSR pass)
    this.hasConsumers = anyEnabled;
  }
}
