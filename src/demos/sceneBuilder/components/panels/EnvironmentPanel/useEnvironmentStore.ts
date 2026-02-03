import { useCallback, useState, useEffect } from 'preact/hooks';
import type { LightingManager } from '../../../lightingManager';
import type { WindManager } from '../../../wind';
import type { PanelContext } from '../../../componentPanels/panelContext';

export interface EnvironmentStore {
  // Lighting state
  lightMode: 'directional' | 'hdr';
  sunAzimuth: number;
  sunElevation: number;
  sunAmbient: number;
  hdrExposure: number;
  toneMapping: string;
  hdrFilename: string;
  
  // Wind state
  windEnabled: boolean;
  windDirection: number;
  windStrength: number;
  windTurbulence: number;
  windGustStrength: number;
  windDebug: number;
  
  // HDR loading state
  isLoadingHdr: boolean;
  hdrProgress: number;
  
  // Actions
  setLightMode: (mode: 'directional' | 'hdr') => void;
  setSunAzimuth: (value: number) => void;
  setSunElevation: (value: number) => void;
  setSunAmbient: (value: number) => void;
  setHdrExposure: (value: number) => void;
  setToneMapping: (value: string) => void;
  setWindEnabled: (enabled: boolean) => void;
  setWindDirection: (value: number) => void;
  setWindStrength: (value: number) => void;
  setWindTurbulence: (value: number) => void;
  setWindGustStrength: (value: number) => void;
  setWindDebug: (value: number) => void;
  setHdrProgress: (progress: number) => void;
  setIsLoadingHdr: (loading: boolean) => void;
  setHdrFilename: (filename: string) => void;
}

export function useEnvironmentStore(
  lightingManager: LightingManager,
  windManager: WindManager,
  context: PanelContext
): EnvironmentStore {
  // Lighting state
  const [lightMode, setLightModeState] = useState<'directional' | 'hdr'>(lightingManager.activeMode);
  const [sunAzimuth, setSunAzimuthState] = useState(lightingManager.sunLight.azimuth);
  const [sunElevation, setSunElevationState] = useState(lightingManager.sunLight.elevation);
  const [sunAmbient, setSunAmbientState] = useState(lightingManager.sunLight.ambientIntensity);
  const [hdrExposure, setHdrExposureState] = useState(lightingManager.hdrLight.exposure);
  const [toneMapping, setToneMappingState] = useState('aces');
  const [hdrFilename, setHdrFilenameState] = useState('No HDR loaded');
  
  // Wind state
  const [windEnabled, setWindEnabledState] = useState(windManager.enabled);
  const [windDirection, setWindDirectionState] = useState(windManager.direction);
  const [windStrength, setWindStrengthState] = useState(windManager.strength);
  const [windTurbulence, setWindTurbulenceState] = useState(windManager.turbulence);
  const [windGustStrength, setWindGustStrengthState] = useState(windManager.gustStrength);
  const [windDebug, setWindDebugState] = useState(windManager.debug);
  
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
    lightingManager.sunLight.azimuth = value;
    context.onLightingChanged();
  }, [lightingManager, context]);

  const setSunElevation = useCallback((value: number) => {
    setSunElevationState(value);
    lightingManager.sunLight.elevation = value;
    context.onLightingChanged();
  }, [lightingManager, context]);

  const setSunAmbient = useCallback((value: number) => {
    setSunAmbientState(value);
    lightingManager.sunLight.ambientIntensity = value;
    context.onLightingChanged();
  }, [lightingManager, context]);

  const setHdrExposure = useCallback((value: number) => {
    setHdrExposureState(value);
    lightingManager.hdrLight.exposure = value;
    context.onLightingChanged();
  }, [lightingManager, context]);

  const setToneMapping = useCallback((value: string) => {
    setToneMappingState(value);
    // Note: TONE_MAPPING conversion would be done in the component
    context.onLightingChanged();
  }, [context]);

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

  const setWindDebug = useCallback((value: number) => {
    setWindDebugState(value);
    windManager.debug = value;
    context.onWindChanged();
  }, [windManager, context]);

  const setHdrFilename = useCallback((filename: string) => {
    setHdrFilenameState(filename);
  }, []);

  return {
    lightMode,
    sunAzimuth,
    sunElevation,
    sunAmbient,
    hdrExposure,
    toneMapping,
    hdrFilename,
    windEnabled,
    windDirection,
    windStrength,
    windTurbulence,
    windGustStrength,
    windDebug,
    isLoadingHdr,
    hdrProgress,
    setLightMode,
    setSunAzimuth,
    setSunElevation,
    setSunAmbient,
    setHdrExposure,
    setToneMapping,
    setWindEnabled,
    setWindDirection,
    setWindStrength,
    setWindTurbulence,
    setWindGustStrength,
    setWindDebug,
    setHdrProgress,
    setIsLoadingHdr,
    setHdrFilename,
  };
}
