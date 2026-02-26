import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Group component — assigns an entity to a named group for bulk operations.
 */
export class GroupComponent extends Component {
  readonly type: ComponentType = 'group';

  groupId: string | null = null;
}