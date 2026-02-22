/**
 * AtlasTextureCompositor
 * 
 * Combines separate albedo (baseColor) and opacity textures into a single
 * RGBA GPU texture suitable for billboard rendering with alpha cutout.
 * 
 * Input:
 *   - baseColorPath: RGB albedo texture (vegetation color)
 *   - opacityPath: grayscale opacity texture (white = opaque, black = transparent)
 * 
 * Output:
 *   - Single RGBA GPU texture where RGB = baseColor, A = opacity
 * 
 * Uses an offscreen canvas to composite the two images before GPU upload.
 * Results are cached by a composite key of both paths.
 */

import { GPUContext, UnifiedGPUTexture } from '../gpu';

// Cache composited textures by "baseColor|opacity" key
const compositeCache = new Map<string, UnifiedGPUTexture>();

/**
 * Load an image from a URL path and return an ImageBitmap.
 */
async function loadImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${url} (${response.status})`);
  }
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Composite albedo + opacity into a single RGBA ImageData.
 * 
 * @param albedo - RGB base color image
 * @param opacity - Grayscale opacity image (R channel used as alpha)
 * @returns RGBA ImageData at the albedo's dimensions
 */
function compositeAlbedoOpacity(albedo: ImageBitmap, opacity: ImageBitmap): ImageData {
  const width = albedo.width;
  const height = albedo.height;
  
  // Draw albedo to get RGB pixels
  const albedoCanvas = new OffscreenCanvas(width, height);
  const albedoCtx = albedoCanvas.getContext('2d')!;
  albedoCtx.drawImage(albedo, 0, 0, width, height);
  const albedoData = albedoCtx.getImageData(0, 0, width, height);
  
  // Draw opacity (may be different size — scale to match albedo)
  const opacityCanvas = new OffscreenCanvas(width, height);
  const opacityCtx = opacityCanvas.getContext('2d')!;
  opacityCtx.drawImage(opacity, 0, 0, width, height);
  const opacityData = opacityCtx.getImageData(0, 0, width, height);
  
  // Composite: RGB from albedo, A from opacity's R channel
  const pixels = albedoData.data; // Uint8ClampedArray [R,G,B,A, R,G,B,A, ...]
  const opacityPixels = opacityData.data;
  
  for (let i = 0; i < pixels.length; i += 4) {
    // RGB stays from albedo (already there)
    // A comes from opacity's R channel (grayscale — R=G=B)
    pixels[i + 3] = opacityPixels[i]; // Use R channel as alpha
  }
  
  return albedoData;
}

/**
 * Load and composite albedo + opacity textures into a single RGBA GPU texture.
 * Results are cached by the combination of both paths.
 * 
 * @param ctx - GPU context
 * @param baseColorPath - Path to the albedo/base color texture
 * @param opacityPath - Path to the opacity/alpha texture
 * @returns RGBA GPU texture with color from albedo and alpha from opacity
 */
export async function loadCompositeAtlasTexture(
  ctx: GPUContext,
  baseColorPath: string,
  opacityPath: string,
): Promise<UnifiedGPUTexture> {
  const cacheKey = `${baseColorPath}|${opacityPath}`;
  
  // Check cache
  const cached = compositeCache.get(cacheKey);
  if (cached) return cached;
  
  // Load both images in parallel
  const [albedoBitmap, opacityBitmap] = await Promise.all([
    loadImage(baseColorPath),
    loadImage(opacityPath),
  ]);
  
  // Composite into RGBA
  const composited = compositeAlbedoOpacity(albedoBitmap, opacityBitmap);
  
  // Create GPU texture
  const width = composited.width;
  const height = composited.height;
  
  const texture = UnifiedGPUTexture.create2D(ctx, {
    label: `atlas-composite-${baseColorPath}`,
    width,
    height,
    format: 'rgba8unorm',
    sampled: true,
  });
  
  // Upload pixel data
  ctx.queue.writeTexture(
    { texture: texture.texture },
    composited.data,
    { bytesPerRow: width * 4 },
    [width, height, 1],
  );
  
  // Cleanup bitmaps
  albedoBitmap.close();
  opacityBitmap.close();
  
  // Cache the result
  compositeCache.set(cacheKey, texture);
  
  console.log(`[AtlasTextureCompositor] Composited ${width}x${height} atlas from "${baseColorPath}" + "${opacityPath}"`);
  
  return texture;
}

/**
 * Clear the composite texture cache.
 * Call when vegetation system is destroyed.
 */
export function clearCompositeCache(): void {
  for (const tex of compositeCache.values()) {
    tex.destroy();
  }
  compositeCache.clear();
}