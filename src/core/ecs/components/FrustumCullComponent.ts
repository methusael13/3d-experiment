import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * FrustumCullComponent — Singleton component that holds the set of entity IDs
 * visible in the current frame's camera frustum.
 *
 * Populated each frame by FrustumCullSystem. Read by VariantRenderer to skip
 * entities whose AABBs are entirely outside the frustum.
 *
 * Attach this to a dedicated "Frustum Cull" entity (or any singleton entity).
 * There should only be one in the world.
 */
export class FrustumCullComponent extends Component {
  readonly type: ComponentType = 'frustum-cull';

  /** Set of entity IDs that passed frustum culling this frame. */
  visibleEntityIds: Set<string> = new Set();

  /** Whether frustum culling is enabled. When disabled, all entities are rendered. */
  enabled = true;

  /** Number of entities culled last frame (for debug stats). */
  culledCount = 0;

  /** Number of entities visible last frame (for debug stats). */
  visibleCount = 0;

  /** Total entities tested last frame. */
  totalTested = 0;
}