import { useCallback } from 'preact/hooks';
import { Panel, Slider, ColorPicker } from '../../ui';
import type { PBRMaterial } from '../../../../../core/sceneObjects';
import styles from './MaterialPanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

export interface MaterialPanelProps {
  selectedObjectId: string | null;
  objectType: string | null;
  material: PBRMaterial | null;
  onMaterialChange: (material: Partial<PBRMaterial>) => void;
}

// Material presets
const PRESETS: Record<string, PBRMaterial> = {
  plastic: { albedo: [0.8, 0.2, 0.2], metallic: 0.0, roughness: 0.4 },
  metal: { albedo: [0.9, 0.9, 0.9], metallic: 1.0, roughness: 0.3 },
  gold: { albedo: [1.0, 0.84, 0.0], metallic: 1.0, roughness: 0.2 },
  ceramic: { albedo: [0.95, 0.95, 0.92], metallic: 0.0, roughness: 0.1 },
};

export function MaterialPanel({
  selectedObjectId,
  objectType,
  material,
  onMaterialChange,
}: MaterialPanelProps) {
  const isPrimitive = objectType === 'primitive';
  const hasSelection = !!selectedObjectId;

  const handleAlbedoChange = useCallback(
    (color: [number, number, number]) => {
      onMaterialChange({ albedo: color });
    },
    [onMaterialChange]
  );

  const handleMetallicChange = useCallback(
    (value: number) => {
      onMaterialChange({ metallic: value });
    },
    [onMaterialChange]
  );

  const handleRoughnessChange = useCallback(
    (value: number) => {
      onMaterialChange({ roughness: value });
    },
    [onMaterialChange]
  );

  const handlePreset = useCallback(
    (presetName: string) => () => {
      const preset = PRESETS[presetName];
      if (preset) {
        onMaterialChange(preset);
      }
    },
    [onMaterialChange]
  );

  // Current values with defaults
  const albedo = material?.albedo ?? [0.75, 0.75, 0.75];
  const metallic = material?.metallic ?? 0;
  const roughness = material?.roughness ?? 0.5;

  return (
    <Panel title="Material">
      {/* No selection state */}
      {!hasSelection && (
        <div class={styles.noSelection}>Select a primitive to edit material</div>
      )}

      {/* Editable controls for primitives */}
      {hasSelection && isPrimitive && (
        <div class={styles.controls}>
          <ColorPicker
            label="Albedo"
            value={albedo as [number, number, number]}
            onChange={handleAlbedoChange}
          />

          <Slider
            label="Metallic"
            value={metallic}
            min={0}
            max={1}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={handleMetallicChange}
          />

          <Slider
            label="Roughness"
            value={roughness}
            min={0.04}
            max={1}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={handleRoughnessChange}
          />

          {/* Preset buttons */}
          <div class={styles.presets}>
            <button
              class={styles.presetBtn}
              onClick={handlePreset('plastic')}
              type="button"
            >
              Plastic
            </button>
            <button
              class={styles.presetBtn}
              onClick={handlePreset('metal')}
              type="button"
            >
              Metal
            </button>
            <button
              class={styles.presetBtn}
              onClick={handlePreset('gold')}
              type="button"
            >
              Gold
            </button>
            <button
              class={styles.presetBtn}
              onClick={handlePreset('ceramic')}
              type="button"
            >
              Ceramic
            </button>
          </div>
        </div>
      )}

      {/* Read-only info for GLB models */}
      {hasSelection && !isPrimitive && (
        <div class={styles.glbInfo}>
          <div class={styles.glbNotice}>GLB material (read-only)</div>
          {material ? (
            <div class={styles.glbProps}>
              <div class={styles.glbProp}>
                Metallic: {(material.metallic ?? 1).toFixed(2)}
              </div>
              <div class={styles.glbProp}>
                Roughness: {(material.roughness ?? 1).toFixed(2)}
              </div>
            </div>
          ) : (
            <div class={styles.glbProp}>No PBR data</div>
          )}
        </div>
      )}
    </Panel>
  );
}
