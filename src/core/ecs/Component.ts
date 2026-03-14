import type { ComponentType } from './types';

/**
 * Base class for all components.
 * Components are data bags — they hold state but contain minimal logic.
 */
export abstract class Component {
  /** Unique type identifier for this component kind */
  abstract readonly type: ComponentType;

  /**
   * Optional: Expose a named GPU resource for shader binding.
   * Called by ResourceResolver when building bind groups.
   * Return null if this component doesn't provide the named resource.
   */
  getGPUResource?(name: string): GPUBindingResource | null;

  /** Optional: Cleanup when removed from an entity */
  destroy?(): void;

  /** Optional: Serialize for save/load */
  serialize?(): Record<string, unknown>;

  /** Optional: Deserialize from saved data */
  deserialize?(data: Record<string, unknown>): void;

  /**
   * Optional: Create a shallow clone of this component for entity duplication.
   * Subclasses should override to provide proper cloning.
   *
   * By default returns null, meaning the component cannot be auto-cloned
   * and must be handled by explicit duplication logic (e.g., for GPU-owning
   * components like MeshComponent or singleton components like TerrainComponent).
   */
  clone?(): Component | null;
}
