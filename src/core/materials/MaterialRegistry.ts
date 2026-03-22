/**
 * MaterialRegistry - Central material system for Pyro Engine
 * 
 * Singleton registry storing all named PBR materials.
 * Materials are referenced by ID from terrain biomes, scene objects, etc.
 * 
 * Uses @preact/signals for reactive UI updates in the editor.
 * Supports change callbacks for non-UI consumers (terrain, render systems).
 */

import { signal, type Signal } from '@preact/signals';
import {
  type MaterialDefinition,
  type SerializedNodeGraph,
  type MaterialTextureRef,
  type MaterialTextureSlot,
  createDefaultMaterialDefinition,
  generateMaterialId,
} from './types';
import { createBuiltInPresets } from './presets';

// ============================================================================
// Serialization Types
// ============================================================================

/** Serialized registry for save/load */
export interface SerializedMaterialRegistry {
  version: 1;
  materials: MaterialDefinition[];
}

// ============================================================================
// Change Callback Types
// ============================================================================

export type MaterialChangeType = 'create' | 'update' | 'delete';

export interface MaterialChangeEvent {
  type: MaterialChangeType;
  materialId: string;
  material?: MaterialDefinition; // Present for create/update, absent for delete
}

export type MaterialChangeCallback = (event: MaterialChangeEvent) => void;

// ============================================================================
// Registry Implementation
// ============================================================================

/**
 * Central material registry.
 * 
 * Usage:
 *   const registry = getMaterialRegistry();
 *   const mat = registry.create('Grass Material');
 *   registry.update(mat.id, { albedo: [0.2, 0.5, 0.1] });
 *   const allMaterials = registry.materialsSignal.value;
 */
class MaterialRegistryImpl {
  /** Internal map of all materials */
  private materials: Map<string, MaterialDefinition> = new Map();
  
  /** Reactive signal for UI (array of all materials, sorted by name) */
  readonly materialsSignal: Signal<MaterialDefinition[]> = signal([]);
  
  /** Signal for currently selected material ID in the editor */
  readonly selectedMaterialId: Signal<string | null> = signal(null);
  
  /** Change listeners for non-UI consumers */
  private changeListeners: Set<MaterialChangeCallback> = new Set();
  
  /** Whether presets have been loaded */
  private presetsLoaded = false;
  
  constructor() {
    // Load built-in presets on first access
    this.loadBuiltInPresets();
  }
  
  // ==================== CRUD Operations ====================
  
  /**
   * Create a new material with default values.
   * @param name Display name
   * @param template Optional partial overrides
   * @returns The created material definition
   */
  create(name: string, template?: Partial<MaterialDefinition>): MaterialDefinition {
    const material = createDefaultMaterialDefinition({
      ...template,
      name,
      id: template?.id ?? generateMaterialId(),
      isPreset: false,
    });
    
    this.materials.set(material.id, material);
    this.emitSignal();
    this.emitChange({ type: 'create', materialId: material.id, material });
    
    return material;
  }
  
  /**
   * Get a material by ID.
   */
  get(id: string): MaterialDefinition | undefined {
    return this.materials.get(id);
  }
  
  /**
   * Update a material's properties.
   * @param id Material ID
   * @param changes Partial properties to merge
   */
  update(id: string, changes: Partial<MaterialDefinition>): void {
    const existing = this.materials.get(id);
    if (!existing) {
      console.warn(`[MaterialRegistry] Cannot update unknown material: ${id}`);
      return;
    }
    
    // Merge changes (shallow merge for top-level, deep merge for textures)
    const updated: MaterialDefinition = {
      ...existing,
      ...changes,
      updatedAt: Date.now(),
    };
    
    // Deep merge textures if provided
    if (changes.textures) {
      updated.textures = {
        ...existing.textures,
        ...changes.textures,
      };
    }
    
    this.materials.set(id, updated);
    this.emitSignal();
    this.emitChange({ type: 'update', materialId: id, material: updated });
  }
  
  /**
   * Delete a material.
   * Built-in presets cannot be deleted.
   * @returns true if deleted, false if not found or preset
   */
  delete(id: string): boolean {
    const existing = this.materials.get(id);
    if (!existing) return false;
    if (existing.isPreset) {
      console.warn(`[MaterialRegistry] Cannot delete built-in preset: ${existing.name}`);
      return false;
    }
    
    this.materials.delete(id);
    
    // Clear selection if this was selected
    if (this.selectedMaterialId.value === id) {
      this.selectedMaterialId.value = null;
    }
    
    this.emitSignal();
    this.emitChange({ type: 'delete', materialId: id });
    
    return true;
  }
  
  /**
   * Duplicate an existing material with a new name.
   */
  duplicate(id: string, newName?: string): MaterialDefinition | null {
    const source = this.materials.get(id);
    if (!source) return null;
    
    const name = newName ?? `${source.name} (Copy)`;
    return this.create(name, {
      ...source,
      id: undefined, // Generate new ID
      isPreset: false,
      tags: [...source.tags.filter(t => t !== 'preset')],
      nodeGraph: source.nodeGraph ? JSON.parse(JSON.stringify(source.nodeGraph)) : null,
      textures: { ...source.textures },
    });
  }
  
