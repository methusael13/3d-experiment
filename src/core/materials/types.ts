/**
 * Material System Types
 * 
 * Core type definitions for the central material registry.
 * Materials are reusable PBR definitions that can be referenced by
 * terrain biomes, scene objects, vegetation, etc.
 */

// ============================================================================
// Texture Reference Types
// ============================================================================

/** How a texture slot is sourced */
export type MaterialTextureRefType = 'asset' | 'procedural' | 'color';

/**
 * Reference to a texture source for a material slot.
 * Can be an asset from the library, a procedurally generated texture, or a solid color.
 */
export interface MaterialTextureRef {
  /** How this texture is sourced */
  type: MaterialTextureRefType;
  
  /** Asset library ID (when type === 'asset') */
  assetId?: string;
  
  /** Direct path to the texture file (when type === 'asset') */
  assetPath?: string;
  
  /** Asset display name (for UI) */
  assetName?: string;
  
  /** Solid color RGBA (when type === 'color') */
  color?: [number, number, number, number];
}

/**
 * All possible texture slots in a PBR material.
 * Maps to the inputs of the PBR node in the node editor.
 */
export type MaterialTextureSlot = 
  | 'baseColor'
  | 'normal'
  | 'metallicRoughness'
  | 'occlusion'
  | 'emissive'
  | 'displacement';

// ============================================================================
// Node Graph Serialization
// ============================================================================

/** Serialized position for node editor */
export interface NodePosition {
  x: number;
  y: number;
}

/** Serialized node in the material graph */
export interface SerializedNode {
  id: string;
  type: 'pbr' | 'textureSet' | 'color' | 'number' | 'preview';
  position: NodePosition;
  data: Record<string, unknown>;
}

/** Serialized edge (connection) in the material graph */
export interface SerializedEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/** Complete serialized node graph for a material */
export interface SerializedNodeGraph {
  nodes: SerializedNode[];
  edges: SerializedEdge[];
}

// ============================================================================
// Material Definition
// ============================================================================

/**
 * A complete PBR material definition stored in the registry.
 * 
 * PBR properties match the MaterialUniforms struct in object-template.wgsl:
 * - albedo, metallic, roughness, normalScale, occlusionStrength
 * - emissiveFactor, ior, clearcoatFactor, clearcoatRoughness, alphaCutoff
 * 
 * Texture references point to asset library files or solid colors.
 * The node graph stores the visual editor state for re-opening.
 */
export interface MaterialDefinition {
  /** Unique identifier (UUID) */
  id: string;
  
  /** User-facing display name */
  name: string;
  
  // ---- PBR Scalar Properties ----
  
  /** Base color (RGB, 0-1) */
  albedo: [number, number, number];
  
  /** Metalness factor (0-1) */
  metallic: number;
  
  /** Surface roughness (0-1) */
  roughness: number;
  
  /** Normal map strength (0-2, default 1) */
  normalScale: number;
  
  /** AO strength (0-1, default 1) */
  occlusionStrength: number;
  
  /** Emissive color (RGB, 0-1+) */
  emissiveFactor: [number, number, number];
  
  /** Index of refraction (1.0-3.0, default 1.5) */
  ior: number;
  
  /** Clearcoat strength (0-1) */
  clearcoatFactor: number;
  
  /** Clearcoat roughness (0-1) */
  clearcoatRoughness: number;
  
  /** Alpha cutoff threshold (0-1) */
  alphaCutoff: number;
  
  /** Whether this material is unlit (negative IOR in shader) */
  unlit: boolean;
  
  // ---- Texture References ----
  
  /** Texture map references keyed by slot */
  textures: Partial<Record<MaterialTextureSlot, MaterialTextureRef>>;
  
  // ---- Node Graph ----
  
  /** Serialized node editor graph (null if created via presets, not editor) */
  nodeGraph: SerializedNodeGraph | null;
  
  // ---- Metadata ----
  
  /** Searchable tags */
  tags: string[];
  
  /** Whether this is a built-in preset (cannot be deleted) */
  isPreset: boolean;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last modification timestamp */
  updatedAt: number;
}

// ============================================================================
// Defaults & Helpers
// ============================================================================

/** Generate a UUID for material IDs */
export function generateMaterialId(): string {
  return `mat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Default PBR material values */
export function createDefaultMaterialDefinition(
  overrides?: Partial<MaterialDefinition>
): MaterialDefinition {
  const now = Date.now();
  return {
    id: generateMaterialId(),
    name: 'New Material',
    
    albedo: [0.75, 0.75, 0.75],
    metallic: 0.0,
    roughness: 0.5,
    normalScale: 1.0,
    occlusionStrength: 1.0,
    emissiveFactor: [0.0, 0.0, 0.0],
    ior: 1.5,
    clearcoatFactor: 0.0,
    clearcoatRoughness: 0.0,
    alphaCutoff: 0.5,
    unlit: false,
    
    textures: {},
    nodeGraph: null,
    
    tags: [],
    isPreset: false,
    createdAt: now,
    updatedAt: now,
    
    ...overrides,
  };
}
