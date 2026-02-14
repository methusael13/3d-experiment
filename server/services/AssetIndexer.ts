/**
 * Asset Indexer Service
 * Scans filesystem and populates the database
 * 
 * Discovery Mechanism:
 * 
 * Models:
 * - .glb files are self-contained models
 * - Folders containing .gltf FILE are model directories (parent folder = asset)
 * - Folders WITH .gltf EXTENSION are NOT gltf files - look inside for actual .gltf file
 * - Vegetation folders may have manifest.json for additional metadata
 * 
 * Textures:
 * - Folders where files share common prefix are texture packs
 * - HDR files are textures with category 'ibl'
 */

import fs from 'fs';
import path from 'path';
import { type AssetType, type AssetCategory, type AssetSubtype, type AssetMetadata, type IndexResult, type AssetFile, TextureTypeValues } from '../types/index.js';
import { getDatabase, type AssetDatabase } from '../db/database.js';

// File extension to asset type mapping
const EXTENSION_MAP: Record<string, { type: AssetType; category?: AssetCategory; subtype?: AssetSubtype }> = {
  // Models (only GLB is self-contained, GLTF is part of a folder)
  '.glb': { type: 'model' },
  '.obj': { type: 'model' },
  '.fbx': { type: 'model' },
  // Textures
  '.jpg': { type: 'texture' },
  '.jpeg': { type: 'texture' },
  '.png': { type: 'texture' },
  '.webp': { type: 'texture' },
  '.tga': { type: 'texture' },
  '.exr': { type: 'texture', category: 'ibl', subtype: 'environment' },
  // HDR (textures with ibl category)
  '.hdr': { type: 'texture', category: 'ibl', subtype: 'environment' },
  // Materials
  '.mtl': { type: 'material' },
};

// Directories that indicate asset type/category based on path
const DIR_TYPE_HINTS: Record<string, { type: AssetType; category?: AssetCategory; subtype?: AssetSubtype }> = {
  // Vegetation models (type: model, category: vegetation)
  'vegetation': { type: 'model', category: 'vegetation' },
  'plants': { type: 'model', category: 'vegetation' },
  'grass': { type: 'model', category: 'vegetation', subtype: 'grass' },
  'trees': { type: 'model', category: 'vegetation', subtype: 'tree' },
  'ferns': { type: 'model', category: 'vegetation', subtype: 'fern' },
  'flowers': { type: 'model', category: 'vegetation', subtype: 'flower' },
  // Regular models
  'models': { type: 'model' },
  'assets': { type: 'model' },
  'props': { type: 'model', subtype: 'prop' },
  'rocks': { type: 'model', subtype: 'rock' },
  // Textures
  'textures': { type: 'texture' },
  'atlas': { type: 'texture', subtype: 'atlas' },
  // IBL/HDR (type: texture, category: ibl)
  'hdr': { type: 'texture', category: 'ibl' },
  'hdri': { type: 'texture', category: 'ibl' },
  'ibl': { type: 'texture', category: 'ibl' },
  'environment': { type: 'texture', category: 'ibl', subtype: 'environment' },
};

// Files to ignore
const IGNORED_PATTERNS = [
  /^\./, // Hidden files
  /thumbs\.db/i,
  /\.DS_Store/,
  /desktop\.ini/i,
];

export class AssetIndexer {
  private db: AssetDatabase;
  private rootPath: string;

  constructor(rootPath: string) {
    this.db = getDatabase();
    this.rootPath = path.resolve(rootPath);
  }

