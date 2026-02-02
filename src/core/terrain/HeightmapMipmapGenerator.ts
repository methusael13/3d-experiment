/**
 * HeightmapMipmapGenerator - GPU-based mipmap generation for heightmaps
 * 
 * Generates a chain of downsampled heightmaps for LOD-based terrain rendering.
 * Uses compute shaders to efficiently downsample on the GPU.
 * 
 * Typical usage:
 * 1. Generate full-res heightmap (1024x1024) with erosion
 * 2. Use this generator to create mip levels: 512, 256, 128, 64
 * 3. Store all mip levels in tile cache
 * 4. Vertex shader selects appropriate mip based on LOD level
 */

import {
  GPUContext,
  UnifiedGPUTexture,
  UnifiedGPUBuffer,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
} from '../gpu';

// Import shader
import downsampleShader from '../gpu/shaders/terrain/heightmap-downsample.wgsl?raw';

/**
 * Mipmap chain - array of textures at decreasing resolutions
 */
export interface HeightmapMipChain {
  /** Base resolution texture (full quality) */
  base: UnifiedGPUTexture;
  /** Array of mip levels [half, quarter, eighth, ...] */
  mips: UnifiedGPUTexture[];
  /** Resolution of base texture */
  baseResolution: number;
  /** Number of mip levels (including base) */
  levelCount: number;
}

/**
 * Configuration for mipmap generation
 */
export interface MipmapConfig {
  /** Minimum mip resolution to generate (default: 64) */
  minResolution: number;
  /** Maximum number of mip levels (default: 4) */
  maxLevels: number;
}

/**
 * Default mipmap configuration
 */
export function createDefaultMipmapConfig(): MipmapConfig {
  return {
    minResolution: 64,
    maxLevels: 4,
  };
}

/**
 * HeightmapMipmapGenerator - Generates LOD mipmap chains for heightmaps
 */
export class HeightmapMipmapGenerator {
  private ctx: GPUContext;
  private config: MipmapConfig;
  
  // Compute pipeline
  private computePipeline: ComputePipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Uniform buffer (reused for each mip level)
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  
  // Sampler for reading source textures
  private sampler: GPUSampler | null = null;
  
  constructor(ctx: GPUContext, config?: Partial<MipmapConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultMipmapConfig(), ...config };
    
