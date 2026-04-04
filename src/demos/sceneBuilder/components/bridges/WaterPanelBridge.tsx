/**
 * WaterPanelBridge - Connects WaterPanel to the store (ECS Step 3)
 * Shows only when an entity with OceanComponent is selected
 */

import { useCallback, useState, useEffect } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getSceneBuilderStore } from '../state';
import { WaterPanel, type WaterParams, type FFTParams, FFT_DEBUG_TEXTURES, type FFTDebugTextureName } from '../panels/WaterPanel';
import { OceanComponent } from '@/core/ecs/components/OceanComponent';
import { TerrainComponent } from '@/core/ecs/components/TerrainComponent';
import { createDefaultWaterConfig } from '../../../../core/gpu/renderers';
import type { OceanManager } from '@/core/ocean/OceanManager';
import { BoundsComponent } from '@/core/ecs';
import type { FFTOceanSpectrum } from '@/core/ocean/FFTOceanSpectrum';

// ==================== Connected Component ====================

export function ConnectedWaterPanel() {
  const store = getSceneBuilderStore();
  
  // Get ocean manager from selected entity's OceanComponent
  const selectedOceanManager = useComputed<OceanManager | null>(() => {
    const entity = store.firstSelectedObject.value;
    if (!entity) return null;
    
    const oceanComp = entity.getComponent<OceanComponent>('ocean');
    if (oceanComp) {
      return oceanComp.manager;
    }
    
    return null;
  });
  
  // Local state for water params
  const [waterParams, setWaterParams] = useState<WaterParams>(createDefaultWaterConfig);
  
  // Sync local state when selection changes
  useEffect(() => {
    const manager = selectedOceanManager.value;
    if (!manager) {
      setWaterParams(createDefaultWaterConfig());
      return;
    }
    
    setWaterParams(manager.getConfig());
  }, [selectedOceanManager.value]);
  
  // Handler for param changes
  const handleParamsChange = useCallback((changes: Partial<WaterParams>) => {
    const manager = selectedOceanManager.value;
    if (!manager) return;
    
    const currentConfig = manager.getConfig();
    const newConfig = { ...currentConfig, ...changes };
    
    manager.setConfig(newConfig);
    setWaterParams(newConfig);
    
    // Recompute ocean worldBounds when grid dimensions change
    const boundsAffectingParams = 'gridCenterX' in changes || 'gridCenterZ' in changes || 
                                  'gridSizeX' in changes || 'gridSizeZ' in changes ||
                                  'waterLevel' in changes;
    if (boundsAffectingParams) {
      const entity = store.firstSelectedObject.value;
      if (entity) {
        const oceanComp = entity.getComponent?.('ocean') as OceanComponent;
        const boundsComp = entity.getComponent?.('bounds') as BoundsComponent;
        if (oceanComp?.computeWorldBounds && boundsComp) {
          boundsComp.worldBounds = oceanComp.computeWorldBounds();
          boundsComp.dirty = false;
        }
      }
      // BoundsSystem callback will trigger camera update automatically
    }
  }, [selectedOceanManager, store]);
  
  // FFT params
  const [fftLocalParams, setFFTLocalParams] = useState<FFTParams | null>(null);
  
  // Sync FFT params when selection changes
  useEffect(() => {
    const manager = selectedOceanManager.value;
    if (!manager) {
      setFFTLocalParams(null);
      return;
    }
    
    const fft = manager.getFFTSpectrum();
    if (fft?.isReady) {
      const config = fft.getConfig();
      const angle = Math.atan2(config.windDirection[1], config.windDirection[0]) * 180 / Math.PI;
      setFFTLocalParams({
        windSpeed: config.windSpeed,
        windDirectionAngle: ((angle % 360) + 360) % 360,
        choppiness: config.choppiness,
        amplitudeScale: config.amplitudeScale,
        fetch: config.fetch,
        spectrumType: config.spectrumType,
        directionalSpread: config.directionalSpread,
        swellMix: config.swellMix,
        swellDirectionAngle: Math.round(Math.atan2(config.swellDirection[0], config.swellDirection[1]) * 180 / Math.PI + 360) % 360,
        swellWavelength: config.swellWavelength,
      });
    } else {
      setFFTLocalParams(null);
    }
  }, [selectedOceanManager.value]);
  
  // Handler for FFT param changes
  const handleFFTParamsChange = useCallback((changes: Partial<FFTParams>) => {
    const manager = selectedOceanManager.value;
    if (!manager) return;
    
    const fft = manager.getFFTSpectrum();
    if (!fft) return;
    
    // Apply changes to FFTOceanSpectrum
    if ('windSpeed' in changes && changes.windSpeed !== undefined) {
      fft.setWindSpeed(changes.windSpeed);
    }
    if ('windDirectionAngle' in changes && changes.windDirectionAngle !== undefined) {
      const rad = changes.windDirectionAngle * Math.PI / 180;
      fft.setWindDirection([Math.cos(rad), Math.sin(rad)]);
    }
    if ('choppiness' in changes && changes.choppiness !== undefined) {
      fft.setChoppiness(changes.choppiness);
    }
    if ('amplitudeScale' in changes && changes.amplitudeScale !== undefined) {
      fft.setAmplitudeScale(changes.amplitudeScale);
    }
    if ('fetch' in changes && changes.fetch !== undefined) {
      fft.setFetch(changes.fetch);
    }
    if ('spectrumType' in changes && changes.spectrumType !== undefined) {
      fft.setSpectrumType(changes.spectrumType);
    }
    if ('directionalSpread' in changes && changes.directionalSpread !== undefined) {
      fft.setDirectionalSpread(changes.directionalSpread);
    }
    if ('swellMix' in changes && changes.swellMix !== undefined) {
      fft.setSwellMix(changes.swellMix);
    }
    if ('swellDirectionAngle' in changes && changes.swellDirectionAngle !== undefined) {
      const rad = changes.swellDirectionAngle * Math.PI / 180;
      fft.setSwellDirection([Math.sin(rad), Math.cos(rad)]);
    }
    if ('swellWavelength' in changes && changes.swellWavelength !== undefined) {
      fft.setSwellWavelength(changes.swellWavelength);
    }
    
    // Update local state
    setFFTLocalParams(prev => prev ? { ...prev, ...changes } : null);
  }, [selectedOceanManager]);
  
  // Only render if an ocean is selected
  if (!selectedOceanManager.value) {
    return null;
  }
  
  // Get terrain size from World (query for terrain entity)
  const world = store.world;
  let terrainSize = 1024;
  if (world) {
    const terrainEntity = world.queryFirst('terrain');
    if (terrainEntity) {
      const tc = terrainEntity.getComponent<TerrainComponent>('terrain');
      terrainSize = tc?.manager?.getConfig()?.worldSize ?? 1024;
    }
  }
  
  // Debug texture toggles — state tracks which are enabled in DebugTextureManager
  const [debugTextureState, setDebugTextureState] = useState<Record<FFTDebugTextureName, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const name of FFT_DEBUG_TEXTURES) { initial[name] = false; }
    return initial as Record<FFTDebugTextureName, boolean>;
  });

  const handleDebugTextureToggle = useCallback((name: FFTDebugTextureName, enabled: boolean) => {
    // Toggle via the DebugTextureManager (accessed through the engine pipeline)
    const dtm = store.viewport?.getDebugTextureManager?.();
    if (dtm) {
      dtm.setEnabled(name, enabled);
    }
    setDebugTextureState(prev => ({ ...prev, [name]: enabled }));
  }, [store]);

  return (
    <WaterPanel
      params={waterParams}
      onParamsChange={handleParamsChange}
      fftParams={fftLocalParams}
      onFFTParamsChange={handleFFTParamsChange}
      terrainSize={terrainSize}
      debugTextures={debugTextureState}
      onDebugTextureToggle={handleDebugTextureToggle}
    />
  );
}
