import { useCallback } from 'preact/hooks';
import { Slider, Checkbox } from '../../ui';
import styles from './ObjectPanel.module.css';

export interface PrimitiveConfig {
  size: number;
  subdivision?: number;
}

export interface EditTabProps {
  primitiveType: 'cube' | 'plane' | 'sphere';
  config: PrimitiveConfig;
  showNormals: boolean;
  onConfigChange: (config: Partial<PrimitiveConfig>) => void;
  onShowNormalsChange: (show: boolean) => void;
}

const typeNames: Record<string, string> = {
  cube: 'Cube',
  plane: 'Plane',
  sphere: 'UV Sphere',
};

export function EditTab({
  primitiveType,
  config,
  showNormals,
  onConfigChange,
  onShowNormalsChange,
}: EditTabProps) {
  const handleSizeChange = useCallback(
    (value: number) => {
      onConfigChange({ size: value });
    },
    [onConfigChange]
  );

  const handleSubdivisionChange = useCallback(
    (value: number) => {
      onConfigChange({ subdivision: Math.round(value) });
    },
    [onConfigChange]
  );

  const showSubdivision = primitiveType === 'sphere';

  return (
    <div class={styles.editTab}>
      <div class={styles.controlGroup}>
        <label class={styles.controlLabel}>Primitive Type</label>
        <div class={styles.typeDisplay}>{typeNames[primitiveType] || primitiveType}</div>
      </div>

      <Slider
        label="Size"
        value={config.size}
        min={0.1}
        max={10}
        step={0.1}
        format={(v) => v.toFixed(1)}
        onChange={handleSizeChange}
      />

      {showSubdivision && (
        <Slider
          label="Subdivision"
          value={config.subdivision ?? 16}
          min={4}
          max={64}
          step={4}
          format={(v) => String(Math.round(v))}
          onChange={handleSubdivisionChange}
        />
      )}

      <div class={styles.divider} />

      <div class={styles.debugSection}>
        <label class={styles.debugLabel}>Debug</label>
        <Checkbox
          label="Show Normals"
          checked={showNormals}
          onChange={onShowNormalsChange}
        />
      </div>
    </div>
  );
}
