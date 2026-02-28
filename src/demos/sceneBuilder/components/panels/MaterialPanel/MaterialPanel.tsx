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

// Material presets (updated with new PBR properties)
const PRESETS: Record<string, PBRMaterial> = {
  plastic: { albedo: [0.8, 0.2, 0.2], metallic: 0.0, roughness: 0.4, ior: 1.5 },
  metal: { albedo: [0.9, 0.9, 0.9], metallic: 1.0, roughness: 0.3, ior: 2.5 },
  gold: { albedo: [1.0, 0.84, 0.0], metallic: 1.0, roughness: 0.2, ior: 0.47 },
  ceramic: { albedo: [0.95, 0.95, 0.92], metallic: 0.0, roughness: 0.1, ior: 1.5 },
  glass: { albedo: [0.95, 0.95, 0.95], metallic: 0.0, roughness: 0.05, ior: 1.5 },
  carPaint: { albedo: [0.05, 0.1, 0.6], metallic: 0.0, roughness: 0.4, ior: 1.5, clearcoatFactor: 1.0, clearcoatRoughness: 0.05 },
  water: { albedo: [0.02, 0.02, 0.02], metallic: 0.0, roughness: 0.0, ior: 1.33 },
  diamond: { albedo: [0.97, 0.97, 0.97], metallic: 0.0, roughness: 0.0, ior: 2.42 },
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

  const handleEmissiveChange = useCallback(
    (color: [number, number, number]) => {
      onMaterialChange({ emissive: color });
    },
    [onMaterialChange]
  );

  const handleIorChange = useCallback(
    (value: number) => {
      onMaterialChange({ ior: value });
    },
    [onMaterialChange]
  );

  const handleClearcoatFactorChange = useCallback(
    (value: number) => {
      onMaterialChange({ clearcoatFactor: value });
    },
    [onMaterialChange]
  );

  const handleClearcoatRoughnessChange = useCallback(
    (value: number) => {
      onMaterialChange({ clearcoatRoughness: value });
    },
    [onMaterialChange]
  );

  const handleUnlitChange = useCallback(
    (e: Event) => {
      const checked = (e.target as HTMLInputElement).checked;
      onMaterialChange({ unlit: checked });
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
  const emissive = material?.emissive ?? [0, 0, 0];
  const ior = material?.ior ?? 1.5;
  const clearcoatFactor = material?.clearcoatFactor ?? 0;
  const clearcoatRoughness = material?.clearcoatRoughness ?? 0;
  const unlit = material?.unlit ?? false;

  return (
    <Panel title="Material">
      {/* No selection state */}
      {!hasSelection && (
        <div class={styles.noSelection}>Select a primitive to edit material</div>
      )}

      {/* Editable controls for primitives */}
      {hasSelection && isPrimitive && (
        <div class={styles.controls}>
          {/* Unlit toggle */}
          <label class={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={unlit}
              onChange={handleUnlitChange}
            />
            <span>Unlit</span>
          </label>

          <ColorPicker
            label="Albedo"
            value={albedo as [number, number, number]}
            onChange={handleAlbedoChange}
          />

          {!unlit && (
            <>
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

              <ColorPicker
                label="Emissive"
                value={emissive as [number, number, number]}
                onChange={handleEmissiveChange}
              />

              <Slider
                label="IOR"
                value={ior}
                min={1.0}
                max={3.0}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={handleIorChange}
              />

              <Slider
                label="Clearcoat"
                value={clearcoatFactor}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={handleClearcoatFactorChange}
              />

              {clearcoatFactor > 0 && (
                <Slider
                  label="Clearcoat Roughness"
                  value={clearcoatRoughness}
                  min={0.04}
                  max={1}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onChange={handleClearcoatRoughnessChange}
                />
              )}
            </>
          )}

          {/* Preset buttons */}
          <div class={styles.presets}>
            <button class={styles.presetBtn} onClick={handlePreset('plastic')} type="button">Plastic</button>
            <button class={styles.presetBtn} onClick={handlePreset('metal')} type="button">Metal</button>
            <button class={styles.presetBtn} onClick={handlePreset('gold')} type="button">Gold</button>
            <button class={styles.presetBtn} onClick={handlePreset('ceramic')} type="button">Ceramic</button>
            <button class={styles.presetBtn} onClick={handlePreset('glass')} type="button">Glass</button>
            <button class={styles.presetBtn} onClick={handlePreset('carPaint')} type="button">Car Paint</button>
            <button class={styles.presetBtn} onClick={handlePreset('water')} type="button">Water</button>
            <button class={styles.presetBtn} onClick={handlePreset('diamond')} type="button">Diamond</button>
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
              {(material.ior ?? 1.5) !== 1.5 && (
                <div class={styles.glbProp}>
                  IOR: {(material.ior ?? 1.5).toFixed(2)}
                </div>
              )}
              {(material.clearcoatFactor ?? 0) > 0 && (
                <div class={styles.glbProp}>
                  Clearcoat: {(material.clearcoatFactor ?? 0).toFixed(2)}
                </div>
              )}
              {material.unlit && (
                <div class={styles.glbProp}>Unlit</div>
              )}
            </div>
          ) : (
            <div class={styles.glbProp}>No PBR data</div>
          )}
        </div>
      )}
    </Panel>
  );
}