  /**
   * Full index scan - clears existing data and rescans
   */
  async fullIndex(): Promise<IndexResult> {
    const startTime = Date.now();
    const existingAssets = new Set(this.db.getAllAssets().map(a => a.id));
    const foundAssets = new Set<string>();
    let newCount = 0;
    let updatedCount = 0;

    // Scan directory recursively
    const assets = await this.scanDirectory(this.rootPath);

    // Process in transaction
    this.db.transaction(() => {
      for (const asset of assets) {
        console.log(`Processing asset: ${asset.id}, files: ${asset.files.length}`);
        foundAssets.add(asset.id);
        
        if (existingAssets.has(asset.id)) {
          // Update existing
          console.log(`Found existing asset: ${asset.id}`);
          this.db.deleteAsset(asset.id);
          updatedCount++;
        } else {
          newCount++;
        }

        // Insert asset
        this.db.insertAsset({
          id: asset.id,
          name: asset.name,
          type: asset.type,
          category: asset.category,
          subtype: asset.subtype,
          path: asset.path,
          metadataPath: asset.metadataPath,
          previewPath: asset.previewPath,
          fileSize: asset.fileSize,
          modifiedAt: asset.modifiedAt,
          createdAt: Date.now(),
        });

        // Insert metadata
        if (asset.metadata) {
          this.db.insertMetadata(asset.id, asset.metadata);
        }

        // Insert files
        for (const file of asset.files) {
          this.db.insertFile(file);
        }

        // Insert tags
        if (asset.tags.length > 0) {
          this.db.setTags(asset.id, asset.tags);
        }
      }

      // Remove deleted assets
      for (const id of existingAssets) {
        if (!foundAssets.has(id)) {
          this.db.deleteAsset(id);
        }
      }
    });

    const removedCount = existingAssets.size - updatedCount;
    const duration = Date.now() - startTime;

    console.log(`[AssetIndexer] Indexed ${assets.length} assets in ${duration}ms`);
    console.log(`  New: ${newCount}, Updated: ${updatedCount}, Removed: ${removedCount}`);

    return {
      totalAssets: assets.length,
      newAssets: newCount,
      updatedAssets: updatedCount,
      removedAssets: removedCount,
      duration,
    };
  }

  /**
   * Incremental update for a single path
   */
  async updatePath(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    
    if (!absolutePath.startsWith(this.rootPath)) {
      return;
    }

    const relativePath = path.relative(this.rootPath, absolutePath);
    const assetId = this.pathToAssetId(relativePath);

    if (!fs.existsSync(absolutePath)) {
      // File deleted
      this.db.deleteAsset(assetId);
      console.log(`[AssetIndexer] Removed: ${assetId}`);
      return;
    }

    const stat = fs.statSync(absolutePath);
    
    if (stat.isDirectory()) {
      // Directory changed - rescan it
      const assets = await this.scanDirectory(absolutePath);
      this.db.transaction(() => {
        for (const asset of assets) {
          this.insertOrUpdateAsset(asset);
        }
      });
    } else {
      // Single file changed
      const asset = await this.parseFile(absolutePath);
      if (asset) {
        this.db.transaction(() => {
          this.insertOrUpdateAsset(asset);
        });
      }
    }
  }

  private insertOrUpdateAsset(asset: ParsedAsset): void {
    this.db.deleteAsset(asset.id);
    this.db.insertAsset({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      category: asset.category,
      subtype: asset.subtype,
      path: asset.path,
      metadataPath: asset.metadataPath,
      previewPath: asset.previewPath,
      fileSize: asset.fileSize,
      modifiedAt: asset.modifiedAt,
      createdAt: Date.now(),
    });

    if (asset.metadata) {
      this.db.insertMetadata(asset.id, asset.metadata);
    }

    for (const file of asset.files) {
      this.db.insertFile(file);
    }

    if (asset.tags.length > 0) {
      this.db.setTags(asset.id, asset.tags);
    }

    console.log(`[AssetIndexer] Updated: ${asset.id}`);
  }

