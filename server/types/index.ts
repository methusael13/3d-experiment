/**
 * Asset Server Types
 * Shared between server and client (can be imported in frontend too)
 */

// Main asset types (simplified - no more 'vegetation' or 'hdr' as separate types)
export type AssetType = 'model' | 'texture' | 'material' | 'unknown';

// Category within a type (e.g., Models > Vegetation, Textures > IBL)
export type AssetCategory = 
  | 'vegetation'  // model category
  | 'animation'   // model category — animation-only GLBs (skeleton + keyframes)
  | 'ibl'         // texture category (HDR environments)
  | null;         // uncategorized

// Specific subtype within a category
export type AssetSubtype = 
  | 'grass' | 'tree' | 'shrub' | 'fern' | 'flower'  // vegetation subtypes
  | 'rock' | 'terrain' | 'prop' | 'character'       // model subtypes
  | 'albedo' | 'normal' | 'roughness' | 'atlas'     // texture subtypes
  | 'environment' | 'studio'                        // ibl subtypes
  | null;

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  category: AssetCategory;
  subtype: AssetSubtype | null;
  path: string;
  metadataPath: string | null;
  previewPath: string | null;
  fileSize: number;
  modifiedAt: number;
  createdAt: number;
  metadata: AssetMetadata | null;
  files: AssetFile[];
  tags: string[];
}

export interface AssetMetadata {
  biome: string | null;
  physicalSize: string | null;
  resolution: string | null;
  hasBillboard: boolean;
  hasLod: boolean;
  lodCount: number;
  variantCount: number;
  latinName: string | null;
  averageColor: string | null;
  rawJson: Record<string, unknown> | null;
}

export type TextureType = 'albedo' | 'ao' | 'bump' | 'cavity' | 'displacement'
  | 'gloss' | 'normal' | 'opacity' | 'roughness' | 'specular' | 'translucency';

/**
 * Texture type values exported by Quixel MegaScans
 */
export const TextureTypeValues: { pattern: string, type: TextureType }[] = [
  // Quixel MegaScans full names (matched first — most specific)
  { pattern: 'basecolor', type: 'albedo' },
  { pattern: 'albedo', type: 'albedo' },
  { pattern: 'displacement', type: 'displacement' },
  { pattern: 'roughness', type: 'roughness' },
  { pattern: 'normal', type: 'normal' },
  { pattern: 'specular', type: 'specular' },
  { pattern: 'translucency', type: 'translucency' },
  { pattern: 'opacity', type: 'opacity' },
  { pattern: 'cavity', type: 'cavity' },
  { pattern: 'gloss', type: 'gloss' },
  { pattern: 'bump', type: 'bump' },
  { pattern: 'ao', type: 'ao' },

  // PolyHaven / common abbreviated patterns (use delimiter-safe patterns)
  { pattern: 'diffuse', type: 'albedo' },   // Standard "diffuse" naming
  { pattern: '_diff_', type: 'albedo' },     // PolyHaven: *_diff_4k.png
  { pattern: '_diff.', type: 'albedo' },     // PolyHaven: *_diff.png (end of name)
  { pattern: '_col_', type: 'albedo' },      // Common "color" abbreviated
  { pattern: '_color_', type: 'albedo' },    // Common "color" full
  { pattern: '_nor_', type: 'normal' },      // PolyHaven: *_nor_gl_4k.png
  { pattern: '_nrm', type: 'normal' },       // Some tools use "nrm"
  { pattern: '_rough_', type: 'roughness' }, // PolyHaven: *_rough_4k.png
  { pattern: '_rough.', type: 'roughness' }, // PolyHaven: *_rough.png
  { pattern: '_disp_', type: 'displacement' }, // PolyHaven: *_disp_4k.png
  { pattern: '_disp.', type: 'displacement' }, // PolyHaven: *_disp.png
  { pattern: '_arm_', type: 'ao' },          // ARM packed (AO/Roughness/Metallic)
  { pattern: '_arm.', type: 'ao' },          // ARM packed (end of name)
  { pattern: '_metallic', type: 'roughness' }, // Separate metallic maps (treat as roughness category)

  // Quixel MegaScans billboard naming conventions
  { pattern: 'b-o', type: 'albedo' },       // BaseColor+Opacity
  { pattern: 'n-t', type: 'normal' },       // Normal+Translucency
]

export interface AssetFile {
  id: number;
  assetId: string;
  fileType: 'model' | 'texture' | 'billboard' | 'preview';
  fileSubType: TextureType | null;
  lodLevel: number | null;
  resolution: string | null;
  format: string;
  path: string;
  fileSize: number;
}

export interface AssetQuery {
  type?: AssetType;
  category?: AssetCategory;
  subtype?: AssetSubtype;
  biome?: string;
  tag?: string;
  search?: string;
  hasLod?: boolean;
  hasBillboard?: boolean;
}

export interface IndexResult {
  totalAssets: number;
  newAssets: number;
  updatedAssets: number;
  removedAssets: number;
  duration: number;
}

export interface PreviewResult {
  assetId: string;
  previewPath: string;
  width: number;
  height: number;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  assetId?: string;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AssetsListResponse {
  assets: Asset[];
  total: number;
}

export interface ServerStatus {
  isIndexing: boolean;
  totalAssets: number;
  lastIndexed: number | null;
  watcherActive: boolean;
}
