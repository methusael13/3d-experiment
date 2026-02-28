/**
 * ReflectionProbeSystem — Manages per-entity reflection probe bake lifecycle.
 *
 * Runs before MeshRenderSystem (priority 96) to update ReflectionProbeComponent
 * state. When a probe has `bakeState === 'pending'`, this system coordinates
 * with the ReflectionProbeCaptureRenderer to capture 6 cubemap faces.
 *
 * When a baked probe is available and enabled, MeshRenderSystem will include the
 * 'reflection-probe' shader feature instead of 'ssr' for that entity.
 *
 * Auto-bake: if `autoBakeOnTransformChange` is true, the system detects
 * transform changes and sets bakeState to 'pending'.
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { ReflectionProbeComponent } from '../components/ReflectionProbeComponent';
import { TransformComponent } from '../components/TransformComponent';
import { BoundsComponent } from '../components/BoundsComponent';
import { ReflectionProbeCaptureRenderer } from '@/core/gpu/renderers/ReflectionProbeCaptureRenderer';

/**
 * Simple hash of a Float32Array for change detection.
 */
function hashMatrix(m: Float32Array | number[]): number {
  let h = 0;
  for (let i = 0; i < 16; i++) {
    // Use a simple FNV-like hash on the float bits
    h = (h * 31 + ((m[i] * 1000) | 0)) | 0;
  }
  return h;
}

export class ReflectionProbeSystem extends System {
  readonly name = 'reflection-probe';
  readonly priority = 96; // After LODSystem (10), before MeshRenderSystem (100)
  readonly requiredComponents: readonly ComponentType[] = ['reflection-probe'];

  /**
   * Reference to the capture renderer — set externally by the Viewport/Pipeline.
   * When null, bake requests are deferred until the renderer is available.
   */
  captureRenderer: ReflectionProbeCaptureRenderer | null = null;

  update(entities: Entity[], _deltaTime: number, ctx: SystemContext): void {
    for (const entity of entities) {
      const probe = entity.getComponent<ReflectionProbeComponent>('reflection-probe');
      if (!probe || !probe.enabled) continue;

      // Auto-bake on transform change detection
      if (probe.autoBakeOnTransformChange && probe.bakeState === 'baked') {
        const transform = entity.getComponent<TransformComponent>('transform');
        if (transform) {
          const currentHash = hashMatrix(transform.modelMatrix as Float32Array);
          if (currentHash !== probe._lastTransformHash) {
            probe._lastTransformHash = currentHash;
            probe.bakeState = 'pending';
          }
        }
      }

      // Process pending bakes
      if (probe.bakeState === 'pending' && this.captureRenderer) {
        // Determine capture position from AABB center or transform position
        const capturePos = this.getCapturePosition(entity);
        probe.capturePosition = capturePos;
        probe.bakeState = 'baking';

        // Initiate the bake
        this.captureRenderer.bakeProbe(entity, probe, capturePos, ctx);
      }

      // Note: Per-entity probe binding is handled by VariantRenderer.renderColor(),
      // which reads the probe cubemap directly from the entity's ReflectionProbeComponent.
      // We do NOT push to SceneEnvironment here since it's a global singleton and would
      // overwrite probes from other entities.
    }
  }

  /**
   * Get the world-space capture position for the probe.
   * Prefers AABB center if BoundsComponent is available, otherwise uses transform position.
   */
  private getCapturePosition(entity: Entity): [number, number, number] {
    const bounds = entity.getComponent<BoundsComponent>('bounds');
    if (bounds && bounds.worldBounds) {
      const aabb = bounds.worldBounds;
      return [
        (aabb.min[0] + aabb.max[0]) * 0.5,
        (aabb.min[1] + aabb.max[1]) * 0.5,
        (aabb.min[2] + aabb.max[2]) * 0.5,
      ];
    }

    // Fallback: extract translation from model matrix
    const transform = entity.getComponent<TransformComponent>('transform');
    if (transform) {
      const m = transform.modelMatrix;
      return [m[12] as number, m[13] as number, m[14] as number];
    }

    return [0, 0, 0];
  }
}