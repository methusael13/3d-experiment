import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { WindComponent } from '../components/WindComponent';
import { WindSourceComponent } from '../components/WindSourceComponent';
import { TransformComponent } from '../components/TransformComponent';
import { WindManager } from '../../../demos/sceneBuilder/wind';
import {
  calculateWindForce,
  updateSpringPhysics,
  decaySpringToRest,
  computeLocalWindContribution,
} from '../../wind/WindForce';
import type { Vec2 } from '../../types';
import type { SpringParams, WindForceParams } from '../../wind/types';

/**
 * WindSystem — self-contained wind simulation with global + local sources.
 *
 * Priority 50: after TransformSystem (0) and BoundsSystem (10),
 * before render systems (100).
 *
 * ## Architecture
 *
 * The system maintains two entity sets:
 * 1. **Receivers**: entities with `[transform, wind]` — things that respond to wind
 *    (vegetation, flags, cloth, etc.)
 * 2. **Sources**: entities with `[transform, wind-source]` — local wind emitters
 *    (helicopters, fans, explosions, etc.)
 *
 * Each frame, for each receiver:
 * 1. Start with the global wind force from WindManager
 * 2. Iterate all local wind sources and accumulate their contributions
 *    (with distance-based falloff and shape attenuation)
 * 3. Run the spring physics simulation with the combined force
 * 4. Write displacement/velocity to the WindComponent
 *
 * Global wind is always applied uniformly (no spatial falloff).
 * Local sources use per-entity position for distance calculations.
 *
 * The Viewport doesn't need to know about WindManager internals —
 * it just registers this system. UI reads global wind state via
 * getWindManager() accessor.
 */
export class WindSystem extends System {
  readonly name = 'wind';
  readonly requiredComponents: readonly ComponentType[] = ['transform', 'wind'];
  priority = 50;

  private windManager: WindManager;

  /** Spring physics parameters (shared across all receivers) */
  private readonly springParams: SpringParams = {
    springStiffness: 2.0,
    damping: 0.92,
    mass: 1.0,
  };

  /** Cached list of wind source entities (rebuilt each frame) */
  private windSources: Entity[] = [];

  constructor() {
    super();
    this.windManager = new WindManager();
  }

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    // Collect wind source entities from the world
    this.windSources = context.world.queryAny('wind-source');

    // Update global wind simulation (gusts, time)
    if (this.windManager.enabled) {
      this.windManager.update(deltaTime);
    }

    // Update gust state for each local wind source
    for (const srcEntity of this.windSources) {
      const src = srcEntity.getComponent<WindSourceComponent>('wind-source');
      if (!src || !src.enabled) continue;
      this.updateSourceGust(src, deltaTime);
    }

    // Sync spring params from WindManager (in case UI changed them)
    this.springParams.springStiffness = this.windManager.springStiffness;
    this.springParams.damping = this.windManager.damping;

    // Process each wind receiver
    for (const entity of entities) {
      const wind = entity.getComponent<WindComponent>('wind');
      if (!wind || !wind.enabled) {
        if (wind) decaySpringToRest(wind);
        continue;
      }

      if (!this.windManager.enabled && this.windSources.length === 0) {
        decaySpringToRest(wind);
        continue;
      }

      // Accumulate total force from global + local sources
      const totalForce: Vec2 = [0, 0];

      // 1. Global wind contribution
      if (this.windManager.enabled) {
        const globalForce = this.windManager.calculateWindForce();
        totalForce[0] += globalForce[0];
        totalForce[1] += globalForce[1];
      }

      // 2. Local wind source contributions
      if (this.windSources.length > 0) {
        const receiverTransform = entity.getComponent<TransformComponent>('transform');
        if (receiverTransform) {
          const receiverPos: [number, number, number] = [
            receiverTransform.position[0],
            receiverTransform.position[1],
            receiverTransform.position[2],
          ];

          for (const srcEntity of this.windSources) {
            const src = srcEntity.getComponent<WindSourceComponent>('wind-source');
            const srcTransform = srcEntity.getComponent<TransformComponent>('transform');
            if (!src || !src.enabled || !srcTransform) continue;

            const sourcePos: [number, number, number] = [
              srcTransform.position[0],
              srcTransform.position[1],
              srcTransform.position[2],
            ];

            // Compute spatial contribution (direction + attenuation)
            const contribution = computeLocalWindContribution(
              src.shape,
              sourcePos,
              receiverPos,
              src.direction,
              src.coneAngle,
              src.innerRadius,
              src.radius,
              src.falloff,
            );

            if (!contribution) continue;

            // Build force params for this source
            const sourceForceParams: WindForceParams = {
              direction: contribution.direction,
              strength: src.strength,
              turbulence: src.turbulence,
              gustIntensity: src._currentGust,
              gustVector: src._gustVector,
            };

            // Calculate the raw wind force from this source
            const localForce = calculateWindForce(sourceForceParams, src._time);

            // Apply distance/angular attenuation and add to total
            totalForce[0] += localForce[0] * contribution.attenuation;
            totalForce[1] += localForce[1] * contribution.attenuation;
          }
        }
      }

      // Run spring physics with combined force
      updateSpringPhysics(
        wind,
        totalForce,
        this.springParams,
        wind.influence,
        wind.stiffness,
        deltaTime,
      );
    }
  }

  /**
   * Update gust simulation for a local wind source (mirrors WindManager.update logic).
   */
  private updateSourceGust(src: WindSourceComponent, deltaTime: number): void {
    src._time += deltaTime;
    src._gustTime += deltaTime;

    if (src._gustTime > 1 / src.gustFrequency) {
      src._gustTime = 0;
      src._currentGust = Math.random() * src.gustStrength;
      src._gustVector = [
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
      ];
    }

    // Decay gust over time
    src._currentGust *= 0.93;
    src._gustVector[0] *= 0.95;
    src._gustVector[1] *= 0.95;
  }

  /**
   * Get the underlying WindManager (for UI reads/writes of global wind state).
   */
  getWindManager(): WindManager {
    return this.windManager;
  }
}
