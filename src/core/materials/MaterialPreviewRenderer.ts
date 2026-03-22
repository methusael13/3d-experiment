/**
 * MaterialPreviewRenderer - Offscreen WebGPU renderer for material preview
 * 
 * Renders a PBR-lit sphere (or cube/plane) to a 256×256 offscreen render target.
 * The resulting image is copied to an HTMLCanvasElement for display inside
 * the Preview node in the material editor.
 * 
 * Features:
 * - Procedural sphere/cube/plane geometry (no vertex buffers needed)
 * - Full PBR lighting with key + fill lights + hemisphere ambient
 * - Texture sampling for baseColor, normal, metallicRoughness, occlusion, emissive
 * - Reference-counted texture loading via MaterialGPUCache
 * - Debounced rendering (~100ms) on property changes
 */

import { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUTexture } from '../gpu/GPUTexture';
import { UnifiedGPUBuffer } from '../gpu/GPUBuffer';
import { getMaterialGPUCache } from './MaterialGPUCache';
import materialPreviewShader from '../gpu/shaders/material-preview.wgsl?raw';

// ============================================================================
// Types
// ============================================================================

export type PreviewShape = 'sphere' | 'cube' | 'plane';

const SHAPE_INDEX: Record<PreviewShape, number> = {
  sphere: 0,
  cube: 1,
  plane: 2,
};

/** Vertex counts per shape for the draw call */
const SHAPE_VERTEX_COUNT: Record<PreviewShape, number> = {
  sphere: 32 * 32 * 6, // SEGMENTS_U * SEGMENTS_V * 6
  cube: 36,
  plane: 6,
};

/**
 * Material properties resolved from the PBR node + texture connections.
 * This is what the Preview node passes to the renderer.
 */
export interface PreviewMaterialProps {
  albedo: [number, number, number];
  metallic: number;
  roughness: number;
  normalScale: number;
  occlusionStrength: number;
  emissiveFactor: [number, number, number];
  ior: number;
  clearcoatFactor: number;
  clearcoatRoughness: number;
  alphaCutoff: number;
  
  // Texture paths (from Texture Set node connections, or null if not connected)
  baseColorTexPath?: string | null;
  normalTexPath?: string | null;
  metallicRoughnessTexPath?: string | null;
  occlusionTexPath?: string | null;
  emissiveTexPath?: string | null;
  bumpTexPath?: string | null;
  displacementTexPath?: string | null;
  bumpScale?: number;
  displacementScale?: number;
  displacementBias?: number;
}

// ============================================================================
// Renderer
// ============================================================================

const PREVIEW_SIZE = 512;

// Uniform buffer: 6 × vec4f = 96 bytes
const UNIFORM_SIZE = 96;

/**
 * Offscreen material preview renderer.
 * 
 * Usage:
 *   const renderer = new MaterialPreviewRenderer();
 *   await renderer.init(gpuContext);
 *   await renderer.render(materialProps, 'sphere', canvas);
 *   renderer.destroy();
 */
export class MaterialPreviewRenderer {
  private ctx: GPUContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  
  // Offscreen render target
  private colorTarget: UnifiedGPUTexture | null = null;
  private depthTarget: UnifiedGPUTexture | null = null;
  
  // Track which texture paths are currently loaded (for releasing)
  private loadedTexPaths: Set<string> = new Set();
  
  private initialized = false;
  
  /**
   * Initialize the renderer with a GPU context.
   * Creates the pipeline, uniform buffer, render targets, and sampler.
   */
  async init(ctx: GPUContext): Promise<void> {
    if (this.initialized) return;
    
    this.ctx = ctx;
    
    // Init texture cache
    const cache = getMaterialGPUCache();
    cache.init(ctx);
    
    // Create shader module
    const shaderModule = ctx.device.createShaderModule({
      label: 'material-preview-shader',
      code: materialPreviewShader,
    });
    
    // Bind group layout
    this.bindGroupLayout = ctx.device.createBindGroupLayout({
      label: 'material-preview-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // baseColor
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // normal
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // metallicRoughness
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // occlusion
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // emissive
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // bump
        { binding: 8, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // displacement (vertex: offset along normal)
      ],
    });
    
    const pipelineLayout = ctx.device.createPipelineLayout({
      label: 'material-preview-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    // Render pipeline
    this.pipeline = ctx.device.createRenderPipeline({
      label: 'material-preview-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba8unorm',
        }],
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none', // No culling — plane, cube faces need to be visible from all angles
      },
    });
    