  /**
   * Scan a directory recursively for assets
   */
  private async scanDirectory(dirPath: string): Promise<ParsedAsset[]> {
    const assets: ParsedAsset[] = [];
    const processedDirs = new Set<string>();

    const scan = async (currentPath: string): Promise<void> => {
      if (!fs.existsSync(currentPath)) return;
      if (processedDirs.has(currentPath)) return;
      
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      
      // Separate files and directories
      const files = entries.filter(e => e.isFile() && !this.shouldIgnore(e.name));
      const dirs = entries.filter(e => e.isDirectory() && !this.shouldIgnore(e.name));
      
      // Check for vegetation manifest (manifest.json)
      // But first check if this directory has a type hint that indicates it's NOT vegetation
      const relativePath = path.relative(this.rootPath, currentPath);
      const dirHint = this.getDirTypeHint(relativePath);
      const isVegetationPath = !dirHint || dirHint.category === 'vegetation';
      
      const manifestFile = files.find(f => f.name === 'manifest.json');
      if (manifestFile && isVegetationPath) {
        const manifestPath = path.join(currentPath, manifestFile.name);
        const asset = await this.parseVegetationManifest(manifestPath);
        if (asset) {
          assets.push(asset);
          processedDirs.add(currentPath);
          return; // Don't recurse into manifest-based assets
        }
      }

      // Check for glTF model directory
      // A .gltf FILE (not folder) inside means this is a model directory
      const gltfFile = files.find(f => f.name.endsWith('.gltf'));
      if (gltfFile) {
        const gltfPath = path.join(currentPath, gltfFile.name);
        const asset = await this.parseGltfDirectory(currentPath, gltfPath);
        if (asset) {
          assets.push(asset);
          processedDirs.add(currentPath);
          return; // Don't recurse into model directories
        }
      }

      // Check for texture pack (files with common prefix)
      const texturePack = await this.parseTexturePack(currentPath, files);
      if (texturePack) {
        assets.push(texturePack);
        processedDirs.add(currentPath);
        return; // Don't recurse into texture packs
      }

      // Process standalone .glb files
      for (const file of files) {
        if (file.name.endsWith('.glb')) {
          const filePath = path.join(currentPath, file.name);
          const asset = await this.parseGlbFile(filePath);
          if (asset) {
            assets.push(asset);
          }
        }
      }

      // Process other standalone files (HDR, EXR, etc.) that match EXTENSION_MAP
      for (const file of files) {
        const ext = path.extname(file.name).toLowerCase();
        if (ext !== '.glb' && EXTENSION_MAP[ext]) {
          const filePath = path.join(currentPath, file.name);
          const asset = await this.parseFile(filePath);
          if (asset) {
            assets.push(asset);
          }
        }
      }

      // Recurse into subdirectories
      for (const dir of dirs) {
        const dirFullPath = path.join(currentPath, dir.name);
        
        // Check if directory name ends with .gltf extension
        // These are FOLDERS that happen to have .gltf in the name
        // They should be treated as regular directories containing a model
        if (dir.name.endsWith('.gltf')) {
          // Look inside for the actual .gltf file
          const innerEntries = fs.readdirSync(dirFullPath, { withFileTypes: true });
          const innerGltfFile = innerEntries.find(e => 
            e.isFile() && e.name.endsWith('.gltf')
          );
          
          if (innerGltfFile) {
            const gltfPath = path.join(dirFullPath, innerGltfFile.name);
            const asset = await this.parseGltfDirectory(dirFullPath, gltfPath);
            if (asset) {
              assets.push(asset);
              processedDirs.add(dirFullPath);
            }
          }
        } else {
          await scan(dirFullPath);
        }
      }
    };

    await scan(dirPath);
    return assets;
  }

  /**
   * Parse a standalone .glb file as a model asset
   */
  private async parseGlbFile(filePath: string): Promise<ParsedAsset | null> {
    try {
      const relativePath = path.relative(this.rootPath, filePath);
      const fileName = path.basename(filePath, '.glb');
      const id = this.pathToAssetId(relativePath);
      const stat = fs.statSync(filePath);

      // Determine type/category from directory hints
      const dirHint = this.getDirTypeHint(relativePath);
      let assetType: AssetType = 'model';
      let category: AssetCategory = null;
      let subtype: AssetSubtype = null;
      
      if (dirHint) {
        assetType = dirHint.type;
        category = dirHint.category || null;
        subtype = dirHint.subtype || null;
      }

      return {
        id,
        name: this.formatAssetName(fileName),
        type: assetType,
        category,
        subtype,
        path: relativePath,
        metadataPath: null,
        previewPath: null,
        fileSize: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        metadata: null,
        files: [{
          assetId: id,
          fileType: 'model',
          fileSubType: null,
          lodLevel: this.extractLodLevel(fileName),
          resolution: null,
          format: 'glb',
          path: relativePath,
          fileSize: stat.size,
        }],
        tags: [],
      };
    } catch (err) {
      console.warn(`[AssetIndexer] Failed to parse GLB file: ${filePath}`, err);
      return null;
    }
  }

