import { useState, useCallback, useEffect } from 'preact/hooks';
import { Slider } from '../../ui';
import { getMaterialRegistry, type MaterialDefinition } from '@/core/materials';
import styles from './TerrainPanel.module.css';

// ==================== Types ====================

/** Biome types for material assignment (3 biomes: grass, rock, forest) */
export type BiomeType = 'grass' | 'rock' | 'forest';

/**
 * Material params for terrain rendering.
 * Uses material registry IDs instead of individual texture/color selectors.
 * Each biome references a material from the central MaterialRegistry.
 */
export interface MaterialParams {
  // Primary biome colors (used as fallback when no material is assigned)
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  forestColor: [number, number, number];
  
  // Material registry IDs per biome (null = use fallback color)
  grassMaterialId?: string | null;
  rockMaterialId?: string | null;
  forestMaterialId?: string | null;
  
  // Tiling scale overrides per biome (world units per texture tile)
  grassTiling?: number;
  rockTiling?: number;
  forestTiling?: number;
}

export interface MaterialSectionProps {
  params: MaterialParams;
  onParamsChange: (params: Partial<MaterialParams>) => void;
  /** Whether island mode is enabled (shows beach controls) */
  islandEnabled?: boolean;
  /** Callback when a biome material is selected */
  onBiomeMaterialSelect?: (biome: BiomeType, materialId: string | null, tilingScale: number) => void;
}

// ==================== Icons ====================

const MaterialIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
  </svg>
);

const ClearIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

// ==================== Sub-components ====================

/** Small color swatch showing the material's albedo */
function MaterialSwatch({ color }: { color: [number, number, number] }) {
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  return (
    <div
      style={{
        width: '14px',
        height: '14px',
        borderRadius: '2px',
        backgroundColor: `rgb(${r},${g},${b})`,
        border: '1px solid rgba(255,255,255,0.2)',
        flexShrink: 0,
      }}
    />
  );
}

interface BiomeMaterialRowProps {
  label: string;
  biome: BiomeType;
  materialId: string | null | undefined;
  tilingScale: number;
  materials: MaterialDefinition[];
  onMaterialChange: (biome: BiomeType, materialId: string | null) => void;
  onTilingChange: (biome: BiomeType, scale: number) => void;
}

function BiomeMaterialRow({
  label,
  biome,
  materialId,
  tilingScale,
  materials,
  onMaterialChange,
  onTilingChange,
}: BiomeMaterialRowProps) {
  const hasMaterial = materialId != null;
  const selectedMaterial = hasMaterial ? materials.find(m => m.id === materialId) : null;
  
  return (
    <div class={styles.biomeRow}>
      <div class={styles.biomeColorRow}>
        {/* Material swatch */}
        {selectedMaterial && <MaterialSwatch color={selectedMaterial.albedo} />}
        {!selectedMaterial && (
          <div style={{
            width: '14px', height: '14px', borderRadius: '2px',
            backgroundColor: '#333', border: '1px dashed #666', flexShrink: 0,
          }} />
        )}
        
        {/* Material dropdown */}
        <select
          class={styles.materialSelect}
          value={materialId ?? ''}
          onChange={(e) => {
            const value = (e.target as HTMLSelectElement).value;
            onMaterialChange(biome, value || null);
          }}
          title={selectedMaterial ? `${label}: ${selectedMaterial.name}` : `Select ${label} material`}
        >
          <option value="">— {label} (none) —</option>
          {materials.map(mat => (
            <option key={mat.id} value={mat.id}>
              {mat.isPreset ? '⬡ ' : ''}{mat.name}
            </option>
          ))}
        </select>
        
        {/* Clear button */}
        {hasMaterial && (
          <button
            class={styles.clearTextureButton}
            onClick={() => onMaterialChange(biome, null)}
            title="Clear material"
          >
            <ClearIcon />
          </button>
        )}
      </div>
      
      {/* Tiling slider (shown when material is assigned) */}
      {hasMaterial && (
        <div class={styles.textureTilingRow}>
          <Slider
            label="Tiling"
            value={tilingScale}
            min={0.5}
            max={20}
            step={0.5}
            format={(v) => `${v.toFixed(1)}m`}
            onChange={(v) => onTilingChange(biome, v)}
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
  onBiomeMaterialSelect 
}: MaterialSectionProps) {
  // Get all materials from registry (reactive via signal)
  const registry = getMaterialRegistry();
  const [materials, setMaterials] = useState<MaterialDefinition[]>(registry.materialsSignal.value);
  
  // Subscribe to material registry changes
  useEffect(() => {
    // Update when signal changes
    const unsub = registry.materialsSignal.subscribe((mats) => {
      setMaterials(mats);
    });
    return unsub;
  }, [registry]);
  
  // Handle material selection for a biome
  const handleMaterialChange = useCallback((biome: BiomeType, materialId: string | null) => {
    const key = `${biome}MaterialId` as keyof MaterialParams;
    const tilingKey = `${biome}Tiling` as keyof MaterialParams;
    const tilingScale = (params[tilingKey] as number) ?? 4.0;
    
    onParamsChange({ [key]: materialId } as Partial<MaterialParams>);
    
    // If a material is selected, also update the fallback color from the material's albedo
    if (materialId) {
      const mat = registry.get(materialId);
      if (mat) {
        const colorKey = `${biome}Color` as keyof MaterialParams;
        onParamsChange({ [colorKey]: mat.albedo } as Partial<MaterialParams>);
      }
    }
    
    onBiomeMaterialSelect?.(biome, materialId, tilingScale);
  }, [params, onParamsChange, onBiomeMaterialSelect, registry]);
  
  // Handle tiling change
  const handleTilingChange = useCallback((biome: BiomeType, scale: number) => {
    const tilingKey = `${biome}Tiling` as keyof MaterialParams;
    const matKey = `${biome}MaterialId` as keyof MaterialParams;
    const materialId = params[matKey] as string | null | undefined;
    
    onParamsChange({ [tilingKey]: scale } as Partial<MaterialParams>);
    onBiomeMaterialSelect?.(biome, materialId ?? null, scale);
  }, [params, onParamsChange, onBiomeMaterialSelect]);

  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Material</div>

      <div class={styles.subsectionTitle}>Biome Materials</div>
      <div class={styles.hint}>
        Assign materials from the Material Registry to each biome.
      </div>
      
      <BiomeMaterialRow
        label="Grass"
        biome="grass"
        materialId={params.grassMaterialId}
        tilingScale={params.grassTiling ?? 4.0}
        materials={materials}
        onMaterialChange={handleMaterialChange}
        onTilingChange={handleTilingChange}
      />
      
      <BiomeMaterialRow
        label="Rock"
        biome="rock"
        materialId={params.rockMaterialId}
        tilingScale={params.rockTiling ?? 8.0}
        materials={materials}
        onMaterialChange={handleMaterialChange}
        onTilingChange={handleTilingChange}
      />
      
      <BiomeMaterialRow
        label="Forest"
        biome="forest"
        materialId={params.forestMaterialId}
        tilingScale={params.forestTiling ?? 4.0}
        materials={materials}
        onMaterialChange={handleMaterialChange}
        onTilingChange={handleTilingChange}
      />
    </div>
  );
}
