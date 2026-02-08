/**
 * ShaderDebugPanelBridge - Uses DockingManager to show shader editor in a dockable window
 */

import { h } from 'preact';
import { useCallback, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useDockingManager, WindowConfig } from '../ui';
import { ShaderDebugContent } from '../panels/ShaderDebugPanel';

// ==================== Window Configuration ====================

const SHADER_WINDOW_ID = 'shader-editor';

const getShaderWindowConfig = (onClose: () => void): WindowConfig => ({
  id: SHADER_WINDOW_ID,
  title: 'Shader Editor',
  icon: '🔧',
  defaultPosition: { x: window.innerWidth - 570, y: 60 },
  defaultSize: { width: 550, height: 500 },
  minSize: { width: 400, height: 300 },
  maxSize: { width: 900, height: 800 },
  content: <ShaderDebugContent />,
  onClose,
});

// ==================== Global Visibility Signal ====================

// Global visibility signal (accessible for menu/keyboard toggle)
export const shaderPanelVisible = signal(false);

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

/**
 * ShaderDebugPanelContainer - Syncs visibility signal with DockingManager
 * Renders nothing - the actual window is rendered by DockingManagerProvider
 */
export function ShaderDebugPanelContainer() {
  const { openWindow, closeWindow, isWindowOpen } = useDockingManager();
  
  // Handler for window close (sync back to signal)
  const handleClose = useCallback(() => {
    shaderPanelVisible.value = false;
  }, []);
  
  // Sync signal with DockingManager
  useEffect(() => {
    const visible = shaderPanelVisible.value;
    const isOpen = isWindowOpen(SHADER_WINDOW_ID);
    
    if (visible && !isOpen) {
      openWindow(getShaderWindowConfig(handleClose));
    } else if (!visible && isOpen) {
      closeWindow(SHADER_WINDOW_ID);
    }
  }, [shaderPanelVisible.value, openWindow, closeWindow, isWindowOpen, handleClose]);
  
  // No DOM output - window rendered by DockingManager
  return null;
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