  /**
   * Parse a glTF model directory as a single asset
   * The parent folder of the .gltf file is the asset
   */
  private async parseGltfDirectory(dirPath: string, gltfFilePath: string): Promise<ParsedAsset | null> {
    try {
      const relativeDirPath = path.relative(this.rootPath, dirPath);
      const relativeGltfPath = path.relative(this.rootPath, gltfFilePath);
      const dirName = path.basename(dirPath);
      
      // Remove .gltf extension from folder name if present (for folders like "Camera_01_4k.gltf/")
      const assetName = dirName.endsWith('.gltf') 
        ? dirName.slice(0, -5) 
        : dirName;
      
      const id = this.pathToAssetId(relativeDirPath);
      const stat = fs.statSync(dirPath);

      // Collect all files in the directory
      const files = this.collectFiles(dirPath, id);
      
      // Ensure the main .gltf file has fileType 'model'
      const mainModelFile = files.find(f => f.path === relativeGltfPath);
      if (mainModelFile) {
        mainModelFile.fileType = 'model';
      }

      // Check for preview image
      let previewPath: string | null = null;
      const previewFile = files.find(f => 
        f.fileType === 'preview' || 
        f.path.toLowerCase().includes('preview') ||
        f.path.toLowerCase().includes('thumb')
      );
      if (previewFile) {
        previewPath = previewFile.path;
      }

      // Determine type/category from directory hints
      const dirHint = this.getDirTypeHint(relativeDirPath);
      let assetType: AssetType = 'model';
      let category: AssetCategory = null;
      let subtype: AssetSubtype = null;
      
      if (dirHint) {
        assetType = dirHint.type;
        category = dirHint.category || null;
        subtype = dirHint.subtype || null;
      }

      return {
        id,
        name: this.formatAssetName(assetName),
        type: assetType,
        category,
        subtype,
        path: relativeDirPath,
        metadataPath: null,
        previewPath,
        fileSize: this.getDirSize(dirPath),
        modifiedAt: Math.floor(stat.mtimeMs),
        metadata: null,
        files,
        tags: [],
      };
    } catch (err) {
      console.warn(`[AssetIndexer] Failed to parse glTF directory: ${dirPath}`, err);
      return null;
    }
  }

