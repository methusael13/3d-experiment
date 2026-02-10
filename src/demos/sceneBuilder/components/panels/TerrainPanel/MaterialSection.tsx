import { useState, useCallback } from 'preact/hooks';
import { Slider, ColorPicker } from '../../ui';
import { AssetPickerModal } from '../../ui/AssetPickerModal';
import type { Asset } from '../../hooks/useAssetLibrary';
import styles from './TerrainPanel.module.css';

// ==================== Types ====================

/** Biome types for texture assignment (3 biomes: grass, rock, forest) */
export type BiomeType = 'grass' | 'rock' | 'forest';

/** Biome texture configuration */
export interface BiomeTextureConfig {
  /** Selected texture asset (null if using solid color) */
  asset: Asset | null;
  /** Tiling scale in world units (from physicalSize) */
  tilingScale: number;
}

/**
 * Material params for terrain rendering.
 * Uses biome mask texture for weight calculation (R=grass, G=rock, B=forest).
 * Legacy fields kept for backwards compatibility with uniform buffer layout.
 */
export interface MaterialParams {
  // Primary biome colors (used by shader)
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  forestColor: [number, number, number];
  
  // Texture configurations per biome
  grassTexture?: BiomeTextureConfig;
  rockTexture?: BiomeTextureConfig;
  forestTexture?: BiomeTextureConfig;
}

export interface MaterialSectionProps {
  params: MaterialParams;
  onParamsChange: (params: Partial<MaterialParams>) => void;
  /** Whether island mode is enabled (shows beach controls) */
  islandEnabled?: boolean;
  /** Callback when a biome texture is selected */
  onBiomeTextureSelect?: (biome: BiomeType, asset: Asset | null, tilingScale: number) => void;
}

// ==================== Icons ====================

const TextureIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zm-5.04-6.71l-2.75 3.54-1.96-2.36L8.5 17h7l-2.75-3.54z"/>
  </svg>
);

const ClearIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

// ==================== Sub-components ====================

interface BiomeTextureRowProps {
  label: string;
  color: [number, number, number];
  texture?: BiomeTextureConfig;
  onColorChange: (color: [number, number, number]) => void;
  onTextureClick: () => void;
  onTextureClear: () => void;
  onTilingChange: (scale: number) => void;
}

