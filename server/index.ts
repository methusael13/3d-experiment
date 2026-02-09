/**
 * Asset Server Entry Point
 * Express server for asset management with SQLite database
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
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
