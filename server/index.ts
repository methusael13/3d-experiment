/**
 * Asset Server Entry Point
 * Express server for asset management with SQLite database
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from './db/database.js';
import { AssetIndexer } from './services/AssetIndexer.js';
import { PreviewGenerator } from './services/PreviewGenerator.js';
import { FileWatcher } from './services/FileWatcher.js';
import type { AssetQuery, ServerStatus, ApiResponse, AssetsListResponse } from './types/index.js';

// Get project root directory reliably (works with both vite dev and direct node)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PORT = 3002;
const WS_PORT = 3003;
const PUBLIC_PATH = path.join(PROJECT_ROOT, 'public');
const PREVIEW_DIR = path.join(PROJECT_ROOT, '.asset-server', 'previews');

// Initialize services
const indexer = new AssetIndexer(PUBLIC_PATH);
const previewGenerator = new PreviewGenerator(PUBLIC_PATH);
const fileWatcher = new FileWatcher(PUBLIC_PATH);

// Server state
let isIndexing = false;
let lastIndexed: number | null = null;

const app = express();
app.use(cors());
app.use(express.json());

// Serve preview images statically (more reliable than manual file checks)
app.use('/api/previews', express.static(PREVIEW_DIR));

// ========== Status & Health ==========

app.get('/api/status', (_req, res) => {
  const db = getDatabase();
  const stats = db.getStats();
  
  const status: ServerStatus = {
    isIndexing,
    totalAssets: stats.total,
    lastIndexed,
    watcherActive: fileWatcher.isActive(),
  };
  
  res.json({ success: true, data: status } as ApiResponse<ServerStatus>);
});

// ========== Asset Operations ==========

// List all assets with optional filtering
app.get('/api/assets', (req, res) => {
  const db = getDatabase();
  const query: AssetQuery = {
    type: req.query.type as any,
    subtype: req.query.subtype as any,
    biome: req.query.biome as string,
    tag: req.query.tag as string,
    search: req.query.search as string,
    hasLod: req.query.hasLod === 'true' ? true : req.query.hasLod === 'false' ? false : undefined,
    hasBillboard: req.query.hasBillboard === 'true' ? true : req.query.hasBillboard === 'false' ? false : undefined,
  };
  
  // Remove undefined values
  Object.keys(query).forEach(key => {
    if ((query as any)[key] === undefined) {
      delete (query as any)[key];
    }
  });
  
  const assets = Object.keys(query).length > 0 
    ? db.queryAssets(query)
    : db.getAllAssets();
  
  res.json({ 
    success: true, 
    data: { assets, total: assets.length } 
  } as ApiResponse<AssetsListResponse>);
});

// Get single asset by ID
app.get('/api/assets/:id', (req, res) => {
  const db = getDatabase();
  const asset = db.getAsset(req.params.id);
  
  if (!asset) {
    return res.status(404).json({ success: false, error: 'Asset not found' });
  }
  
  res.json({ success: true, data: asset });
});

// Get asset files
app.get('/api/assets/:id/files', (req, res) => {
  const db = getDatabase();
  const files = db.getFiles(req.params.id);
  
  res.json({ success: true, data: files });
});

// Get asset statistics grouped by type
app.get('/api/assets/stats/types', (_req, res) => {
  const db = getDatabase();
  const stats = db.getStats();
  
  res.json({ success: true, data: stats });
});

// ========== Indexing Operations ==========

// Trigger full reindex
app.post('/api/index/full', async (_req, res) => {
  if (isIndexing) {
    return res.status(409).json({ success: false, error: 'Indexing already in progress' });
  }
  
  isIndexing = true;
  
  try {
    const result = await indexer.fullIndex();
    lastIndexed = Date.now();
    
    // Generate previews in background
    previewGenerator.generateAllPreviews().catch(console.error);
    
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  } finally {
    isIndexing = false;
  }
});

// ========== Preview Operations ==========

// Get preview for asset (generates if needed)
app.get('/api/preview/:id', async (req, res) => {
  try {
    const previewUrl = await previewGenerator.getPreview(req.params.id);
    
    if (!previewUrl) {
      return res.status(404).json({ success: false, error: 'Preview not available' });
    }
    
    res.json({ success: true, data: { previewUrl } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Note: Preview images are now served via express.static middleware above
// The /api/previews/:filename route is handled automatically

// Generate all previews
app.post('/api/previews/generate', async (_req, res) => {
  try {
    const result = await previewGenerator.generateAllPreviews();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ========== File Watching ==========

app.post('/api/watcher/start', (_req, res) => {
  if (fileWatcher.isActive()) {
    return res.json({ success: true, data: { message: 'Watcher already running' } });
  }
  
  fileWatcher.start();
  res.json({ success: true, data: { message: 'Watcher started' } });
});

app.post('/api/watcher/stop', async (_req, res) => {
  await fileWatcher.stop();
  res.json({ success: true, data: { message: 'Watcher stopped' } });
});

// ========== Billboard Generation ==========

// Upload client-generated billboard atlas for an asset
app.post('/api/assets/:id/billboard', express.raw({ type: 'image/png', limit: '20mb' }), (req, res) => {
  const db = getDatabase();
  const assetId = req.params.id;
  const asset = db.getAsset(assetId);
  
  if (!asset) {
    return res.status(404).json({ success: false, error: 'Asset not found' });
  }
  
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ success: false, error: 'No image data received' });
  }
  
  try {
    // Get existing files first (needed for both texture folder lookup and duplicate check)
    const existingFiles = db.getFiles(assetId);
    console.log('Existing files:', existingFiles);
    
    // Determine output path — save to the texture folder of the model
    // Find an existing texture file to determine the textures directory
    // Only consider actual image files as textures (not .bin or other model data)
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.tga', '.exr'];
    const existingTextureFile = existingFiles.find(
      f => (f.fileType === 'texture' || f.fileType === 'billboard') &&
           imageExtensions.some(ext => f.path.toLowerCase().endsWith(ext))
    );
    
    let assetDir: string;
    if (existingTextureFile) {
      // Use the directory of the first texture file
      assetDir = path.dirname(path.join(PUBLIC_PATH, existingTextureFile.path));
      console.log('Found texture directory:', assetDir);
    } else {
      // Fallback: look for a 'textures' subdirectory inside the asset folder
      const assetFullPath = path.join(PUBLIC_PATH, asset.path);
      const baseDir = fs.statSync(assetFullPath).isDirectory() 
        ? assetFullPath 
        : path.dirname(assetFullPath);
      const texturesSubdir = path.join(baseDir, 'textures');
      console.log('Looking up texture subdirectory:', texturesSubdir);
      
      if (fs.existsSync(texturesSubdir) && fs.statSync(texturesSubdir).isDirectory()) {
        assetDir = texturesSubdir;
        console.log('Found texture subdirectory:', texturesSubdir);
      } else {
        // Last resort: use the asset directory itself
        assetDir = baseDir;
        console.log('Could not find texture subdirectory:', texturesSubdir);
      }
    }
    const safeName = asset.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    
    // Get the type from query param: 'albedo' or 'normal'
    const billboardType = (req.query.type as string) || 'albedo';
    const filename = `${safeName}_billboard_${billboardType}.png`;
    const outputPath = path.join(assetDir, filename);
    
    // Write the PNG to disk
    fs.writeFileSync(outputPath, req.body);
    
    // Compute relative path from public/ for the asset DB
    const relativePath = path.relative(PUBLIC_PATH, outputPath).replace(/\\/g, '/');
    
    // Register in asset_files
    const fileType = 'billboard' as const;
    const existingBillboard = existingFiles.find(
      f => f.fileType === 'billboard' && f.path.includes(`_billboard_${billboardType}`)
    );
    
    if (!existingBillboard) {
      db.insertFile({
        assetId,
        fileType,
        fileSubType: billboardType === 'normal' ? 'normal' : 'albedo',
        lodLevel: null,
        resolution: req.query.resolution as string || '512',
        format: 'png',
        path: relativePath,
        fileSize: req.body.length,
      });
    }
    
    // Update asset_metadata has_billboard flag
    const meta = db.getMetadata(assetId);
    if (meta) {
      meta.hasBillboard = true;
      db.insertMetadata(assetId, meta);
    } else {
      db.insertMetadata(assetId, {
        biome: null,
        physicalSize: null,
        resolution: null,
        hasBillboard: true,
        hasLod: false,
        lodCount: 0,
        variantCount: 1,
        latinName: null,
        averageColor: null,
        rawJson: null,
      });
    }
    
    console.log(`[Server] Billboard ${billboardType} saved for "${asset.name}" → ${relativePath}`);
    
    res.json({ 
      success: true, 
      data: { 
        path: relativePath,
        type: billboardType,
        size: req.body.length,
      } 
    });
  } catch (err) {
    console.error(`[Server] Failed to save billboard for ${assetId}:`, err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ========== Startup ==========

async function startup(): Promise<void> {
  console.log('╔═════════════════════════════════════════╗');
  console.log('║       Asset Server Starting...          ║');
  console.log('╚═════════════════════════════════════════╝');
  
  // Initialize database
  console.log('[Server] Initializing database...');
  getDatabase();
  
  // Check if we need to do initial index
  const db = getDatabase();
  const stats = db.getStats();
  
  if (stats.total === 0) {
    console.log('[Server] No assets found, performing initial index...');
    isIndexing = true;
    try {
      await indexer.fullIndex();
      lastIndexed = Date.now();
      console.log('[Server] Initial index complete');
      
      // Generate previews
      console.log('[Server] Generating previews...');
      await previewGenerator.generateAllPreviews();
    } finally {
      isIndexing = false;
    }
  } else {
    console.log(`[Server] Found ${stats.total} assets in database`);
    lastIndexed = Date.now();
  }
  
  // Start file watcher
  fileWatcher.start();
  fileWatcher.startWebSocket(WS_PORT);
  
  // Start HTTP server
  app.listen(PORT, () => {
    console.log('');
    console.log(`[Server] HTTP API running on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket running on ws://localhost:${WS_PORT}`);
    console.log(`[Server] Watching: ${PUBLIC_PATH}`);
    console.log('');
    console.log('Available endpoints:');
    console.log('  GET  /api/status         - Server status');
    console.log('  GET  /api/assets         - List all assets (with query params)');
    console.log('  GET  /api/assets/:id     - Get single asset');
    console.log('  POST /api/index/full     - Trigger full reindex');
    console.log('  GET  /api/preview/:id    - Get asset preview');
    console.log('  POST /api/previews/generate - Generate all previews');
    console.log('');
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  await fileWatcher.stop();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Shutting down...');
  await fileWatcher.stop();
  closeDatabase();
  process.exit(0);
});

// Start server
startup().catch(console.error);
