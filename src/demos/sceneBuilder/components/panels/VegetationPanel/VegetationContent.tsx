/**
 * VegetationContent - Panel content for vegetation/plant registry management
 * 
 * Provides UI to:
 * - View/edit plants organized by biome tabs
 * - Add/remove plants
 * - Adjust plant properties (density, size, etc.)
 * - Associate texture atlases
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { signal, useSignal } from '@preact/signals';
import type { 
  PlantType, 
  BiomeChannel, 
  BiomePlantConfig,
  VegetationConfig,
  WindParams,
  AtlasReference,
} from '../../../../../core/vegetation/types';
import type { PlantRegistry, PlantRegistryEvent } from '../../../../../core/vegetation/PlantRegistry';
import { detectAtlasRegions } from '../../../../../core/vegetation/AtlasRegionDetector';
import { Section } from '../../ui/Section/Section';
import { AssetPickerModal } from '../../ui/AssetPickerModal';
import type { Asset } from '../../hooks/useAssetLibrary';
import styles from './VegetationContent.module.css';

// ==================== Types ====================

export interface VegetationContentProps {
  /** PlantRegistry instance from TerrainManager */
  registry: PlantRegistry;
}

interface BiomeTabInfo {
  channel: BiomeChannel;
  name: string;
  color: string;
}

const BIOME_TABS: BiomeTabInfo[] = [
  { channel: 'r', name: 'Grassland', color: '#4caf50' },
  { channel: 'g', name: 'Rock/Cliff', color: '#9e9e9e' },
  { channel: 'b', name: 'Forest Edge', color: '#2e7d32' },
];

// ==================== Icons ====================

const AddIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
  </svg>
);

const DeleteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
  </svg>
);

const TextureIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 3H3C2 3 1 4 1 5v14c0 1.1.9 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2zM5 17l3.5-4.5 2.5 3.01L14.5 11l4.5 6H5z"/>
  </svg>
);

const ExpandIcon = ({ expanded }: { expanded: boolean }) => (
  <svg 
    width="12" 
    height="12" 
    viewBox="0 0 24 24" 
    fill="currentColor"
    style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
  </svg>
);

// ==================== Sub-components ====================

interface PlantItemProps {
  plant: PlantType;
  onUpdate: (updates: Partial<PlantType>) => void;
  onDelete: () => void;
  onSelectAtlas: () => void;
}

