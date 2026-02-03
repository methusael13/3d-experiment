/**
 * RenderingPanelBridge - Connects RenderingPanel Preact component to the store
 */

import { useState, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { RenderingPanel, type WebGPUShadowSettings } from '../panels';

// ==================== Local Rendering State ====================
// These are rendering-specific settings that don't need to be in the global store

interface RenderingState {
  shadowSettings: WebGPUShadowSettings;
  showShadowThumbnail: boolean;
  webgpuEnabled: boolean;
  webgpuStatus: string;
}

const defaultRenderingState: RenderingState = {
  shadowSettings: {
    enabled: true,
    resolution: 2048,
    shadowRadius: 200,
    softShadows: true,
  },
  showShadowThumbnail: false,
  webgpuEnabled: false,
  webgpuStatus: 'Not initialized',
};

// ==================== Types ====================

export interface ConnectedRenderingPanelProps {
  onToggleWebGPU?: (enabled: boolean) => void;
  onShadowSettingsChange?: (settings: WebGPUShadowSettings) => void;
}

// ==================== Connected Component ====================

export function ConnectedRenderingPanel({
  onToggleWebGPU,
  onShadowSettingsChange: externalShadowChange,
}: ConnectedRenderingPanelProps) {
  const store = getSceneBuilderStore();
  
  // Local state for rendering settings
  const [shadowSettings, setShadowSettings] = useState<WebGPUShadowSettings>(
    defaultRenderingState.shadowSettings
  );
  const [showShadowThumbnail, setShowShadowThumbnail] = useState(false);
  
  // Handlers
  const handleShadowSettingsChange = useCallback((settings: Partial<WebGPUShadowSettings>) => {
    setShadowSettings(prev => {
      const updated = { ...prev, ...settings };
      if (externalShadowChange) {
        externalShadowChange(updated);
      }
      // Update viewport shadow settings if available
      const viewport = store.viewport;
      if (viewport) {
        viewport.setWebGPUShadowSettings(updated);
      }
      return updated;
    });
  }, [store, externalShadowChange]);
  
  const handleShowShadowThumbnailChange = useCallback((show: boolean) => {
    setShowShadowThumbnail(show);
    const viewport = store.viewport;
    if (viewport) {
      viewport.setShowShadowThumbnail(show);
    }
  }, [store]);
  
  return (
    <RenderingPanel
      shadowSettings={shadowSettings}
      showShadowThumbnail={showShadowThumbnail}
      onShadowSettingsChange={handleShadowSettingsChange}
      onShowShadowThumbnailChange={handleShowShadowThumbnailChange}
      webgpuEnabled={store.isWebGPU.value}
      webgpuStatus={store.isWebGPU.value ? 'Initialized' : 'Not initialized'}
      onToggleWebGPU={onToggleWebGPU ?? (() => {})}
    />
  );
}

// ==================== Utility to set status from outside ====================

export function updateRenderingStatus(status: string) {
  // This could be connected to a signal if needed
}
