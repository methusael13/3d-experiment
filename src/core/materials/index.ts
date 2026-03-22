/**
 * Material System - Barrel Exports
 */

// Types
export type {
  MaterialDefinition,
  MaterialTextureRef,
  MaterialTextureRefType,
  MaterialTextureSlot,
  SerializedNodeGraph,
  SerializedNode,
  SerializedEdge,
  NodePosition,
} from './types';

export {
  createDefaultMaterialDefinition,
  generateMaterialId,
} from './types';

// Registry
export {
  getMaterialRegistry,
  resetMaterialRegistry,
  type MaterialRegistry,
  type MaterialChangeEvent,
  type MaterialChangeType,
  type MaterialChangeCallback,
  type SerializedMaterialRegistry,
} from './MaterialRegistry';

// Presets
export { createBuiltInPresets } from './presets';
