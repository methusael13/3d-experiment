import { useCallback } from 'preact/hooks';
import { VectorInput } from '../../ui';
import type { GizmoMode } from '../../../gizmos';
import type { GizmoOrientation } from '../../../gizmos/BaseGizmo';
import type { OriginPivot } from '../../../../../core/sceneObjects/SceneObject';
import styles from './ObjectPanel.module.css';

export interface TransformData {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface TransformTabProps {
  objectName: string;
  selectionCount: number;
  transform: TransformData;
  gizmoMode: GizmoMode;
  gizmoOrientation: GizmoOrientation;
  onNameChange: (name: string) => void;
  onPositionChange: (value: [number, number, number]) => void;
  onRotationChange: (value: [number, number, number]) => void;
  onScaleChange: (value: [number, number, number]) => void;
  onGizmoModeChange: (mode: GizmoMode) => void;
  onGizmoOrientationChange: (orientation: GizmoOrientation) => void;
  originPivot?: OriginPivot;
  onOriginPivotChange?: (pivot: OriginPivot) => void;
  onDelete: () => void;
}

export function TransformTab({
  objectName,
  selectionCount,
  transform,
  gizmoMode,
  gizmoOrientation,
  onNameChange,
  onPositionChange,
  onRotationChange,
  onScaleChange,
  onGizmoModeChange,
  onGizmoOrientationChange,
  originPivot = 'center',
  onOriginPivotChange,
  onDelete,
}: TransformTabProps) {
  const isSingleSelection = selectionCount === 1;

  const handleNameInput = useCallback(
    (e: Event) => {
      const target = e.target as HTMLInputElement;
      onNameChange(target.value || 'Unnamed');
    },
    [onNameChange]
  );

  return (
    <div class={styles.transformTab}>
      {/* Gizmo Mode Toggle */}
      <div class={styles.gizmoToggle}>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'translate' ? styles.active : ''}`}
          onClick={() => onGizmoModeChange('translate')}
          title="Translate (T)"
          type="button"
        >
          T
        </button>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'rotate' ? styles.active : ''}`}
          onClick={() => onGizmoModeChange('rotate')}
          title="Rotate (R)"
          type="button"
        >
          R
        </button>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'scale' ? styles.active : ''}`}
          onClick={() => onGizmoModeChange('scale')}
          title="Scale (S)"
          type="button"
        >
          S
        </button>
        <span class={styles.gizmoSeparator}>|</span>
        <button
          class={`${styles.gizmoBtn} ${styles.orientationBtn} ${gizmoOrientation === 'world' ? styles.active : ''}`}
          onClick={() => onGizmoOrientationChange('world')}
          title="World Space"
          type="button"
        >
          W
        </button>
        <button
          class={`${styles.gizmoBtn} ${styles.orientationBtn} ${gizmoOrientation === 'local' ? styles.active : ''}`}
          onClick={() => onGizmoOrientationChange('local')}
          title="Local Space"
          type="button"
        >
          L
        </button>
      </div>

      {/* Name Input */}
      <div class={styles.controlGroup}>
        <label class={styles.controlLabel}>Name</label>
        <input
          type="text"
          class={styles.nameInput}
          value={isSingleSelection ? objectName : `${selectionCount} objects`}
          disabled={!isSingleSelection}
          onInput={handleNameInput}
        />
      </div>

      {/* Transform Inputs */}
      <VectorInput
        label="Position"
        value={transform.position}
        onChange={onPositionChange}
        onReset={() => onPositionChange([0, 0, 0])}
        disabled={!isSingleSelection}
      />
      <VectorInput
        label="Rotation (°)"
        value={transform.rotation}
        onChange={onRotationChange}
        step={5}
        onReset={() => onRotationChange([0, 0, 0])}
        disabled={!isSingleSelection}
      />
      <VectorInput
        label="Scale"
        value={transform.scale}
        onChange={onScaleChange}
        onReset={() => onScaleChange([1, 1, 1])}
        disabled={!isSingleSelection}
      />

      {/* Origin Pivot */}
      {isSingleSelection && onOriginPivotChange && (
        <div class={styles.controlGroup}>
          <label class={styles.controlLabel}>Origin</label>
          <select
            class={styles.nameInput}
            value={originPivot}
            onChange={(e) => onOriginPivotChange?.((e.target as HTMLSelectElement).value as OriginPivot)}
          >
            <option value="top">Top</option>
            <option value="center">Center</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
      )}

      {/* Delete Button */}
      <button class={styles.deleteBtn} onClick={onDelete} type="button">
        Delete Object
      </button>
    </div>
  );
}