    // Uniform buffer
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'material-preview-uniforms',
      size: UNIFORM_SIZE,
    });
    
    // Sampler
    this.sampler = ctx.device.createSampler({
      label: 'material-preview-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    
    // Render targets
    this.colorTarget = UnifiedGPUTexture.create2D(ctx, {
      label: 'material-preview-color',
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      format: 'rgba8unorm',
      renderTarget: true,
      sampled: true,
      copySrc: true,
    });
    
    this.depthTarget = UnifiedGPUTexture.createDepth(
      ctx,
      PREVIEW_SIZE,
      PREVIEW_SIZE,
      'depth24plus',
      'material-preview-depth',
    );
    
    this.initialized = true;
    console.log('[MaterialPreviewRenderer] Initialized');
  }
  
  /**
   * Render a material preview to a canvas element.
   * 
   * @param props Material properties from the PBR node
   * @param shape Preview shape: sphere, cube, or plane
   * @param canvas Target canvas to copy the result into
   */
  async render(props: PreviewMaterialProps, shape: PreviewShape, canvas: HTMLCanvasElement): Promise<void> {
    if (!this.ctx || !this.pipeline || !this.uniformBuffer || !this.colorTarget || !this.depthTarget) {
      console.warn('[MaterialPreviewRenderer] Not initialized');
      return;
    }
    
    const ctx = this.ctx;
    const cache = getMaterialGPUCache();
    
    // Load textures (async, cached)
    const [baseColorTex, normalTex, mrTex, occlusionTex, emissiveTex, bumpTex, dispTex] = await Promise.all([
      this.resolveTexture(props.baseColorTexPath, cache.placeholder),
      this.resolveTexture(props.normalTexPath, cache.normalPlaceholder),
      this.resolveTexture(props.metallicRoughnessTexPath, cache.placeholder),
      this.resolveTexture(props.occlusionTexPath, cache.placeholder),
      this.resolveTexture(props.emissiveTexPath, cache.placeholder),
      this.resolveTexture(props.bumpTexPath, cache.placeholder),
      this.resolveTexture(props.displacementTexPath, cache.placeholder),
    ]);
    
    // Write uniforms
    const uniforms = new Float32Array(24);
    
    // vec4(albedo.rgb, metallic)
    uniforms[0] = props.albedo[0];
    uniforms[1] = props.albedo[1];
    uniforms[2] = props.albedo[2];
    uniforms[3] = props.metallic;
    
    // vec4(roughness, normalScale, occlusionStrength, alphaCutoff)
    uniforms[4] = props.roughness;
    uniforms[5] = props.normalScale;
    uniforms[6] = props.occlusionStrength;
    uniforms[7] = props.alphaCutoff;
    
    // vec4(emissive.rgb, ior)
    uniforms[8] = props.emissiveFactor[0];
    uniforms[9] = props.emissiveFactor[1];
    uniforms[10] = props.emissiveFactor[2];
    uniforms[11] = props.ior;
    
    // vec4(clearcoatFactor, clearcoatRoughness, hasBaseColorTex, hasNormalTex)
    uniforms[12] = props.clearcoatFactor;
    uniforms[13] = props.clearcoatRoughness;
    uniforms[14] = props.baseColorTexPath ? 1.0 : 0.0;
    uniforms[15] = props.normalTexPath ? 1.0 : 0.0;
    
    // vec4(hasMRTex, hasOcclusionTex, hasEmissiveTex, shapeType)
    uniforms[16] = props.metallicRoughnessTexPath ? 1.0 : 0.0;
    uniforms[17] = props.occlusionTexPath ? 1.0 : 0.0;
    uniforms[18] = props.emissiveTexPath ? 1.0 : 0.0;
    uniforms[19] = SHAPE_INDEX[shape];
    
    // vec4(hasBumpTex, bumpScale, hasDisplacementTex, displacementScale)
    uniforms[20] = props.bumpTexPath ? 1.0 : 0.0;
    uniforms[21] = props.bumpScale ?? 1.0;
    uniforms[22] = props.displacementTexPath ? 1.0 : 0.0;
    uniforms[23] = props.displacementScale ?? 0.05;
    
    this.uniformBuffer.write(ctx, uniforms);
    
    // Create bind group
    const bindGroup = ctx.device.createBindGroup({
      label: 'material-preview-bind-group',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer.buffer } },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: baseColorTex.view },
        { binding: 3, resource: normalTex.view },
        { binding: 4, resource: mrTex.view },
        { binding: 5, resource: occlusionTex.view },
        { binding: 6, resource: emissiveTex.view },
        { binding: 7, resource: bumpTex.view },
        { binding: 8, resource: dispTex.view },
      ],
    });
    
    // Render pass
    const encoder = ctx.device.createCommandEncoder({ label: 'material-preview-encoder' });
    
    const pass = encoder.beginRenderPass({
      label: 'material-preview-pass',
      colorAttachments: [{
        view: this.colorTarget.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.12, g: 0.12, b: 0.14, a: 1.0 }, // Dark background
      }],
      depthStencilAttachment: {
        view: this.depthTarget.view,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1.0,
      },
    });
    
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(SHAPE_VERTEX_COUNT[shape]);
    pass.end();
    
    ctx.queue.submit([encoder.finish()]);
    
    // Copy render target to canvas
    await this.copyToCanvas(canvas);
  }
  
  /**
   * Copy the offscreen render target to a visible canvas.
   */
  private async copyToCanvas(canvas: HTMLCanvasElement): Promise<void> {
    if (!this.ctx || !this.colorTarget) return;
    
    // Ensure canvas matches preview size
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    
    const ctx = this.ctx;
    
    // Create a staging buffer to read the texture back
    const bytesPerRow = Math.ceil(PREVIEW_SIZE * 4 / 256) * 256;
    const bufferSize = bytesPerRow * PREVIEW_SIZE;
    
    const stagingBuffer = ctx.device.createBuffer({
      label: 'material-preview-staging',
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    
    const encoder = ctx.device.createCommandEncoder({ label: 'material-preview-copy' });
    encoder.copyTextureToBuffer(
      { texture: this.colorTarget.texture },
      { buffer: stagingBuffer, bytesPerRow, rowsPerImage: PREVIEW_SIZE },
      { width: PREVIEW_SIZE, height: PREVIEW_SIZE },
    );
    ctx.queue.submit([encoder.finish()]);
    
    // Read back the data
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(stagingBuffer.getMappedRange());
    
    // Write to canvas
    const ctx2d = canvas.getContext('2d');
    if (ctx2d) {
      const imageData = ctx2d.createImageData(PREVIEW_SIZE, PREVIEW_SIZE);
      
      // Copy row by row (bytesPerRow may include padding)
      for (let y = 0; y < PREVIEW_SIZE; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * PREVIEW_SIZE * 4;
        for (let x = 0; x < PREVIEW_SIZE; x++) {
          const si = srcOffset + x * 4;
          const di = dstOffset + x * 4;
          imageData.data[di + 0] = data[si + 0]; // R
          imageData.data[di + 1] = data[si + 1]; // G
          imageData.data[di + 2] = data[si + 2]; // B
          imageData.data[di + 3] = data[si + 3]; // A
        }
      }
      
      ctx2d.putImageData(imageData, 0, 0);
    }
    
    stagingBuffer.unmap();
    stagingBuffer.destroy();
  }
  
  /**
   * Resolve a texture path to a GPUTextureView.
   * Returns the cached texture if available, or the placeholder.
   */
  private async resolveTexture(
    path: string | null | undefined,
    placeholder: UnifiedGPUTexture,
  ): Promise<UnifiedGPUTexture> {
    if (!path) return placeholder;
    
    const cache = getMaterialGPUCache();
    
    try {
      // Track loaded path for cleanup
      this.loadedTexPaths.add(path);
      const entry = await cache.acquire(path);
      return entry.texture;
    } catch {
      return placeholder;
    }
  }
  
  /**
   * Release all loaded texture references.
   */
  releaseTextures(): void {
    const cache = getMaterialGPUCache();
    for (const path of this.loadedTexPaths) {
      cache.release(path);
    }
    this.loadedTexPaths.clear();
  }
  
  /**
   * Destroy all GPU resources.
   */
  destroy(): void {
    this.releaseTextures();
    this.colorTarget?.destroy();
    this.depthTarget?.destroy();
    this.uniformBuffer?.destroy();
    this.colorTarget = null;
    this.depthTarget = null;
    this.uniformBuffer = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.sampler = null;
    this.ctx = null;
    this.initialized = false;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let rendererInstance: MaterialPreviewRenderer | null = null;

/**
 * Get the global MaterialPreviewRenderer singleton.
 */
export function getMaterialPreviewRenderer(): MaterialPreviewRenderer {
  if (!rendererInstance) {
    rendererInstance = new MaterialPreviewRenderer();
  }
  return rendererInstance;
}
