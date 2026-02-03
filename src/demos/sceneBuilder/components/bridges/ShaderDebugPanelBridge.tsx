/**
 * ShaderDebugPanelBridge - Wraps the imperative ShaderDebugPanel class with Preact
 */

import { h } from 'preact';
import { useRef, useEffect, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { ShaderDebugPanel } from '../../ShaderDebugPanel';

// Global visibility signal (accessible for menu/keyboard toggle)
export const shaderPanelVisible = signal(false);

// Handler for syncing close event back to signal
function handlePanelClose() {
  shaderPanelVisible.value = false;
}

// ==================== Hook for Shader Panel ====================

export function useShaderDebugPanel() {
  const toggle = useCallback(() => {
    shaderPanelVisible.value = !shaderPanelVisible.value;
  }, []);
  
  const show = useCallback(() => {
    shaderPanelVisible.value = true;
  }, []);
  
  const hide = useCallback(() => {
    shaderPanelVisible.value = false;
  }, []);
  
  return { visible: shaderPanelVisible, toggle, show, hide };
}

// ==================== Component ====================

export interface ShaderDebugPanelContainerProps {
  container?: HTMLDivElement | null;
}

/**
 * ShaderDebugPanelContainer - Mounts the ShaderDebugPanel to a container
 * The panel is rendered imperatively by the ShaderDebugPanel class
 */
export function ShaderDebugPanelContainer({ container }: ShaderDebugPanelContainerProps) {
  const panelRef = useRef<ShaderDebugPanel | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Initialize panel
  useEffect(() => {
    const target = container || containerRef.current;
    if (!target) return;
    
    panelRef.current = new ShaderDebugPanel(target, {
      onClose: handlePanelClose,
    });
    
    return () => {
      panelRef.current?.destroy();
      panelRef.current = null;
    };
  }, [container]);
  
  // Sync visibility with signal
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    
    if (shaderPanelVisible.value) {
      panel.show();
    } else {
      panel.hide();
    }
  }, [shaderPanelVisible.value]);
  
  // If no external container, render a placeholder div for panel mounting
  if (container) {
    return null;
  }
  
  return <div ref={containerRef} />;
}

// ==================== Export Helpers ====================

export function toggleShaderPanel(): void {
  shaderPanelVisible.value = !shaderPanelVisible.value;
}

export function showShaderPanel(): void {
  shaderPanelVisible.value = true;
}

export function hideShaderPanel(): void {
  shaderPanelVisible.value = false;
}
