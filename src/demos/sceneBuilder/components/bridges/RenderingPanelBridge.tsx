/**
 * RenderingPanelBridge - Connects RenderingPanel Preact component to the store
 */

import { useState, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { RenderingPanel, type WebGPUShadowSettings, type SSAOSettings } from '../panels';
import type { CompositeEffectConfig } from '@/core/gpu/postprocess';

// ==================== Local Rendering State ====================
// These are rendering-specific settings that don't need to be in the global store

interface RenderingState {
  shadowSettings: WebGPUShadowSettings;
  showShadowThumbnail: boolean;
  ssaoSettings: SSAOSettings;
  compositeSettings: Required<CompositeEffectConfig>;
  webgpuEnabled: boolean;
  webgpuStatus: string;
}

const defaultRenderingState: RenderingState = {
  shadowSettings: {
    enabled: true,
    resolution: 4096,
    shadowRadius: 200,
    softShadows: true,
  },
  showShadowThumbnail: false,
  ssaoSettings: {
    enabled: false,
    radius: 0.4,
    intensity: 0.8,
    bias: 0.025,
    samples: 64,
    blur: true,
  },
  compositeSettings: {
    tonemapping: 3, // ACES
    gamma: 2.2,
    exposure: 1.0,
  },
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
  const [ssaoSettings, setSSAOSettings] = useState<SSAOSettings>(
    defaultRenderingState.ssaoSettings
  );
  const [compositeSettings, setCompositeSettings] = useState<Required<CompositeEffectConfig>>(
    defaultRenderingState.compositeSettings
  );
  
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
  
  const handleSSAOSettingsChange = useCallback((settings: Partial<SSAOSettings>) => {
    setSSAOSettings(prev => {
      const updated = { ...prev, ...settings };
      // Update viewport SSAO settings if available
      const viewport = store.viewport;
      if (viewport) {
        viewport.setSSAOSettings(updated);
      }
      return updated;
    });
  }, [store]);
  
  const handleCompositeSettingsChange = useCallback((settings: Partial<CompositeEffectConfig>) => {
    setCompositeSettings(prev => {
      const updated = { ...prev, ...settings };
      // Update viewport composite settings if available
      const viewport = store.viewport;
      if (viewport) {
        viewport.setCompositeSettings(updated);
      }
      return updated;
    });
  }, [store]);
  
  return (
    <RenderingPanel
      shadowSettings={shadowSettings}
      showShadowThumbnail={showShadowThumbnail}
      onShadowSettingsChange={handleShadowSettingsChange}
      onShowShadowThumbnailChange={handleShowShadowThumbnailChange}
      ssaoSettings={ssaoSettings}
      onSSAOSettingsChange={handleSSAOSettingsChange}
      compositeSettings={compositeSettings}
      onCompositeSettingsChange={handleCompositeSettingsChange}
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
