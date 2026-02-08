/**
 * GPUTexture - Texture and sampler management for WebGPU
 * Supports 2D textures, cube maps, depth textures, and render targets
 */

import { GPUContext } from './GPUContext';

/** Texture dimension types */
export type TextureDimension = '1d' | '2d' | '3d';

/** Common texture formats */
export type CommonTextureFormat =
  | 'rgba8unorm'
  | 'rgba8snorm'
  | 'rgba16float'
  | 'rgba32float'
  | 'r32float'
  | 'rg32float'
  | 'depth24plus'
  | 'depth32float'
  | 'depth24plus-stencil8';

/** Options for texture creation */
export interface GPUTextureOptions {
  /** Texture label for debugging */
  label?: string;
  /** Texture width */
  width: number;
  /** Texture height */
  height: number;
  /** Texture depth (for 3D textures) or array layers */
  depthOrArrayLayers?: number;
  /** Texture format */
  format?: GPUTextureFormat;
  /** Number of mip levels (1 = no mipmaps) */
  mipLevelCount?: number;
  /** Sample count for multisampling */
  sampleCount?: number;
  /** Texture dimension */
  dimension?: TextureDimension;
  /** Whether texture is used as render target */
  renderTarget?: boolean;
  /** Whether texture is used for sampling */
  sampled?: boolean;
  /** Whether texture is used for storage (compute) */
  storage?: boolean;
  /** Whether texture can be copied to */
  copyDst?: boolean;
  /** Whether texture can be copied from */
  copySrc?: boolean;
}

/** Options for sampler creation */
export interface GPUSamplerOptions {
  /** Sampler label for debugging */
  label?: string;
  /** Address mode for U coordinate */
  addressModeU?: GPUAddressMode;
  /** Address mode for V coordinate */
  addressModeV?: GPUAddressMode;
  /** Address mode for W coordinate */
  addressModeW?: GPUAddressMode;
  /** Magnification filter */
  magFilter?: GPUFilterMode;
  /** Minification filter */
  minFilter?: GPUFilterMode;
  /** Mipmap filter */
  mipmapFilter?: GPUMipmapFilterMode;
  /** LOD clamp minimum */
  lodMinClamp?: number;
  /** LOD clamp maximum */
  lodMaxClamp?: number;
  /** Comparison function for depth textures */
  compare?: GPUCompareFunction;
  /** Maximum anisotropy */
  maxAnisotropy?: number;
}

// Mipmap generation pipeline (lazily created, shared across all textures)
let mipmapPipeline: GPURenderPipeline | null = null;
let mipmapSampler: GPUSampler | null = null;

// Mipmap shader (simple box filter downsample)
const MIPMAP_SHADER = `
  @group(0) @binding(0) var srcTexture: texture_2d<f32>;
  @group(0) @binding(1) var srcSampler: sampler;

  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
  }

  @vertex
  fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Full-screen triangle
    var output: VertexOutput;
    let x = f32((vertexIndex << 1u) & 2u);
    let y = f32(vertexIndex & 2u);
    output.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    output.uv = vec2f(x, y);
    return output;
  }

  @fragment
  fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(srcTexture, srcSampler, input.uv);
  }
`;

/**
 * Get or create the mipmap generation pipeline
 */
function getMipmapPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  if (mipmapPipeline && mipmapSampler) {
    return mipmapPipeline;
  }

  const shaderModule = device.createShaderModule({
    label: 'mipmap-shader',
    code: MIPMAP_SHADER,
  });

  mipmapSampler = device.createSampler({
    label: 'mipmap-sampler',
    minFilter: 'linear',
    magFilter: 'linear',
  });

  const bindGroupLayout = device.createBindGroupLayout({
    label: 'mipmap-bind-group-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: 'mipmap-pipeline-layout',
    bindGroupLayouts: [bindGroupLayout],
  });

  mipmapPipeline = device.createRenderPipeline({
    label: 'mipmap-pipeline',
    layout: pipelineLayout,
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

  return mipmapPipeline;
}

/**
 * Unified GPU texture class
 */
export class UnifiedGPUTexture {
  private _texture: GPUTexture;
  private _view: GPUTextureView;
  private _format: GPUTextureFormat;
  private _width: number;
  private _height: number;
  private _depthOrArrayLayers: number;
  private _mipLevelCount: number;
  private _label: string;

  private constructor(
    texture: GPUTexture,
    view: GPUTextureView,
    format: GPUTextureFormat,
    width: number,
    height: number,
    depthOrArrayLayers: number,
    mipLevelCount: number,
    label: string
  ) {
    this._texture = texture;
    this._view = view;
    this._format = format;
    this._width = width;
    this._height = height;
    this._depthOrArrayLayers = depthOrArrayLayers;
    this._mipLevelCount = mipLevelCount;
    this._label = label;
  }

  /**
   * Create a 2D texture
   */
  static create2D(ctx: GPUContext, options: GPUTextureOptions): UnifiedGPUTexture {
    const {
      label = 'texture-2d',
      width,
      height,
      format = 'rgba8unorm',
      mipLevelCount = 1,
      sampleCount = 1,
      renderTarget = false,
      sampled = true,
      storage = false,
      copyDst = true,
      copySrc = false,
    } = options;

    let usage = 0;
    if (renderTarget) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
    if (sampled) usage |= GPUTextureUsage.TEXTURE_BINDING;
    if (storage) usage |= GPUTextureUsage.STORAGE_BINDING;
    if (copyDst) usage |= GPUTextureUsage.COPY_DST;
    if (copySrc) usage |= GPUTextureUsage.COPY_SRC;

    const texture = ctx.device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      mipLevelCount,
      sampleCount,
      dimension: '2d',
      usage,
    });

    const view = texture.createView({
      label: `${label}-view`,
      dimension: '2d',
    });

    return new UnifiedGPUTexture(texture, view, format, width, height, 1, mipLevelCount, label);
  }

  /**
   * Create a depth texture
   */
  static createDepth(
    ctx: GPUContext,
    width: number,
    height: number,
    format: GPUTextureFormat = 'depth24plus',
    label = 'depth-texture'
  ): UnifiedGPUTexture {
    const texture = ctx.device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    const view = texture.createView({
      label: `${label}-view`,
      dimension: '2d',
      aspect: 'depth-only',
    });

    return new UnifiedGPUTexture(texture, view, format, width, height, 1, 1, label);
  }

  /**
   * Create a storage texture for compute shaders
   */
  static createStorage(
    ctx: GPUContext,
    width: number,
    height: number,
    format: GPUTextureFormat = 'rgba32float',
    label = 'storage-texture'
  ): UnifiedGPUTexture {
    const texture = ctx.device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    const view = texture.createView({
      label: `${label}-view`,
      dimension: '2d',
    });

    return new UnifiedGPUTexture(texture, view, format, width, height, 1, 1, label);
  }

  /**
   * Create a render target texture
   */
  static createRenderTarget(
    ctx: GPUContext,
    width: number,
    height: number,
    format?: GPUTextureFormat,
    sampleCount = 1,
    label = 'render-target'
  ): UnifiedGPUTexture {
    const textureFormat = format || ctx.format;
    
    const texture = ctx.device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format: textureFormat,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const view = texture.createView({
      label: `${label}-view`,
    });

    return new UnifiedGPUTexture(texture, view, textureFormat, width, height, 1, 1, label);
  }

  /**
   * Create a heightmap texture (r32float format, optimized for terrain)
   * @param generateMipmaps - If true, creates texture with mipmap levels for LOD
   */
  static createHeightmap(
    ctx: GPUContext,
    width: number,
    height: number,
    label = 'heightmap',
    generateMipmaps = false
  ): UnifiedGPUTexture {
    // Calculate mip level count if requested
    const mipLevelCount = generateMipmaps 
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;
    
    return UnifiedGPUTexture.create2D(ctx, {
      label,
      width,
      height,
      format: 'r32float',
      mipLevelCount,
      sampled: true,
      storage: true,
      copyDst: true,
      copySrc: true,
    });
  }

  /**
   * Create a cube map texture
   */
  static createCubeMap(
    ctx: GPUContext,
    size: number,
    format: GPUTextureFormat = 'rgba8unorm',
    mipLevelCount = 1,
    label = 'cubemap'
  ): UnifiedGPUTexture {
    const texture = ctx.device.createTexture({
      label,
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const view = texture.createView({
      label: `${label}-view`,
      dimension: 'cube',
    });

    return new UnifiedGPUTexture(texture, view, format, size, size, 6, mipLevelCount, label);
  }

  /**
   * Upload image data to the texture
   */
  uploadData(
    ctx: GPUContext,
    data: ArrayBuffer | Uint8Array | Float32Array | Uint16Array | Uint32Array,
    bytesPerRow?: number,
    rowsPerImage?: number
  ): void {
    const calculatedBytesPerRow = bytesPerRow || this.getBytesPerRow();
    
    ctx.queue.writeTexture(
      { texture: this._texture },
      data as ArrayBuffer,
      { bytesPerRow: calculatedBytesPerRow, rowsPerImage: rowsPerImage || this._height },
      { width: this._width, height: this._height, depthOrArrayLayers: this._depthOrArrayLayers }
    );
  }

  /**
   * Upload an ImageBitmap to the texture
   */
  uploadImageBitmap(ctx: GPUContext, bitmap: ImageBitmap): void {
    ctx.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this._texture },
      { width: bitmap.width, height: bitmap.height }
    );
  }

  /**
   * Generate mipmaps for this texture
   * Should be called after uploading data to mip level 0
   * 
   * Note: The texture must have been created with:
   * - mipLevelCount > 1
   * - renderTarget: true (for RENDER_ATTACHMENT usage)
   */
  generateMipmaps(ctx: GPUContext): void {
    if (this._mipLevelCount <= 1) {
      return; // No mipmaps to generate
    }

    const pipeline = getMipmapPipeline(ctx.device, this._format);
    const encoder = ctx.device.createCommandEncoder({ label: 'mipmap-encoder' });

    let srcWidth = this._width;
    let srcHeight = this._height;

    for (let level = 1; level < this._mipLevelCount; level++) {
      const dstWidth = Math.max(1, srcWidth >> 1);
      const dstHeight = Math.max(1, srcHeight >> 1);

      // Create view for source mip level
      const srcView = this._texture.createView({
        label: `${this._label}-mip-src-${level - 1}`,
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      });

      // Create view for destination mip level
      const dstView = this._texture.createView({
        label: `${this._label}-mip-dst-${level}`,
        baseMipLevel: level,
        mipLevelCount: 1,
      });

      // Create bind group for this pass
      const bindGroupLayout = pipeline.getBindGroupLayout(0);
      const bindGroup = ctx.device.createBindGroup({
        label: `mipmap-bind-group-${level}`,
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: mipmapSampler! },
        ],
      });

      // Render pass to generate this mip level
      const pass = encoder.beginRenderPass({
        label: `mipmap-pass-${level}`,
        colorAttachments: [{
          view: dstView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });

      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // Full-screen triangle
      pass.end();

      srcWidth = dstWidth;
      srcHeight = dstHeight;
    }

    ctx.queue.submit([encoder.finish()]);
  }

  /**
   * Create a new view with custom options
   */
  createView(options?: GPUTextureViewDescriptor): GPUTextureView {
    return this._texture.createView(options);
  }

  /**
   * Calculate bytes per row based on format
   */
  private getBytesPerRow(): number {
    const bytesPerPixel = this.getFormatBytesPerPixel();
    // WebGPU requires bytesPerRow to be a multiple of 256
    return Math.ceil((this._width * bytesPerPixel) / 256) * 256;
  }

  /**
   * Get bytes per pixel for the format
   */
  private getFormatBytesPerPixel(): number {
    switch (this._format) {
      case 'r8unorm':
      case 'r8snorm':
      case 'r8uint':
      case 'r8sint':
        return 1;
      case 'r16uint':
      case 'r16sint':
      case 'r16float':
      case 'rg8unorm':
      case 'rg8snorm':
        return 2;
      case 'r32uint':
      case 'r32sint':
      case 'r32float':
      case 'rg16uint':
      case 'rg16sint':
      case 'rg16float':
      case 'rgba8unorm':
      case 'rgba8snorm':
      case 'bgra8unorm':
        return 4;
      case 'rg32uint':
      case 'rg32sint':
      case 'rg32float':
      case 'rgba16uint':
      case 'rgba16sint':
      case 'rgba16float':
        return 8;
      case 'rgba32uint':
      case 'rgba32sint':
      case 'rgba32float':
        return 16;
      default:
        return 4; // Default assumption
    }
  }

  // Getters
  get texture(): GPUTexture {
    return this._texture;
  }

  get view(): GPUTextureView {
    return this._view;
  }

  get format(): GPUTextureFormat {
    return this._format;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  get depthOrArrayLayers(): number {
    return this._depthOrArrayLayers;
  }

  get mipLevelCount(): number {
    return this._mipLevelCount;
  }

  get label(): string {
    return this._label;
  }

  /**
   * Destroy the texture and release GPU memory
   */
  destroy(): void {
    this._texture.destroy();
  }
}

