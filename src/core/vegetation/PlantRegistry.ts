/**
 * PlantRegistry
 * 
 * Dynamic registry for plant types organized by biome.
 * Manages plant definitions and their associated texture atlases.
 */

import {
  type PlantType,
  type BiomeChannel,
  type BiomePlantConfig,
  type VegetationConfig,
  type WindParams,
  type AtlasReference,
  DEFAULT_BIOME_CONFIGS,
  GRASSLAND_PLANT_PRESETS,
  FOREST_PLANT_PRESETS,
  createDefaultVegetationConfig,
  createDefaultWindParams,
  createDefaultPlantType,
} from './types';

/**
 * Event types for registry changes.
 */
export type PlantRegistryEvent = 
  | { type: 'plant-added'; biome: BiomeChannel; plant: PlantType }
  | { type: 'plant-removed'; biome: BiomeChannel; plantId: string }
  | { type: 'plant-updated'; biome: BiomeChannel; plant: PlantType }
  | { type: 'config-changed'; config: VegetationConfig }
  | { type: 'wind-changed'; wind: WindParams }
  | { type: 'biome-cleared'; biome: BiomeChannel }
  | { type: 'registry-reset' };

/**
 * Listener callback type.
 */
export type PlantRegistryListener = (event: PlantRegistryEvent) => void;

/**
 * PlantRegistry manages plant type definitions organized by biome.
 * 
 * Features:
 * - CRUD operations for plant types
 * - Biome-based organization
 * - Default presets
 * - Event-based change notifications
 * - Serialization support
 */
export class PlantRegistry {
  /** Plants organized by biome channel */
  private biomes: Map<BiomeChannel, BiomePlantConfig>;
  
  /** Global vegetation config */
  private config: VegetationConfig;
  
  /** Wind parameters */
  private wind: WindParams;
  
  /** Event listeners */
  private listeners: Set<PlantRegistryListener>;
  
  /** Next unique ID counter */
  private nextId: number;

  constructor() {
    this.biomes = new Map();
    this.config = createDefaultVegetationConfig();
    this.wind = createDefaultWindParams();
    this.listeners = new Set();
    this.nextId = 1;
    
    // Initialize biomes
    this.initializeBiomes();
  }

  // ==================== Initialization ====================

  /**
   * Initialize biomes with default configurations.
   */
  private initializeBiomes(): void {
    const channels: BiomeChannel[] = ['r', 'g', 'b', 'a'];
    
    for (const channel of channels) {
      const baseConfig = DEFAULT_BIOME_CONFIGS[channel];
      this.biomes.set(channel, {
        ...baseConfig,
        plants: [],
      });
    }
  }

  /**
   * Load default plant presets for common biomes.
   */
  loadDefaultPresets(): void {
    // Clear existing
    this.clearAllBiomes(false);
    
    // Load grassland presets (R channel)
    for (const preset of GRASSLAND_PLANT_PRESETS) {
      this.addPlant('r', { ...preset, id: `preset-${this.nextId++}` }, false);
    }
    
    // Load forest presets (B channel)
    for (const preset of FOREST_PLANT_PRESETS) {
      this.addPlant('b', { ...preset, id: `preset-${this.nextId++}` }, false);
    }
    
    this.emit({ type: 'registry-reset' });
  }

  // ==================== Plant CRUD ====================

  /**
   * Add a plant to a biome.
   */
  addPlant(biome: BiomeChannel, plant: PlantType, notify = true): void {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return;
    
    // Ensure unique ID
    if (!plant.id) {
      plant.id = `plant-${this.nextId++}`;
    }
    
    // Override biome channel to match
    plant.biomeChannel = biome;
    
    // Check for duplicate ID
    const existingIndex = biomeConfig.plants.findIndex(p => p.id === plant.id);
    if (existingIndex >= 0) {
      biomeConfig.plants[existingIndex] = plant;
      if (notify) this.emit({ type: 'plant-updated', biome, plant });
    } else {
      biomeConfig.plants.push(plant);
      if (notify) this.emit({ type: 'plant-added', biome, plant });
    }
  }

