/**
 * DockingManager - Context and hooks for managing dockable windows
 */

export { 
  DockingManagerProvider, 
  DockingManagerContext,
  default,
} from './DockingManager';
export type { 
  WindowConfig, 
  WindowState, 
  DockingManagerContextValue,
} from './DockingManager';

export { useDockingManager } from './useDockingManager';
