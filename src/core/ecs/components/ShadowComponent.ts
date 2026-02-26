import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Shadow component — opt-in shadow casting and receiving.
 *
 * Replaces the `castsShadow` field that was baked into SceneObject.
 * Only entities with this component participate in shadow passes.
 */
export class ShadowComponent extends Component {
  readonly type: ComponentType = 'shadow';

  castsShadow: boolean = true;
  receivesShadow: boolean = true;

  /**
   * Maximum distance from the camera at which this object participates in shadows.
   * Beyond this distance, the object will neither cast nor sample shadows.
   * Defaults to Infinity (no distance limit).
   */
  maxShadowDistance: number = Infinity;
}