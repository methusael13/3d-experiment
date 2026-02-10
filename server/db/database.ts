/**
 * SQLite Database Service
 * Handles database initialization, schema, and queries
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Asset, AssetMetadata, AssetFile, AssetQuery } from '../types/index.js';

const DB_PATH = path.join(process.cwd(), '.asset-server', 'assets.db');
const CACHE_DIR = path.join(process.cwd(), '.asset-server', 'previews');

export class AssetDatabase {
  private db: Database.Database;

  constructor() {
    // Ensure directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Core asset table
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT,
        subtype TEXT,
        path TEXT NOT NULL,
        metadata_path TEXT,
        preview_path TEXT,
        file_size INTEGER DEFAULT 0,
        modified_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      -- Tags for categorization
      CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag)
      );

      -- Metadata extracted from JSON
      CREATE TABLE IF NOT EXISTS asset_metadata (
        asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
        biome TEXT,
        physical_size TEXT,
        resolution TEXT,
        has_billboard INTEGER DEFAULT 0,
        has_lod INTEGER DEFAULT 0,
        lod_count INTEGER DEFAULT 0,
        variant_count INTEGER DEFAULT 1,
        latin_name TEXT,
        average_color TEXT,
        raw_json TEXT
      );

      -- Individual files within an asset
      CREATE TABLE IF NOT EXISTS asset_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
        file_type TEXT,
        file_sub_type TEXT,
        lod_level INTEGER,
        resolution TEXT,
        format TEXT,
        path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
      CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
      CREATE INDEX IF NOT EXISTS idx_assets_subtype ON assets(subtype);
      CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_metadata_biome ON asset_metadata(biome);
      CREATE INDEX IF NOT EXISTS idx_files_asset ON asset_files(asset_id);
    `);
  }

  // ========== Asset Operations ==========

  insertAsset(asset: Omit<Asset, 'metadata' | 'files' | 'tags'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO assets (id, name, type, category, subtype, path, metadata_path, preview_path, file_size, modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      asset.id, asset.name, asset.type, asset.category, asset.subtype,
      asset.path, asset.metadataPath, asset.previewPath,
      asset.fileSize, asset.modifiedAt
    );
  }

  deleteAsset(id: string): void {
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  updatePreviewPath(assetId: string, previewPath: string): void {
    this.db.prepare('UPDATE assets SET preview_path = ? WHERE id = ?').run(previewPath, assetId);
  }

  getAsset(id: string): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToAsset(row);
  }

  getAllAssets(): Asset[] {
    const rows = this.db.prepare('SELECT * FROM assets ORDER BY name').all() as any[];
    return rows.map(r => this.rowToAsset(r));
  }

  getAllAssetFiles(): AssetFile[] {
    const rows = this.db.prepare('SELECT * FROM asset_files').all() as any[];
    return rows.map(r => this.rowToAssetFile(r));
  }

  queryAssets(query: AssetQuery): Asset[] {
    let sql = 'SELECT DISTINCT a.* FROM assets a';
    const params: any[] = [];
    const conditions: string[] = [];

    if (query.biome || query.search) {
      sql += ' LEFT JOIN asset_metadata m ON a.id = m.asset_id';
    }
    if (query.tag) {
      sql += ' LEFT JOIN asset_tags t ON a.id = t.asset_id';
    }

    if (query.type) {
      conditions.push('a.type = ?');
      params.push(query.type);
    }
    if (query.category) {
      conditions.push('a.category = ?');
      params.push(query.category);
    }
    if (query.subtype) {
      conditions.push('a.subtype = ?');
      params.push(query.subtype);
    }
    if (query.biome) {
      conditions.push('m.biome = ?');
      params.push(query.biome);
    }
    if (query.tag) {
      conditions.push('t.tag LIKE ?');
      params.push(`%${query.tag}%`);
    }
    if (query.hasLod !== undefined) {
      sql += query.biome ? '' : ' LEFT JOIN asset_metadata m ON a.id = m.asset_id';
      conditions.push('m.has_lod = ?');
      params.push(query.hasLod ? 1 : 0);
    }
    if (query.hasBillboard !== undefined) {
      if (!query.hasLod) sql += ' LEFT JOIN asset_metadata m ON a.id = m.asset_id';
      conditions.push('m.has_billboard = ?');
      params.push(query.hasBillboard ? 1 : 0);
    }
    if (query.search) {
      conditions.push('(a.name LIKE ? OR m.latin_name LIKE ?)');
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY a.name';

    return this.db.prepare(sql).all(...params).map((r: any) => this.rowToAsset(r));
  }

  // ========== Metadata Operations ==========

  insertMetadata(assetId: string, meta: AssetMetadata): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO asset_metadata 
      (asset_id, biome, physical_size, resolution, has_billboard, has_lod, lod_count, variant_count, latin_name, average_color, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Ensure all values are SQLite-compatible types (numbers, strings, bigints, buffers, null)
    const biome = typeof meta.biome === 'string' ? meta.biome : null;
    const physicalSize = typeof meta.physicalSize === 'string' ? meta.physicalSize : null;
    const resolution = typeof meta.resolution === 'string' ? meta.resolution : null;
    const hasBillboard = meta.hasBillboard === true ? 1 : 0;
    const hasLod = meta.hasLod === true ? 1 : 0;
    const lodCount = typeof meta.lodCount === 'number' ? meta.lodCount : 0;
    const variantCount = typeof meta.variantCount === 'number' ? meta.variantCount : 1;
    const latinName = typeof meta.latinName === 'string' ? meta.latinName : null;
    const averageColor = typeof meta.averageColor === 'string' ? meta.averageColor : null;
    const rawJson = meta.rawJson && typeof meta.rawJson === 'object' ? JSON.stringify(meta.rawJson) : null;
    
    stmt.run(assetId, biome, physicalSize, resolution, hasBillboard, hasLod, lodCount, variantCount, latinName, averageColor, rawJson);
  }

  getMetadata(assetId: string): AssetMetadata | null {
    const row = this.db.prepare('SELECT * FROM asset_metadata WHERE asset_id = ?').get(assetId) as any;
    if (!row) return null;
    return {
      biome: row.biome,
      physicalSize: row.physical_size,
      resolution: row.resolution,
      hasBillboard: row.has_billboard === 1,
      hasLod: row.has_lod === 1,
      lodCount: row.lod_count,
      variantCount: row.variant_count,
      latinName: row.latin_name,
      averageColor: row.average_color,
      rawJson: row.raw_json ? JSON.parse(row.raw_json) : null,
    };
  }

  // ========== Tags Operations ==========

  setTags(assetId: string, tags: string[]): void {
    this.db.prepare('DELETE FROM asset_tags WHERE asset_id = ?').run(assetId);
    const stmt = this.db.prepare('INSERT INTO asset_tags (asset_id, tag) VALUES (?, ?)');
    for (const tag of tags) {
      stmt.run(assetId, tag);
    }
  }

  getTags(assetId: string): string[] {
    const rows = this.db.prepare('SELECT tag FROM asset_tags WHERE asset_id = ?').all(assetId) as any[];
    return rows.map(r => r.tag);
  }

  // ========== Files Operations ==========

  insertFile(file: Omit<AssetFile, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO asset_files (asset_id, file_type, file_sub_type, lod_level, resolution, format, path, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      file.assetId, file.fileType, file.fileSubType, file.lodLevel,
      file.resolution, file.format, file.path, file.fileSize
    );
    return Number(result.lastInsertRowid);
  }

  clearFiles(assetId: string): void {
    this.db.prepare('DELETE FROM asset_files WHERE asset_id = ?').run(assetId);
  }

  getFiles(assetId: string): AssetFile[] {
    const rows = this.db.prepare('SELECT * FROM asset_files WHERE asset_id = ? ORDER BY lod_level').all(assetId) as any[];
    return rows.map(r => this.rowToAssetFile(r));
  }

  // ========== Stats ==========

  getStats(): { total: number; byType: Record<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM assets').get() as any).count;
    const byType = this.db.prepare('SELECT type, COUNT(*) as count FROM assets GROUP BY type').all() as any[];
    return {
      total,
      byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
    };
  }

  // ========== Transaction ==========

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ========== Helpers ==========

  private rowToAsset(row: any): Asset {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      category: row.category,
      subtype: row.subtype,
      path: row.path,
      metadataPath: row.metadata_path,
      previewPath: row.preview_path,
      fileSize: row.file_size,
      modifiedAt: row.modified_at,
      createdAt: row.created_at,
      metadata: this.getMetadata(row.id),
      files: this.getFiles(row.id),
      tags: this.getTags(row.id),
    };
  }

  private rowToAssetFile(row: any): AssetFile {
    return {
      id: row.id,
      assetId: row.asset_id,
      fileType: row.file_type,
      fileSubType: row.file_sub_type,
      lodLevel: row.lod_level,
      resolution: row.resolution,
      format: row.format,
      path: row.path,
      fileSize: row.file_size
    }
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: AssetDatabase | null = null;

export function getDatabase(): AssetDatabase {
  if (!dbInstance) {
    dbInstance = new AssetDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
