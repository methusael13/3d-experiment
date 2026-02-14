/**
 * ViewportContainer - Preact wrapper for the Viewport class
 * Handles lifecycle and bridges props to imperative Viewport API
 */

import { useRef, useEffect, useCallback } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { Viewport, type ViewportOptions } from '../../Viewport';
import { getSceneBuilderStore } from '../state';
import { ViewportToolbar } from '../layout';
import { useFileDrop } from '../hooks';
import { setCurrentFps } from '../bridges/MenuBarBridge';
import type { Vec3 } from '../../../../core/types';
import type { quat } from 'gl-matrix';
import styles from './ViewportContainer.module.css';

// ==================== Types ====================

export interface ViewportContainerProps {
  width?: number;
  height?: number;
  onFps?: (fps: number) => void;
  onInitialized?: (viewport: Viewport) => void;
}

export interface ViewportContainerHandle {
  getViewport(): Viewport | null;
  getGL(): WebGL2RenderingContext | null;
}

// ==================== Component ====================

export function ViewportContainer({
  width = 800,
  height = 600,
  onFps,
  onInitialized,
}: ViewportContainerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const store = getSceneBuilderStore();
  
  // ==================== Resize Handling ====================
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && viewportRef.current && canvasRef.current) {
          // Update canvas dimensions
          canvasRef.current.width = Math.floor(width);
          canvasRef.current.height = Math.floor(height);
          
          // Notify viewport of resize
          viewportRef.current.resize(Math.floor(width), Math.floor(height));
        }
      }
    });
    
    resizeObserver.observe(containerRef.current);
    
    return () => {
      resizeObserver.disconnect();
    };
  }, []);
  
  // ==================== Viewport Lifecycle ====================
  
  useEffect(() => {
    if (!canvasRef.current) return;
    
    // Get initial size from container
    const containerWidth = containerRef.current?.clientWidth ?? width;
    const containerHeight = containerRef.current?.clientHeight ?? height;
    
    const viewportOptions: ViewportOptions = {
      width: containerWidth,
      height: containerHeight,
      onFps: (fps: number) => {
        // Update the menu bar FPS display
        setCurrentFps(fps);
        // Also call the prop callback if provided
        onFps?.(fps);
      },
      onUpdate: (dt: number) => {
        // Wind update callback - will be connected when windManager is set
        const windManager = store.windManager;
        if (windManager) {
          windManager.update(dt);
          for (const [_, settings] of store.objectWindSettings.value) {
            windManager.updateObjectPhysics(settings, dt);
          }
          viewportRef.current?.setWindParams(windManager.getShaderUniforms());
        }
      },
      onGizmoTransform: (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat) => {
        const scene = store.scene;
        if (scene) {
          scene.applyTransform(type, value as any);
          store.syncFromScene();
        }
      },
      onGizmoDragEnd: () => {
        store.scene?.resetTransformTracking();
        updateGizmoTarget();
      },
      onUniformScaleChange: (newScale: Vec3) => {
        const scene = store.scene;
        if (scene && store.selectionCount.value === 1) {
          const obj = scene.getFirstSelected();
          if (obj) {
            obj.scale = newScale;
            scene.updateObjectTransform(obj.id);
            store.syncFromScene();
            updateGizmoTarget();
          }
        }
      },
      onUniformScaleCommit: () => {
        // Scale committed
      },
      onUniformScaleCancel: () => {
        // Viewport already returned original scale
      },
      onObjectClicked: (objectId: string, shiftKey: boolean) => {
        store.select(objectId, shiftKey);
      },
      onBackgroundClicked: (shiftKey: boolean) => {
        if (!shiftKey) store.clearSelection();
      },
    };
    
    const viewport = new Viewport(canvasRef.current, viewportOptions);
    const asyncInit = async () => {
      const initiated = await viewport.init();
      if (!initiated) {
        console.error('[ViewportContainer] Failed to initialize Viewport');
        return;
      }

      viewportRef.current = viewport;
      store.viewport = viewport;
      
      // Set overlay container
      if (containerRef.current) {
        viewport.setOverlayContainer(containerRef.current);
      }
      
      // Get GL context and notify
      if (onInitialized) {
        onInitialized(viewport);
      }
    }
    asyncInit();

    return () => {
      viewport.destroy();
      viewportRef.current = null;
      store.viewport = null;
    };
  }, []); // Only run once on mount

  useSignalEffect(() => {
    // Update gizmo target on selection change
    const _ = store.selectedIds.value;
    updateGizmoTarget();
  });

  // ==================== Sync State to Viewport ====================
  
  const updateGizmoTarget = useCallback(() => {
    const scene = store.scene;
    const viewport = viewportRef.current;
    if (!scene || !viewport) return;
    
    const target = scene.getGizmoTarget();
    if (target.position && target.rotationQuat) {
      viewport.setGizmoTargetWithQuat(target.position, target.rotationQuat, target.scale ?? undefined);
    } else {
      viewport.setGizmoTarget(target.position ?? null, target.rotation ?? undefined, target.scale ?? undefined);
    }
    scene.resetTransformTracking();
  }, []);
  
  // Sync gizmo mode changes
  useSignalEffect(() => {
    const mode = store.gizmoMode.value;
    viewportRef.current?.setGizmoMode(mode);
  });
  
  // Sync gizmo orientation changes
  useSignalEffect(() => {
    const orientation = store.gizmoOrientation.value;
    viewportRef.current?.setGizmoOrientation(orientation);
  });
  
  // Sync viewport mode changes
  useSignalEffect(() => {
    const state = store.viewportState.value;
    viewportRef.current?.setViewportMode(state.mode);
    viewportRef.current?.setShowGrid(state.showGrid);
    viewportRef.current?.setShowAxes(state.showAxes);
  });
  
  // ==================== File Drop ====================
  
  const fileDropState = useFileDrop(containerRef);
  
  // ==================== Event Handlers ====================
  
  // Stop mouse events from bubbling to the document
  const handleMouseEvent = useCallback((e: MouseEvent) => {
    e.stopPropagation();
  }, []);
  
  // ==================== Render ====================
  
  return (
    <div 
      ref={containerRef} 
      class={`${styles.container} ${fileDropState.isDragging ? styles.dragging : ''}`}
      onWheel={handleMouseEvent}
    >
      <canvas
        ref={canvasRef}
        id="canvas"
        class={styles.canvas}
      />
      
      {/* Viewport Toolbar */}
      <ViewportToolbar />
      
      {/* Drop overlay */}
      {fileDropState.isDragging && (
        <div class={styles.dropOverlay}>
          <div class={styles.dropMessage}>
            <span class={styles.dropIcon}>📂</span>
            <span>Drop files to import</span>
            <span class={styles.dropHint}>GLB, OBJ, HDR, JSON</span>
          </div>
        </div>
      )}
      
      {/* Loading overlay */}
      {fileDropState.isProcessing && (
        <div class={styles.loadingOverlay}>
          <div class={styles.loadingSpinner} />
          <span>Importing...</span>
        </div>
      )}
    </div>
  );
}
