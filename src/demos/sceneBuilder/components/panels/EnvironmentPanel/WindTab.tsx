import { Checkbox, Slider } from '../../ui';
import styles from './EnvironmentPanel.module.css';

interface WindTabProps {
  windEnabled: boolean;
  windDirection: number;
  windStrength: number;
  windTurbulence: number;
  windGustStrength: number;
  onWindEnabledChange: (enabled: boolean) => void;
  onWindDirectionChange: (value: number) => void;
  onWindStrengthChange: (value: number) => void;
  onWindTurbulenceChange: (value: number) => void;
  onWindGustStrengthChange: (value: number) => void;
}

export function WindTab({
  windEnabled,
  windDirection,
  windStrength,
  windTurbulence,
  windGustStrength,
  onWindEnabledChange,
  onWindDirectionChange,
  onWindStrengthChange,
  onWindTurbulenceChange,
  onWindGustStrengthChange,
}: WindTabProps) {
  return (
    <div class={styles.windTab}>
      {/* Wind Enable Toggle */}
      <div class={styles.windEnableRow}>
        <Checkbox
          label="Enable Wind"
          checked={windEnabled}
          onChange={onWindEnabledChange}
        />
        <span class={`${styles.windIndicator} ${windEnabled ? styles.active : ''}`} />
      </div>

      {/* Wind Direction Indicator */}
      <div class={styles.windDirectionIndicator}>
        <div
          class={styles.windDirectionArrow}
          style={{ transform: `translateY(-50%) rotate(${windDirection}deg)` }}
        />
      </div>

      {/* Wind Controls */}
      <Slider
        label="Direction"
        value={windDirection}
        min={0}
        max={360}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={onWindDirectionChange}
      />

      <Slider
        label="Strength"
        value={windStrength}
        min={0}
        max={2}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={onWindStrengthChange}
      />

      <Slider
        label="Turbulence"
        value={windTurbulence}
        min={0}
        max={1}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={onWindTurbulenceChange}
      />

      <Slider
        label="Gust Strength"
        value={windGustStrength}
        min={0}
        max={1}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={onWindGustStrengthChange}
      />
    </div>
  );
}
