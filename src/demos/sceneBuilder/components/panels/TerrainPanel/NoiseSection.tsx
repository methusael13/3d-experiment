import { useCallback } from 'preact/hooks';
import { Slider, Checkbox } from '../../ui';
import styles from './TerrainPanel.module.css';

export interface NoiseParams {
  seed: number;
  offsetX: number;
  offsetZ: number;
  scale: number;
  octaves: number;
  lacunarity: number;
  persistence: number;
  heightScale: number;
  ridgeWeight: number;
  // Domain warping
  warpStrength: number;
  warpScale: number;
  warpOctaves: number;
  // Octave rotation
  rotateOctaves: boolean;
  octaveRotation: number;
}

export interface NoiseSectionProps {
  params: NoiseParams;
  onParamsChange: (params: Partial<NoiseParams>) => void;
  onRandomizeSeed: () => void;
  heightScaleMax: number;
}

export function NoiseSection({
  params,
  onParamsChange,
  onRandomizeSeed,
  heightScaleMax,
}: NoiseSectionProps) {
  const handleChange = useCallback(
    <K extends keyof NoiseParams>(key: K, value: NoiseParams[K]) => {
      onParamsChange({ [key]: value } as Partial<NoiseParams>);
    },
    [onParamsChange]
  );

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Noise</div>

      {/* Seed */}
      <div class={styles.seedRow}>
        <label class={styles.seedLabel}>Seed</label>
        <input
          type="number"
          class={styles.seedInput}
          value={params.seed}
          onInput={(e) => handleChange('seed', parseInt((e.target as HTMLInputElement).value, 10) || 0)}
        />
        <button class={styles.seedBtn} onClick={onRandomizeSeed} title="Randomize">
          🎲
        </button>
      </div>

      {/* Offset X */}
      <Slider
        label="Offset X"
        value={params.offsetX}
        min={0}
        max={1000}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('offsetX', v)}
      />

      {/* Offset Z */}
      <Slider
        label="Offset Z"
        value={params.offsetZ}
        min={0}
        max={1000}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('offsetZ', v)}
      />

      {/* Scale */}
      <Slider
        label="Scale"
        value={params.scale}
        min={0.5}
        max={10}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('scale', v)}
      />

      {/* Octaves */}
      <Slider
        label="Octaves"
        value={params.octaves}
        min={1}
        max={10}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('octaves', Math.round(v))}
      />

      {/* Lacunarity */}
      <Slider
        label="Lacunarity"
        value={params.lacunarity}
        min={1}
        max={4}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('lacunarity', v)}
      />

      {/* Persistence */}
      <Slider
        label="Persistence"
        value={params.persistence}
        min={0.1}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('persistence', v)}
      />

      {/* Height */}
      <Slider
        label="Height"
        value={params.heightScale}
        min={0.1}
        max={heightScaleMax}
        step={Math.max(0.1, heightScaleMax / 50)}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('heightScale', v)}
      />

      {/* Ridge Amount */}
      <Slider
        label="Ridge Amount"
        value={params.ridgeWeight}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('ridgeWeight', v)}
      />

      <div class={styles.divider} />
      <div class={styles.sectionTitle}>Domain Warping</div>

      {/* Warp Strength */}
      <Slider
        label="Warp Strength"
        value={params.warpStrength}
        min={0}
        max={2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => handleChange('warpStrength', v)}
      />

      {/* Warp Scale */}
      <Slider
        label="Warp Scale"
        value={params.warpScale}
        min={0.5}
        max={5}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={(v) => handleChange('warpScale', v)}
      />

      {/* Warp Octaves */}
      <Slider
        label="Warp Octaves"
        value={params.warpOctaves}
        min={1}
        max={3}
        step={1}
        format={(v) => String(Math.round(v))}
        onChange={(v) => handleChange('warpOctaves', Math.round(v))}
      />

      <div class={styles.divider} />
      <div class={styles.sectionTitle}>Octave Rotation</div>

      {/* Rotate Octaves Checkbox */}
      <Checkbox
        label="Rotate Octaves (reduces patterns)"
        checked={params.rotateOctaves}
        onChange={(v) => handleChange('rotateOctaves', v)}
      />

      {/* Rotation Angle */}
      <Slider
        label="Rotation Angle"
        value={params.octaveRotation}
        min={10}
        max={60}
        step={1}
        format={(v) => `${Math.round(v)}°`}
        onChange={(v) => handleChange('octaveRotation', v)}
        disabled={!params.rotateOctaves}
      />
    </div>
  );
}
