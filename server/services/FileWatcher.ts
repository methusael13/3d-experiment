/**
 * File Watcher Service
 * Monitors the public directory for changes and updates the database
 */

import {FSWatcher, watch } from 'chokidar';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import type { FileChangeEvent } from '../types/index.js';
import { AssetIndexer } from './AssetIndexer.js';
import { PreviewGenerator } from './PreviewGenerator.js';

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private rootPath: string;
  private indexer: AssetIndexer;
  private previewGenerator: PreviewGenerator;
  private wsServer: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    this.indexer = new AssetIndexer(rootPath);
    this.previewGenerator = new PreviewGenerator(rootPath);
  }

  /**
   * Start watching the directory
   */
  start(): void {
    if (this.watcher) return;

    console.log(`[FileWatcher] Watching: ${this.rootPath}`);

    this.watcher = watch(this.rootPath, {
      ignored: [
        /(^|[\/\\])\../, // Ignore dotfiles
        /node_modules/,
        /.asset-server/,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher
      .on('add', (filePath) => this.handleChange('add', filePath))
      .on('change', (filePath) => this.handleChange('change', filePath))
      .on('unlink', (filePath) => this.handleChange('unlink', filePath))
      .on('addDir', (filePath) => this.handleChange('add', filePath))
      .on('unlinkDir', (filePath) => this.handleChange('unlink', filePath))
      .on('error', (error) => console.error('[FileWatcher] Error:', error));
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      console.log('[FileWatcher] Stopped');
    }

    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
  }

  /**
   * Start WebSocket server for live updates
   */
  startWebSocket(port: number): void {
    this.wsServer = new WebSocketServer({ port });
    
    this.wsServer.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[FileWatcher] WebSocket client connected (${this.clients.size} total)`);
      
      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[FileWatcher] WebSocket client disconnected (${this.clients.size} total)`);
      });
    });

    console.log(`[FileWatcher] WebSocket server listening on port ${port}`);
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void {
    const relativePath = path.relative(this.rootPath, filePath);
    
    // Skip non-asset files
    if (this.shouldIgnore(relativePath)) return;

    // Debounce rapid changes to the same file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.debounceTimers.set(filePath, setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      
      console.log(`[FileWatcher] ${type}: ${relativePath}`);
      
      try {
        // Update the database
        await this.indexer.updatePath(filePath);
        
        // Regenerate preview if needed
        if (type !== 'unlink') {
          const assetId = this.pathToAssetId(relativePath);
          this.previewGenerator.deletePreview(assetId);
        }
        
        // Notify WebSocket clients
        this.broadcast({
          type,
          path: relativePath,
          assetId: this.pathToAssetId(relativePath),
        });
      } catch (err) {
        console.error(`[FileWatcher] Failed to process ${type} for ${relativePath}:`, err);
      }
    }, 300));
  }

  /**
   * Broadcast event to all WebSocket clients
   */
  private broadcast(event: FileChangeEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Check if file should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    const parts = relativePath.split(path.sep);
    
    // Skip hidden files/folders
    if (parts.some(p => p.startsWith('.'))) return true;
    
    // Skip certain file types
    const ext = path.extname(relativePath).toLowerCase();
    const ignoredExts = ['.md', '.txt', '.log', '.bak', '.tmp'];
    if (ignoredExts.includes(ext)) return true;
    
    return false;
  }

  /**
   * Convert file path to asset ID
   */
  private pathToAssetId(relativePath: string): string {
    return relativePath
      .replace(/[/\\]/g, '_')
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
  }

  /**
   * Check if watcher is active
   */
  isActive(): boolean {
    return this.watcher !== null;
  }
}
