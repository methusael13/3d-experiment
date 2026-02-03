/**
 * useKeyboardShortcuts - Global keyboard shortcuts for Scene Builder
 */

import { useEffect, useCallback } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';

/**
 * Hook that handles global keyboard shortcuts
 * Must be called from within a component
 */
export function useKeyboardShortcuts() {
  const store = getSceneBuilderStore();
  
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if typing in an input
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    
    const scene = store.scene;
    const viewport = store.viewport;
    
    // ==================== Gizmo Mode Shortcuts ====================
    
    // T - Translate mode
    if (e.key === 't' || e.key === 'T') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        store.setGizmoMode('translate');
        e.preventDefault();
        return;
      }
    }
    
    // R - Rotate mode
    if (e.key === 'r' || e.key === 'R') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        store.setGizmoMode('rotate');
        e.preventDefault();
        return;
      }
    }
    
    // S - Uniform scale mode (starts scale operation)
    if (e.key === 's' || e.key === 'S') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // Set gizmo to scale mode
        store.setGizmoMode('scale');
        // TODO: Start uniform scale drag if viewport supports it
        e.preventDefault();
        return;
      }
    }
    
    // ==================== Object Manipulation ====================
    
    // D - Duplicate selected objects
    if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey) {
      if (scene && store.selectionCount.value > 0) {
        const selectedIds = Array.from(store.selectedIds.value);
        for (const id of selectedIds) {
          scene.duplicateObject(id);
        }
        store.syncFromScene();
        e.preventDefault();
        return;
      }
    }
    
    // Delete or Backspace - Delete selected objects
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (scene && store.selectionCount.value > 0) {
        const selectedIds = Array.from(store.selectedIds.value);
        for (const id of selectedIds) {
          scene.removeObject(id);
        }
        store.syncFromScene();
        e.preventDefault();
        return;
      }
    }
    
    // A - Select all toggle
    if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey) {
      if (scene) {
        const allObjects = scene.getAllObjects();
        const allSelected = store.selectionCount.value === allObjects.length;
        
        if (allSelected) {
          // Deselect all
          scene.clearSelection();
        } else {
          // Select all
          for (const obj of allObjects) {
            scene.select(obj.id, { additive: true });
          }
        }
        store.syncFromScene();
        e.preventDefault();
        return;
      }
    }
    
    // ==================== Grouping ====================
    
    // Ctrl+G - Group selection
    if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      if (scene && store.selectionCount.value >= 2) {
        scene.createGroupFromSelection();
        store.syncFromScene();
        e.preventDefault();
        return;
      }
    }
    
    // Ctrl+Shift+G - Ungroup
    if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      if (scene && store.selectionCount.value > 0) {
        scene.ungroupSelection();
        store.syncFromScene();
        e.preventDefault();
        return;
      }
    }
    
    // ==================== Camera Presets ====================
    
    // 0-3 - Camera presets
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const controller = viewport ? (viewport as any).cameraController : null;
      
      switch (e.key) {
        case '0': // Perspective
          if (controller?.setAngles) {
            controller.setAngles(0.5, 0.3);
            e.preventDefault();
          }
          return;
        case '1': // Front
          if (controller?.setAngles) {
            controller.setAngles(0, 0);
            e.preventDefault();
          }
          return;
        case '2': // Top
          if (controller?.setAngles) {
            controller.setAngles(0, Math.PI / 2);
            e.preventDefault();
          }
          return;
        case '3': // Side
          if (controller?.setAngles) {
            controller.setAngles(Math.PI / 2, 0);
            e.preventDefault();
          }
          return;
      }
    }
    
  }, [store]);
  
  // Attach listener on mount
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