    this.initialize();
  }
  
  /**
   * Initialize compute pipeline and resources
   */
  private initialize(): void {
    // Create bind group layout
    this.bindGroupLayout = new BindGroupLayoutBuilder('heightmap-mipmap-layout')
      .uniformBuffer(0, 'compute')                          // Uniforms
      .texture(1, 'compute', 'unfilterable-float', '2d')    // Source heightmap
      .storageTexture(2, 'r32float', 'compute', 'write-only') // Destination mip
      .build(this.ctx);
    
    // Create compute pipeline
    this.computePipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'heightmap-mipmap-pipeline',
      shader: downsampleShader,
      entryPoint: 'generate_mip',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    // Create uniform buffer (32 bytes = 8 u32)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'heightmap-mipmap-uniforms',
      size: 32,
    });
  }
  
  /**
   * Generate a complete mipmap chain from a base heightmap
   * 
   * @param baseHeightmap - Full resolution heightmap texture
   * @returns HeightmapMipChain with all mip levels
   */
  generateMipChain(baseHeightmap: UnifiedGPUTexture): HeightmapMipChain {
    const baseRes = baseHeightmap.width;
    const mips: UnifiedGPUTexture[] = [];
    
    // Calculate number of mip levels
    let levels = 0;
    let res = baseRes;
    while (res > this.config.minResolution && levels < this.config.maxLevels) {
      res = Math.floor(res / 2);
      levels++;
    }
    
    // Generate each mip level
    let srcTexture = baseHeightmap;
    let srcRes = baseRes;
    
    for (let level = 0; level < levels; level++) {
      const dstRes = Math.floor(srcRes / 2);
      
      // Create destination texture for this mip
      const dstTexture = UnifiedGPUTexture.createHeightmap(
        this.ctx,
        dstRes,
        dstRes,
        `heightmap-mip-${level + 1}`
      );

      // Run downsample pass
      this.runDownsamplePass(srcTexture, dstTexture, srcRes, dstRes, level);
      
      mips.push(dstTexture);
      
      // Next level uses this as source
      srcTexture = dstTexture;
      srcRes = dstRes;
    }
    
    return {
      base: baseHeightmap,
      mips,
      baseResolution: baseRes,
      levelCount: 1 + mips.length,
    };
  }
  
  /**
   * Run a single downsample pass
   */
  private runDownsamplePass(
    src: UnifiedGPUTexture,
    dst: UnifiedGPUTexture,
    srcRes: number,
    dstRes: number,
    mipLevel: number
  ): void {
    if (!this.computePipeline || !this.bindGroupLayout || !this.uniformBuffer) {
      return;
    }
    
    // Update uniforms
    const uniformData = new Uint32Array([
      srcRes,    // srcWidth
      srcRes,    // srcHeight
      dstRes,    // dstWidth
      dstRes,    // dstHeight
      mipLevel,  // mipLevel
      0,         // padding
      0,
      0,
    ]);
    this.uniformBuffer.write(this.ctx, uniformData);
    
    // Create bind group for this pass
    const bindGroup = new BindGroupBuilder('mipmap-pass-bindgroup')
      .buffer(0, this.uniformBuffer)
      .texture(1, src)
      .texture(2, dst) // Storage texture - will be written to
      .build(this.ctx, this.bindGroupLayout);
    
    // Create command encoder and run compute pass
    const encoder = this.ctx.device.createCommandEncoder({
      label: `mipmap-level-${mipLevel}`,
    });
    
    const computePass = encoder.beginComputePass({
      label: `mipmap-compute-${mipLevel}`,
    });
    
    computePass.setPipeline(this.computePipeline.pipeline);
    computePass.setBindGroup(0, bindGroup);
    
    // Dispatch workgroups (8x8 per workgroup)
    const workgroupsX = Math.ceil(dstRes / 8);
    const workgroupsY = Math.ceil(dstRes / 8);
    computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
    
    computePass.end();
    
    // Submit
    this.ctx.queue.submit([encoder.finish()]);
  }
  
  /**
   * Generate mipmaps and wait for completion
   */
  async generateMipChainAsync(baseHeightmap: UnifiedGPUTexture): Promise<HeightmapMipChain> {
    const chain = this.generateMipChain(baseHeightmap);
    await this.ctx.device.queue.onSubmittedWorkDone();
    return chain;
  }
  
  /**
   * Generate mipmaps into a single texture's mip levels
   * 
   * This is the preferred method for CDLOD rendering where the shader
   * uses textureLoad(heightmap, coord, mipLevel) to sample different LODs.
   * 
   * @param heightmap - A texture created with mipLevelCount > 1
   */
  generateMipmapsInPlace(heightmap: UnifiedGPUTexture): void {
    if (!this.computePipeline || !this.bindGroupLayout || !this.uniformBuffer) {
      console.warn('[HeightmapMipmapGenerator] Not initialized');
      return;
    }
    
    const mipLevelCount = heightmap.mipLevelCount;
    if (mipLevelCount <= 1) {
      console.warn('[HeightmapMipmapGenerator] Texture has no mip levels to generate');
      return;
    }
    
    let srcWidth = heightmap.width;
    let srcHeight = heightmap.height;
    
    for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
      const dstWidth = Math.max(1, Math.floor(srcWidth / 2));
      const dstHeight = Math.max(1, Math.floor(srcHeight / 2));
      
      // Create views for specific mip levels
      const srcView = heightmap.texture.createView({
        label: `heightmap-mip-${mipLevel - 1}-view`,
        dimension: '2d',
        baseMipLevel: mipLevel - 1,
        mipLevelCount: 1,
      });
      
      const dstView = heightmap.texture.createView({
        label: `heightmap-mip-${mipLevel}-view`,
        dimension: '2d',
        baseMipLevel: mipLevel,
        mipLevelCount: 1,
      });
      
      // Update uniforms
      const uniformData = new Uint32Array([
        srcWidth,
        srcHeight,
        dstWidth,
        dstHeight,
        mipLevel,
        0, 0, 0 // padding
      ]);
      this.uniformBuffer.write(this.ctx, uniformData);
      
      // Create bind group for this pass using raw views
      const bindGroup = this.ctx.device.createBindGroup({
        label: `mipmap-inplace-bindgroup-${mipLevel}`,
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer.buffer } },
          { binding: 1, resource: srcView },
          { binding: 2, resource: dstView },
        ],
      });
      
      // Dispatch compute
      const encoder = this.ctx.device.createCommandEncoder({
        label: `mipmap-inplace-encoder-${mipLevel}`,
      });
      
      const computePass = encoder.beginComputePass({
        label: `mipmap-inplace-compute-${mipLevel}`,
      });
      
      computePass.setPipeline(this.computePipeline.pipeline);
      computePass.setBindGroup(0, bindGroup);
      
      const workgroupsX = Math.ceil(dstWidth / 8);
      const workgroupsY = Math.ceil(dstHeight / 8);
      computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
      
      computePass.end();
      this.ctx.queue.submit([encoder.finish()]);
      
      // Update src dimensions for next level
      srcWidth = dstWidth;
      srcHeight = dstHeight;
    }
    
    console.log(`[HeightmapMipmapGenerator] Generated ${mipLevelCount - 1} mip levels in-place`);
  }
  
  /**
   * Generate mipmaps in-place and wait for completion
   */
  async generateMipmapsInPlaceAsync(heightmap: UnifiedGPUTexture): Promise<void> {
    this.generateMipmapsInPlace(heightmap);
    await this.ctx.device.queue.onSubmittedWorkDone();
  }
  
  /**
   * Get the recommended mip level for a given LOD level
   * 
   * @param lodLevel - CDLOD level (0 = closest, higher = farther)
   * @param maxMipLevel - Maximum mip level available
   * @returns Mip level index (0 = base, 1 = half, etc.)
   */
  static getMipLevelForLOD(lodLevel: number, maxMipLevel: number): number {
    // LOD 0-2 → mip 0 (full res)
    // LOD 3-4 → mip 1 (half res)
    // LOD 5-6 → mip 2 (quarter res)
    // LOD 7+  → mip 3 (eighth res)
    
    const mipLevel = Math.floor(lodLevel / 2);
    return Math.min(mipLevel, maxMipLevel);
  }
  
  /**
   * Get texture from mip chain by mip level
   */
  static getTextureFromChain(chain: HeightmapMipChain, mipLevel: number): UnifiedGPUTexture {
    if (mipLevel === 0) {
      return chain.base;
    }
    const index = Math.min(mipLevel - 1, chain.mips.length - 1);
    return chain.mips[index] ?? chain.base;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.computePipeline = null;
    this.bindGroupLayout = null;
  }
  
  /**
   * Destroy a mip chain (disposes all mip textures, NOT the base)
   */
  static destroyMipChain(chain: HeightmapMipChain): void {
    for (const mip of chain.mips) {
      mip.destroy();
    }
    chain.mips = [];
  }
}
