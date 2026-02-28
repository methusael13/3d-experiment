/**
 * RenderingPanelBridge - Connects RenderingPanel Preact component to the store
 */

import { useState, useCallback } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { RenderingPanel, type WebGPUShadowSettings, type SSAOSettings, type SSRSettings, type DebugViewMode } from '../panels';
import type { CompositeEffectConfig } from '@/core/gpu/postprocess';
import type { SSRQualityLevel } from '@/core/gpu/pipeline/SSRConfig';

// ==================== Local Rendering State ====================
// These are rendering-specific settings that don't need to be in the global store

interface RenderingState {
  shadowSettings: WebGPUShadowSettings;
  ssaoSettings: SSAOSettings;
  ssrSettings: SSRSettings;
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
  ssrSettings: {
    enabled: false,
    quality: 'medium' as SSRQualityLevel,
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
  const [ssrSettings, setSSRSettings] = useState<SSRSettings>(
    defaultRenderingState.ssrSettings
  );
  const [debugViewMode, setDebugViewMode] = useState<DebugViewMode>('off');
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
  
  const handleSSRSettingsChange = useCallback((settings: Partial<SSRSettings>) => {
    setSSRSettings(prev => {
      const updated = { ...prev, ...settings };
      // Update viewport SSR settings if available
      const viewport = store.viewport;
      if (viewport) {
        viewport.setSSRSettings(updated);
      }
      return updated;
    });
  }, [store]);
  
  const handleDebugViewModeChange = useCallback((mode: DebugViewMode) => {
    setDebugViewMode(mode);
    const viewport = store.viewport;
    if (viewport) {
      viewport.setDebugViewMode(mode);
    }
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
      ssrSettings={ssrSettings}
      onSSRSettingsChange={handleSSRSettingsChange}
      debugViewMode={debugViewMode}
      onDebugViewModeChange={handleDebugViewModeChange}
      compositeSettings={compositeSettings}
      onCompositeSettingsChange={handleCompositeSettingsChange}
    />
  );
}

// ==================== Utility to set status from outside ====================

export function updateRenderingStatus(status: string) {
  // This could be connected to a signal if needed
}
