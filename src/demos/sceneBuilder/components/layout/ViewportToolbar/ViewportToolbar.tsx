/**
 * ViewportToolbar - Floating toolbar over the viewport for quick toggles
 */

import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { getSceneBuilderStore } from '../../state';
import styles from './ViewportToolbar.module.css';

// Create local signals for view settings (not in store yet)
const showGrid = signal(true);
const showAxes = signal(true);
const viewportMode = signal<'solid' | 'wireframe'>('solid');

export function ViewportToolbar() {
  const store = getSceneBuilderStore();
  
  const handleToggleSolid = useCallback(() => {
    viewportMode.value = 'solid';
    const viewport = store.viewport;
    if (viewport) {
      viewport.setViewportMode('solid');
    }
  }, [store]);
  
  const handleToggleWireframe = useCallback(() => {
    viewportMode.value = 'wireframe';
    const viewport = store.viewport;
    if (viewport) {
      viewport.setViewportMode('wireframe');
    }
  }, [store]);
  
  const handleToggleGrid = useCallback(() => {
    showGrid.value = !showGrid.value;
    const viewport = store.viewport;
    if (viewport) {
      viewport.setShowGrid(showGrid.value);
    }
  }, [store]);
  
  const handleToggleAxes = useCallback(() => {
    showAxes.value = !showAxes.value;
    const viewport = store.viewport;
    if (viewport) {
      viewport.setShowAxes(showAxes.value);
    }
  }, [store]);
  
  return (
    <div class={styles.toolbar}>
      {/* Viewport Mode */}
      <div class={styles.group}>
        <button
          class={`${styles.button} ${viewportMode.value === 'solid' ? styles.active : ''}`}
          onClick={handleToggleSolid}
          title="Solid View"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
        </button>
        <button
          class={`${styles.button} ${viewportMode.value === 'wireframe' ? styles.active : ''}`}
          onClick={handleToggleWireframe}
          title="Wireframe View"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.27 6.96L12 12.01l8.73-5.05" />
            <path d="M12 22.08V12" />
          </svg>
        </button>
      </div>
      
      <span class={styles.divider} />
      
      {/* Visibility Toggles */}
      <div class={styles.group}>
        <button
          class={`${styles.button} ${showGrid.value ? styles.active : ''}`}
          onClick={handleToggleGrid}
          title="Toggle Grid"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
        <button
          class={`${styles.button} ${showAxes.value ? styles.active : ''}`}
          onClick={handleToggleAxes}
          title="Toggle Axes"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2">
            <line x1="2" y1="20" x2="22" y2="20" stroke="#ff4444" />
            <line x1="4" y1="22" x2="4" y2="2" stroke="#44ff44" />
            <line x1="2" y1="18" x2="8" y2="8" stroke="#4444ff" />
          </svg>
        </button>
      </div>
    </div>
  );
}
