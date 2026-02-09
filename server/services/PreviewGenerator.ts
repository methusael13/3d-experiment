/**
 * Preview Generator Service
 * Generates and caches thumbnail previews for assets
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { getDatabase } from '../db/database.js';

// Get project root directory reliably (works with both vite dev and direct node)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const PREVIEW_SIZE = 256;
const CACHE_DIR = path.join(PROJECT_ROOT, '.asset-server', 'previews');

export class PreviewGenerator {
  private rootPath: string;
  private generating = new Set<string>();

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    
    // Ensure cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  /**
   * Get preview path for an asset, generating if needed
   */
  async getPreview(assetId: string): Promise<string | null> {
    const previewPath = path.join(CACHE_DIR, `${assetId}.webp`);
    
    // Check if cached preview exists
    if (fs.existsSync(previewPath)) {
      return `/api/previews/${assetId}.webp`;
    }

    // Get asset from database
    const db = getDatabase();
    const asset = db.getAsset(assetId);
    if (!asset) return null;

    // Find source image
    const sourceImage = this.findSourceImage(asset);
    if (!sourceImage) return null;

    // Generate preview
    await this.generatePreview(assetId, sourceImage);
    
    // Update database with preview path
    db.updatePreviewPath(assetId, `/api/previews/${assetId}.webp`);

    return `/api/previews/${assetId}.webp`;
  }

  /**
   * Generate previews for all assets without one
   */
  async generateAllPreviews(): Promise<{ generated: number; failed: number }> {
    const db = getDatabase();
    const assets = db.getAllAssets();
    let generated = 0;
    let failed = 0;

    for (const asset of assets) {
      if (asset.previewPath) continue;
      
      const sourceImage = this.findSourceImage(asset);
      if (!sourceImage) {
        failed++;
        continue;
      }

      try {
        await this.generatePreview(asset.id, sourceImage);
        
        // Update database with preview path only (doesn't trigger CASCADE delete)
        db.updatePreviewPath(asset.id, `/api/previews/${asset.id}.webp`);
        
        generated++;
      } catch (err) {
        console.warn(`[PreviewGenerator] Failed to generate preview for ${asset.id}:`, err);
        failed++;
      }
    }

    console.log(`[PreviewGenerator] Generated ${generated} previews, ${failed} failed`);
    return { generated, failed };
  }

  /**
   * Generate a preview image
   */
  private async generatePreview(assetId: string, sourcePath: string): Promise<void> {
    // Prevent duplicate generation
    if (this.generating.has(assetId)) return;
    this.generating.add(assetId);

    try {
      const absolutePath = path.join(this.rootPath, sourcePath);
      const outputPath = path.join(CACHE_DIR, `${assetId}.webp`);

      await sharp(absolutePath)
        .resize(PREVIEW_SIZE, PREVIEW_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 80 })
        .toFile(outputPath);

      console.log(`[PreviewGenerator] Generated: ${assetId}`);
    } finally {
      this.generating.delete(assetId);
    }
  }

  /**
   * Find the best source image for preview generation
   */
  private findSourceImage(asset: import('../types/index.js').Asset): string | null {
    // Priority: preview file > albedo/diffuse > any texture > model thumbnail
    const files = asset.files || [];

    // Check for existing preview file
    const previewFile = files.find(f => 
      f.fileType === 'preview' || 
      f.path.toLowerCase().includes('preview') ||
      f.path.toLowerCase().includes('thumb')
    );
    if (previewFile && this.isImageFile(previewFile.path)) {
      return previewFile.path;
    }

    // Check for albedo/diffuse texture
    const albedoFile = files.find(f => {
      const lower = f.path.toLowerCase();
      return (lower.includes('albedo') || lower.includes('diffuse') || lower.includes('basecolor')) &&
        this.isImageFile(f.path);
    });
    if (albedoFile) return albedoFile.path;

    // Check for any texture file
    const textureFile = files.find(f => this.isImageFile(f.path));
    if (textureFile) return textureFile.path;

    // For models, we can't generate preview without WebGL
    // Could later add 3D thumbnail generation

    return null;
  }

  /**
   * Check if file is a supported image format
   */
  private isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tga'].includes(ext);
  }

  /**
   * Delete preview for an asset
   */
  deletePreview(assetId: string): void {
    const previewPath = path.join(CACHE_DIR, `${assetId}.webp`);
    if (fs.existsSync(previewPath)) {
      fs.unlinkSync(previewPath);
      console.log(`[PreviewGenerator] Deleted: ${assetId}`);
    }
  }

  /**
   * Get preview file path for serving
   */
  getPreviewFilePath(filename: string): string | null {
    const filePath = path.join(CACHE_DIR, filename);
    console.log('Preview path is:', filePath);
    return fs.existsSync(filePath) ? filePath : null;
  }
}
