import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { AABB } from '../../sceneObjects/types';

/**
 * Bounds component — local and world-space axis-aligned bounding boxes.
 *
 * The BoundsSystem recomputes worldBounds when dirty (transform changed).
 */
export class BoundsComponent extends Component {
  readonly type: ComponentType = 'bounds';

  localBounds: AABB | null = null;
  worldBounds: AABB | null = null;
  dirty: boolean = true;

  clone(): BoundsComponent {
    const c = new BoundsComponent();
    if (this.localBounds) {
      c.localBounds = {
        min: [...this.localBounds.min] as [number, number, number],
        max: [...this.localBounds.max] as [number, number, number],
      };
    }
    c.dirty = true;
    return c;
  }
}
