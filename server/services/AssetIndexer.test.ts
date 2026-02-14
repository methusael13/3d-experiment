/**
 * Unit tests for AssetIndexer
 * Tests the scanDirectory function with mocked filesystem
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import the indexer - we'll need to expose scanDirectory for testing
// For now, we'll test via the full index flow with a temp directory

// Helper to create a temp directory structure
function createTempStructure(structure: Record<string, string | null>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-indexer-test-'));
  
  for (const [filePath, content] of Object.entries(structure)) {
    const fullPath = path.join(tmpDir, filePath);
    const dir = path.dirname(fullPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (content !== null) {
      fs.writeFileSync(fullPath, content);
    }
  }
  
  return tmpDir;
}

// Helper to clean up temp directory
function cleanupTempDir(tmpDir: string): void {
  if (tmpDir.includes('asset-indexer-test-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('AssetIndexer', () => {
  let tmpDir: string;
  
  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
  });

  describe('getDirTypeHint', () => {
    it('should detect vegetation category from path', async () => {
      // Create a structure mimicking models/terrain/vegetation/...
      tmpDir = createTempStructure({
        'models/terrain/vegetation/ribbon_grass/model.gltf': '{}',
        'models/terrain/vegetation/ribbon_grass/model.bin': 'binary',
      });
      
      // Import dynamically to avoid database issues
      const { AssetIndexer } = await import('./AssetIndexer.js');
      
      // Create indexer with mock database
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      const result = await indexer.fullIndex();
      
      // Find the ribbon_grass asset
      const vegetationAsset = mockDb.insertedAssets.find(a => 
        a.path.includes('vegetation')
      );
      
      expect(vegetationAsset).toBeDefined();
      expect(vegetationAsset?.category).toBe('vegetation');
      expect(vegetationAsset?.type).toBe('model');
    });

    it('should detect IBL category from path', async () => {
      tmpDir = createTempStructure({
        'ibl/autumn_field.hdr': 'hdr-content',
        'ibl/night_sky.exr': 'exr-content',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const hdrAsset = mockDb.insertedAssets.find((a: any) => 
        a.path.includes('autumn_field')
      );
      const exrAsset = mockDb.insertedAssets.find((a: any) => 
        a.path.includes('night_sky')
      );
      
      expect(hdrAsset).toBeDefined();
      expect(hdrAsset?.type).toBe('texture');
      expect(hdrAsset?.category).toBe('ibl');
      expect(hdrAsset?.subtype).toBe('environment');
      
      expect(exrAsset).toBeDefined();
      expect(exrAsset?.type).toBe('texture');
      expect(exrAsset?.category).toBe('ibl');
      expect(exrAsset?.subtype).toBe('environment');
    });

    it('should detect rocks subtype from path', async () => {
      tmpDir = createTempStructure({
        'models/terrain/rocks/boulder/model.gltf': '{}',
        'models/terrain/rocks/boulder/model.bin': 'binary',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const rockAsset = mockDb.insertedAssets.find(a => 
        a.path.includes('rocks')
      );
      
      expect(rockAsset).toBeDefined();
      expect(rockAsset?.subtype).toBe('rock');
      expect(rockAsset?.type).toBe('model');
    });
  });

  describe('GLB file parsing', () => {
    it('should parse standalone GLB files as model assets', async () => {
      tmpDir = createTempStructure({
        'models/assets/duck.glb': 'glb-binary-content',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const glbAsset = mockDb.insertedAssets.find(a => 
        a.path.includes('duck.glb')
      );
      
      expect(glbAsset).toBeDefined();
      expect(glbAsset?.type).toBe('model');
      expect(glbAsset?.name).toBe('Duck');
    });
  });

  describe('glTF directory parsing', () => {
    it('should parse folder with .gltf file as single model asset', async () => {
      tmpDir = createTempStructure({
        'models/assets/camera_01_4k/scene.gltf': '{"asset":{"version":"2.0"}}',
        'models/assets/camera_01_4k/scene.bin': 'binary',
        'models/assets/camera_01_4k/textures/albedo.jpg': 'image',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      // Should be treated as a single asset, not multiple
      const assets = mockDb.insertedAssets.filter(a => 
        a.path.includes('camera_01_4k')
      );
      
      expect(assets.length).toBe(1);
      expect(assets[0].type).toBe('model');
      expect(assets[0].path).toBe('models/assets/camera_01_4k');
    });

    it('should handle folders WITH .gltf extension (not actual gltf files)', async () => {
      // Folders like "Camera_01_4k.gltf/" that contain the actual .gltf file inside
      tmpDir = createTempStructure({
        'models/assets/Camera_01_4k.gltf/Camera_01_4k.gltf': '{"asset":{"version":"2.0"}}',
        'models/assets/Camera_01_4k.gltf/Camera_01_4k.bin': 'binary',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const gltfAsset = mockDb.insertedAssets.find(a => 
        a.path.includes('Camera_01_4k')
      );
      
      expect(gltfAsset).toBeDefined();
      expect(gltfAsset?.type).toBe('model');
      // Name should strip the .gltf extension from folder name
      expect(gltfAsset?.name).toBe('Camera 01 4k');
    });
  });

  describe('Texture pack parsing', () => {
    it('should detect texture pack when files share common prefix', async () => {
      tmpDir = createTempStructure({
        'textures/atlas/vegetation/fern_4k/Fern_4K_BaseColor.jpg': 'image',
        'textures/atlas/vegetation/fern_4k/Fern_4K_Normal.jpg': 'image',
        'textures/atlas/vegetation/fern_4k/Fern_4K_Roughness.jpg': 'image',
        'textures/atlas/vegetation/fern_4k/Fern_4K_Opacity.jpg': 'image',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const texturePack = mockDb.insertedAssets.find(a => 
        a.path.includes('fern_4k')
      );
      
      expect(texturePack).toBeDefined();
      expect(texturePack?.type).toBe('texture');
      // Should have multiple files associated
      const files = mockDb.insertedFiles.filter(f => 
        f.assetId === texturePack?.id
      );

      expect(files.length).toBeGreaterThanOrEqual(4);
      expect(files[0].fileSubType).toBe('albedo');
    });
  });

  describe('HDR/EXR file parsing', () => {
    it('should parse standalone HDR files as IBL texture assets', async () => {
      tmpDir = createTempStructure({
        'ibl/studio.hdr': 'hdr-binary-content',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const hdrAsset = mockDb.insertedAssets.find((a: any) => 
        a.path.includes('studio')
      );
      
      expect(hdrAsset).toBeDefined();
      expect(hdrAsset?.type).toBe('texture');
      expect(hdrAsset?.category).toBe('ibl');
      expect(hdrAsset?.name).toBe('Studio');
      
      // Should have one file entry
      const files = mockDb.insertedFiles.filter((f: any) => 
        f.assetId === hdrAsset?.id
      );
      expect(files.length).toBe(1);
      expect(files[0].format).toBe('hdr');
    });

    it('should parse standalone EXR files as IBL texture assets', async () => {
      tmpDir = createTempStructure({
        'ibl/NightSkyHDRI001_4K_HDR.exr': 'exr-binary-content',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const exrAsset = mockDb.insertedAssets.find((a: any) => 
        a.path.includes('NightSkyHDRI001')
      );
      
      expect(exrAsset).toBeDefined();
      expect(exrAsset?.type).toBe('texture');
      expect(exrAsset?.category).toBe('ibl');
      expect(exrAsset?.subtype).toBe('environment');
      
      const files = mockDb.insertedFiles.filter((f: any) => 
        f.assetId === exrAsset?.id
      );
      expect(files.length).toBe(1);
      expect(files[0].format).toBe('exr');
    });
  });

  describe('Path category override', () => {
    it('should prefer more specific path hints over generic ones', async () => {
      // models/ (type: model) -> terrain/ -> vegetation/ (category: vegetation)
      // The vegetation category should override the generic model type
      tmpDir = createTempStructure({
        'models/terrain/vegetation/grass/model.gltf': '{}',
        'models/terrain/vegetation/grass/model.bin': 'binary',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      const grassAsset = mockDb.insertedAssets.find(a => 
        a.path.includes('grass')
      );
      
      expect(grassAsset).toBeDefined();
      expect(grassAsset?.type).toBe('model');
      expect(grassAsset?.category).toBe('vegetation');
      expect(grassAsset?.subtype).toBe('grass'); // grass folder also sets subtype
    });
  });

  describe('Ignored files', () => {
    it('should ignore hidden files and system files', async () => {
      tmpDir = createTempStructure({
        '.DS_Store': 'system-file',
        'models/.hidden_folder/model.glb': 'glb',
        'models/assets/duck.glb': 'glb',
        'thumbs.db': 'system-file',
      });
      
      const { AssetIndexer } = await import('./AssetIndexer.js');
      const mockDb = createMockDatabase();
      vi.spyOn(await import('../db/database.js'), 'getDatabase').mockReturnValue(mockDb);
      
      const indexer = new AssetIndexer(tmpDir);
      await indexer.fullIndex();
      
      // Should only find duck.glb, not hidden files or system files
      const dsStore = mockDb.insertedAssets.find(a => a.path.includes('.DS_Store'));
      const thumbsDb = mockDb.insertedAssets.find(a => a.path.includes('thumbs.db'));
      const hidden = mockDb.insertedAssets.find(a => a.path.includes('.hidden'));
      
      expect(dsStore).toBeUndefined();
      expect(thumbsDb).toBeUndefined();
      expect(hidden).toBeUndefined();
      
      const duck = mockDb.insertedAssets.find(a => a.path.includes('duck.glb'));
      expect(duck).toBeDefined();
    });
  });
});

// Mock database for testing - cast to any to avoid strict type checking
function createMockDatabase(): any {
  const insertedAssets: any[] = [];
  const insertedFiles: any[] = [];
  const insertedMetadata: any[] = [];
  const insertedTags: any[] = [];
  
  return {
    db: null,
    initSchema: () => {},
    getAllAssets: () => [],
    getAsset: () => null,
    queryAssets: () => [],
    getAssetFiles: () => [],
    getAssetMetadata: () => null,
    getAssetTags: () => [],
    searchAssets: () => [],
    getAssetCounts: () => ({ total: 0, byType: {} }),
    getMetadata: () => null,
    getTags: () => [],
    clearFiles: () => {},
    getFiles: () => [],
    close: () => {},
    insertAsset: (asset: any) => {
      insertedAssets.push(asset);
      return { changes: 1 };
    },
    insertFile: (file: any) => {
      insertedFiles.push(file);
      return { changes: 1 };
    },
    insertMetadata: (assetId: string, metadata: any) => {
      insertedMetadata.push({ assetId, ...metadata });
      return { changes: 1 };
    },
    setTags: (assetId: string, tags: string[]) => {
      insertedTags.push({ assetId, tags });
    },
    deleteAsset: () => {},
    transaction: (fn: () => void) => fn(),
    // Expose for assertions
    insertedAssets,
    insertedFiles,
    insertedMetadata,
    insertedTags,
  };
}
