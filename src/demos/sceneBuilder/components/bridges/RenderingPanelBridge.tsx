/**
 * RenderingPanelBridge - Connects RenderingPanel Preact component to the store
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import { getSceneBuilderStore } from '../state';
import { RenderingPanel, type WebGPUShadowSettings, type SSAOSettings, type SSRSettings, type AtmosphericFogSettings, type VolumetricFogSettings, type CloudSettings, type GodRaySettings, type DebugViewMode, type ResolutionScalePreset } from '../panels';
import type { CompositeEffectConfig, AtmosphericFogConfig } from '@/core/gpu/postprocess';
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
  const [atmosphericFogSettings, setAtmosphericFogSettings] = useState<AtmosphericFogSettings>({
    enabled: false,
    visibilityDistance: 3000,
    hazeIntensity: 0.8,
    hazeScaleHeight: 800,
    heightFogEnabled: false,
    fogVisibilityDistance: 1500,
    fogMode: 'exp' as const,
    fogHeight: 0,
    fogHeightFalloff: 0.05,
    fogColor: [0.85, 0.88, 0.92],
    fogSunScattering: 0.3,
  });
  
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
  
  const handleAtmosphericFogSettingsChange = useCallback((settings: Partial<AtmosphericFogSettings>) => {
    setAtmosphericFogSettings((prev: AtmosphericFogSettings) => {
      const updated = { ...prev, ...settings };
      // Update viewport atmospheric fog settings if available
      const viewport = store.viewport;
      if (viewport) {
        viewport.setAtmosphericFogSettings(updated);
      }
      return updated;
    });
  }, [store]);
  
  // Cloud state
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>({
    enabled: false,
    coverage: 0.4,
    cloudType: 0.75,
    density: 0.2,
    cloudBase: 1500,
    cloudThickness: 2500,
    windSpeed: 5,
    windDirection: 45,
    seed: 42,
  });
  
  // Weather preset state (Phase 5) — before cloud handlers so they can reference it
  const [weatherPreset, setWeatherPreset] = useState<string | null>('Partly Cloudy');

  // Cloud shadow debug
  const [showCloudShadowDebug, setShowCloudShadowDebug] = useState(false);
  
  const handleCloudShadowDebugToggle = useCallback((enabled: boolean) => {
    setShowCloudShadowDebug(enabled);
    const debugManager = store.viewport?.getDebugTextureManager?.();
    if (debugManager) {
      debugManager.setEnabled('cloud-shadow', enabled);
    }
  }, [store]);
  
  const handleCloudSettingsChange = useCallback((settings: Partial<CloudSettings>) => {
    setCloudSettings((prev: CloudSettings) => {
      const updated = { ...prev, ...settings };
      const viewport = store.viewport;
      if (viewport) {
        viewport.setCloudSettings(updated);
      }
      return updated;
    });
    // When user manually changes cloud sliders, switch to Custom mode:
    // clear the active weather preset so the WeatherStateManager stops
    // overriding cloud params, and reset weatherDimming to 1.0 (neutral).
    if (weatherPreset !== null) {
      setWeatherPreset(null);
      const viewport = store.viewport;
      if (viewport) {
        viewport.clearWeatherPreset();
      }
    }
  }, [store, weatherPreset]);
  
  const handleWeatherPresetChange = useCallback((preset: string) => {
    setWeatherPreset(preset);
    const viewport = store.viewport;
    if (viewport) {
      viewport.setWeatherPreset(preset);
    }
  }, [store]);
  
  // Volumetric fog state (Phase 6)
  const [volumetricFogSettings, setVolumetricFogSettings] = useState<VolumetricFogSettings>({
    enabled: false,
    fogHeight: 0,
    fogHeightFalloff: 0.02,
    fogBaseDensity: 0.015,
    fogColor: [0.85, 0.88, 0.92],
    mieG: 0.76,
    scatteringScale: 1.0,
    ambientFogIntensity: 0.05,
    noiseEnabled: false,
    noiseScale: 0.003,
    noiseStrength: 0.5,
    temporalEnabled: true,
    temporalBlend: 0.95,
  });

  const handleVolumetricFogSettingsChange = useCallback((settings: Partial<VolumetricFogSettings>) => {
    setVolumetricFogSettings((prev: VolumetricFogSettings) => {
      const updated = { ...prev, ...settings };
      const viewport = store.viewport;
      if (viewport) {
        viewport.setVolumetricFogSettings?.(updated);
      }
      return updated;
    });
  }, [store]);

  // God ray state
  const [godRaySettings, setGodRaySettings] = useState<GodRaySettings>({
    enabled: false,
    mode: 'screen-space',
    intensity: 1.0,
    samples: 64,
    decay: 0.97,
    weight: 1.0,
    density: 1.0,
  });
  
  const handleGodRaySettingsChange = useCallback((settings: Partial<GodRaySettings>) => {
    setGodRaySettings((prev: GodRaySettings) => {
      const updated = { ...prev, ...settings };
      const viewport = store.viewport;
      if (viewport) {
        viewport.setGodRaySettings(updated);
      }
      return updated;
    });
  }, [store]);
  
  // Resolution scale state
  const [resolutionScale, setResolutionScale] = useState<ResolutionScalePreset>('1.0');
  
  const handleResolutionScaleChange = useCallback((scale: ResolutionScalePreset) => {
    setResolutionScale(scale);
    const viewport = store.viewport;
    if (viewport) {
      viewport.setResolutionScale(parseFloat(scale));
    }
  }, [store]);
  
  // Compute effective render resolution label
  const renderResolutionLabel = useMemo(() => {
    const viewport = store.viewport;
    if (!viewport) return undefined;
    const dpr = viewport.getDevicePixelRatio();
    const [w, h] = viewport.getRenderResolution();
    const scaleNum = parseFloat(resolutionScale);
    const effectiveDpr = (dpr * scaleNum).toFixed(2);
    return `${w} × ${h} px (DPR ${effectiveDpr})`;
  }, [store, resolutionScale]);
  
  return (
    <RenderingPanel
      resolutionScale={resolutionScale}
      onResolutionScaleChange={handleResolutionScaleChange}
      renderResolutionLabel={renderResolutionLabel}
      shadowSettings={shadowSettings}
      showShadowThumbnail={showShadowThumbnail}
      onShadowDebugToggle={handleShadowDebugToggle}
      onShadowSettingsChange={handleShadowSettingsChange}
      ssaoSettings={ssaoSettings}
      onSSAOSettingsChange={handleSSAOSettingsChange}
      ssrSettings={ssrSettings}
      onSSRSettingsChange={handleSSRSettingsChange}
      atmosphericFogSettings={atmosphericFogSettings}
      onAtmosphericFogSettingsChange={handleAtmosphericFogSettingsChange}
      cloudSettings={cloudSettings}
      onCloudSettingsChange={handleCloudSettingsChange}
      showCloudShadowDebug={showCloudShadowDebug}
      onCloudShadowDebugToggle={handleCloudShadowDebugToggle}
      weatherPreset={weatherPreset}
      onWeatherPresetChange={handleWeatherPresetChange}
      volumetricFogSettings={volumetricFogSettings}
      onVolumetricFogSettingsChange={handleVolumetricFogSettingsChange}
      godRaySettings={godRaySettings}
      onGodRaySettingsChange={handleGodRaySettingsChange}
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
