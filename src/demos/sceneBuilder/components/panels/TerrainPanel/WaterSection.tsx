import { useCallback } from 'preact/hooks';
import { Slider, Checkbox, ColorPicker } from '../../ui';
import styles from './TerrainPanel.module.css';
import { WaterConfig } from '../../../../../core/gpu/renderers/WaterRendererGPU';

export type WaterParams = WaterConfig;

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
          label="Wave Scale"
          value={params.waveScale}
          min={0}
          max={3}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(v) => handleChange('waveScale', v)}
          disabled={!params.enabled}
        />

        <div class={styles.colorColumn}>
          <ColorPicker
            label="Water Color"
            value={params.waterColor}
            onChange={(v) => handleChange('waterColor', v)}
            disabled={!params.enabled}
          />
          <ColorPicker
            label="Deep Color"
            value={params.deepColor}
            onChange={(v) => handleChange('deepColor', v)}
            disabled={!params.enabled}
          />
          <ColorPicker
            label="Foam Color"
            value={params.foamColor}
            onChange={(v) => handleChange('foamColor', v)}
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
