/**
 * DockableWindow - Reusable draggable/resizable window component
 * 
 * Features:
 * - Drag by header (constrained to viewport)
 * - Resize from corner with min/max constraints
 * - Minimize collapses in place
 * - Close button with callback
 * - Z-index management for layering
 * - Keyboard event isolation
 */

import { h, ComponentChildren } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import styles from './DockableWindow.module.css';

// ==================== Types ====================

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface DockableWindowProps {
  /** Unique window identifier */
  id: string;
  /** Window title displayed in header */
  title: string;
  /** Optional emoji/icon before title */
  icon?: string;
  /** Initial position (defaults to centered) */
  defaultPosition?: WindowPosition;
  /** Initial size */
  defaultSize?: WindowSize;
  /** Minimum allowed size */
  minSize?: WindowSize;
  /** Maximum allowed size */
  maxSize?: WindowSize;
  /** Z-index for layering (managed by DockingManager) */
  zIndex?: number;
  /** Called when close button clicked */
  onClose?: () => void;
  /** Called when window is clicked (for bring-to-front) */
  onFocus?: () => void;
  /** Window content */
  children: ComponentChildren;
}

// ==================== Default Values ====================

const DEFAULT_SIZE: WindowSize = { width: 500, height: 400 };
const DEFAULT_MIN_SIZE: WindowSize = { width: 300, height: 200 };
const DEFAULT_MAX_SIZE: WindowSize = { width: 1200, height: 900 };

// ==================== Component ====================

export function DockableWindow({
  id,
  title,
  icon,
  defaultPosition,
  defaultSize = DEFAULT_SIZE,
  minSize = DEFAULT_MIN_SIZE,
  maxSize = DEFAULT_MAX_SIZE,
  zIndex = 1000,
  onClose,
  onFocus,
  children,
}: DockableWindowProps) {
  // Position and size state
  const [position, setPosition] = useState<WindowPosition>(() => {
    if (defaultPosition) return defaultPosition;
    // Default to right side of viewport
    return {
      x: Math.max(10, window.innerWidth - defaultSize.width - 20),
      y: 60,
    };
  });
  const [size, setSize] = useState<WindowSize>(defaultSize);
  const [isMinimized, setIsMinimized] = useState(false);
  
  // Drag/resize state refs
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const windowRef = useRef<HTMLDivElement>(null);

  // ==================== Drag Logic ====================

  const handleHeaderMouseDown = useCallback((e: MouseEvent) => {
    // Ignore if clicking buttons
    if ((e.target as HTMLElement).closest('button')) return;
    
    isDragging.current = true;
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    
    // Bring to front
    onFocus?.();
  }, [position, onFocus]);

  // ==================== Resize Logic ====================

  const handleResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;
    onFocus?.();
  }, [onFocus]);

  // ==================== Global Mouse Handlers ====================

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        // Calculate new position
        let newX = e.clientX - dragOffset.current.x;
        let newY = e.clientY - dragOffset.current.y;
        
        // Constrain to viewport bounds
        const winWidth = windowRef.current?.offsetWidth || size.width;
        const winHeight = windowRef.current?.offsetHeight || size.height;
        
        // Keep at least 100px visible horizontally, header visible vertically
        newX = Math.max(0, Math.min(window.innerWidth - winWidth, newX));
        newY = Math.max(0, Math.min(window.innerHeight - 50, newY));
        
        setPosition({ x: newX, y: newY });
      }
      
      if (isResizing.current && windowRef.current) {
        const rect = windowRef.current.getBoundingClientRect();
        
        // Calculate new size from mouse position
        let newWidth = e.clientX - rect.left;
        let newHeight = e.clientY - rect.top;
        
        // Apply min/max constraints
        newWidth = Math.max(minSize.width, Math.min(maxSize.width, newWidth));
        newHeight = Math.max(minSize.height, Math.min(maxSize.height, newHeight));
        
        // Also constrain to viewport
        const maxViewportWidth = window.innerWidth - position.x - 10;
        const maxViewportHeight = window.innerHeight - position.y - 10;
        newWidth = Math.min(newWidth, maxViewportWidth);
        newHeight = Math.min(newHeight, maxViewportHeight);
        
        setSize({ width: newWidth, height: newHeight });
      }
    };
    
    const handleMouseUp = () => {
      isDragging.current = false;
      isResizing.current = false;
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [position, size, minSize, maxSize]);

  // ==================== Keyboard Event Isolation ====================

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  // ==================== Render ====================

  const windowClasses = [
    styles.window,
    isMinimized ? styles.minimized : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={windowRef}
      className={windowClasses}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${size.width}px`,
        height: isMinimized ? 'auto' : `${size.height}px`,
        zIndex,
      }}
      onMouseDown={onFocus}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      data-window-id={id}
    >
      {/* Header */}
      <div 
        className={styles.header}
        onMouseDown={handleHeaderMouseDown}
      >
        <span className={styles.title}>
          {icon && <span className={styles.icon}>{icon}</span>}
          {title}
        </span>
        <div className={styles.controls}>
          <button 
            className={styles.controlBtn}
            onClick={() => setIsMinimized(!isMinimized)}
            title={isMinimized ? 'Restore' : 'Minimize'}
          >
            {isMinimized ? '+' : '−'}
          </button>
          <button 
            className={`${styles.controlBtn} ${styles.closeBtn}`}
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>
      
      {/* Body */}
      <div className={styles.body}>
        {children}
      </div>
      
      {/* Resize Handle */}
      <div 
        className={styles.resizeHandle}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
}

export default DockableWindow;
