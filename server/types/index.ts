/**
 * Asset Server Types
 * Shared between server and client (can be imported in frontend too)
 */

// Main asset types (simplified - no more 'vegetation' or 'hdr' as separate types)
export type AssetType = 'model' | 'texture' | 'material' | 'unknown';

// Category within a type (e.g., Models > Vegetation, Textures > IBL)
export type AssetCategory = 
  | 'vegetation'  // model category
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

export interface AssetFile {
  id: number;
  assetId: string;
  fileType: 'model' | 'texture' | 'billboard' | 'preview';
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
