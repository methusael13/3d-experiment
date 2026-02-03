import { useCallback } from 'preact/hooks';
import { Checkbox, Slider } from '../../ui';
import styles from './ObjectPanel.module.css';

export interface WindSettings {
  enabled: boolean;
  influence: number;
  stiffness: number;
  anchorHeight: number;
  leafMaterialIndices: Set<number>;
  branchMaterialIndices: Set<number>;
}

export interface TerrainBlendSettings {
  enabled: boolean;
  blendDistance: number;
}

export interface MaterialInfo {
  name?: string;
  baseColorFactor?: number[];
}

export interface ModifiersTabProps {
  windSettings: WindSettings;
  terrainBlendSettings: TerrainBlendSettings;
  materials: MaterialInfo[];
  onWindSettingsChange: (settings: Partial<WindSettings>) => void;
  onTerrainBlendChange: (settings: Partial<TerrainBlendSettings>) => void;
  onToggleLeafMaterial: (index: number) => void;
  onToggleBranchMaterial: (index: number) => void;
}

export function ModifiersTab({
  windSettings,
  terrainBlendSettings,
  materials,
  onWindSettingsChange,
  onTerrainBlendChange,
  onToggleLeafMaterial,
  onToggleBranchMaterial,
}: ModifiersTabProps) {
  // Wind controls
  const handleWindEnabled = useCallback(
    (enabled: boolean) => {
      onWindSettingsChange({ enabled });
    },
    [onWindSettingsChange]
  );

  const handleWindInfluence = useCallback(
    (value: number) => {
      onWindSettingsChange({ influence: value });
    },
    [onWindSettingsChange]
  );

  const handleWindStiffness = useCallback(
    (value: number) => {
      onWindSettingsChange({ stiffness: value });
    },
    [onWindSettingsChange]
  );

  const handleWindAnchor = useCallback(
    (value: number) => {
      onWindSettingsChange({ anchorHeight: value });
    },
    [onWindSettingsChange]
  );

  // Terrain blend controls
  const handleTerrainBlendEnabled = useCallback(
    (enabled: boolean) => {
      onTerrainBlendChange({ enabled });
    },
    [onTerrainBlendChange]
  );

  const handleBlendDistance = useCallback(
    (value: number) => {
      onTerrainBlendChange({ blendDistance: value });
    },
    [onTerrainBlendChange]
  );

  // Helper to get color string from material
  const getColorStr = (mat: MaterialInfo): string => {
    const color = mat.baseColorFactor || [0.8, 0.8, 0.8, 1];
    return `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`;
  };

  return (
    <div class={styles.modifiersTab}>
      {/* Wind Modifier Section */}
      <div class={styles.modifierSection}>
        <Checkbox
          label="Wind Affects This Object"
          checked={windSettings.enabled}
          onChange={handleWindEnabled}
        />

        <div
          class={`${styles.modifierSettings} ${!windSettings.enabled ? styles.disabled : ''}`}
        >
          <Slider
            label="Influence"
            value={windSettings.influence}
            min={0}
            max={2}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleWindInfluence}
            disabled={!windSettings.enabled}
          />

          <Slider
            label="Stiffness"
            value={windSettings.stiffness}
            min={0}
            max={1}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleWindStiffness}
            disabled={!windSettings.enabled}
          />

          <Slider
            label="Anchor Height"
            value={windSettings.anchorHeight}
            min={-2}
            max={5}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleWindAnchor}
            disabled={!windSettings.enabled}
          />

          {/* Leaf Materials */}
          <div class={styles.materialSection}>
            <label class={styles.materialLabel}>Leaf Materials</label>
            <div class={styles.materialList}>
              {materials.length > 0 ? (
                materials.map((mat, idx) => {
                  const isLeaf = windSettings.leafMaterialIndices.has(idx);
                  return (
                    <div
                      key={idx}
                      class={styles.materialItem}
                      onClick={() => onToggleLeafMaterial(idx)}
                    >
                      <input type="checkbox" checked={isLeaf} readOnly />
                      <div
                        class={styles.materialSwatch}
                        style={{ background: getColorStr(mat) }}
                      />
                      <span class={styles.materialName}>
                        {mat.name || `Material ${idx}`}
                      </span>
                      {isLeaf && <span class={styles.leafBadge}>Leaf</span>}
                    </div>
                  );
                })
              ) : (
                <div class={styles.noMaterials}>No materials found</div>
              )}
            </div>
          </div>

          {/* Branch Materials */}
          <div class={styles.materialSection}>
            <label class={styles.materialLabel}>Branch Materials</label>
            <div class={styles.materialList}>
              {materials.length > 0 ? (
                materials.map((mat, idx) => {
                  const isBranch = windSettings.branchMaterialIndices.has(idx);
                  return (
                    <div
                      key={idx}
                      class={styles.materialItem}
                      onClick={() => onToggleBranchMaterial(idx)}
                    >
                      <input type="checkbox" checked={isBranch} readOnly />
                      <div
                        class={styles.materialSwatch}
                        style={{ background: getColorStr(mat) }}
                      />
                      <span class={styles.materialName}>
                        {mat.name || `Material ${idx}`}
                      </span>
                      {isBranch && <span class={styles.branchBadge}>Branch</span>}
                    </div>
                  );
                })
              ) : (
                <div class={styles.noMaterials}>No materials found</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div class={styles.modifierDivider} />

      {/* Terrain Blend Section */}
      <div class={styles.modifierSection}>
        <Checkbox
          label="Terrain Blend"
          checked={terrainBlendSettings.enabled}
          onChange={handleTerrainBlendEnabled}
        />

        <div
          class={`${styles.modifierSettings} ${!terrainBlendSettings.enabled ? styles.disabled : ''}`}
        >
          <Slider
            label="Blend Distance"
            value={terrainBlendSettings.blendDistance}
            min={0.1}
            max={2}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={handleBlendDistance}
            disabled={!terrainBlendSettings.enabled}
          />
          <p class={styles.helpText}>
            Fades object edges at intersections with other geometry
          </p>
        </div>
      </div>
    </div>
  );
}