  /**
   * Remove a plant from a biome by ID.
   */
  removePlant(biome: BiomeChannel, plantId: string): boolean {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return false;
    
    const index = biomeConfig.plants.findIndex(p => p.id === plantId);
    if (index < 0) return false;
    
    biomeConfig.plants.splice(index, 1);
    this.emit({ type: 'plant-removed', biome, plantId });
    return true;
  }

  /**
   * Update a plant's properties.
   */
  updatePlant(biome: BiomeChannel, plantId: string, updates: Partial<PlantType>): boolean {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return false;
    
    const plant = biomeConfig.plants.find(p => p.id === plantId);
    if (!plant) return false;
    
    // Apply updates (excluding id and biomeChannel)
    const { id: _id, biomeChannel: _channel, ...safeUpdates } = updates;
    Object.assign(plant, safeUpdates);
    
    this.emit({ type: 'plant-updated', biome, plant });
    return true;
  }

  /**
   * Get a plant by ID.
   */
  getPlant(biome: BiomeChannel, plantId: string): PlantType | undefined {
    const biomeConfig = this.biomes.get(biome);
    return biomeConfig?.plants.find(p => p.id === plantId);
  }

  /**
   * Get all plants in a biome.
   */
  getPlantsByBiome(biome: BiomeChannel): PlantType[] {
    const biomeConfig = this.biomes.get(biome);
    return biomeConfig?.plants ?? [];
  }

  /**
   * Get all plants across all biomes.
   */
  getAllPlants(): PlantType[] {
    const all: PlantType[] = [];
    for (const config of this.biomes.values()) {
      all.push(...config.plants);
    }
    return all;
  }

  /**
   * Create a new plant with default values.
   */
  createPlant(biome: BiomeChannel, name: string): PlantType {
    const id = `plant-${this.nextId++}`;
    const plant = createDefaultPlantType(id, name);
    plant.biomeChannel = biome;
    return plant;
  }

  // ==================== Biome Operations ====================

  /**
   * Get biome configuration.
   */
  getBiomeConfig(biome: BiomeChannel): BiomePlantConfig | undefined {
    return this.biomes.get(biome);
  }

  /**
   * Get all biome configurations.
   */
  getAllBiomeConfigs(): BiomePlantConfig[] {
    return Array.from(this.biomes.values());
  }

  /**
   * Clear all plants from a biome.
   */
  clearBiome(biome: BiomeChannel): void {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return;
    
    biomeConfig.plants = [];
    this.emit({ type: 'biome-cleared', biome });
  }

  /**
   * Clear all biomes.
   */
  clearAllBiomes(notify = true): void {
    for (const biome of this.biomes.keys()) {
      const config = this.biomes.get(biome);
      if (config) config.plants = [];
    }
    if (notify) this.emit({ type: 'registry-reset' });
  }

  // ==================== Atlas Association ====================

  /**
   * Associate an atlas with a plant.
   */
  setPlantAtlas(
    biome: BiomeChannel,
    plantId: string,
    atlasRef: AtlasReference | null
  ): boolean {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return false;
    
    const plant = biomeConfig.plants.find(p => p.id === plantId);
    if (!plant) return false;
    
    plant.atlasRef = atlasRef;
    plant.atlasRegionIndex = null; // Reset region selection
    
    this.emit({ type: 'plant-updated', biome, plant });
    return true;
  }

  /**
   * Set which atlas region a plant uses.
   */
  setPlantAtlasRegion(
    biome: BiomeChannel,
    plantId: string,
    regionIndex: number | null
  ): boolean {
    const biomeConfig = this.biomes.get(biome);
    if (!biomeConfig) return false;
    
    const plant = biomeConfig.plants.find(p => p.id === plantId);
    if (!plant) return false;
    
    plant.atlasRegionIndex = regionIndex;
    
    this.emit({ type: 'plant-updated', biome, plant });
    return true;
  }

