/**
 * AtlasRegionDetector
 * 
 * Detects sprite regions in texture atlases by analyzing the opacity map.
 * Uses connected component labeling to find distinct sprites.
 */

import type { AtlasRegion } from './types';

/**
 * Configuration for region detection.
 */
export interface DetectionConfig {
  /** Minimum opacity value to consider a pixel part of a sprite (0-255) */
  opacityThreshold: number;
  /** Minimum region size in pixels (width * height) */
  minRegionSize: number;
  /** Maximum number of regions to detect */
  maxRegions: number;
  /** Padding to add around detected regions (pixels) */
  padding: number;
  /** Merge regions that are closer than this distance */
  mergeDistance: number;
}

/**
 * Default detection configuration.
 */
export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  opacityThreshold: 32,  // ~12.5% opacity
  minRegionSize: 100,    // At least 10x10 pixels
  maxRegions: 64,
  padding: 2,
  mergeDistance: 5,
};

/**
 * Result of region detection.
 */
export interface DetectionResult {
  /** Detected regions */
  regions: AtlasRegion[];
  /** Atlas dimensions */
  atlasSize: [number, number];
  /** Detection statistics */
  stats: {
    totalPixels: number;
    opaquePixels: number;
    rawRegionsFound: number;
    mergedRegions: number;
    filteredRegions: number;
  };
}

/**
 * Detects sprite regions from an opacity map image.
 * 
 * Algorithm:
 * 1. Load image and extract opacity values
 * 2. Threshold to create binary mask
 * 3. Find connected components using flood fill
 * 4. Extract bounding boxes for each component
 * 5. Merge nearby regions
 * 6. Filter by size
 */
export class AtlasRegionDetector {
  private config: DetectionConfig;

  constructor(config: Partial<DetectionConfig> = {}) {
    this.config = { ...DEFAULT_DETECTION_CONFIG, ...config };
  }

  /**
   * Detect regions from an opacity image URL.
   */
  async detectFromUrl(opacityUrl: string): Promise<DetectionResult> {
    const imageData = await this.loadImage(opacityUrl);
    return this.detectFromImageData(imageData);
  }

  /**
   * Detect regions from ImageData.
   */
  detectFromImageData(imageData: ImageData): DetectionResult {
    const { width, height, data } = imageData;
    
    // Extract opacity channel (assuming grayscale or using alpha)
    const opacity = this.extractOpacity(data, width, height);
    
    // Create binary mask
    const mask = this.createBinaryMask(opacity, width, height);
    
    // Find connected components
    const components = this.findConnectedComponents(mask, width, height);
    
    // Extract bounding boxes
    let regions = this.extractBoundingBoxes(components, width, height);
    
    const rawRegionsFound = regions.length;
    
    // Merge nearby regions
    regions = this.mergeNearbyRegions(regions);
    const mergedRegions = regions.length;
    
    // Filter by size
    regions = regions.filter(r => 
      r.width * r.height >= this.config.minRegionSize
    );
    
    // Limit count
    if (regions.length > this.config.maxRegions) {
      // Sort by size (largest first) and take top N
      regions.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      regions = regions.slice(0, this.config.maxRegions);
    }
    
    // Add padding
    regions = this.addPadding(regions, width, height);
    
    // Sort by position (top-left to bottom-right)
    regions.sort((a, b) => {
      const rowA = Math.floor(a.v / 100);
      const rowB = Math.floor(b.v / 100);
      if (rowA !== rowB) return rowA - rowB;
      return a.u - b.u;
    });
    
    // Calculate stats
    const opaquePixels = opacity.filter(v => v >= this.config.opacityThreshold).length;
    
    return {
      regions,
      atlasSize: [width, height],
      stats: {
        totalPixels: width * height,
        opaquePixels,
        rawRegionsFound,
        mergedRegions,
        filteredRegions: regions.length,
      },
    };
  }

