/**
 * LayersSection - Terrain layer stack UI
 *
 * Displays an ordered list of terrain layers with:
 * - Visibility toggles, type badges, layer names
 * - Reorder (up/down) and delete buttons
 * - Add layer buttons for each type (noise, rock, flatten)
 * - Per-layer detail editor when selected (blend mode, blend factor, erodable, bounds)
 * - Bounds numeric fields that sync with LayerBoundsGizmo
 *
 * This is a pure presentational component — all state management is in the bridge.
 */

import { useCallback } from 'preact/hooks';
import { Slider, Checkbox } from '../../ui';
import type {
  TerrainLayer,
  TerrainLayerType,
  TerrainBlendMode,
  TerrainLayerBounds,
  TerrainLayerBlendCurve,
  RockLayerParams,
  FlattenLayerParams,
} from '../../../../../core/terrain/types';
import { createDefaultBlendCurve } from '../../../../../core/terrain/types';
import styles from './LayersSection.module.css';
import terrainStyles from './TerrainPanel.module.css';

// ============================================================================
// Types
// ============================================================================

export interface LayersSectionProps {
  /** All layers sorted by order */
  layers: ReadonlyArray<TerrainLayer>;
  /** Currently selected layer ID (null = none) */
  selectedLayerId: string | null;
  /** Callbacks */
  onSelectLayer: (layerId: string | null) => void;
  onAddLayer: (type: TerrainLayerType) => void;
  onRemoveLayer: (layerId: string) => void;
  onUpdateLayer: (layerId: string, updates: Partial<TerrainLayer>) => void;
  onReorderLayer: (layerId: string, direction: 'up' | 'down') => void;
  onToggleLayerVisibility: (layerId: string) => void;
  /** Called when bounds are modified via numeric fields (syncs to gizmo) */
  onBoundsChange?: (layerId: string, bounds: TerrainLayerBounds | null) => void;
}

// ============================================================================
// Blend mode options
// ============================================================================

const BLEND_MODE_OPTIONS: Array<{ value: TerrainBlendMode; label: string }> = [
  { value: 'additive', label: 'Additive' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'replace', label: 'Replace' },
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
];

// ============================================================================
// Component
// ============================================================================

export function LayersSection({
  layers,
  selectedLayerId,
  onSelectLayer,
  onAddLayer,
  onRemoveLayer,
  onUpdateLayer,
  onReorderLayer,
  onToggleLayerVisibility,
  onBoundsChange,
}: LayersSectionProps) {
  const selectedLayer = layers.find(l => l.id === selectedLayerId) ?? null;

  return (
    <div class={terrainStyles.section}>
      <div class={terrainStyles.sectionTitle}>Layers</div>

      {/* Add layer buttons */}
      <div class={styles.addLayerRow}>
        <button class={styles.addLayerBtn} onClick={() => onAddLayer('noise')}>+ Noise</button>
        <button class={styles.addLayerBtn} onClick={() => onAddLayer('rock')}>+ Rock</button>
        <button class={styles.addLayerBtn} onClick={() => onAddLayer('flatten')}>+ Flatten</button>
      </div>

      {/* Layer list */}
      {layers.length === 0 ? (
        <div class={styles.emptyState}>No layers — using base heightmap only</div>
      ) : (
        <div class={styles.layerList}>
          {layers.map((layer, idx) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              index={idx}
              total={layers.length}
              isSelected={layer.id === selectedLayerId}
              onSelect={() => onSelectLayer(layer.id === selectedLayerId ? null : layer.id)}
              onToggleVisibility={() => onToggleLayerVisibility(layer.id)}
              onMoveUp={() => onReorderLayer(layer.id, 'up')}
              onMoveDown={() => onReorderLayer(layer.id, 'down')}
              onDelete={() => onRemoveLayer(layer.id)}
            />
          ))}
        </div>
      )}

      {/* Selected layer detail editor */}
      {selectedLayer && (
        <LayerDetailEditor
          layer={selectedLayer}
          onUpdate={(updates) => onUpdateLayer(selectedLayer.id, updates)}
          onBoundsChange={onBoundsChange ? (bounds) => onBoundsChange(selectedLayer.id, bounds) : undefined}
        />
      )}
    </div>
  );
}

// ============================================================================
// LayerRow — single layer in the list
// ============================================================================