  // ==================== Configuration ====================

  /**
   * Get vegetation configuration.
   */
  getConfig(): VegetationConfig {
    return { ...this.config };
  }

  /**
   * Update vegetation configuration.
   */
  setConfig(updates: Partial<VegetationConfig>): void {
    Object.assign(this.config, updates);
    this.emit({ type: 'config-changed', config: { ...this.config } });
  }

  /**
   * Get wind parameters.
   */
  getWind(): WindParams {
    return { ...this.wind };
  }

  /**
   * Update wind parameters.
   */
  setWind(updates: Partial<WindParams>): void {
    Object.assign(this.wind, updates);
    this.emit({ type: 'wind-changed', wind: { ...this.wind } });
  }

  // ==================== Events ====================

  /**
   * Subscribe to registry changes.
   */
  subscribe(listener: PlantRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: PlantRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[PlantRegistry] Listener error:', err);
      }
    }
  }

  // ==================== Serialization ====================

  /**
   * Serialize registry to JSON.
   */
  toJSON(): PlantRegistryData {
    const biomes: Record<BiomeChannel, PlantType[]> = {
      r: this.getPlantsByBiome('r'),
      g: this.getPlantsByBiome('g'),
      b: this.getPlantsByBiome('b'),
      a: this.getPlantsByBiome('a'),
    };
    
    return {
      version: 1,
      biomes,
      config: this.config,
      wind: this.wind,
    };
  }

  /**
   * Load registry from JSON.
   */
  fromJSON(data: PlantRegistryData): void {
    if (data.version !== 1) {
      console.warn('[PlantRegistry] Unknown data version:', data.version);
      return;
    }
    
    // Clear existing
    this.clearAllBiomes(false);
    
    // Load plants
    if (data.biomes) {
      for (const [biome, plants] of Object.entries(data.biomes)) {
        for (const plant of plants) {
          this.addPlant(biome as BiomeChannel, plant, false);
        }
      }
    }
    
    // Load config
    if (data.config) {
      this.config = { ...createDefaultVegetationConfig(), ...data.config };
    }
    
    // Load wind
    if (data.wind) {
      this.wind = { ...createDefaultWindParams(), ...data.wind };
    }
    
    // Update next ID
    const allPlants = this.getAllPlants();
    const maxId = allPlants.reduce((max, p) => {
      const match = p.id.match(/\d+$/);
      return match ? Math.max(max, parseInt(match[0], 10)) : max;
    }, 0);
    this.nextId = maxId + 1;
    
    this.emit({ type: 'registry-reset' });
  }

  // ==================== Statistics ====================

  /**
   * Get statistics about the registry.
   */
  getStats(): PlantRegistryStats {
    const stats: PlantRegistryStats = {
      totalPlants: 0,
      plantsByBiome: {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
      },
      plantsWithAtlas: 0,
      plantsWithoutAtlas: 0,
    };
    
    for (const [biome, config] of this.biomes) {
      stats.plantsByBiome[biome] = config.plants.length;
      stats.totalPlants += config.plants.length;
      
      for (const plant of config.plants) {
        if (plant.atlasRef) {
          stats.plantsWithAtlas++;
        } else {
          stats.plantsWithoutAtlas++;
        }
      }
    }
    
    return stats;
  }
}

// ==================== Types ====================

/**
 * Serialized registry data format.
 */
export interface PlantRegistryData {
  version: number;
  biomes: Record<BiomeChannel, PlantType[]>;
  config: VegetationConfig;
  wind: WindParams;
}

/**
 * Registry statistics.
 */
export interface PlantRegistryStats {
  totalPlants: number;
  plantsByBiome: Record<BiomeChannel, number>;
  plantsWithAtlas: number;
  plantsWithoutAtlas: number;
}
