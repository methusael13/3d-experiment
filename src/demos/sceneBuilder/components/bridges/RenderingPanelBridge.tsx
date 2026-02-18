/**
 * RenderingPanelBridge - Connects RenderingPanel Preact component to the store
 */

import { useState, useCallback } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { RenderingPanel, type WebGPUShadowSettings, type SSAOSettings } from '../panels';
import type { CompositeEffectConfig } from '@/core/gpu/postprocess';

// ==================== Local Rendering State ====================
// These are rendering-specific settings that don't need to be in the global store

interface RenderingState {
  shadowSettings: WebGPUShadowSettings;
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
    // CSM defaults
    csmEnabled: false,
    cascadeCount: 4,
    cascadeBlendFraction: 0.1,
  },
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
  onShadowSettingsChange?: (settings: WebGPUShadowSettings) => void;
}

// ==================== Connected Component ====================

export function ConnectedRenderingPanel({
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

  /** Apply the correct shadow debug textures based on CSM state */
  const applyShadowDebugTextures = useCallback((enabled: boolean, csmEnabled: boolean, cascadeCount: number) => {
    const debugManager = store.viewport?.getDebugTextureManager?.();
    if (!debugManager) return;

    if (csmEnabled) {
      // CSM mode: show cascade maps, hide single map
      debugManager.setEnabled('shadow-map', false);
      for (let i = 0; i < 4; i++) {
        debugManager.setEnabled(`csm-cascade-${i}`, enabled && i < cascadeCount);
      }
    } else {
      // Single map mode: show single map, hide all cascades
      debugManager.setEnabled('shadow-map', enabled);
      for (let i = 0; i < 4; i++) {
        debugManager.setEnabled(`csm-cascade-${i}`, false);
      }
    }
  }, [store]);

  const handleShadowDebugToggle = useCallback((enabled: boolean) => {
    applyShadowDebugTextures(enabled, shadowSettings.csmEnabled ?? false, shadowSettings.cascadeCount ?? 4);
    setShowShadowThumbnail(enabled);
  }, [shadowSettings.csmEnabled, shadowSettings.cascadeCount, applyShadowDebugTextures]);

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
      // Re-apply debug textures if thumbnail is visible and CSM settings changed
      if (showShadowThumbnail && (settings.csmEnabled !== undefined || settings.cascadeCount !== undefined)) {
        applyShadowDebugTextures(true, updated.csmEnabled ?? false, updated.cascadeCount ?? 4);
      }
      return updated;
    });
  }, [store, externalShadowChange, showShadowThumbnail, applyShadowDebugTextures]);
  
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
      onShadowDebugToggle={handleShadowDebugToggle}
      onShadowSettingsChange={handleShadowSettingsChange}
      ssaoSettings={ssaoSettings}
      onSSAOSettingsChange={handleSSAOSettingsChange}
      compositeSettings={compositeSettings}
      onCompositeSettingsChange={handleCompositeSettingsChange}
    />
  );
}

// ==================== Utility to set status from outside ====================

export function updateRenderingStatus(status: string) {
  // This could be connected to a signal if needed
}
