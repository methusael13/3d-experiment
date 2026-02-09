/**
 * DebugTextureManager - Centralized manager for debug texture visualizations
 * 
 * Manages multiple debug texture overlays that stack horizontally from the bottom-left.
 * Supports both depth textures (shadow maps) and float textures (flow maps, heightmaps).
 */

import { GPUContext } from '../GPUContext';
import { DepthTextureVisualizer } from './DepthTextureVisualizer';
import { FloatTextureVisualizer, type FloatTextureColormap } from './FloatTextureVisualizer';

/** Types of textures that can be visualized */
export type DebugTextureType = 'depth' | 'float';

/** Configuration for a registered debug texture */
export interface DebugTextureConfig {
  /** Display name for the texture */
  name: string;
  /** Type of texture visualization */
  type: DebugTextureType;
  /** Whether the texture is currently visible */
  enabled: boolean;
  /** Colormap for float textures (ignored for depth) */
  colormap?: FloatTextureColormap;
  /** Callback to get the current texture view (may change each frame) */
  getTextureView: () => GPUTextureView | null;
}

/** Layout settings for debug thumbnails */
export interface DebugLayoutConfig {
  /** Size of each thumbnail in pixels */
  thumbnailSize: number;
  /** Margin from screen edge */
  margin: number;
  /** Spacing between thumbnails */
  spacing: number;
}

const DEFAULT_LAYOUT: DebugLayoutConfig = {
  thumbnailSize: 200,
  margin: 10,
  spacing: 10,
};

/**
 * Manages debug texture visualizations with automatic horizontal stacking
 */
export class DebugTextureManager {
  private ctx: GPUContext;
  
  // Visualizers
  private depthVisualizer: DepthTextureVisualizer;
  private floatVisualizer: FloatTextureVisualizer;
  
  // Registered textures (ordered by insertion)
  private textures: Map<string, DebugTextureConfig> = new Map();
  
  // Layout configuration
  private layout: DebugLayoutConfig = { ...DEFAULT_LAYOUT };
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.depthVisualizer = new DepthTextureVisualizer(ctx);
    this.floatVisualizer = new FloatTextureVisualizer(ctx);
  }
  
  /**
   * Register a debug texture for visualization
   * 
   * @param name - Unique identifier for the texture
   * @param type - Type of texture ('depth' or 'float')
   * @param getTextureView - Callback that returns the current texture view
   * @param options - Optional configuration (colormap, initial enabled state)
   */
  register(
    name: string,
    type: DebugTextureType,
    getTextureView: () => GPUTextureView | null,
    options: { colormap?: FloatTextureColormap; enabled?: boolean } = {}
  ): void {
    this.textures.set(name, {
      name,
      type,
      enabled: options.enabled ?? false,
      colormap: options.colormap ?? 'grayscale',
      getTextureView,
    });
  }
  
  /**
   * Unregister a debug texture
   */
  unregister(name: string): void {
    this.textures.delete(name);
  }
  
  /**
   * Enable or disable a debug texture visualization
   */
  setEnabled(name: string, enabled: boolean): void {
    const config = this.textures.get(name);
    if (config) {
      config.enabled = enabled;
    }
  }
  
  /**
   * Toggle a debug texture visualization
   */
  toggle(name: string): boolean {
    const config = this.textures.get(name);
    if (config) {
      config.enabled = !config.enabled;
      return config.enabled;
    }
    return false;
  }
  
  /**
   * Check if a debug texture is enabled
   */
  isEnabled(name: string): boolean {
    return this.textures.get(name)?.enabled ?? false;
  }
  
  /**
   * Set colormap for a float texture
   */
  setColormap(name: string, colormap: FloatTextureColormap): void {
    const config = this.textures.get(name);
    if (config && config.type === 'float') {
      config.colormap = colormap;
    }
  }
  
  /**
   * Configure layout settings
   */
  setLayout(config: Partial<DebugLayoutConfig>): void {
    this.layout = { ...this.layout, ...config };
  }
  
  /**
   * Get all registered texture names
   */
  getRegisteredTextures(): string[] {
    return Array.from(this.textures.keys());
  }
  
  /**
   * Get enabled texture names
   */
  getEnabledTextures(): string[] {
    return Array.from(this.textures.entries())
      .filter(([_, config]) => config.enabled)
      .map(([name]) => name);
  }
  
  /**
   * Render all enabled debug textures
   * Textures are stacked horizontally from bottom-left
   * 
   * @param encoder - Command encoder
   * @param targetView - Target texture view to render to
   * @param screenWidth - Screen width in pixels
   * @param screenHeight - Screen height in pixels
   */
  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    screenWidth: number,
    screenHeight: number
  ): void {
    const { thumbnailSize, margin, spacing } = this.layout;
    
    // Calculate position for each enabled texture
    let xOffset = margin;
    
    for (const config of this.textures.values()) {
      if (!config.enabled) continue;
      
      const textureView = config.getTextureView();
      if (!textureView) continue;
      
      // Render based on type
      if (config.type === 'depth') {
        this.depthVisualizer.render(
          encoder,
          targetView,
          textureView,
          xOffset,
          margin, // y from bottom
          thumbnailSize,
          screenWidth,
          screenHeight
        );
      } else if (config.type === 'float') {
        this.floatVisualizer.render(
          encoder,
          targetView,
          textureView,
          xOffset,
          margin, // y from bottom
          thumbnailSize,
          screenWidth,
          screenHeight,
          config.colormap ?? 'grayscale'
        );
      }
      
      // Move to next position
      xOffset += thumbnailSize + spacing;
    }
  }
  
  /**
   * Check if any debug textures are enabled
   */
  hasEnabledTextures(): boolean {
    for (const config of this.textures.values()) {
      if (config.enabled) return true;
    }
    return false;
  }
  
  /**
   * Clear all visualizer caches (call when textures are recreated)
   */
  clearCaches(): void {
    this.depthVisualizer.clearCache();
    this.floatVisualizer.clearCache();
  }
  
  destroy(): void {
    this.depthVisualizer.destroy();
    this.floatVisualizer.destroy();
    this.textures.clear();
  }
}