  /**
   * Parse a vegetation manifest file (manifest.json)
   */
  private async parseVegetationManifest(manifestPath: string): Promise<ParsedAsset | null> {
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      
      const dirPath = path.dirname(manifestPath);
      const relativePath = path.relative(this.rootPath, dirPath);
      const id = manifest.id || this.pathToAssetId(relativePath);
      
      // Collect files in the directory
      const files = this.collectFiles(dirPath, id);
      
      // Detect subtype from manifest or name
      let subtype: AssetSubtype = manifest.subtype || null;
      if (!subtype && manifest.name) {
        subtype = this.detectVegetationSubtype(manifest.name);
      }

      // Build tags
      const tags: string[] = [];
      if (manifest.tags) tags.push(...manifest.tags);
      if (subtype) tags.push(`subtype:${subtype}`);

      // Find preview image
      let previewPath: string | null = manifest.preview || null;
      if (!previewPath) {
        const previewFile = files.find(f => 
          f.fileType === 'preview' || 
          f.path.toLowerCase().includes('preview') ||
          f.path.toLowerCase().includes('thumb')
        );
        if (previewFile) {
          previewPath = previewFile.path;
        }
      }

      // Extract metadata
      const metadata: AssetMetadata = {
        biome: manifest.biome || null,
        physicalSize: manifest.physicalSize || null,
        resolution: manifest.resolution || null,
        hasBillboard: manifest.hasBillboard || files.some(f => f.path.toLowerCase().includes('billboard')),
        hasLod: manifest.hasLod || files.some(f => f.lodLevel !== null),
        lodCount: manifest.lodCount || files.filter(f => f.lodLevel !== null).length,
        variantCount: manifest.variantCount || 1,
        latinName: manifest.latinName || null,
        averageColor: manifest.averageColor || null,
        rawJson: manifest,
      };

      const stat = fs.statSync(dirPath);

      return {
        id,
        name: manifest.name || this.formatAssetName(path.basename(dirPath)),
        type: 'model',
        category: 'vegetation',
        subtype,
        path: relativePath,
        metadataPath: path.relative(this.rootPath, manifestPath),
        previewPath,
        fileSize: this.getDirSize(dirPath),
        modifiedAt: Math.floor(stat.mtimeMs),
        metadata,
        files,
        tags,
      };
    } catch (err) {
      console.warn(`[AssetIndexer] Failed to parse vegetation manifest: ${manifestPath}`, err);
      return null;
    }
  }

  /**
   * Parse a texture pack directory
   * Detects folders where image files share a common prefix
   */
  private async parseTexturePack(
    dirPath: string, 
    files: fs.Dirent[]
  ): Promise<ParsedAsset | null> {
    try {
      // Get image files
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.tga', '.exr'];
      const imageFiles = files.filter(f => 
        imageExtensions.includes(path.extname(f.name).toLowerCase())
      );

      // Need at least 2 image files to be a texture pack
      if (imageFiles.length < 2) return null;

      // Find common prefix among image files
      const prefix = this.findCommonPrefix(imageFiles.map(f => f.name));
      
      // If prefix is too short or empty, not a texture pack
      if (!prefix || prefix.length < 3) return null;
      
      // Check that most files share this prefix
      const filesWithPrefix = imageFiles.filter(f => 
        f.name.toLowerCase().startsWith(prefix.toLowerCase())
      );
      
      // At least 50% of files should share the prefix
      if (filesWithPrefix.length < imageFiles.length * 0.5) return null;

      const relativePath = path.relative(this.rootPath, dirPath);
      const id = this.pathToAssetId(relativePath);
      const stat = fs.statSync(dirPath);

      // Collect all files
      const assetFiles = this.collectFiles(dirPath, id);

      // Find preview image (preferably albedo/diffuse)
      let previewPath: string | null = null;
      const albedoFile = assetFiles.find(f => {
        const nameLower = f.path.toLowerCase();
        return nameLower.includes('albedo') || nameLower.includes('diffuse') || nameLower.includes('color');
      });
      if (albedoFile) {
        previewPath = albedoFile.path;
      } else if (assetFiles.length > 0) {
        previewPath = assetFiles[0].path;
      }

      // Check directory hints for category/subtype
      const dirHint = this.getDirTypeHint(relativePath);
      const category = dirHint?.category || null;
      const subtype = dirHint?.subtype || null;

      // Use prefix as asset name (cleaned up)
      const assetName = this.formatAssetName(prefix.replace(/_$/, ''));

      return {
        id,
        name: assetName,
        type: 'texture',
        category,
        subtype,
        path: relativePath,
        metadataPath: null,
        previewPath,
        fileSize: this.getDirSize(dirPath),
        modifiedAt: Math.floor(stat.mtimeMs),
        metadata: null,
        files: assetFiles,
        tags: [],
      };
    } catch (err) {
      console.warn(`[AssetIndexer] Failed to parse texture pack: ${dirPath}`, err);
      return null;
    }
  }

  /**
   * Parse a single file as an asset (fallback for non-model files)
   */
  private async parseFile(filePath: string): Promise<ParsedAsset | null> {
    const ext = path.extname(filePath).toLowerCase();
    const typeInfo = EXTENSION_MAP[ext];
    
    if (!typeInfo) return null;

    // Skip .gltf files - they're handled as directories
    if (ext === '.gltf') return null;

    const relativePath = path.relative(this.rootPath, filePath);
    const id = this.pathToAssetId(relativePath);
    const name = path.basename(filePath, ext);
    const stat = fs.statSync(filePath);

    // Check directory hints for category/subtype
    let category = typeInfo.category || null;
    let subtype = typeInfo.subtype || null;
    const dirHint = this.getDirTypeHint(relativePath);
    if (dirHint) {
      category = dirHint.category || category;
      subtype = dirHint.subtype || subtype;
    }

    const fileType = this.getFileType(ext);
    const fileSubType = fileType === 'texture' ? this.getFileSubType(name) : null;

    return {
      id,
      name: this.formatAssetName(name),
      type: typeInfo.type,
      category,
      subtype,
      path: relativePath,
      metadataPath: null,
      previewPath: null,
      fileSize: stat.size,
      modifiedAt: Math.floor(stat.mtimeMs),
      metadata: null,
      files: [{
        assetId: id,
        fileType,
        fileSubType,
        lodLevel: this.extractLodLevel(name),
        resolution: this.extractResolution(name),
        format: ext.slice(1),
        path: relativePath,
        fileSize: stat.size,
      }],
      tags: [],
    };
  }

  /**
   * Collect all files in a directory for an asset
   */
  private collectFiles(dirPath: string, assetId: string): Array<Omit<import('../types/index.js').AssetFile, 'id'>> {
    const files: Array<Omit<import('../types/index.js').AssetFile, 'id'>> = [];

    const scan = (currentPath: string): void => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue;

        const entryPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          scan(entryPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const relativePath = path.relative(this.rootPath, entryPath);
          const stat = fs.statSync(entryPath);
          const nameLower = entry.name.toLowerCase();

          // Determine file type
          let fileType: 'model' | 'texture' | 'billboard' | 'preview' = 'texture';
          if (['.glb', '.gltf', '.obj', '.fbx'].includes(ext)) {
            fileType = 'model';
          } else if (nameLower.includes('preview') || nameLower.includes('thumb')) {
            fileType = 'preview';
          } else if (nameLower.includes('billboard') || nameLower.includes('atlas')) {
            fileType = 'billboard';
          }

          let fileSubType: AssetFile['fileSubType'] = null;
          if (fileType === 'texture' || fileType === 'billboard') {
            fileSubType = this.getFileSubType(nameLower);
          }

          files.push({
            assetId,
            fileType,
            fileSubType,
            lodLevel: this.extractLodLevel(entry.name),
            resolution: this.extractResolution(entry.name),
            format: ext.slice(1),
            path: relativePath,
            fileSize: stat.size,
          });
        }
      }
    };

    scan(dirPath);
    return files;
  }

  // ========== Helpers ==========

  private pathToAssetId(relativePath: string): string {
    return relativePath
      .replace(/[/\\]/g, '_')
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
  }

  private shouldIgnore(name: string): boolean {
    return IGNORED_PATTERNS.some(pattern => pattern.test(name));
  }

  private getDirTypeHint(relativePath: string): { type: AssetType; category?: AssetCategory; subtype?: AssetSubtype } | null {
    const parts = relativePath.toLowerCase().split(/[/\\]/);
    let result: { type: AssetType; category?: AssetCategory; subtype?: AssetSubtype } | null = null;
    
    // Iterate through all path segments and merge hints
    // Later (more specific) matches override earlier ones for category/subtype
    for (const part of parts) {
      if (DIR_TYPE_HINTS[part]) {
        const hint = DIR_TYPE_HINTS[part];
        if (!result) {
          result = { ...hint };
        } else {
          // Override type if present
          result.type = hint.type;
          // Override category and subtype if more specific
          if (hint.category) result.category = hint.category;
          if (hint.subtype) result.subtype = hint.subtype;
        }
      }
    }
    return result;
  }

  private getFileType(ext: string): 'model' | 'texture' | 'billboard' | 'preview' {
    if (['.glb', '.gltf', '.obj', '.fbx'].includes(ext)) return 'model';
    return 'texture';
  }

  private getFileSubType(name: string): AssetFile['fileSubType'] {
    const value = TextureTypeValues.find((v) => name.toLowerCase().includes(v.pattern));
    return value ? value.type : null;
  }

  private extractLodLevel(filename: string): number | null {
    const match = filename.match(/lod(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  private extractResolution(filename: string): string | null {
    const match = filename.match(/(\d+)[kK]/) || filename.match(/_(\d{3,4})x\d{3,4}/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= 8) return `${num}K`;
      if (num >= 512) return `${num}`;
    }
    return null;
  }

  private getDirSize(dirPath: string): number {
    let size = 0;
    const scan = (p: string): void => {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(p, entry.name);
        if (entry.isDirectory()) {
          scan(entryPath);
        } else {
          size += fs.statSync(entryPath).size;
        }
      }
    };
    scan(dirPath);
    return size;
  }

  /**
   * Find the longest common prefix among a list of strings
   */
  private findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0].replace(/\.[^.]+$/, '');

    // Sort to compare first and last (most different)
    const sorted = [...strings].sort();
    const first = sorted[0].toLowerCase();
    const last = sorted[sorted.length - 1].toLowerCase();

    let prefix = '';
    for (let i = 0; i < Math.min(first.length, last.length); i++) {
      if (first[i] === last[i]) {
        prefix += first[i];
      } else {
        break;
      }
    }

    // Trim trailing underscore or hyphen
    return prefix.replace(/[_-]$/, '');
  }

  /**
   * Detect vegetation subtype from name
   */
  private detectVegetationSubtype(name: string): AssetSubtype {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('grass') || nameLower.includes('ribbon')) return 'grass';
    if (nameLower.includes('fern') || nameLower.includes('bracken')) return 'fern';
    if (nameLower.includes('tree') || nameLower.includes('oak') || nameLower.includes('birch') || nameLower.includes('maple')) return 'tree';
    if (nameLower.includes('flower')) return 'flower';
    if (nameLower.includes('shrub') || nameLower.includes('bush')) return 'shrub';
    return null;
  }

  /**
   * Format asset name for display (convert snake_case to Title Case)
   */
  private formatAssetName(name: string): string {
    return name
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }
}

interface ParsedAsset {
  id: string;
  name: string;
  type: AssetType;
  category: AssetCategory;
  subtype: AssetSubtype;
  path: string;
  metadataPath: string | null;
  previewPath: string | null;
  fileSize: number;
  modifiedAt: number;
  metadata: AssetMetadata | null;
  files: Array<Omit<import('../types/index.js').AssetFile, 'id'>>;
  tags: string[];
}
