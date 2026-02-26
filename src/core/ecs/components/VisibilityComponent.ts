import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Visibility component — controls whether an entity is rendered.
 */
export class VisibilityComponent extends Component {
  readonly type: ComponentType = 'visibility';

  visible: boolean = true;
}