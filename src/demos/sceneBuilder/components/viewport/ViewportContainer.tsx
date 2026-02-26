/**
 * ViewportContainer - Preact wrapper for the Viewport class
 * Handles lifecycle and bridges props to imperative Viewport API
 */

import { useRef, useEffect, useCallback } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import { vec3, quat as quatType } from 'gl-matrix';
import { Viewport, type ViewportOptions } from '../../Viewport';
import { getSceneBuilderStore } from '../state';
import { ViewportToolbar } from '../layout';
import { useFileDrop } from '../hooks';
import { setCurrentFps, setCurrentDrawCalls } from '../bridges/MenuBarBridge';
import { TransformComponent } from '@/core/ecs/components/TransformComponent';
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
          canvasRef.current.width = Math.floor(width);
          canvasRef.current.height = Math.floor(height);
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
    
    const containerWidth = containerRef.current?.clientWidth ?? width;
    const containerHeight = containerRef.current?.clientHeight ?? height;
    
    const viewportOptions: ViewportOptions = {
      width: containerWidth,
      height: containerHeight,
      onFps: (fps: number) => {
        setCurrentFps(fps);
        onFps?.(fps);
      },
      onDrawCalls: (count: number) => {
        setCurrentDrawCalls(count);
      },
      onUpdate: (_dt: number) => {
        // Wind is now handled by WindSystem inside ECS world.update()
      },
      onGizmoTransform: (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat) => {
        // Apply transform delta to selected entities via TransformComponent
        const world = store.world;
        if (!world) return;
        
        const selected = world.getSelectedEntities();
        for (const entity of selected) {
          const transform = entity.getComponent<TransformComponent>('transform');
          if (!transform) continue;
          
          if (type === 'position') {
            transform.setPosition(value as Vec3);
          } else if (type === 'rotation') {
            transform.setRotationQuat(value as quatType);
          } else if (type === 'scale') {
            transform.setScale(value as Vec3);
          }
        }
        store.syncFromWorld();
      },
      onGizmoDragEnd: () => {
        updateGizmoTarget();
      },
      onUniformScaleChange: (newScale: Vec3) => {
        const world = store.world;
        if (world && store.selectionCount.value === 1) {
          const selected = world.getSelectedEntities();
          if (selected.length === 1) {
            const transform = selected[0].getComponent<TransformComponent>('transform');
            if (transform) {
              transform.setScale(newScale);
              store.syncFromWorld();
              updateGizmoTarget();
            }
          }
        }
      },
      onUniformScaleCommit: () => {},
      onUniformScaleCancel: () => {},
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
      
      if (containerRef.current) {
        viewport.setOverlayContainer(containerRef.current);
      }
      
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
  }, []);

  useSignalEffect(() => {
    const _ = store.selectedIds.value;
    updateGizmoTarget();
  });

  // ==================== Sync State to Viewport ====================
  
  const updateGizmoTarget = useCallback(() => {
    const world = store.world;
    const viewport = viewportRef.current;
    if (!world || !viewport) return;
    
    const selected = world.getSelectedEntities();
    if (selected.length === 0) {
      viewport.setGizmoTarget(null);
      return;
    }
    
    // Use first selected entity's transform
    const entity = selected[0];
    const transform = entity.getComponent<TransformComponent>('transform');
    if (!transform) {
      viewport.setGizmoTarget(null);
      return;
    }
    
    const pos: Vec3 = [transform.position[0], transform.position[1], transform.position[2]];
    const scl: Vec3 = [transform.scale[0], transform.scale[1], transform.scale[2]];
    viewport.setGizmoTargetWithQuat(pos, transform.rotationQuat, scl);
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