  /**
   * Load an image from URL and return ImageData.
   */
  private async loadImage(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }
        
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      };
      
      img.onerror = () => {
        reject(new Error(`Failed to load image: ${url}`));
      };
      
      img.src = url;
    });
  }

  /**
   * Extract opacity values from image data.
   * For grayscale images, uses the red channel.
   * For RGBA, uses the alpha channel if present.
   */
  private extractOpacity(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
    const opacity = new Uint8Array(width * height);
    
    for (let i = 0; i < width * height; i++) {
      const base = i * 4;
      const r = data[base];
      const g = data[base + 1];
      const b = data[base + 2];
      const a = data[base + 3];
      
      // For opacity maps: if image has transparency, use alpha
      // Otherwise use luminance (grayscale)
      if (a < 255) {
        // Use alpha channel
        opacity[i] = a;
      } else {
        // Use luminance (grayscale approximation)
        opacity[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    
    return opacity;
  }

  /**
   * Create binary mask from opacity values.
   */
  private createBinaryMask(opacity: Uint8Array, width: number, height: number): Uint8Array {
    const mask = new Uint8Array(width * height);
    const threshold = this.config.opacityThreshold;
    
    for (let i = 0; i < opacity.length; i++) {
      mask[i] = opacity[i] >= threshold ? 1 : 0;
    }
    
    return mask;
  }

  /**
   * Find connected components using flood fill.
   * Returns label array where each pixel has its component ID.
   */
  private findConnectedComponents(
    mask: Uint8Array,
    width: number,
    height: number
  ): Int32Array {
    const labels = new Int32Array(width * height);
    let nextLabel = 1;
    
    const getIndex = (x: number, y: number) => y * width + x;
    
    // Flood fill function
    const floodFill = (startX: number, startY: number, label: number) => {
      const stack: [number, number][] = [[startX, startY]];
      
      while (stack.length > 0) {
        const [x, y] = stack.pop()!;
        const idx = getIndex(x, y);
        
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        if (mask[idx] === 0 || labels[idx] !== 0) continue;
        
        labels[idx] = label;
        
        // 4-connectivity (up, down, left, right)
        stack.push([x - 1, y]);
        stack.push([x + 1, y]);
        stack.push([x, y - 1]);
        stack.push([x, y + 1]);
      }
    };
    
    // Scan image and flood fill each unlabeled opaque pixel
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = getIndex(x, y);
        if (mask[idx] === 1 && labels[idx] === 0) {
          floodFill(x, y, nextLabel);
          nextLabel++;
        }
      }
    }
    
    return labels;
  }

  /**
   * Extract bounding boxes from labeled components.
   */
  private extractBoundingBoxes(
    labels: Int32Array,
    width: number,
    height: number
  ): AtlasRegion[] {
    // Find unique labels
    const labelSet = new Set<number>();
    for (const label of labels) {
      if (label > 0) labelSet.add(label);
    }
    
    // Calculate bounding box for each label
    const boxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
    
    for (const label of labelSet) {
      boxes.set(label, {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      });
    }
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const label = labels[y * width + x];
        if (label > 0) {
          const box = boxes.get(label)!;
          box.minX = Math.min(box.minX, x);
          box.minY = Math.min(box.minY, y);
          box.maxX = Math.max(box.maxX, x);
          box.maxY = Math.max(box.maxY, y);
        }
      }
    }
    
    // Convert to AtlasRegion
    const regions: AtlasRegion[] = [];
    for (const box of boxes.values()) {
      regions.push({
        u: box.minX,
        v: box.minY,
        width: box.maxX - box.minX + 1,
        height: box.maxY - box.minY + 1,
      });
    }
    
    return regions;
  }

  /**
   * Merge regions that are close together.
   */
  private mergeNearbyRegions(regions: AtlasRegion[]): AtlasRegion[] {
    if (regions.length <= 1) return regions;
    
    const distance = this.config.mergeDistance;
    const merged: AtlasRegion[] = [];
    const used = new Set<number>();
    
    const overlaps = (a: AtlasRegion, b: AtlasRegion): boolean => {
      // Check if regions are within merge distance
      const aRight = a.u + a.width + distance;
      const aBottom = a.v + a.height + distance;
      const bRight = b.u + b.width + distance;
      const bBottom = b.v + b.height + distance;
      
      return !(a.u - distance > bRight ||
               b.u - distance > aRight ||
               a.v - distance > bBottom ||
               b.v - distance > aBottom);
    };
    
    const mergeTwo = (a: AtlasRegion, b: AtlasRegion): AtlasRegion => {
      const minU = Math.min(a.u, b.u);
      const minV = Math.min(a.v, b.v);
      const maxU = Math.max(a.u + a.width, b.u + b.width);
      const maxV = Math.max(a.v + a.height, b.v + b.height);
      
      return {
        u: minU,
        v: minV,
        width: maxU - minU,
        height: maxV - minV,
      };
    };
    
    // Iteratively merge overlapping regions
    let changed = true;
    let current = [...regions];
    
    while (changed) {
      changed = false;
      const next: AtlasRegion[] = [];
      const usedInPass = new Set<number>();
      
      for (let i = 0; i < current.length; i++) {
        if (usedInPass.has(i)) continue;
        
        let region = current[i];
        
        for (let j = i + 1; j < current.length; j++) {
          if (usedInPass.has(j)) continue;
          
          if (overlaps(region, current[j])) {
            region = mergeTwo(region, current[j]);
            usedInPass.add(j);
            changed = true;
          }
        }
        
        next.push(region);
        usedInPass.add(i);
      }
      
      current = next;
    }
    
    return current;
  }

  /**
   * Add padding to regions while staying within bounds.
   */
  private addPadding(
    regions: AtlasRegion[],
    atlasWidth: number,
    atlasHeight: number
  ): AtlasRegion[] {
    const padding = this.config.padding;
    
    return regions.map(r => ({
      u: Math.max(0, r.u - padding),
      v: Math.max(0, r.v - padding),
      width: Math.min(atlasWidth - Math.max(0, r.u - padding), r.width + padding * 2),
      height: Math.min(atlasHeight - Math.max(0, r.v - padding), r.height + padding * 2),
    }));
  }

  /**
   * Update detection configuration.
   */
  setConfig(config: Partial<DetectionConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Get current configuration.
   */
  getConfig(): DetectionConfig {
    return { ...this.config };
  }
}

/**
 * Singleton instance for convenience.
 */
let defaultDetector: AtlasRegionDetector | null = null;

/**
 * Get or create the default detector instance.
 */
export function getAtlasRegionDetector(): AtlasRegionDetector {
  if (!defaultDetector) {
    defaultDetector = new AtlasRegionDetector();
  }
  return defaultDetector;
}

/**
 * Convenience function to detect regions from URL.
 */
export async function detectAtlasRegions(
  opacityUrl: string,
  config?: Partial<DetectionConfig>
): Promise<DetectionResult> {
  const detector = config 
    ? new AtlasRegionDetector(config)
    : getAtlasRegionDetector();
  return detector.detectFromUrl(opacityUrl);
}