function PlantItem({ plant, onUpdate, onDelete, onSelectAtlas }: PlantItemProps) {
  const [expanded, setExpanded] = useState(false);
  
  return (
    <div class={styles.plantItem}>
      {/* Header row */}
      <div class={styles.plantHeader} onClick={() => setExpanded(!expanded)}>
        <span class={styles.expandIcon}>
          <ExpandIcon expanded={expanded} />
        </span>
        <div 
          class={styles.plantColorSwatch} 
          style={{ backgroundColor: `rgb(${plant.color.map(c => Math.round(c * 255)).join(',')})` }}
        />
        <span class={styles.plantName}>{plant.name}</span>
        <div class={styles.plantActions}>
          <button 
            class={styles.iconButton}
            onClick={(e) => { e.stopPropagation(); onSelectAtlas(); }}
            title="Select texture atlas"
          >
            <TextureIcon />
          </button>
          <button 
            class={styles.iconButton}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete plant"
          >
            <DeleteIcon />
          </button>
        </div>
      </div>
      
      {/* Expanded properties */}
      {expanded && (
        <div class={styles.plantProperties}>
          {/* Name */}
          <div class={styles.propertyRow}>
            <label>Name</label>
            <input 
              type="text"
              value={plant.name}
              onInput={(e) => onUpdate({ name: (e.target as HTMLInputElement).value })}
            />
          </div>
          
          {/* Atlas info */}
          {plant.atlasRef && (
            <div class={styles.atlasInfo}>
              <span class={styles.atlasLabel}>Atlas:</span>
              <span class={styles.atlasName}>{plant.atlasRef.assetName}</span>
              <span class={styles.atlasRegions}>
                ({plant.atlasRef.regions.length} regions)
              </span>
            </div>
          )}
          
          {/* Spawn Probability */}
          <div class={styles.propertyRow}>
            <label>Spawn Probability</label>
            <input 
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={plant.spawnProbability}
              onInput={(e) => onUpdate({ spawnProbability: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class={styles.propertyValue}>{(plant.spawnProbability * 100).toFixed(0)}%</span>
          </div>
          
          {/* Biome Threshold */}
          <div class={styles.propertyRow}>
            <label>Biome Threshold</label>
            <input 
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={plant.biomeThreshold}
              onInput={(e) => onUpdate({ biomeThreshold: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class={styles.propertyValue}>{(plant.biomeThreshold * 100).toFixed(0)}%</span>
          </div>
          
          {/* Size Range */}
          <div class={styles.propertyGroup}>
            <label>Size Range (m)</label>
            <div class={styles.sizeInputs}>
              <div>
                <span>Min W:</span>
                <input 
                  type="number"
                  step="0.1"
                  value={plant.minSize[0]}
                  onInput={(e) => onUpdate({ minSize: [parseFloat((e.target as HTMLInputElement).value), plant.minSize[1]] })}
                />
              </div>
              <div>
                <span>Min H:</span>
                <input 
                  type="number"
                  step="0.1"
                  value={plant.minSize[1]}
                  onInput={(e) => onUpdate({ minSize: [plant.minSize[0], parseFloat((e.target as HTMLInputElement).value)] })}
                />
              </div>
              <div>
                <span>Max W:</span>
                <input 
                  type="number"
                  step="0.1"
                  value={plant.maxSize[0]}
                  onInput={(e) => onUpdate({ maxSize: [parseFloat((e.target as HTMLInputElement).value), plant.maxSize[1]] })}
                />
              </div>
              <div>
                <span>Max H:</span>
                <input 
                  type="number"
                  step="0.1"
                  value={plant.maxSize[1]}
                  onInput={(e) => onUpdate({ maxSize: [plant.maxSize[0], parseFloat((e.target as HTMLInputElement).value)] })}
                />
              </div>
            </div>
          </div>
          
          {/* Clustering */}
          <div class={styles.propertyRow}>
            <label>Clustering</label>
            <input 
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={plant.clusterStrength}
              onInput={(e) => onUpdate({ clusterStrength: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class={styles.propertyValue}>{(plant.clusterStrength * 100).toFixed(0)}%</span>
          </div>
          
          {/* Min Spacing */}
          <div class={styles.propertyRow}>
            <label>Min Spacing (m)</label>
            <input 
              type="number"
              step="0.1"
              min="0"
              value={plant.minSpacing}
              onInput={(e) => onUpdate({ minSpacing: parseFloat((e.target as HTMLInputElement).value) })}
            />
          </div>
          
          {/* Max Distance */}
          <div class={styles.propertyRow}>
            <label>Max Distance (m)</label>
            <input 
              type="number"
              step="10"
              min="10"
              value={plant.maxDistance}
              onInput={(e) => onUpdate({ maxDistance: parseFloat((e.target as HTMLInputElement).value) })}
            />
          </div>
          
          {/* LOD Bias */}
          <div class={styles.propertyRow}>
            <label>LOD Bias</label>
            <input 
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={plant.lodBias}
              onInput={(e) => onUpdate({ lodBias: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class={styles.propertyValue}>{plant.lodBias.toFixed(1)}</span>
          </div>
          
          {/* Color (fallback) */}
          <div class={styles.propertyRow}>
            <label>Fallback Color</label>
            <input 
              type="color"
              value={`#${plant.color.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`}
              onInput={(e) => {
                const hex = (e.target as HTMLInputElement).value;
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                onUpdate({ color: [r, g, b] });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function VegetationContent({ registry }: VegetationContentProps) {
  // State
  const [selectedBiome, setSelectedBiome] = useState<BiomeChannel>('r');
  const [plants, setPlants] = useState<PlantType[]>([]);
  const [config, setConfig] = useState<VegetationConfig>(registry.getConfig());
  const [wind, setWind] = useState<WindParams>(registry.getWind());
  const [isAtlasPickerOpen, setAtlasPickerOpen] = useState(false);
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  
  // Load plants for selected biome
  const loadPlants = useCallback(() => {
    setPlants(registry.getPlantsByBiome(selectedBiome));
    setConfig(registry.getConfig());
    setWind(registry.getWind());
  }, [registry, selectedBiome]);
  
  // Subscribe to registry changes
  useEffect(() => {
    loadPlants();
    const unsubscribe = registry.subscribe((event: PlantRegistryEvent) => {
      loadPlants();
    });
    return unsubscribe;
  }, [registry, selectedBiome, loadPlants]);
  
  // Handlers
  const handleAddPlant = useCallback(() => {
    const newPlant = registry.createPlant(selectedBiome, `New Plant ${Date.now() % 1000}`);
    registry.addPlant(selectedBiome, newPlant);
  }, [registry, selectedBiome]);
  
  const handleUpdatePlant = useCallback((plantId: string, updates: Partial<PlantType>) => {
    registry.updatePlant(selectedBiome, plantId, updates);
  }, [registry, selectedBiome]);
  
  const handleDeletePlant = useCallback((plantId: string) => {
    if (confirm('Delete this plant type?')) {
      registry.removePlant(selectedBiome, plantId);
    }
  }, [registry, selectedBiome]);
  
  const handleSelectAtlas = useCallback((plantId: string) => {
    setSelectedPlantId(plantId);
    setAtlasPickerOpen(true);
  }, []);
  
  const handleAtlasSelected = useCallback(async (asset: Asset) => {
    if (!selectedPlantId) return;
    
    // Find opacity map in asset files or derive from base path
    // Atlas textures typically have an opacity map in a sibling file
    const rawJson = asset.metadata?.rawJson as Record<string, unknown> | null;
    const maps = rawJson?.maps as Record<string, string> | undefined;
    const opacityPath = maps?.opacity || 
                        maps?.alpha ||
                        asset.path.replace('_albedo', '_opacity').replace('_basecolor', '_opacity');
    const baseColorPath = asset.path;
    
    try {
      // Detect regions from opacity map
      const result = await detectAtlasRegions(opacityPath);
      
      const atlasRef: AtlasReference = {
        assetId: asset.id,
        assetName: asset.name,
        opacityPath,
        baseColorPath,
        atlasSize: result.atlasSize,
        regions: result.regions,
      };
      
      registry.setPlantAtlas(selectedBiome, selectedPlantId, atlasRef);
      console.log(`[VegetationContent] Detected ${result.regions.length} regions in atlas`);
    } catch (err) {
      console.error('[VegetationContent] Failed to detect atlas regions:', err);
      // Still set atlas without auto-detected regions
      const atlasRef: AtlasReference = {
        assetId: asset.id,
        assetName: asset.name,
        opacityPath,
        baseColorPath,
        atlasSize: [1024, 1024], // Fallback
        regions: [],
      };
      registry.setPlantAtlas(selectedBiome, selectedPlantId, atlasRef);
    }
    
    setSelectedPlantId(null);
  }, [registry, selectedBiome, selectedPlantId]);
  
  const handleConfigChange = useCallback((updates: Partial<VegetationConfig>) => {
    registry.setConfig(updates);
    setConfig(registry.getConfig());
  }, [registry]);
  
  const handleWindChange = useCallback((updates: Partial<WindParams>) => {
    registry.setWind(updates);
    setWind(registry.getWind());
  }, [registry]);
  
  const handleLoadPresets = useCallback(() => {
    if (confirm('Load default presets? This will replace current plants.')) {
      registry.loadDefaultPresets();
    }
  }, [registry]);
  
  // Stats
  const stats = registry.getStats();
  
  return (
    <div class={styles.container}>
      {/* Global Config Section */}
      <Section title="Global Settings" defaultCollapsed={true}>
        <div class={styles.globalConfig}>
          <div class={styles.configRow}>
            <label>
              <input 
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => handleConfigChange({ enabled: (e.target as HTMLInputElement).checked })}
              />
              Enable Vegetation
            </label>
          </div>
          
          <div class={styles.configRow}>
            <label>Global Density</label>
            <input 
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={config.globalDensity}
              onInput={(e) => handleConfigChange({ globalDensity: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span>{(config.globalDensity * 100).toFixed(0)}%</span>
          </div>
          
          <div class={styles.configRow}>
            <label>
              <input 
                type="checkbox"
                checked={config.windEnabled}
                onChange={(e) => handleConfigChange({ windEnabled: (e.target as HTMLInputElement).checked })}
              />
              Enable Wind
            </label>
          </div>
          
          {config.windEnabled && (
            <>
              <div class={styles.configRow}>
                <label>Wind Strength</label>
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={wind.strength}
                  onInput={(e) => handleWindChange({ strength: parseFloat((e.target as HTMLInputElement).value) })}
                />
                <span>{(wind.strength * 100).toFixed(0)}%</span>
              </div>
              
              <div class={styles.configRow}>
                <label>Wind Frequency</label>
                <input 
                  type="range"
                  min="0.1"
                  max="3"
                  step="0.1"
                  value={wind.frequency}
                  onInput={(e) => handleWindChange({ frequency: parseFloat((e.target as HTMLInputElement).value) })}
                />
                <span>{wind.frequency.toFixed(1)}</span>
              </div>
            </>
          )}
          
          <div class={styles.statsRow}>
            <span>Total plants: {stats.totalPlants}</span>
            <span>With atlas: {stats.plantsWithAtlas}</span>
          </div>
          
          <button class={styles.presetButton} onClick={handleLoadPresets}>
            Load Default Presets
          </button>
        </div>
      </Section>
      
      {/* Biome Tabs */}
      <div class={styles.biomeTabs}>
        {BIOME_TABS.map(tab => (
          <button
            key={tab.channel}
            class={`${styles.biomeTab} ${selectedBiome === tab.channel ? styles.active : ''}`}
            onClick={() => setSelectedBiome(tab.channel)}
            style={{ '--tab-color': tab.color } as any}
          >
            <span class={styles.tabIndicator} />
            {tab.name}
            <span class={styles.tabCount}>
              ({stats.plantsByBiome[tab.channel]})
            </span>
          </button>
        ))}
      </div>
      
      {/* Plant List */}
      <div class={styles.plantList}>
        {plants.length === 0 ? (
          <div class={styles.emptyState}>
            <p>No plants defined for this biome.</p>
            <button onClick={handleAddPlant}>
              <AddIcon /> Add Plant
            </button>
          </div>
        ) : (
          plants.map(plant => (
            <PlantItem
              key={plant.id}
              plant={plant}
              onUpdate={(updates) => handleUpdatePlant(plant.id, updates)}
              onDelete={() => handleDeletePlant(plant.id)}
              onSelectAtlas={() => handleSelectAtlas(plant.id)}
            />
          ))
        )}
      </div>
      
      {/* Add Plant Button */}
      {plants.length > 0 && (
        <button class={styles.addButton} onClick={handleAddPlant}>
          <AddIcon /> Add Plant Type
        </button>
      )}
      
      {/* Atlas Picker Modal */}
      <AssetPickerModal
        isOpen={isAtlasPickerOpen}
        onClose={() => setAtlasPickerOpen(false)}
        onSelect={handleAtlasSelected}
        title="Select Texture Atlas"
        filterType="texture"
        filterSubtype="atlas"
      />
    </div>
  );
}