/**
 * Sampler factory with common presets
 */
export class SamplerFactory {
  private static cache = new Map<string, GPUSampler>();

  /**
   * Create a linear filtering sampler with clamp-to-edge
   */
  static linear(ctx: GPUContext, label = 'sampler-linear'): GPUSampler {
    const key = `linear-clamp`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const sampler = ctx.device.createSampler({
      label,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this.cache.set(key, sampler);
    return sampler;
  }

  /**
   * Create a nearest filtering sampler with clamp-to-edge
   */
  static nearest(ctx: GPUContext, label = 'sampler-nearest'): GPUSampler {
    const key = `nearest-clamp`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const sampler = ctx.device.createSampler({
      label,
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this.cache.set(key, sampler);
    return sampler;
  }

  /**
   * Create a linear filtering sampler with repeat wrapping
   */
  static linearRepeat(ctx: GPUContext, label = 'sampler-linear-repeat'): GPUSampler {
    const key = `linear-repeat`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const sampler = ctx.device.createSampler({
      label,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });

    this.cache.set(key, sampler);
    return sampler;
  }

  /**
   * Create a depth comparison sampler for shadow mapping
   */
  static depthCompare(ctx: GPUContext, label = 'sampler-depth-compare'): GPUSampler {
    const key = `depth-compare`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const sampler = ctx.device.createSampler({
      label,
      magFilter: 'linear',
      minFilter: 'linear',
      compare: 'less',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.cache.set(key, sampler);
    return sampler;
  }

  /**
   * Create an anisotropic filtering sampler
   */
  static anisotropic(ctx: GPUContext, maxAnisotropy = 16, label = 'sampler-anisotropic'): GPUSampler {
    const key = `anisotropic-${maxAnisotropy}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const sampler = ctx.device.createSampler({
      label,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy,
    });

    this.cache.set(key, sampler);
    return sampler;
  }

  /**
   * Create a custom sampler
   */
  static custom(ctx: GPUContext, options: GPUSamplerOptions): GPUSampler {
    return ctx.device.createSampler({
      label: options.label || 'sampler-custom',
      magFilter: options.magFilter || 'linear',
      minFilter: options.minFilter || 'linear',
      mipmapFilter: options.mipmapFilter || 'linear',
      addressModeU: options.addressModeU || 'clamp-to-edge',
      addressModeV: options.addressModeV || 'clamp-to-edge',
      addressModeW: options.addressModeW || 'clamp-to-edge',
      lodMinClamp: options.lodMinClamp || 0,
      lodMaxClamp: options.lodMaxClamp || 32,
      compare: options.compare,
      maxAnisotropy: options.maxAnisotropy || 1,
    });
  }

  /**
   * Clear the sampler cache
   */
  static clearCache(): void {
    this.cache.clear();
  }
}
