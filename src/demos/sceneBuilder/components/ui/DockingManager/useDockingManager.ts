/**
 * useDockingManager - Hook for accessing the DockingManager context
 */

import { useContext } from 'preact/hooks';
import { DockingManagerContext, DockingManagerContextValue } from './DockingManager';

/**
 * Hook to access the DockingManager context
 * Must be used within a DockingManagerProvider
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { openWindow, closeWindow, isWindowOpen } = useDockingManager();
 *   
 *   const handleOpenEditor = () => {
 *     openWindow({
 *       id: 'my-editor',
 *       title: 'My Editor',
 *       icon: '📝',
 *       content: <EditorContent />,
 *     });
 *   };
 *   
 *   return <button onClick={handleOpenEditor}>Open Editor</button>;
 * }
 * ```
 */
export function useDockingManager(): DockingManagerContextValue {
  const context = useContext(DockingManagerContext);
  
  if (!context) {
    throw new Error('useDockingManager must be used within a DockingManagerProvider');
  }
  
  return context;
}

export default useDockingManager;
