/**
 * useKeyboardShortcuts - Global keyboard shortcuts for Scene Builder
 * 
 * Uses InputManager 'editor' channel so shortcuts are disabled during FPS mode.
 */

import { useEffect, useCallback, useRef } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import type { InputEvent, InputManager } from '../../InputManager';
import { Vec3 } from '@/core/types';

/**
 * Hook that handles global keyboard shortcuts
 * Must be called from within a component
 */
export function useKeyboardShortcuts() {
  const store = getSceneBuilderStore();
  const handlerRef = useRef<((e: InputEvent<KeyboardEvent>) => void) | null>(null);
  
  const handleKeyDown = useCallback((e: InputEvent<KeyboardEvent>) => {
    // Ignore if typing in an input (check originalEvent target)
    const target = e.originalEvent.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }
    
    const scene = store.scene;
    const viewport = store.viewport;
    const key = e.key;
    
    // ==================== Gizmo Mode Shortcuts ====================
    
    // T - Translate mode
    if (key === 't' || key === 'T') {
      if (!e.ctrlKey && !e.altKey) {
        store.setGizmoMode('translate');
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // R - Rotate mode
    if (key === 'r' || key === 'R') {
      if (!e.ctrlKey && !e.altKey) {
        store.setGizmoMode('rotate');
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // S - Uniform scale mode (starts uniform scale operation)
    if (key === 's' || key === 'S') {
      if (!e.ctrlKey && !e.altKey) {
        // Uniform scale requires exactly 1 object selected and no active gizmo drag
        if (scene && store.selectionCount.value === 1 && viewport) {
          const v = viewport;
          
          // Check if gizmo is already dragging or uniform scale is active
          if (!v.isGizmoDragging?.() && !v.isUniformScaleActive?.()) {
            // Get the selected object
            const selectedIds = Array.from(store.selectedIds.value);
            const obj = scene.getObject(selectedIds[0]);
            
            if (obj) {
              // Get object's current scale
              const startScale = [...obj.scale] as [number, number, number];
              
              // Project object position to screen space
              const objectScreenPos = v.projectObjectToScreen(obj.position as Vec3);
              
              // Get current mouse position
              const mousePos = v.getLastMousePos();
              
              // Start uniform scale mode
              v.startUniformScale(startScale, objectScreenPos, mousePos);
              e.originalEvent.preventDefault();
              return;
            }
          }
        }
        
        // Fallback: just set gizmo to scale mode (per-axis scale)
        store.setGizmoMode('scale');
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // ==================== Object Manipulation ====================
    
    // D - Duplicate selected objects
    if ((key === 'd' || key === 'D') && !e.ctrlKey) {
      if (scene && store.selectionCount.value > 0) {
        const selectedIds = Array.from(store.selectedIds.value);
        for (const id of selectedIds) {
          scene.duplicateObject(id);
        }
        store.syncFromScene();
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // Delete or Backspace - Delete selected objects
    if (key === 'Delete' || key === 'Backspace') {
      if (scene && store.selectionCount.value > 0) {
        const selectedIds = Array.from(store.selectedIds.value);
        for (const id of selectedIds) {
          scene.removeObject(id);
        }
        store.syncFromScene();
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // A - Select all toggle
    if ((key === 'a' || key === 'A') && !e.ctrlKey) {
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
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // ==================== Grouping ====================
    
    // Ctrl+G - Group selection
    if ((key === 'g' || key === 'G') && e.ctrlKey && !e.shiftKey) {
      if (scene && store.selectionCount.value >= 2) {
        scene.createGroupFromSelection();
        store.syncFromScene();
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // Ctrl+Shift+G - Ungroup
    if ((key === 'g' || key === 'G') && e.ctrlKey && e.shiftKey) {
      if (scene && store.selectionCount.value > 0) {
        scene.ungroupSelection();
        store.syncFromScene();
        e.originalEvent.preventDefault();
        return;
      }
    }
    
    // ==================== Camera Presets ====================
    
    // 0-3 - Camera presets
    if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
      const controller = viewport ? (viewport as any).cameraController : null;
      
      switch (key) {
        case '0': // Perspective
          if (controller?.setAngles) {
            controller.setAngles(0.5, 0.3);
            e.originalEvent.preventDefault();
          }
          return;
        case '1': // Front
          if (controller?.setAngles) {
            controller.setAngles(0, 0);
            e.originalEvent.preventDefault();
          }
          return;
        case '2': // Top
          if (controller?.setAngles) {
            controller.setAngles(0, Math.PI / 2);
            e.originalEvent.preventDefault();
          }
          return;
        case '3': // Side
          if (controller?.setAngles) {
            controller.setAngles(Math.PI / 2, 0);
            e.originalEvent.preventDefault();
          }
          return;
      }
    }
    
  }, [store]);
  
  // Store handler reference for cleanup
  handlerRef.current = handleKeyDown;
  
  // Attach to InputManager 'editor' channel on mount
  useEffect(() => {
    if (!store.viewportInitialized.value) {
      return;
    }

    const viewport = store.viewport;
    const inputManager = viewport?.getInputManager();

    if (!inputManager) {
      console.warn('[useKeyboardShortcuts] No InputManager available');
      return;
    }
    
    // Subscribe to 'editor' channel - won't receive events during FPS mode
    const handler = (e: InputEvent<KeyboardEvent>) => {
      handlerRef.current?.(e);
    };
    
    inputManager.on('editor', 'keydown', handler);
    
    return () => {
      inputManager.off('editor', 'keydown', handler);
    };
  }, [store.viewportInitialized]);
}
