import { useCallback, useMemo } from 'preact/hooks';
import { Slider, Checkbox, ColorPicker } from '../../ui';
import styles from './TerrainPanel.module.css';
import { WaterConfig } from '../../../../../core/gpu/renderers/WaterRendererGPU';

export type WaterParams = WaterConfig & {
  enabled: boolean;
};

export interface WaterSectionProps {
  params: WaterParams;
  onParamsChange: (params: Partial<WaterParams>) => void;
  terrainSize?: number;
}

export function WaterSection({ params, onParamsChange, terrainSize = 1024 }: WaterSectionProps) {
  const handleChange = useCallback(
    <K extends keyof WaterParams>(key: K, value: WaterParams[K]) => {
      onParamsChange({ [key]: value } as Partial<WaterParams>);
    },
    [onParamsChange]
  );

  // Calculate cell count from grid size and cell size
  const gridInfo = useMemo(() => {
    const cellsX = Math.max(1, Math.ceil(params.gridSizeX / params.cellSize));
    const cellsZ = Math.max(1, Math.ceil(params.gridSizeZ / params.cellSize));
    const maxCells = 2048;
    const clampedX = Math.min(cellsX, maxCells);
    const clampedZ = Math.min(cellsZ, maxCells);
    return {
      cellsX: clampedX,
      cellsZ: clampedZ,
      totalQuads: clampedX * clampedZ,
    };
  }, [params.gridSizeX, params.gridSizeZ, params.cellSize]);

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

        <Slider
          label="Wavelength"
          value={params.wavelength}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v.toFixed(0)}m`}
          onChange={(v) => handleChange('wavelength', v)}
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

        <Slider
          label="Foam Threshold"
          value={params.foamThreshold}
          min={0}
          max={5}
          step={0.1}
          format={(v) => `${v.toFixed(1)}m`}
          onChange={(v) => handleChange('foamThreshold', v)}
          disabled={!params.enabled}
        />

        {/* Grid Placement Settings */}
        <div class={styles.subsectionTitle}>Grid Placement</div>
        
        <Slider
          label="Center X"
          value={params.gridCenterX}
          min={-terrainSize}
          max={terrainSize}
          step={10}
          format={(v) => v.toFixed(0)}
          onChange={(v) => handleChange('gridCenterX', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Center Z"
          value={params.gridCenterZ}
          min={-terrainSize}
          max={terrainSize}
          step={10}
          format={(v) => v.toFixed(0)}
          onChange={(v) => handleChange('gridCenterZ', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Size X"
          value={params.gridSizeX}
          min={10}
          max={terrainSize * 2}
          step={10}
          format={(v) => v.toFixed(0)}
          onChange={(v) => handleChange('gridSizeX', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Size Z"
          value={params.gridSizeZ}
          min={10}
          max={terrainSize * 2}
          step={10}
          format={(v) => v.toFixed(0)}
          onChange={(v) => handleChange('gridSizeZ', v)}
          disabled={!params.enabled}
        />

        <Slider
          label="Cell Size"
          value={params.cellSize}
          min={0.5}
          max={20}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(v) => handleChange('cellSize', v)}
          disabled={!params.enabled}
        />

        <div class={styles.gridInfo}>
          Grid: {gridInfo.cellsX}×{gridInfo.cellsZ} = {gridInfo.totalQuads.toLocaleString()} quads
        </div>
      </div>
    </div>
  );
}
