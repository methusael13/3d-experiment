import { useCallback } from 'preact/hooks';
import { Slider, ColorPicker } from '../../ui';
import styles from './TerrainPanel.module.css';

export interface MaterialParams {
  snowLine: number;
  rockLine: number;
  maxGrassSlope: number;
  beachMaxHeight: number;  // Max normalized height for beach (island mode)
  beachMaxSlope: number;   // Max slope for beach (island mode)
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  snowColor: [number, number, number];
  dirtColor: [number, number, number];
  beachColor: [number, number, number];
}

export interface MaterialSectionProps {
  params: MaterialParams;
  onParamsChange: (params: Partial<MaterialParams>) => void;
  /** Whether island mode is enabled (shows beach controls) */
  islandEnabled?: boolean;
}

export function MaterialSection({ params, onParamsChange, islandEnabled = false }: MaterialSectionProps) {
  const handleChange = useCallback(
    <K extends keyof MaterialParams>(key: K, value: MaterialParams[K]) => {
      onParamsChange({ [key]: value } as Partial<MaterialParams>);
    },
    [onParamsChange]
  );

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Material</div>

      <Slider
        label="Snow Line"
        value={params.snowLine}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('snowLine', v)}
      />

      <Slider
        label="Rock Line"
        value={params.rockLine}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('rockLine', v)}
      />

      <Slider
        label="Max Grass Slope"
        value={params.maxGrassSlope}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('maxGrassSlope', v)}
      />

      <div class={styles.colorGrid}>
        <ColorPicker
          label="Grass"
          value={params.grassColor}
          onChange={(v) => handleChange('grassColor', v)}
        />
        <ColorPicker
          label="Rock"
          value={params.rockColor}
          onChange={(v) => handleChange('rockColor', v)}
        />
        <ColorPicker
          label="Snow"
          value={params.snowColor}
          onChange={(v) => handleChange('snowColor', v)}
        />
        <ColorPicker
          label="Dirt"
          value={params.dirtColor}
          onChange={(v) => handleChange('dirtColor', v)}
        />
        {islandEnabled && (
          <ColorPicker
            label="Beach"
            value={params.beachColor}
            onChange={(v) => handleChange('beachColor', v)}
          />
        )}
      </div>

      {/* Beach settings (island mode only) */}
      {islandEnabled && (
        <>
          <div class={styles.subsectionTitle}>Beach (Island Mode)</div>
          <Slider
            label="Beach Max Height"
            value={params.beachMaxHeight}
            min={0.01}
            max={0.5}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => handleChange('beachMaxHeight', v)}
          />
          <Slider
            label="Beach Max Slope"
            value={params.beachMaxSlope}
            min={0.05}
            max={0.8}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => handleChange('beachMaxSlope', v)}
          />
        </>
      )}
    </div>
  );
}
