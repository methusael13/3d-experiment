import { useCallback } from 'preact/hooks';
import { Slider } from '../../ui';
import styles from './TerrainPanel.module.css';

export interface DetailParams {
  frequency: number;
  amplitude: number;
  octaves: number;
  fadeStart: number;
  fadeEnd: number;
  slopeInfluence: number;
}

export interface DetailSectionProps {
  params: DetailParams;
  onParamsChange: (params: Partial<DetailParams>) => void;
}

export function DetailSection({ params, onParamsChange }: DetailSectionProps) {
  const handleChange = useCallback(
    <K extends keyof DetailParams>(key: K, value: DetailParams[K]) => {
      onParamsChange({ [key]: value } as Partial<DetailParams>);
    },
    [onParamsChange]
  );

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Procedural Detail (Close-up)</div>

      <Slider
        label="Detail Frequency"
        value={params.frequency}
        min={0.1}
        max={2}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('frequency', v)}
      />

      <Slider
        label="Detail Amplitude"
        value={params.amplitude}
        min={0}
        max={2}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('amplitude', v)}
      />

      <Slider
        label="Detail Octaves"
        value={params.octaves}
        min={1}
        max={5}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('octaves', Math.round(v))}
      />

      <Slider
        label="Fade Start (m)"
        value={params.fadeStart}
        min={10}
        max={200}
        step={10}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('fadeStart', v)}
      />

      <Slider
        label="Fade End (m)"
        value={params.fadeEnd}
        min={50}
        max={500}
        step={10}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('fadeEnd', v)}
      />

      <Slider
        label="Slope Influence"
        value={params.slopeInfluence}
        min={0}
        max={1}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('slopeInfluence', v)}
      />
    </div>
  );
}
