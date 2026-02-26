import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { WindComponent } from '../components/WindComponent';
import { WindManager } from '../../../demos/sceneBuilder/wind';

/**
 * WindSystem — self-contained wind simulation system.
 *
 * Priority 50: after TransformSystem (0) and BoundsSystem (10),
 * before render systems (100).
 *
 * Owns its own WindManager (global wind parameters: direction, strength,
 * turbulence, gusts). Each frame, for each entity with WindComponent,
 * the system calls WindManager.updateObjectPhysics() to advance the spring
 * simulation, updating displacement and velocity on the component.
 *
 * The Viewport doesn't need to know about WindManager internals —
 * it just registers this system. UI reads global wind state via
 * getWindManager() accessor.
 *
 * Entities without WindComponent are never processed — zero cost.
 */
export class WindSystem extends System {
  readonly name = 'wind';
  readonly requiredComponents: readonly ComponentType[] = ['transform', 'wind'];
  priority = 50;

  private windManager: WindManager;

  constructor() {
    super();
    this.windManager = new WindManager();
  }

  update(entities: Entity[], deltaTime: number, _context: SystemContext): void {
    // Update global wind simulation (gusts, time)
    this.windManager.update(deltaTime);

    for (const entity of entities) {
      const wind = entity.getComponent<WindComponent>('wind');
      if (!wind) continue;

      // Delegate spring physics to WindManager using the component's data
      // WindComponent matches ObjectWindSettings interface structurally
      this.windManager.updateObjectPhysics(wind, deltaTime);
    }
  }

  /**
   * Get the underlying WindManager (for UI reads/writes of global wind state).
   */
  getWindManager(): WindManager {
    return this.windManager;
  }
}
