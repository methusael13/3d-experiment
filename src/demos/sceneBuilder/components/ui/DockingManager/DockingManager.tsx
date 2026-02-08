/**
 * DockingManager - Context provider for managing multiple dockable windows
 * 
 * Features:
 * - Manages window state (open/closed, z-index ordering)
 * - Provides context for window operations
 * - Renders all windows as a layer
 * - Click-to-focus brings windows to front
 */

import { h, createContext, ComponentChildren, VNode } from 'preact';
import { useState, useCallback, useMemo } from 'preact/hooks';
import { DockableWindow, WindowPosition, WindowSize } from '../DockableWindow';

// ==================== Types ====================

export interface WindowConfig {
  /** Unique window identifier */
  id: string;
  /** Window title */
  title: string;
  /** Optional emoji/icon */
  icon?: string;
  /** Initial position */
  defaultPosition?: WindowPosition;
  /** Initial size */
  defaultSize?: WindowSize;
  /** Minimum size constraints */
  minSize?: WindowSize;
  /** Maximum size constraints */
  maxSize?: WindowSize;
  /** Window content (VNode) */
  content: VNode | (() => VNode);
  /** Called when window is closed via button */
  onClose?: () => void;
}

export interface WindowState {
  config: WindowConfig;
  zIndex: number;
}

export interface DockingManagerContextValue {
  /** Open a new window or bring existing to front */
  openWindow: (config: WindowConfig) => void;
  /** Close a window by id */
  closeWindow: (id: string) => void;
  /** Bring a window to the front */
  bringToFront: (id: string) => void;
  /** Check if a window is open */
  isWindowOpen: (id: string) => boolean;
  /** Get all open window ids */
  getOpenWindowIds: () => string[];
  /** Toggle a window (open if closed, close if open) */
  toggleWindow: (config: WindowConfig) => void;
}

// ==================== Context ====================

export const DockingManagerContext = createContext<DockingManagerContextValue | null>(null);

// ==================== Provider Component ====================

interface DockingManagerProviderProps {
  children: ComponentChildren;
  /** Base z-index for windows (default: 1000) */
  baseZIndex?: number;
}

export function DockingManagerProvider({
  children,
  baseZIndex = 1000,
}: DockingManagerProviderProps) {
  // Map of window id -> window state
  const [windows, setWindows] = useState<Map<string, WindowState>>(new Map());
  // Counter for z-index assignment (increments on each focus)
  const [zCounter, setZCounter] = useState(0);

  // ==================== Window Operations ====================

  const openWindow = useCallback((config: WindowConfig) => {
    setWindows((prev) => {
      const newMap = new Map(prev);
      const existing = newMap.get(config.id);
      
      if (existing) {
        // Window exists - bring to front by updating z-index
        setZCounter((c) => c + 1);
        newMap.set(config.id, {
          ...existing,
          zIndex: baseZIndex + zCounter + 1,
        });
      } else {
        // New window - add with current z-index
        setZCounter((c) => c + 1);
        newMap.set(config.id, {
          config,
          zIndex: baseZIndex + zCounter + 1,
        });
      }
      
      return newMap;
    });
  }, [baseZIndex, zCounter]);

  const closeWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const newMap = new Map(prev);
      const windowState = newMap.get(id);
      
      // Call onClose callback if provided
      if (windowState?.config.onClose) {
        windowState.config.onClose();
      }
      
      newMap.delete(id);
      return newMap;
    });
  }, []);

  const bringToFront = useCallback((id: string) => {
    setWindows((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      
      setZCounter((c) => c + 1);
      const newMap = new Map(prev);
      newMap.set(id, {
        ...existing,
        zIndex: baseZIndex + zCounter + 1,
      });
      return newMap;
    });
  }, [baseZIndex, zCounter]);

  const isWindowOpen = useCallback((id: string) => {
    return windows.has(id);
  }, [windows]);

  const getOpenWindowIds = useCallback(() => {
    return Array.from(windows.keys());
  }, [windows]);

  const toggleWindow = useCallback((config: WindowConfig) => {
    if (windows.has(config.id)) {
      closeWindow(config.id);
    } else {
      openWindow(config);
    }
  }, [windows, openWindow, closeWindow]);

  // ==================== Context Value ====================

  const contextValue = useMemo<DockingManagerContextValue>(() => ({
    openWindow,
    closeWindow,
    bringToFront,
    isWindowOpen,
    getOpenWindowIds,
    toggleWindow,
  }), [openWindow, closeWindow, bringToFront, isWindowOpen, getOpenWindowIds, toggleWindow]);

  // ==================== Render ====================

  return (
    <DockingManagerContext.Provider value={contextValue}>
      {children}
      
      {/* Render all open windows */}
      {Array.from(windows.values()).map((windowState) => {
        const { config, zIndex } = windowState;
        const content = typeof config.content === 'function' 
          ? config.content() 
          : config.content;
        
        return (
          <DockableWindow
            key={config.id}
            id={config.id}
            title={config.title}
            icon={config.icon}
            defaultPosition={config.defaultPosition}
            defaultSize={config.defaultSize}
            minSize={config.minSize}
            maxSize={config.maxSize}
            zIndex={zIndex}
            onClose={() => closeWindow(config.id)}
            onFocus={() => bringToFront(config.id)}
          >
            {content}
          </DockableWindow>
        );
      })}
    </DockingManagerContext.Provider>
  );
}

export default DockingManagerProvider;
