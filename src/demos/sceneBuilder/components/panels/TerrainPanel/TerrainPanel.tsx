import { useState, useCallback, useMemo } from 'preact/hooks';
import { Panel, Slider, Select, Checkbox } from '../../ui';
import { NoiseSection, type NoiseParams } from './NoiseSection';
import { ErosionSection, type ErosionParams } from './ErosionSection';
import { MaterialSection, type MaterialParams } from './MaterialSection';
import { DetailSection, type DetailParams } from './DetailSection';
import styles from './TerrainPanel.module.css';

// Preset definition
export interface TerrainPreset {
  key: string;
  label: string;
}

export const TERRAIN_PRESETS: TerrainPreset[] = [
  { key: 'default', label: 'Default' },
  { key: 'rolling-hills', label: 'Rolling Hills' },
  { key: 'alpine-mountains', label: 'Alpine Mountains' },
  { key: 'desert-dunes', label: 'Desert Dunes' },
  { key: 'rocky-badlands', label: 'Rocky Badlands' },
  { key: 'volcanic-island', label: 'Volcanic Island' },
];

// Resolution options
const RESOLUTION_OPTIONS = [
  { value: '64', label: '64×64 (Fast)' },
  { value: '128', label: '128×128' },
  { value: '256', label: '256×256' },
  { value: '512', label: '512×512' },
  { value: '1024', label: '1024×1024' },
  { value: '2048', label: '2048×2048 (High)' },
  { value: '4096', label: '4096×4096 (Ultra)' },
];

export interface TerrainPanelProps {
  // Whether a terrain is currently selected
  hasTerrainSelected?: boolean;
  
  // Resolution & world size
  resolution: number;
  onResolutionChange: (resolution: number) => void;
  worldSize: number;
  onWorldSizeChange: (size: number) => void;

  // Noise parameters
  noiseParams: NoiseParams;
  onNoiseParamsChange: (params: Partial<NoiseParams>) => void;

  // Erosion parameters
  erosionParams: ErosionParams;
  onErosionParamsChange: (params: Partial<ErosionParams>) => void;

  // Material parameters
  materialParams: MaterialParams;
  onMaterialParamsChange: (params: Partial<MaterialParams>) => void;

  // Detail parameters (WebGPU only)
  detailParams?: DetailParams;
  onDetailParamsChange?: (params: Partial<DetailParams>) => void;

  // Rendering mode (WebGL only)
  cdlodEnabled?: boolean;
  onCdlodEnabledChange?: (enabled: boolean) => void;
  clipmapEnabled?: boolean;
  onClipmapEnabledChange?: (enabled: boolean) => void;

  // Preset
  currentPreset: string;
  onPresetChange: (preset: string) => void;
  onResetToPreset: () => void;

  // Update action
  onUpdate: () => Promise<void>;

  // Progress callback
  progress?: {
    stage: string;
    percent: number;
  };

  // Mode indicator
  isWebGPU?: boolean;
}