function BiomeTextureRow({
  label,
  color,
  texture,
  onColorChange,
  onTextureClick,
  onTextureClear,
  onTilingChange,
}: BiomeTextureRowProps) {
  const hasTexture = texture?.asset !== null && texture?.asset !== undefined;
  
  return (
    <div class={styles.biomeRow}>
      <div class={styles.biomeColorRow}>
        <ColorPicker
          label={label}
          value={color}
          onChange={onColorChange}
        />
        <button
          class={`${styles.textureButton} ${hasTexture ? styles.hasTexture : ''}`}
          onClick={onTextureClick}
          title={hasTexture ? `Texture: ${texture?.asset?.name}` : 'Select texture'}
        >
          <TextureIcon />
        </button>
        {hasTexture && (
          <button
            class={styles.clearTextureButton}
            onClick={onTextureClear}
            title="Clear texture"
          >
            <ClearIcon />
          </button>
        )}
      </div>
      {hasTexture && (
        <div class={styles.textureTilingRow}>
          <span class={styles.textureLabel} title={texture?.asset?.name}>
            {texture?.asset?.name?.substring(0, 20)}...
          </span>
          <Slider
            label="Tiling"
            value={texture?.tilingScale ?? 2}
            min={0.5}
            max={20}
            step={0.5}
            format={(v) => `${v.toFixed(1)}m`}
            onChange={onTilingChange}
          />
        </div>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function MaterialSection({ 
  params, 
  onParamsChange, 
  islandEnabled = false,
  onBiomeTextureSelect 
}: MaterialSectionProps) {
  // State for texture picker modal
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeBiome, setActiveBiome] = useState<BiomeType | null>(null);
  
  const handleChange = useCallback(
    <K extends keyof MaterialParams>(key: K, value: MaterialParams[K]) => {
      onParamsChange({ [key]: value } as Partial<MaterialParams>);
    },
    [onParamsChange]
  );
  
  // Open texture picker for a specific biome
  const openTexturePicker = useCallback((biome: BiomeType) => {
    setActiveBiome(biome);
    setPickerOpen(true);
  }, []);
  
  // Handle texture selection from picker
  const handleTextureSelect = useCallback((asset: Asset) => {
    if (!activeBiome) return;
    
    // Parse physicalSize from asset metadata (e.g., "2x2" -> 2.0)
    let tilingScale = 2.0; // Default
    const meta = asset.metadata;
    if (meta?.physicalSize) {
      const sizeStr = String(meta.physicalSize);
      const match = sizeStr.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        tilingScale = parseFloat(match[1]);
      }
    }
    
    const textureConfig: BiomeTextureConfig = {
      asset,
      tilingScale,
    };
    
    // Update params
    const key = `${activeBiome}Texture` as keyof MaterialParams;
    onParamsChange({ [key]: textureConfig } as Partial<MaterialParams>);
    
    // Notify parent bridge
    onBiomeTextureSelect?.(activeBiome, asset, tilingScale);
    
    setPickerOpen(false);
    setActiveBiome(null);
  }, [activeBiome, onParamsChange, onBiomeTextureSelect]);
  
  // Clear texture for a biome
  const clearTexture = useCallback((biome: BiomeType) => {
    const key = `${biome}Texture` as keyof MaterialParams;
    onParamsChange({ [key]: { asset: null, tilingScale: 2 } } as Partial<MaterialParams>);
    onBiomeTextureSelect?.(biome, null, 2);
  }, [onParamsChange, onBiomeTextureSelect]);
  
  // Update tiling scale for a biome
  const updateTiling = useCallback((biome: BiomeType, scale: number) => {
    const key = `${biome}Texture` as keyof MaterialParams;
    const current = params[key] as BiomeTextureConfig | undefined;
    if (current?.asset) {
      onParamsChange({ [key]: { ...current, tilingScale: scale } } as Partial<MaterialParams>);
      onBiomeTextureSelect?.(biome, current.asset, scale);
    }
  }, [params, onParamsChange, onBiomeTextureSelect]);

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Material</div>

      {/* Legacy sliders removed - biome weights now come from biome mask texture */}

      <div class={styles.subsectionTitle}>Biome Textures</div>
      
      <BiomeTextureRow
        label="Grass"
        color={params.grassColor}
        texture={params.grassTexture}
        onColorChange={(v) => handleChange('grassColor', v)}
        onTextureClick={() => openTexturePicker('grass')}
        onTextureClear={() => clearTexture('grass')}
        onTilingChange={(v) => updateTiling('grass', v)}
      />
      
      <BiomeTextureRow
        label="Rock"
        color={params.rockColor}
        texture={params.rockTexture}
        onColorChange={(v) => handleChange('rockColor', v)}
        onTextureClick={() => openTexturePicker('rock')}
        onTextureClear={() => clearTexture('rock')}
        onTilingChange={(v) => updateTiling('rock', v)}
      />
      
      <BiomeTextureRow
        label="Forest"
        color={params.forestColor}
        texture={params.forestTexture}
        onColorChange={(v) => handleChange('forestColor', v)}
        onTextureClick={() => openTexturePicker('forest')}
        onTextureClear={() => clearTexture('forest')}
        onTilingChange={(v) => updateTiling('forest', v)}
      />
      
      {/* Texture picker modal */}
      <AssetPickerModal
        isOpen={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setActiveBiome(null);
        }}
        onSelect={handleTextureSelect}
        title={`Select ${activeBiome} Texture`}
        filterType="texture"
        filterCategory="vegetation"
      />
    </div>
  );
}
