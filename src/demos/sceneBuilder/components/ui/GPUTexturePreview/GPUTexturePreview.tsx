/**
 * GPUTexturePreview - Reusable component for displaying GPU textures on a 2D canvas
 * 
 * Reads texture data from GPU to CPU and renders to a canvas element.
 * Supports rgba8unorm and r32float texture formats.
 */

import { useRef, useEffect } from 'preact/hooks';
import type { UnifiedGPUTexture } from '../../../../../core/gpu';
import styles from './GPUTexturePreview.module.css';

export interface GPUTexturePreviewProps {
  /** GPU texture to display (must have COPY_SRC usage) */
  texture: UnifiedGPUTexture | null;
  /** GPU device for readback operations */
  device: GPUDevice | null;
  /** Canvas width in pixels (default: 256) */
  width?: number;
  /** Canvas height in pixels (default: 256) */
  height?: number;
  /** Increment to trigger refresh */
  version?: number;
  /** CSS class for the canvas */
  className?: string;
  /** Placeholder text when no texture */
  placeholder?: string;
  /** Whether to use pixelated rendering (default: true) */
  pixelated?: boolean;
}

/**
 * Read an rgba8unorm GPU texture to a canvas
 */
async function readRGBA8ToCanvas(
  device: GPUDevice,
  texture: UnifiedGPUTexture,
  canvas: HTMLCanvasElement
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = texture.width;
  const height = texture.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256; // Align to 256 bytes
  const bufferSize = bytesPerRow * height;

  // Create staging buffer
  const stagingBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    label: 'texture-preview-staging',
  });

  // Copy texture to buffer
  const encoder = device.createCommandEncoder({ label: 'texture-preview-readback' });
  encoder.copyTextureToBuffer(
    { texture: texture.texture },
    { buffer: stagingBuffer, bytesPerRow },
    { width, height }
  );
  device.queue.submit([encoder.finish()]);

  // Map and read
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(stagingBuffer.getMappedRange());

  // Create ImageData
  const imageData = ctx.createImageData(width, height);
  
  // Copy data row by row (accounting for row alignment)
  for (let y = 0; y < height; y++) {
    const srcOffset = y * bytesPerRow;
    const dstOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const si = srcOffset + x * 4;
      const di = dstOffset + x * 4;
      imageData.data[di + 0] = data[si + 0]; // R
      imageData.data[di + 1] = data[si + 1]; // G
      imageData.data[di + 2] = data[si + 2]; // B
      imageData.data[di + 3] = 255; // Full alpha
    }
  }

  stagingBuffer.unmap();
  stagingBuffer.destroy();

  // Scale to canvas size
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);

  // Draw scaled to preview canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
}

/**
 * Read an r32float GPU texture to a canvas (grayscale)
 */
async function readR32FloatToCanvas(
  device: GPUDevice,
  texture: UnifiedGPUTexture,
  canvas: HTMLCanvasElement
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = texture.width;
  const height = texture.height;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256; // 4 bytes per float, aligned to 256
  const bufferSize = bytesPerRow * height;

  // Create staging buffer
  const stagingBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    label: 'float-texture-preview-staging',
  });

  // Copy texture to buffer
  const encoder = device.createCommandEncoder({ label: 'float-texture-preview-readback' });
  encoder.copyTextureToBuffer(
    { texture: texture.texture },
    { buffer: stagingBuffer, bytesPerRow },
    { width, height }
  );
  device.queue.submit([encoder.finish()]);

  // Map and read
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const floatData = new Float32Array(stagingBuffer.getMappedRange());

  // Create ImageData (grayscale visualization)
  const imageData = ctx.createImageData(width, height);
  const floatsPerRow = bytesPerRow / 4;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * floatsPerRow + x;
      const dstIdx = (y * width + x) * 4;
      
      // Clamp float to 0-1 and convert to 0-255
      const value = Math.max(0, Math.min(1, floatData[srcIdx]));
      const byte = Math.round(value * 255);
      
      imageData.data[dstIdx + 0] = byte; // R
      imageData.data[dstIdx + 1] = byte; // G
      imageData.data[dstIdx + 2] = byte; // B
      imageData.data[dstIdx + 3] = 255;  // A
    }
  }

  stagingBuffer.unmap();
  stagingBuffer.destroy();

  // Scale to canvas size
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);

  // Draw scaled to preview canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
}

export function GPUTexturePreview({
  texture,
  device,
  width = 256,
  height = 256,
  version = 0,
  className,
  placeholder = 'No texture',
  pixelated = true,
}: GPUTexturePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!texture || !device) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;

    const format = texture.format;
    
    const readTexture = async () => {
      try {
        if (format === 'rgba8unorm') {
          await readRGBA8ToCanvas(device, texture, canvas);
        } else if (format === 'r32float') {
          await readR32FloatToCanvas(device, texture, canvas);
        } else {
          console.warn(`[GPUTexturePreview] Unsupported format: ${format}`);
        }
      } catch (err) {
        console.error('[GPUTexturePreview] Failed to read texture:', err);
      }
    };

    readTexture();
  }, [texture, device, version]);

  if (!texture) {
    return (
      <div class={`${styles.placeholder} ${className || ''}`} style={{ width, height }}>
        <span>{placeholder}</span>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      class={`${styles.canvas} ${pixelated ? styles.pixelated : ''} ${className || ''}`}
      width={width}
      height={height}
    />
  );
}

export default GPUTexturePreview;