interface LayerRowProps {
  layer: TerrainLayer;
  index: number;
  total: number;
  isSelected: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function LayerRow({
  layer,
  index,
  total,
  isSelected,
  onSelect,
  onToggleVisibility,
  onMoveUp,
  onMoveDown,
  onDelete,
}: LayerRowProps) {
  const rowClass = [
    styles.layerRow,
    isSelected ? styles.selected : '',
    !layer.enabled ? styles.disabled : '',
  ].filter(Boolean).join(' ');

  const badgeClass = [styles.layerTypeBadge, styles[layer.type]].join(' ');

  return (
    <div class={rowClass} onClick={onSelect}>
      {/* Visibility toggle */}
      <button
        class={`${styles.visibilityBtn} ${layer.enabled ? styles.visible : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
        title={layer.enabled ? 'Hide layer' : 'Show layer'}
      >
        {layer.enabled ? '👁' : '👁‍🗨'}
      </button>

      {/* Type badge */}
      <span class={badgeClass}>{layer.type}</span>

      {/* Name */}
      <span class={styles.layerName}>{layer.name}</span>

      {/* Reorder */}
      <button
        class={styles.reorderBtn}
        disabled={index === 0}
        onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
        title="Move up"
      >▲</button>
      <button
        class={styles.reorderBtn}
        disabled={index === total - 1}
        onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
        title="Move down"
      >▼</button>

      {/* Delete */}
      <button
        class={styles.deleteBtn}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Remove layer"
      >✕</button>
    </div>
  );
}

// ============================================================================
// LayerDetailEditor — blend, params, bounds for the selected layer
// ============================================================================

interface LayerDetailEditorProps {
  layer: TerrainLayer;
  onUpdate: (updates: Partial<TerrainLayer>) => void;
  onBoundsChange?: (bounds: TerrainLayerBounds | null) => void;
}

function LayerDetailEditor({ layer, onUpdate, onBoundsChange }: LayerDetailEditorProps) {
  const handleBlendModeChange = useCallback((e: Event) => {
    onUpdate({ blendMode: (e.target as HTMLSelectElement).value as TerrainBlendMode });
  }, [onUpdate]);

  const handleBoundsToggle = useCallback((enabled: boolean) => {
    if (enabled) {
      const defaultBounds: TerrainLayerBounds = {
        centerX: 0, centerZ: 0,
        halfExtentX: 50, halfExtentZ: 50,
        rotation: 0, featherWidth: 10,
      };
      onUpdate({ bounds: defaultBounds });
      onBoundsChange?.(defaultBounds);
    } else {
      onUpdate({ bounds: null });
      onBoundsChange?.(null);
    }
  }, [onUpdate, onBoundsChange]);

  const handleBoundsFieldChange = useCallback((field: keyof TerrainLayerBounds, value: number) => {
    if (!layer.bounds) return;
    const updated = { ...layer.bounds, [field]: value };
    onUpdate({ bounds: updated });
    onBoundsChange?.(updated);
  }, [layer.bounds, onUpdate, onBoundsChange]);

  return (
    <div class={styles.layerDetail}>
      <div class={terrainStyles.sectionTitle}>Layer Settings</div>

      {/* Blend mode */}
      <div class={styles.detailRow}>
        <span class={styles.detailLabel}>Blend</span>
        <select class={styles.detailSelect} value={layer.blendMode} onChange={handleBlendModeChange}>
          {BLEND_MODE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Blend factor */}
      <Slider
        label="Blend Factor"
        value={layer.blendFactor}
        min={0} max={1} step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => onUpdate({ blendFactor: v })}
      />

      {/* Erodable */}
      <Checkbox
        label="Erodable (affected by erosion)"
        checked={layer.erodable}
        onChange={(v) => onUpdate({ erodable: v })}
      />

      {/* Type-specific params */}
      {layer.type === 'rock' && layer.rockParams && (
        <RockParamsEditor params={layer.rockParams} onUpdate={(rp) => onUpdate({ rockParams: rp })} />
      )}
      {layer.type === 'flatten' && layer.flattenParams && (
        <FlattenParamsEditor params={layer.flattenParams} onUpdate={(fp) => onUpdate({ flattenParams: fp })} />
      )}

      {/* Blend Curve (height/slope modulation) */}
      <BlendCurveEditor
        curve={layer.blendCurve}
        onUpdate={(curve) => onUpdate({ blendCurve: curve })}
      />

      {/* Bounds toggle + fields */}
      <div class={styles.boundsToggleRow}>
        <Checkbox
          label="Spatial Bounds"
          checked={layer.bounds !== null}
          onChange={handleBoundsToggle}
        />
      </div>

      {layer.bounds && (
        <BoundsFields bounds={layer.bounds} onChange={handleBoundsFieldChange} />
      )}
    </div>
  );
}

// ============================================================================
// BlendCurveEditor — height/slope blend curve controls
// ============================================================================

interface BlendCurveEditorProps {
  curve?: TerrainLayerBlendCurve;
  onUpdate: (curve: TerrainLayerBlendCurve) => void;
}

function BlendCurveEditor({ curve, onUpdate }: BlendCurveEditorProps) {
  const c = curve ?? createDefaultBlendCurve();

  const set = useCallback(<K extends keyof TerrainLayerBlendCurve>(key: K, value: TerrainLayerBlendCurve[K]) => {
    onUpdate({ ...c, [key]: value });
  }, [c, onUpdate]);

  return (
    <>
      <div class={terrainStyles.sectionTitle}>Blend Curve</div>

      {/* Height modulation */}
      <Checkbox label="Height Modulation" checked={c.heightEnabled}
        onChange={(v) => set('heightEnabled', v)} />
      {c.heightEnabled && (
        <>
          <Slider label="Height Min" value={c.heightMin} min={0} max={1} step={0.01}
            format={(v) => v.toFixed(2)} onChange={(v) => set('heightMin', v)} />
          <Slider label="Height Max" value={c.heightMax} min={0} max={1} step={0.01}
            format={(v) => v.toFixed(2)} onChange={(v) => set('heightMax', v)} />
          <Checkbox label="Invert (stronger at low)" checked={c.heightInvert}
            onChange={(v) => set('heightInvert', v)} />
        </>
      )}

      {/* Slope modulation */}
      <Checkbox label="Slope Modulation" checked={c.slopeEnabled}
        onChange={(v) => set('slopeEnabled', v)} />
      {c.slopeEnabled && (
        <>
          <Slider label="Slope Min" value={c.slopeMin} min={0} max={1} step={0.01}
            format={(v) => v.toFixed(2)} onChange={(v) => set('slopeMin', v)} />
          <Slider label="Slope Max" value={c.slopeMax} min={0} max={1} step={0.01}
            format={(v) => v.toFixed(2)} onChange={(v) => set('slopeMax', v)} />
          <Checkbox label="Invert (stronger on flat)" checked={c.slopeInvert}
            onChange={(v) => set('slopeInvert', v)} />
        </>
      )}
    </>
  );
}

// ============================================================================
// RockParamsEditor
// ============================================================================

interface RockParamsEditorProps {
  params: RockLayerParams;
  onUpdate: (params: RockLayerParams) => void;
}

function RockParamsEditor({ params, onUpdate }: RockParamsEditorProps) {
  const set = useCallback(<K extends keyof RockLayerParams>(key: K, value: RockLayerParams[K]) => {
    onUpdate({ ...params, [key]: value });
  }, [params, onUpdate]);

  return (
    <>
      <div class={terrainStyles.sectionTitle}>Rock Parameters</div>
      <Slider label="Rock Sharpness" value={params.rockSharpness} min={1} max={5} step={0.1}
        format={(v) => v.toFixed(1)} onChange={(v) => set('rockSharpness', v)} />
      <Slider label="Strata Frequency" value={params.strataFrequency} min={5} max={50} step={1}
        format={(v) => v.toFixed(0)} onChange={(v) => set('strataFrequency', v)} />
      <Slider label="Strata Strength" value={params.strataStrength} min={0} max={1} step={0.01}
        format={(v) => v.toFixed(2)} onChange={(v) => set('strataStrength', v)} />
      <Slider label="Ridge Exponent" value={params.ridgeExponent} min={1} max={3} step={0.1}
        format={(v) => v.toFixed(1)} onChange={(v) => set('ridgeExponent', v)} />
      <Slider label="Detail Frequency" value={params.detailFrequency} min={2} max={20} step={0.5}
        format={(v) => v.toFixed(1)} onChange={(v) => set('detailFrequency', v)} />
      <Slider label="Detail Strength" value={params.detailStrength} min={0} max={1} step={0.01}
        format={(v) => v.toFixed(2)} onChange={(v) => set('detailStrength', v)} />
      <Slider label="Height Scale" value={params.heightScale} min={0.01} max={2} step={0.01}
        format={(v) => v.toFixed(2)} onChange={(v) => set('heightScale', v)} />
    </>
  );
}

// ============================================================================
// FlattenParamsEditor
// ============================================================================

interface FlattenParamsEditorProps {
  params: FlattenLayerParams;
  onUpdate: (params: FlattenLayerParams) => void;
}

function FlattenParamsEditor({ params, onUpdate }: FlattenParamsEditorProps) {
  return (
    <>
      <div class={terrainStyles.sectionTitle}>Flatten Parameters</div>
      <Slider label="Target Height" value={params.targetHeight} min={-0.5} max={0.5} step={0.01}
        format={(v) => v.toFixed(2)} onChange={(v) => onUpdate({ targetHeight: v })} />
    </>
  );
}

// ============================================================================
// BoundsFields — numeric inputs for bounds properties
// ============================================================================

interface BoundsFieldsProps {
  bounds: TerrainLayerBounds;
  onChange: (field: keyof TerrainLayerBounds, value: number) => void;
}

function BoundsFields({ bounds, onChange }: BoundsFieldsProps) {
  const field = (label: string, key: keyof TerrainLayerBounds, value: number) => (
    <div class={styles.boundsField}>
      <span class={styles.boundsFieldLabel}>{label}</span>
      <input
        class={styles.boundsFieldInput}
        type="number"
        value={value.toFixed(1)}
        step="1"
        onInput={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (!isNaN(v)) onChange(key, v);
        }}
      />
    </div>
  );

  return (
    <div class={styles.boundsFieldsGrid}>
      {field('X', 'centerX', bounds.centerX)}
      {field('Z', 'centerZ', bounds.centerZ)}
      {field('W/2', 'halfExtentX', bounds.halfExtentX)}
      {field('H/2', 'halfExtentZ', bounds.halfExtentZ)}
      {field('Rot°', 'rotation', bounds.rotation)}
      {field('Feath', 'featherWidth', bounds.featherWidth)}
    </div>
  );
}