  /**
   * Rename a material.
   */
  rename(id: string, newName: string): void {
    this.update(id, { name: newName });
  }
  
  // ==================== Query Operations ====================
  
  /**
   * List all materials (sorted by name, presets first).
   */
  list(): MaterialDefinition[] {
    return this.getSortedMaterials();
  }
  
  /**
   * Find a material by name (case-insensitive).
   */
  findByName(name: string): MaterialDefinition | undefined {
    const lower = name.toLowerCase();
    for (const mat of this.materials.values()) {
      if (mat.name.toLowerCase() === lower) return mat;
    }
    return undefined;
  }
  
  /**
   * Find materials by tag.
   */
  findByTag(tag: string): MaterialDefinition[] {
    const lower = tag.toLowerCase();
    return Array.from(this.materials.values()).filter(mat =>
      mat.tags.some(t => t.toLowerCase() === lower)
    );
  }
  
  /**
   * Search materials by name or tags (case-insensitive substring match).
   */
  search(query: string): MaterialDefinition[] {
    if (!query.trim()) return this.list();
    
    const lower = query.toLowerCase();
    return Array.from(this.materials.values()).filter(mat =>
      mat.name.toLowerCase().includes(lower) ||
      mat.tags.some(t => t.toLowerCase().includes(lower))
    );
  }
  
  /**
   * Get the total number of materials.
   */
  get count(): number {
    return this.materials.size;
  }
  
  // ==================== Selection ====================
  
  /**
   * Select a material for editing in the node editor.
   */
  select(id: string | null): void {
    this.selectedMaterialId.value = id;
  }
  
  /**
   * Get the currently selected material.
   */
  getSelected(): MaterialDefinition | null {
    const id = this.selectedMaterialId.value;
    return id ? this.materials.get(id) ?? null : null;
  }
  
  // ==================== Change Listeners ====================
  
  /**
   * Subscribe to material changes.
   * Used by terrain, render systems, etc. to react to material updates.
   * @returns Unsubscribe function
   */
  onChange(callback: MaterialChangeCallback): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }
  
  // ==================== Serialization ====================
  
  /**
   * Serialize the registry for saving.
   * Only includes non-preset materials (presets are loaded from code).
   */
  serialize(): SerializedMaterialRegistry {
    const materials = Array.from(this.materials.values())
      .filter(m => !m.isPreset);
    
    return {
      version: 1,
      materials,
    };
  }
  
  /**
   * Deserialize and load materials from saved data.
   * Merges with existing presets (doesn't replace them).
   */
  deserialize(data: SerializedMaterialRegistry): void {
    if (data.version !== 1) {
      console.warn(`[MaterialRegistry] Unknown serialization version: ${data.version}`);
      return;
    }
    
    for (const mat of data.materials) {
      // Don't overwrite presets
      if (this.materials.has(mat.id) && this.materials.get(mat.id)!.isPreset) {
        continue;
      }
      this.materials.set(mat.id, mat);
    }
    
    this.emitSignal();
    console.log(`[MaterialRegistry] Deserialized ${data.materials.length} materials`);
  }
  
  // ==================== Presets ====================
  
  /**
   * Load built-in material presets.
   * Called automatically on first access.
   */
  loadBuiltInPresets(): void {
    if (this.presetsLoaded) return;
    
    const presets = createBuiltInPresets();
    for (const preset of presets) {
      this.materials.set(preset.id, preset);
    }
    
    this.presetsLoaded = true;
    this.emitSignal();
    
    console.log(`[MaterialRegistry] Loaded ${presets.length} built-in presets`);
  }
  
  // ==================== Internal ====================
  
  /**
   * Get materials sorted by: presets first, then alphabetical by name.
   */
  private getSortedMaterials(): MaterialDefinition[] {
    return Array.from(this.materials.values()).sort((a, b) => {
      // Presets first
      if (a.isPreset && !b.isPreset) return -1;
      if (!a.isPreset && b.isPreset) return 1;
      // Then alphabetical
      return a.name.localeCompare(b.name);
    });
  }
  
  /**
   * Update the reactive signal with current material list.
   */
  private emitSignal(): void {
    this.materialsSignal.value = this.getSortedMaterials();
  }
  
  /**
   * Notify all change listeners.
   */
  private emitChange(event: MaterialChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[MaterialRegistry] Change listener error:', err);
      }
    }
  }
}

// ============================================================================
// Singleton Access
// ============================================================================

let instance: MaterialRegistryImpl | null = null;

/**
 * Get the global MaterialRegistry singleton.
 */
export function getMaterialRegistry(): MaterialRegistryImpl {
  if (!instance) {
    instance = new MaterialRegistryImpl();
  }
  return instance;
}

/**
 * Reset the registry (for testing or cleanup).
 */
export function resetMaterialRegistry(): void {
  instance = null;
}

// Export the class type for type annotations
export type MaterialRegistry = MaterialRegistryImpl;
