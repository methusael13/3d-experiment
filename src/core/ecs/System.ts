import type { ComponentType, SystemContext } from './types';
import type { Entity } from './Entity';

/**
 * Base class for all systems.
 * Systems process entities that have a specific set of components.
 * They are stateless processors — all state lives in components.
 */
export abstract class System {
  /** Unique system name */
  abstract readonly name: string;

  /** Component types an entity must have for this system to process it */
  abstract readonly requiredComponents: readonly ComponentType[];

  /** Execution priority (lower = earlier). Default 0. */
  priority: number = 0;

  /** Whether this system is currently active. */
  enabled: boolean = true;

  /**
   * Process matching entities for this frame.
   * Called by World.update() with pre-filtered entity list.
   */
  abstract update(
    entities: Entity[],
    deltaTime: number,
    context: SystemContext,
  ): void;

  /** Optional: One-time initialization when system is added to World */
  initialize?(context: SystemContext): void;

  /** Optional: Cleanup when system is removed from World */
  destroy?(): void;
}