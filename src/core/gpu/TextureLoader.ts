/**
 * TextureLoader - Utility for loading images as GPU textures
 * 
 * Provides reusable functions for loading images from URLs, files, or blobs
 * and converting them to WebGPU textures with optional mipmap generation.
 */

import { GPUContext } from './GPUContext';
import { UnifiedGPUTexture } from './GPUTexture';

/**
 * Options for loading a texture
 */
export interface TextureLoadOptions {
  /** Label for the texture (for debugging) */
  label?: string;
  /** Generate mipmaps for the texture */
  generateMipmaps?: boolean;
  /** Texture format (default: rgba8unorm) */
  format?: GPUTextureFormat;
  /** sRGB color space (default: true for albedo textures) */
  sRGB?: boolean;
  /** Flip Y axis when loading (default: false) */
  flipY?: boolean;
}

/**
 * Result of loading a texture
 */
export interface TextureLoadResult {
  texture: UnifiedGPUTexture;
  width: number;
  height: number;
}

/**
 * Load a texture from a URL
 * 
 * @param ctx - GPU context
 * @param url - URL to load the image from
 * @param options - Optional loading options
 * @returns Promise resolving to the loaded texture
 */
export async function loadTextureFromURL(
  ctx: GPUContext,
  url: string,
  options?: TextureLoadOptions
): Promise<TextureLoadResult> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch texture: ${response.status} ${response.statusText}`);
  }
  
  const blob = await response.blob();
  return loadTextureFromBlob(ctx, blob, options);
}

/**
 * Load a texture from a Blob or File
 * 
 * @param ctx - GPU context
 * @param blob - Blob or File containing image data
 * @param options - Optional loading options
 * @returns Promise resolving to the loaded texture
 */
export async function loadTextureFromBlob(
  ctx: GPUContext,
  blob: Blob,
  options?: TextureLoadOptions
): Promise<TextureLoadResult> {
  const imageBitmap = await createImageBitmap(blob, {
    imageOrientation: options?.flipY ? 'flipY' : 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  return loadTextureFromImageBitmap(ctx, imageBitmap, options);
}

/**
 * Load a texture from an HTMLImageElement
 * 
 * @param ctx - GPU context
 * @param image - HTMLImageElement with loaded image
 * @param options - Optional loading options
 * @returns Promise resolving to the loaded texture
 */
export async function loadTextureFromImage(
  ctx: GPUContext,
  image: HTMLImageElement,
  options?: TextureLoadOptions
): Promise<TextureLoadResult> {
  const imageBitmap = await createImageBitmap(image, {
    imageOrientation: options?.flipY ? 'flipY' : 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  return loadTextureFromImageBitmap(ctx, imageBitmap, options);
}

/**
 * Load a texture from an HTMLCanvasElement
 * 
 * @param ctx - GPU context
 * @param canvas - HTMLCanvasElement with drawn content
 * @param options - Optional loading options
 * @returns Promise resolving to the loaded texture
 */
export async function loadTextureFromCanvas(
  ctx: GPUContext,
  canvas: HTMLCanvasElement,
  options?: TextureLoadOptions
): Promise<TextureLoadResult> {
  const imageBitmap = await createImageBitmap(canvas, {
    imageOrientation: options?.flipY ? 'flipY' : 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  return loadTextureFromImageBitmap(ctx, imageBitmap, options);
}

/**
 * Load a texture from an ImageBitmap
 * 
 * @param ctx - GPU context
 * @param imageBitmap - ImageBitmap to upload
 * @param options - Optional loading options
 * @returns The loaded texture
 */
export function loadTextureFromImageBitmap(
  ctx: GPUContext,
  imageBitmap: ImageBitmap,
  options?: TextureLoadOptions
): TextureLoadResult {
  const label = options?.label ?? 'loaded-texture';
  const format = options?.format ?? 'rgba8unorm';
  const generateMipmaps = options?.generateMipmaps ?? true;
  
  // Calculate mip levels if generating mipmaps
  const mipLevelCount = generateMipmaps 
    ? Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1
    : 1;
  
  // Create the GPU texture using the UnifiedGPUTexture API
  const texture = UnifiedGPUTexture.create2D(ctx, {
    label,
    width: imageBitmap.width,
    height: imageBitmap.height,
    format,
    mipLevelCount,
    sampled: true,
    copyDst: true,
    renderTarget: generateMipmaps, // Need render attachment for mipmap generation
  });
  
  // Upload the image data
  ctx.device.queue.copyExternalImageToTexture(
    { source: imageBitmap },
    { texture: texture.texture },
    { width: imageBitmap.width, height: imageBitmap.height }
  );
  
  // Generate mipmaps if requested
  if (generateMipmaps && mipLevelCount > 1) {
    generateMipmapsForTexture(ctx, texture);
  }
  
  return {
    texture,
    width: imageBitmap.width,
    height: imageBitmap.height,
  };
}

/**
 * Generate mipmaps for a texture using blit operations
 * Uses a simple box filter (averaging) for downsampling
 * 
 * @param ctx - GPU context
 * @param texture - Texture to generate mipmaps for
 */
export function generateMipmapsForTexture(
  ctx: GPUContext,
  texture: UnifiedGPUTexture
): void {
  // Simple mipmap generation using blit
  // For each mip level, render from previous level to current using bilinear filtering
  
  const format = texture.format;
  const mipLevelCount = texture.texture.mipLevelCount;
  
  if (mipLevelCount <= 1) return;
  
  // Create pipeline for mipmap generation if not cached
  const pipeline = getMipmapPipeline(ctx, format);
  const sampler = ctx.device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
  });
  
  const encoder = ctx.device.createCommandEncoder({
    label: 'mipmap-generation',
  });
  
  let width = texture.width;
  let height = texture.height;
  
  for (let level = 1; level < mipLevelCount; level++) {
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
    
    const srcView = texture.texture.createView({
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    });
    
    const dstView = texture.texture.createView({
      baseMipLevel: level,
      mipLevelCount: 1,
    });
    
    const bindGroup = ctx.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: srcView },
      ],
    });
    
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }
  
  ctx.queue.submit([encoder.finish()]);
}

// Cache for mipmap generation pipelines (one per format)
const mipmapPipelineCache = new Map<string, GPURenderPipeline>();

/**
 * Get or create a mipmap generation pipeline for a specific format
 */
function getMipmapPipeline(ctx: GPUContext, format: GPUTextureFormat): GPURenderPipeline {
  const key = `mipmap-${format}`;
  
  let pipeline = mipmapPipelineCache.get(key);
  if (pipeline) return pipeline;
  
  const shaderModule = ctx.device.createShaderModule({
    label: 'mipmap-shader',
    code: MIPMAP_SHADER,
  });
  
  pipeline = ctx.device.createRenderPipeline({
    label: `mipmap-pipeline-${format}`,
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });
  
  mipmapPipelineCache.set(key, pipeline);
  return pipeline;
}

/**
 * Shader for mipmap generation (fullscreen triangle with bilinear sampling)
 */
const MIPMAP_SHADER = `
@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle (covers clip space)
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(srcTexture, srcSampler, input.uv);
}
`;

// ============================================================================
// CPU-Side Image Processing Utilities
// ============================================================================

/**
 * Downsample an ImageBitmap to a target size using OffscreenCanvas.
 * Uses high-quality bilinear filtering via the canvas 2D context.
 * 
 * @param source - Source ImageBitmap to downsample
 * @param targetSize - Target size (both width and height)
 * @returns New ImageBitmap at target size (caller must close())
 */
export async function downsampleBitmap(
  source: ImageBitmap,
  targetSize: number
): Promise<ImageBitmap> {
  if (source.width === targetSize && source.height === targetSize) {
    return source;
  }
  
  // Create offscreen canvas for downsampling
  const canvas = new OffscreenCanvas(targetSize, targetSize);
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) {
    throw new Error('Failed to create 2D context for texture downsampling');
  }
  
  // Use high-quality image smoothing
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = 'high';
  
  // Draw source image scaled to target size
  ctx2d.drawImage(source, 0, 0, targetSize, targetSize);
  
  // Create new ImageBitmap from canvas
  return createImageBitmap(canvas);
}

/**
 * Load an ImageBitmap from a URL with optional validation and downsampling.
 * 
 * @param url - URL to load the image from
 * @param options - Loading options
 * @returns ImageBitmap (caller must close()) and original dimensions
 */
export async function loadBitmapFromURL(
  url: string,
  options?: {
    /** Minimum required source size (rejects if smaller) */
    minSize?: number;
    /** Target size to downsample to (if source is larger) */
    targetSize?: number;
    /** Flip Y axis */
    flipY?: boolean;
  }
): Promise<{ bitmap: ImageBitmap; originalWidth: number; originalHeight: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: options?.flipY ? 'flipY' : 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  
  // Validate minimum size if specified
  if (options?.minSize) {
    if (bitmap.width < options.minSize || bitmap.height < options.minSize) {
      bitmap.close();
      throw new Error(
        `Image too small: ${bitmap.width}x${bitmap.height} < ${options.minSize}x${options.minSize}`
      );
    }
  }
  
  // Downsample if target size specified and source is larger
  if (options?.targetSize && (bitmap.width > options.targetSize || bitmap.height > options.targetSize)) {
    const downsampled = await downsampleBitmap(bitmap, options.targetSize);
    bitmap.close();
    return { bitmap: downsampled, originalWidth, originalHeight };
  }
  
  return { bitmap, originalWidth, originalHeight };
}

// ============================================================================
// Texture Array Mipmap Generation
// ============================================================================

/**
 * Generate mipmaps for a specific layer of a texture array.
 * Uses the same blit shader as regular texture mipmap generation.
 * 
 * @param ctx - GPU context
 * @param texture - Texture array (must have RENDER_ATTACHMENT usage)
 * @param layer - Layer index to generate mipmaps for
 */
export function generateMipmapsForTextureArrayLayer(
  ctx: GPUContext,
  texture: GPUTexture,
  layer: number
): void {
  const format = texture.format;
  const mipLevelCount = texture.mipLevelCount;
  
  if (mipLevelCount <= 1) return;
  
  // Get or create mipmap pipeline
  const pipeline = getMipmapPipeline(ctx, format);
  const sampler = ctx.device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
  });
  
  const encoder = ctx.device.createCommandEncoder({
    label: `mipmap-generation-layer-${layer}`,
  });
  
  let width = texture.width;
  let height = texture.height;
  
  for (let level = 1; level < mipLevelCount; level++) {
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
    
    // Create views for the specific layer at each mip level
    const srcView = texture.createView({
      dimension: '2d',
      baseArrayLayer: layer,
      arrayLayerCount: 1,
      baseMipLevel: level - 1,
      mipLevelCount: 1,
    });
    
    const dstView = texture.createView({
      dimension: '2d',
      baseArrayLayer: layer,
      arrayLayerCount: 1,
      baseMipLevel: level,
      mipLevelCount: 1,
    });
    
    const bindGroup = ctx.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: srcView },
      ],
    });
    
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }
  
  ctx.queue.submit([encoder.finish()]);
}

// ============================================================================
// TextureLoader Class
// ============================================================================

/**
 * TextureLoader class - provides a convenient API for texture loading
 */
export class TextureLoader {
  private ctx: GPUContext;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }
  
  /**
   * Load a texture from a URL
   */
  async loadFromURL(url: string, options?: TextureLoadOptions): Promise<TextureLoadResult> {
    return loadTextureFromURL(this.ctx, url, options);
  }
  
  /**
   * Load a texture from a Blob or File
   */
  async loadFromBlob(blob: Blob, options?: TextureLoadOptions): Promise<TextureLoadResult> {
    return loadTextureFromBlob(this.ctx, blob, options);
  }
  
  /**
   * Load a texture from an HTMLImageElement
   */
  async loadFromImage(image: HTMLImageElement, options?: TextureLoadOptions): Promise<TextureLoadResult> {
    return loadTextureFromImage(this.ctx, image, options);
  }
  
  /**
   * Load a texture from an HTMLCanvasElement
   */
  async loadFromCanvas(canvas: HTMLCanvasElement, options?: TextureLoadOptions): Promise<TextureLoadResult> {
    return loadTextureFromCanvas(this.ctx, canvas, options);
  }
  
  /**
   * Load a texture from an ImageBitmap
   */
  loadFromImageBitmap(imageBitmap: ImageBitmap, options?: TextureLoadOptions): TextureLoadResult {
    return loadTextureFromImageBitmap(this.ctx, imageBitmap, options);
  }
  
  /**
   * Downsample an ImageBitmap to a target size
   */
  static async downsampleBitmap(source: ImageBitmap, targetSize: number): Promise<ImageBitmap> {
    return downsampleBitmap(source, targetSize);
  }
  
  /**
   * Load bitmap from URL with optional validation and downsampling
   */
  static async loadBitmapFromURL(
    url: string,
    options?: { minSize?: number; targetSize?: number; flipY?: boolean }
  ): Promise<{ bitmap: ImageBitmap; originalWidth: number; originalHeight: number }> {
    return loadBitmapFromURL(url, options);
  }
  
  /**
   * Generate mipmaps for a texture array layer
   */
  generateMipmapsForTextureArrayLayer(texture: GPUTexture, layer: number): void {
    generateMipmapsForTextureArrayLayer(this.ctx, texture, layer);
  }
}
