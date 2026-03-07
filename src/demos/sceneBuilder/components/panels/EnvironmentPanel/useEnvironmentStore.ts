import { useCallback, useState } from 'preact/hooks';
import type { WindManager } from '../../../wind';
import type { PanelContext } from '../../../componentPanels/panelContext';
import type { World } from '@/core/ecs/World';
import { LightComponent } from '@/core/ecs/components/LightComponent';

export interface EnvironmentStore {
  // Lighting state
  lightMode: 'directional' | 'hdr';
  sunAzimuth: number;
  sunElevation: number;
  sunAmbient: number;
  hdrExposure: number;
  hdrFilename: string;
  /** Dynamic IBL (Image-Based Lighting) from procedural sky - WebGPU only */
  dynamicIBL: boolean;
  
  // Wind state
  windEnabled: boolean;
  windDirection: number;
  windStrength: number;
  windTurbulence: number;
  windGustStrength: number;
  
  // HDR loading state
  isLoadingHdr: boolean;
  hdrProgress: number;
  
  // Actions
  setLightMode: (mode: 'directional' | 'hdr') => void;
  setSunAzimuth: (value: number) => void;
  setSunElevation: (value: number) => void;
  setSunAmbient: (value: number) => void;
  setHdrExposure: (value: number) => void;
  setWindEnabled: (enabled: boolean) => void;
  setWindDirection: (value: number) => void;
  setWindStrength: (value: number) => void;
  setWindTurbulence: (value: number) => void;
  setWindGustStrength: (value: number) => void;
  setHdrProgress: (progress: number) => void;
  setIsLoadingHdr: (loading: boolean) => void;
  setHdrFilename: (filename: string) => void;
  setDynamicIBL: (enabled: boolean) => void;
}

export function useEnvironmentStore(
  windManager: WindManager,
  context: PanelContext,
  world?: World | null,
): EnvironmentStore {
  // Read initial values from ECS world
  const sunEntity = world?.queryFirst('light');
  const sunLc = sunEntity?.getComponent<LightComponent>('light');

  // Lighting state (seeded from ECS)
  const [lightMode, setLightModeState] = useState<'directional' | 'hdr'>('directional');
  const [sunAzimuth, setSunAzimuthState] = useState(sunLc?.azimuth ?? 45);
  const [sunElevation, setSunElevationState] = useState(sunLc?.elevation ?? 45);
  const [sunAmbient, setSunAmbientState] = useState(sunLc?.ambientIntensity ?? 1.0);
  const [hdrExposure, setHdrExposureState] = useState(1.0);
  const [hdrFilename, setHdrFilenameState] = useState('No HDR loaded');
  const [dynamicIBL, setDynamicIBLState] = useState(true); // Default enabled
  
  // Wind state
  const [windEnabled, setWindEnabledState] = useState(windManager.enabled);
  const [windDirection, setWindDirectionState] = useState(windManager.direction);
  const [windStrength, setWindStrengthState] = useState(windManager.strength);
  const [windTurbulence, setWindTurbulenceState] = useState(windManager.turbulence);
  const [windGustStrength, setWindGustStrengthState] = useState(windManager.gustStrength);
  
  // HDR loading state
  const [isLoadingHdr, setIsLoadingHdr] = useState(false);
  const [hdrProgress, setHdrProgress] = useState(0);

  // Actions
  const setLightMode = useCallback((mode: 'directional' | 'hdr') => {
    setLightModeState(mode);
    context.setLightMode(mode);
  }, [context]);

  const setSunAzimuth = useCallback((value: number) => {
    setSunAzimuthState(value);
    // Write directly to ECS LightComponent (single source of truth)
    if (world) {
      const sunEntity = world.queryFirst('light');
      const lc = sunEntity?.getComponent<LightComponent>('light');
      if (lc) lc.azimuth = value;
    }
  }, [world]);

  const setSunElevation = useCallback((value: number) => {
    setSunElevationState(value);
    // Write directly to ECS LightComponent (single source of truth)
    if (world) {
      const sunEntity = world.queryFirst('light');
      const lc = sunEntity?.getComponent<LightComponent>('light');
      if (lc) lc.elevation = value;
    }
  }, [world]);

  const setSunAmbient = useCallback((value: number) => {
    setSunAmbientState(value);
    // Write directly to ECS LightComponent (single source of truth)
    if (world) {
      const sunEntity = world.queryFirst('light');
      const lc = sunEntity?.getComponent<LightComponent>('light');
      if (lc) lc.ambientIntensity = value;
    }
  }, [world]);

  const setHdrExposure = useCallback((value: number) => {
    setHdrExposureState(value);
    // TODO: HDR exposure via ECS when HDR light component is added
  }, []);

  const setWindEnabled = useCallback((enabled: boolean) => {
    setWindEnabledState(enabled);
    windManager.enabled = enabled;
    context.onWindChanged();
  }, [windManager, context]);

  const setWindDirection = useCallback((value: number) => {
    setWindDirectionState(value);
    windManager.direction = value;
    context.onWindChanged();
  }, [windManager, context]);

  const setWindStrength = useCallback((value: number) => {
    setWindStrengthState(value);
    windManager.strength = value;
    context.onWindChanged();
  }, [windManager, context]);

  const setWindTurbulence = useCallback((value: number) => {
    setWindTurbulenceState(value);
    windManager.turbulence = value;
    context.onWindChanged();
  }, [windManager, context]);

  const setWindGustStrength = useCallback((value: number) => {
    setWindGustStrengthState(value);
    windManager.gustStrength = value;
    context.onWindChanged();
  }, [windManager, context]);

  const setHdrFilename = useCallback((filename: string) => {
    setHdrFilenameState(filename);
  }, []);

  const setDynamicIBL = useCallback((enabled: boolean) => {
    setDynamicIBLState(enabled);
    // Notify context about IBL change (if callback exists)
    if (context.onDynamicIBLChanged) {
      context.onDynamicIBLChanged(enabled);
    }
  }, [context]);

  return {
    lightMode,
    sunAzimuth,
    sunElevation,
    sunAmbient,
    hdrExposure,
    hdrFilename,
    dynamicIBL,
    windEnabled,
    windDirection,
    windStrength,
    windTurbulence,
    windGustStrength,
    isLoadingHdr,
    hdrProgress,
    setLightMode,
    setSunAzimuth,
    setSunElevation,
    setSunAmbient,
    setHdrExposure,
    setWindEnabled,
    setWindDirection,
    setWindStrength,
    setWindTurbulence,
    setWindGustStrength,
    setHdrProgress,
    setIsLoadingHdr,
    setHdrFilename,
    setDynamicIBL,
  };
}
