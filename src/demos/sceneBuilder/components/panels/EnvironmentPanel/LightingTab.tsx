import { Slider } from '../../ui';
import styles from './EnvironmentPanel.module.css';

interface LightingTabProps {
  lightMode: 'directional' | 'hdr';
  sunAzimuth: number;
  sunElevation: number;
  sunAmbient: number;
  hdrExposure: number;
  onLightModeChange: (mode: 'directional' | 'hdr') => void;
  onSunAzimuthChange: (value: number) => void;
  onSunElevationChange: (value: number) => void;
  onSunAmbientChange: (value: number) => void;
  onHdrExposureChange: (value: number) => void;
  hdrControls: preact.ComponentChildren;
}

export function LightingTab({
  lightMode,
  sunAzimuth,
  sunElevation,
  sunAmbient,
  hdrExposure,
  onLightModeChange,
  onSunAzimuthChange,
  onSunElevationChange,
  onSunAmbientChange,
  onHdrExposureChange,
  hdrControls,
}: LightingTabProps) {
  return (
    <div class={styles.lightingTab}>
      {/* Light Mode Toggle */}
      <div class={styles.lightModeToggle}>
        <button
          class={`${styles.lightModeBtn} ${lightMode === 'directional' ? styles.active : ''}`}
          onClick={() => onLightModeChange('directional')}
          type="button"
        >
          ☀️ Sun
        </button>
        <button
          class={`${styles.lightModeBtn} ${lightMode === 'hdr' ? styles.active : ''}`}
          onClick={() => onLightModeChange('hdr')}
          type="button"
        >
          🌄 HDR
        </button>
      </div>

      {/* Sun Controls */}
      {lightMode === 'directional' && (
        <div class={styles.sunControls}>
          <Slider
            label="Azimuth"
            value={sunAzimuth}
            min={0}
            max={360}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={onSunAzimuthChange}
          />
          <Slider
            label="Elevation"
            value={sunElevation}
            min={-90}
            max={90}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={onSunElevationChange}
          />
          <Slider
            label="Ambient"
            value={sunAmbient}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={onSunAmbientChange}
          />
        </div>
      )}

      {/* HDR Controls */}
      {lightMode === 'hdr' && (
        <div class={styles.hdrControls}>
          <Slider
            label="HDR Exposure"
            value={hdrExposure}
            min={0.1}
            max={5}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={onHdrExposureChange}
          />
          {hdrControls}
        </div>
      )}
    </div>
  );
}