export function TerrainPanel({
  hasTerrainSelected = false,
  resolution,
  onResolutionChange,
  worldSize,
  onWorldSizeChange,
  noiseParams,
  onNoiseParamsChange,
  erosionParams,
  onErosionParamsChange,
  materialParams,
  onMaterialParamsChange,
  detailParams,
  onDetailParamsChange,
  cdlodEnabled,
  onCdlodEnabledChange,
  clipmapEnabled,
  onClipmapEnabledChange,
  currentPreset,
  onPresetChange,
  onResetToPreset,
  onUpdate,
  progress,
  isWebGPU = false,
}: TerrainPanelProps) {
  const [isUpdating, setIsUpdating] = useState(false);

  // Calculate heightScaleMax based on worldSize
  const heightScaleMax = useMemo(() => Math.max(1, worldSize / 10 + 100), [worldSize]);

  // Show placeholder if no terrain selected
  if (!hasTerrainSelected) {
    return (
      <Panel title="Terrain">
        <div class={styles.panel}>
          <div class={styles.noTerrainPlaceholder}>
            <div class={styles.placeholderIcon}>🏔️</div>
            <div class={styles.placeholderText}>No terrain selected</div>
            <div class={styles.placeholderHint}>
              Select a terrain object from the scene to edit its parameters
            </div>
          </div>
        </div>
      </Panel>
    );
  }

  const handleUpdate = useCallback(async () => {
    setIsUpdating(true);
    try {
      await onUpdate();
    } finally {
      setIsUpdating(false);
    }
  }, [onUpdate]);

  const handleRandomizeSeed = useCallback(() => {
    onNoiseParamsChange({ seed: Math.floor(Math.random() * 100000) });
  }, [onNoiseParamsChange]);

  const presetOptions = useMemo(
    () => TERRAIN_PRESETS.map((p) => ({ value: p.key, label: p.label })),
    []
  );

  return (
    <Panel title="Terrain">
      <div class={styles.panel}>
        {/* Preset */}
        <div class={styles.sectionTitle}>Preset</div>
        <div class={styles.presetRow}>
          <select
            class={styles.presetSelect}
            value={currentPreset}
            onChange={(e) => onPresetChange((e.target as HTMLSelectElement).value)}
          >
            {TERRAIN_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <button class={styles.resetBtn} onClick={onResetToPreset} title="Reset to preset values">
            ↺ Reset
          </button>
        </div>

        <div class={styles.divider} />

        {/* Resolution */}
        <div class={styles.sectionTitle}>Resolution</div>
        <Select
          label="Resolution"
          value={String(resolution)}
          options={RESOLUTION_OPTIONS}
          onChange={(v) => onResolutionChange(parseInt(v, 10))}
        />

        <Slider
          label="World Size"
          value={worldSize}
          min={10}
          max={1000}
          step={10}
          format={(v) => String(v)}
          onChange={onWorldSizeChange}
        />

        {/* Rendering Mode (WebGL only) */}
        {!isWebGPU && onCdlodEnabledChange && onClipmapEnabledChange && (
          <>
            <div class={styles.divider} />
            <div class={styles.sectionTitle}>Rendering Mode</div>
            <div class={styles.renderingMode}>
              <Checkbox
                label="Enable CDLOD (Quadtree LOD)"
                checked={cdlodEnabled || false}
                onChange={(v) => {
                  onCdlodEnabledChange(v);
                  if (v && clipmapEnabled) onClipmapEnabledChange(false);
                }}
              />
              <Checkbox
                label="Enable Clipmap (Geometric LOD)"
                checked={clipmapEnabled || false}
                onChange={(v) => {
                  onClipmapEnabledChange(v);
                  if (v && cdlodEnabled) onCdlodEnabledChange(false);
                }}
              />
            </div>
          </>
        )}

        <div class={styles.divider} />

        {/* Noise Section */}
        <NoiseSection
          params={noiseParams}
          onParamsChange={onNoiseParamsChange}
          onRandomizeSeed={handleRandomizeSeed}
          heightScaleMax={heightScaleMax}
        />

        <div class={styles.divider} />

        {/* Erosion Section */}
        <ErosionSection params={erosionParams} onParamsChange={onErosionParamsChange} />

        <div class={styles.divider} />

        {/* Material Section */}
        <MaterialSection 
          params={materialParams} 
          onParamsChange={onMaterialParamsChange} 
          islandEnabled={noiseParams.islandEnabled}
        />

        {/* Detail Section (WebGPU only) */}
        {detailParams && onDetailParamsChange && (
          <>
            <div class={styles.divider} />
            <DetailSection params={detailParams} onParamsChange={onDetailParamsChange} />
          </>
        )}

        {/* Update Button */}
        <button class={styles.updateBtn} onClick={handleUpdate} disabled={isUpdating}>
          Update Terrain
        </button>

        {/* Progress Bar */}
        {progress && (
          <div class={`${styles.progressContainer} ${isUpdating ? styles.active : ''}`}>
            <div class={styles.progressBar}>
              <div class={styles.progressFill} style={{ width: `${progress.percent}%` }} />
            </div>
            <div class={styles.progressText}>{progress.stage}</div>
          </div>
        )}
      </div>
    </Panel>
  );
}
