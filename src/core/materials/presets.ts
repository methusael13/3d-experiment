/**
 * Built-in Material Presets
 * 
 * Default materials that ship with the engine.
 * These cannot be deleted but can be duplicated and modified.
 * Matches the presets from the existing MaterialPanel.
 */

import { type MaterialDefinition, createDefaultMaterialDefinition } from './types';

/**
 * Create all built-in material presets.
 * Each preset has isPreset=true and a stable ID for reference.
 */
export function createBuiltInPresets(): MaterialDefinition[] {
  const now = Date.now();
  
  return [
    createDefaultMaterialDefinition({
      id: 'preset_plastic',
      name: 'Plastic',
      albedo: [0.8, 0.2, 0.2],
      metallic: 0.0,
      roughness: 0.4,
      ior: 1.5,
      tags: ['preset', 'dielectric', 'plastic'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_metal',
      name: 'Metal',
      albedo: [0.9, 0.9, 0.9],
      metallic: 1.0,
      roughness: 0.3,
      ior: 2.5,
      tags: ['preset', 'metallic', 'steel'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_gold',
      name: 'Gold',
      albedo: [1.0, 0.84, 0.0],
      metallic: 1.0,
      roughness: 0.2,
      ior: 0.47,
      tags: ['preset', 'metallic', 'gold', 'precious'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_ceramic',
      name: 'Ceramic',
      albedo: [0.95, 0.95, 0.92],
      metallic: 0.0,
      roughness: 0.1,
      ior: 1.5,
      tags: ['preset', 'dielectric', 'ceramic', 'smooth'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_glass',
      name: 'Glass',
      albedo: [0.95, 0.95, 0.95],
      metallic: 0.0,
      roughness: 0.05,
      ior: 1.5,
      tags: ['preset', 'dielectric', 'glass', 'transparent'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_car_paint',
      name: 'Car Paint',
      albedo: [0.05, 0.1, 0.6],
      metallic: 0.0,
      roughness: 0.4,
      ior: 1.5,
      clearcoatFactor: 1.0,
      clearcoatRoughness: 0.05,
      tags: ['preset', 'clearcoat', 'automotive'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_water',
      name: 'Water',
      albedo: [0.02, 0.02, 0.02],
      metallic: 0.0,
      roughness: 0.0,
      ior: 1.33,
      tags: ['preset', 'dielectric', 'water', 'liquid'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_diamond',
      name: 'Diamond',
      albedo: [0.97, 0.97, 0.97],
      metallic: 0.0,
      roughness: 0.0,
      ior: 2.42,
      tags: ['preset', 'dielectric', 'diamond', 'precious', 'gem'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_rubber',
      name: 'Rubber',
      albedo: [0.15, 0.15, 0.15],
      metallic: 0.0,
      roughness: 0.9,
      ior: 1.5,
      tags: ['preset', 'dielectric', 'rubber', 'matte'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_copper',
      name: 'Copper',
      albedo: [0.95, 0.64, 0.54],
      metallic: 1.0,
      roughness: 0.25,
      ior: 2.43,
      tags: ['preset', 'metallic', 'copper'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
    
    createDefaultMaterialDefinition({
      id: 'preset_default',
      name: 'Default',
      albedo: [0.75, 0.75, 0.75],
      metallic: 0.0,
      roughness: 0.5,
      ior: 1.5,
      tags: ['preset', 'default'],
      isPreset: true,
      createdAt: now,
      updatedAt: now,
    }),
  ];
}
