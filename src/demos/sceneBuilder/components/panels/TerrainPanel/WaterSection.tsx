import { useCallback } from 'preact/hooks';
import { Slider, Checkbox, ColorPicker } from '../../ui';
import styles from './TerrainPanel.module.css';

export interface WaterParams {
  enabled: boolean;
  waterLevel: number;
  waveHeight: number;
  waveSpeed: number;
  shallowColor: [number, number, number];
  deepColor: [number, number, number];
  depthFalloff: number;
  opacity: number;
}

export interface WaterSectionProps {
  params: WaterParams;
  onParamsChange: (params: Partial<WaterParams>) => void;
}

export function WaterSection({ params, onParamsChange }: WaterSectionProps) {
  const handleChange = useCallback(
    <K extends keyof WaterParams>(key: K, value: WaterParams[K]) => {
      onParamsChange({ [key]: value } as Partial<WaterParams>);
    },
    [onParamsChange]
  );

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Water</div>

      <Checkbox
        label="Enable Water"
        checked={params.enabled}
        onChange={(v) => handleChange('enabled', v)}
      />

      <div class={`${styles.settingsGroup} ${!params.enabled ? styles.disabled : ''}`}>
        <Slider
          label="Water Level"
          value={params.waterLevel}
          min={-0.5}
          max={0.5}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('waterLevel', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Wave Height"
          value={params.waveHeight}
          min={0}
          max={3}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => handleChange('waveHeight', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Wave Speed"
          value={params.waveSpeed}
          min={0.1}
          max={3}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => handleChange('waveSpeed', v)}
          disabled={!params.enabled}
        />

        <div class={styles.colorRow}>
          <ColorPicker
            label="Shallow"
            value={params.shallowColor}
            onChange={(v) => handleChange('shallowColor', v)}
            disabled={!params.enabled}
          />
          <ColorPicker
            label="Deep"
            value={params.deepColor}
            onChange={(v) => handleChange('deepColor', v)}
            disabled={!params.enabled}
          />
        </div>

        <Slider
          label="Depth Falloff"
          value={params.depthFalloff}
          min={0.01}
          max={0.5}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('depthFalloff', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Opacity"
          value={params.opacity}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('opacity', v)}
          disabled={!params.enabled}
        />
      </div>
    </div>
  );
}
