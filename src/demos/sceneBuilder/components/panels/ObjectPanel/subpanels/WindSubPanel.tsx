import { Slider, Checkbox, Select } from '../../../ui';
import type { SelectOption } from '../../../ui';
import type { Entity } from '@/core/ecs/Entity';
import type { WindComponent, WindDebugMode } from '@/core/ecs/components/WindComponent';
import type { MeshComponent } from '@/core/ecs/components/MeshComponent';
import styles from '../ObjectPanel.module.css';

const WIND_DEBUG_OPTIONS: SelectOption<WindDebugMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'wind-type', label: 'Wind Type' },
  { value: 'height-factor', label: 'Height Factor' },
  { value: 'displacement', label: 'Displacement' },
];

export interface WindSubPanelProps {
  entity: Entity;
  onChanged: () => void;
}

export function WindSubPanel({ entity, onChanged }: WindSubPanelProps) {
  const wc = entity.getComponent<WindComponent>('wind');
  if (!wc) return null;

  // Read materials from entity's mesh component for leaf/branch assignment
  const mesh = entity.getComponent<MeshComponent>('mesh');
  const materials: { name: string; baseColorFactor?: number[] }[] =
    mesh?.model?.materials.map((mat, i) => ({
      name: `Material ${i}`,
      baseColorFactor: mat.baseColorFactor as number[] | undefined,
    })) ?? [];

  const getColorStr = (color?: number[]): string => {
    const c = color || [0.8, 0.8, 0.8, 1];
    return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
  };

  const handleToggleLeaf = (idx: number) => {
    if (wc.leafMaterialIndices.has(idx)) {
      wc.leafMaterialIndices.delete(idx);
    } else {
      wc.leafMaterialIndices.add(idx);
    }
    onChanged();
  };

  const handleToggleBranch = (idx: number) => {
    if (wc.branchMaterialIndices.has(idx)) {
      wc.branchMaterialIndices.delete(idx);
    } else {
      wc.branchMaterialIndices.add(idx);
    }
    onChanged();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <Checkbox
        label="Enabled"
        checked={wc.enabled}
        onChange={(checked) => {
          wc.enabled = checked;
          onChanged();
        }}
      />
      <div style={{ opacity: wc.enabled ? 1 : 0.4, pointerEvents: wc.enabled ? 'auto' : 'none' }}>
        <Slider
          label="Influence"
          value={wc.influence}
          min={0}
          max={2}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            wc.influence = value;
            onChanged();
          }}
        />
        <Slider
          label="Stiffness"
          value={wc.stiffness}
          min={0}
          max={1}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            wc.stiffness = value;
            onChanged();
          }}
        />
        <Slider
          label="Anchor Height"
          value={wc.anchorHeight}
          min={-1}
          max={5}
          step={0.1}
          format={(v) => v.toFixed(1)}
          onChange={(value) => {
            wc.anchorHeight = value;
            onChanged();
          }}
        />

        {/* Leaf Materials */}
        {materials.length > 0 && (
          <div class={styles.materialSection}>
            <label class={styles.materialLabel}>Leaf Materials</label>
            <div class={styles.materialList}>
              {materials.map((mat, idx) => {
                const isLeaf = wc.leafMaterialIndices.has(idx);
                return (
                  <div
                    key={idx}
                    class={styles.materialItem}
                    onClick={() => handleToggleLeaf(idx)}
                  >
                    <input type="checkbox" checked={isLeaf} readOnly />
                    <div
                      class={styles.materialSwatch}
                      style={{ background: getColorStr(mat.baseColorFactor) }}
                    />
                    <span class={styles.materialName}>{mat.name}</span>
                    {isLeaf && <span class={styles.leafBadge}>Leaf</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Debug Mode */}
        <Select
          label="Debug Mode"
          value={wc.debugMode}
          options={WIND_DEBUG_OPTIONS}
          onChange={(value) => {
            wc.debugMode = value;
            onChanged();
          }}
        />

        {/* Branch Materials */}
        {materials.length > 0 && (
          <div class={styles.materialSection}>
            <label class={styles.materialLabel}>Branch Materials</label>
            <div class={styles.materialList}>
              {materials.map((mat, idx) => {
                const isBranch = wc.branchMaterialIndices.has(idx);
                return (
                  <div
                    key={idx}
                    class={styles.materialItem}
                    onClick={() => handleToggleBranch(idx)}
                  >
                    <input type="checkbox" checked={isBranch} readOnly />
                    <div
                      class={styles.materialSwatch}
                      style={{ background: getColorStr(mat.baseColorFactor) }}
                    />
                    <span class={styles.materialName}>{mat.name}</span>
                    {isBranch && <span class={styles.branchBadge}>Branch</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}