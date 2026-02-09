import { useCallback } from 'preact/hooks';
import { Slider, Checkbox } from '../../ui';
import styles from './TerrainPanel.module.css';

export interface ErosionParams {
  // Hydraulic erosion
  hydraulicEnabled: boolean;
  hydraulicIterations: number;
  inertia: number;
  sedimentCapacity: number;
  depositSpeed: number;
  erodeSpeed: number;
  // Thermal erosion
  thermalEnabled: boolean;
  thermalIterations: number;
  talusAngle: number;
  // Debug visualization
  showFlowMapDebug: boolean;
}

export interface ErosionSectionProps {
  params: ErosionParams;
  onParamsChange: (params: Partial<ErosionParams>) => void;
}

function formatIterations(v: number): string {
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

export function ErosionSection({ params, onParamsChange }: ErosionSectionProps) {
  const handleChange = useCallback(
    <K extends keyof ErosionParams>(key: K, value: ErosionParams[K]) => {
      onParamsChange({ [key]: value } as Partial<ErosionParams>);
    },
    [onParamsChange]
  );

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Hydraulic Erosion</div>

      <Checkbox
        label="Enable Hydraulic Erosion"
        checked={params.hydraulicEnabled}
        onChange={(v) => handleChange('hydraulicEnabled', v)}
      />

      <div class={`${styles.settingsGroup} ${!params.hydraulicEnabled ? styles.disabled : ''}`}>
        <Slider
          label="Iterations"
          value={params.hydraulicIterations}
          min={1000}
          max={500000}
          step={1000}
          format={formatIterations}
          onChange={(v) => handleChange('hydraulicIterations', v)}
          disabled={!params.hydraulicEnabled}
        />

        <Slider
          label="Inertia"
          value={params.inertia}
          min={0}
          max={0.2}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('inertia', v)}
          disabled={!params.hydraulicEnabled}
        />

        <Slider
          label="Capacity"
          value={params.sedimentCapacity}
          min={1}
          max={10}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(v) => handleChange('sedimentCapacity', v)}
          disabled={!params.hydraulicEnabled}
        />

        <Slider
          label="Deposit Speed"
          value={params.depositSpeed}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('depositSpeed', v)}
          disabled={!params.hydraulicEnabled}
        />

        <Slider
          label="Erode Speed"
          value={params.erodeSpeed}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('erodeSpeed', v)}
          disabled={!params.hydraulicEnabled}
        />
      </div>

      <div class={styles.divider} />
      <div class={styles.sectionTitle}>Thermal Erosion</div>

      <Checkbox
        label="Enable Thermal Erosion"
        checked={params.thermalEnabled}
        onChange={(v) => handleChange('thermalEnabled', v)}
      />

      <div class={`${styles.settingsGroup} ${!params.thermalEnabled ? styles.disabled : ''}`}>
        <Slider
          label="Iterations"
          value={params.thermalIterations}
          min={10}
          max={500}
          step={10}
          format={(v) => String(Math.round(v))}
          onChange={(v) => handleChange('thermalIterations', v)}
          disabled={!params.thermalEnabled}
        />

        <Slider
          label="Talus Angle"
          value={params.talusAngle}
          min={0.1}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('talusAngle', v)}
          disabled={!params.thermalEnabled}
        />
      </div>

      <div class={styles.divider} />
      <div class={styles.sectionTitle}>Debug</div>
      
      <Checkbox
        label="Show Flow Map (Water Paths)"
        checked={params.showFlowMapDebug}
        onChange={(v) => handleChange('showFlowMapDebug', v)}
        disabled={!params.hydraulicEnabled}
      />
      <div class={styles.hint}>
        Visualizes water flow accumulation from hydraulic erosion. Brighter areas indicate more water flow.
      </div>
    </div>
  );
}
