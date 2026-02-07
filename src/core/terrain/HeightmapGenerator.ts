/**
 * HeightmapGenerator - GPU-based procedural heightmap generation
 * 
 * Uses WebGPU compute shaders to generate terrain heightmaps with various
 * noise functions (fBm, ridged, warped) and post-processing.
 * 
 * Island mode is handled by a separate IslandMaskGenerator which produces
 * a mask texture that CDLOD blends with the heightmap at render time.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  ShaderSources,
  calculateWorkgroupCount2D,
} from '../gpu';
import { HeightmapMipmapGenerator } from './HeightmapMipmapGenerator';

/**
 * Island mask parameters (for separate mask texture generation)
 */
export interface IslandMaskParams {
  /** Random seed for coastline variation */
  seed: number;
  /** Normalized island radius (0.3-0.5 typical) */
  islandRadius: number;
  /** Coastline noise frequency (3-8 typical) */
  coastNoiseScale: number;
  /** Coastline noise amplitude (0.1-0.3 typical) */
  coastNoiseStrength: number;
  /** Width of coast-to-seafloor transition (0.05-0.5 typical) */
  coastFalloff: number;
}

/**
 * Default island mask parameters
 */
export function createDefaultIslandMaskParams(): IslandMaskParams {
  return {
    seed: 12345,
    islandRadius: 0.4,
    coastNoiseScale: 5,
    coastNoiseStrength: 0.2,
    coastFalloff: 0.3,  // Gradual falloff by default
  };
}

/**
 * Noise generation parameters
 * 
 * Note: heightScale is NOT included here - noise generates normalized heights [-0.5, 0.5]
 * Actual terrain heightScale is applied at render time via TerrainManager.config.heightScale
 * This separation allows runtime adjustment of terrain height without regeneration.
 */
export interface NoiseParams {
  /** World offset for seamless tiling */
  offsetX: number;
  offsetY: number;
  /** Scale factor for noise sampling */
  scaleX: number;
  scaleY: number;
  /** Number of noise octaves (1-10) */
  octaves: number;
  /** Amplitude multiplier per octave (typically 0.5) */
  persistence: number;
  /** Frequency multiplier per octave (typically 2.0) */
  lacunarity: number;
  /** Random seed for variation */
  seed: number;
  
  // Domain warping parameters
  /** How much to warp the domain (0-2) */
  warpStrength: number;
  /** Scale of warp noise */
  warpScale: number;
  /** Octaves for warp noise (1-3) */
  warpOctaves: number;
  
  // Ridge/FBM blending
  /** Blend between fbm (0) and ridged (1) */
  ridgeWeight: number;
  
  // Octave rotation (reduces grid artifacts)
  /** Enable octave rotation */
  rotateOctaves: boolean;
  /** Rotation angle in degrees per octave (typically 37) */
  octaveRotation: number;
  
  // Island mode flag (mask texture generated separately)
  /** Enable island mode - uses separate island mask texture */
  islandEnabled: boolean;
  /** Ocean floor depth below water level (negative, e.g., -0.3) */
  seaFloorDepth: number;
  // Note: islandRadius, coastNoiseScale, coastNoiseStrength are now
  // in IslandMaskParams for the separate mask texture pipeline
}

/**
 * Normal map generation parameters
 */
export interface NormalMapParams {
  /** Strength of the normal effect */
  strength: number;
}

/**
 * Default noise parameters
 * Note: scaleX/scaleY of 3 produces natural-looking terrain
 * Values of 1 create too uniform/sine-wave patterns
 */
export function createDefaultNoiseParams(): NoiseParams {
  return {
    offsetX: 0,
    offsetY: 0,
    scaleX: 3,
    scaleY: 3,
    octaves: 6,
    persistence: 0.5,
    lacunarity: 2.0,
    seed: 12345,
    // Domain warping defaults
    warpStrength: 0.5,
    warpScale: 2.0,
    warpOctaves: 1,
    // Ridge/FBM blending
    ridgeWeight: 0.5,
    // Octave rotation
    rotateOctaves: true,
    octaveRotation: 37,
    // Island mode (disabled by default, mask generated separately)
    islandEnabled: false,
    seaFloorDepth: -0.3,
  };
}


/**
 * HeightmapGenerator - Generates heightmaps using WebGPU compute shaders
 */
export class HeightmapGenerator {
  private ctx: GPUContext;
  
  // Compute pipelines
  private fbmPipeline: ComputePipelineWrapper | null = null;
  private normalMapPipeline: ComputePipelineWrapper | null = null;
  private islandMaskPipeline: ComputePipelineWrapper | null = null;
  
  // Bind group layouts
  private noiseBindGroupLayout: GPUBindGroupLayout | null = null;
  private normalMapBindGroupLayout: GPUBindGroupLayout | null = null;
  private islandMaskBindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Uniform buffers
  private noiseParamsBuffer: UnifiedGPUBuffer | null = null;
  private normalParamsBuffer: UnifiedGPUBuffer | null = null;
  private islandMaskParamsBuffer: UnifiedGPUBuffer | null = null;
  
  // Mipmap generator for LOD support
  private mipmapGenerator: HeightmapMipmapGenerator | null = null;
  
  // Cached island mask texture (regenerated on demand)
  private islandMaskTexture: UnifiedGPUTexture | null = null;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.initializePipelines();
    this.mipmapGenerator = new HeightmapMipmapGenerator(ctx);
  }
  
  /**
   * Initialize compute pipelines
   */
  private initializePipelines(): void {
    // Create bind group layout for noise generation
    this.noiseBindGroupLayout = new BindGroupLayoutBuilder('noise-gen-layout')
      .uniformBuffer(0, 'compute')
      .storageTexture(1, 'r32float', 'compute', 'write-only')
      .build(this.ctx);
    
    // Create noise generation pipelines
    this.fbmPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'fbm-heightmap-pipeline',
      shader: ShaderSources.terrainNoise,
      entryPoint: 'main',
      bindGroupLayouts: [this.noiseBindGroupLayout],
    });
    
    // Create bind group layout for normal map generation
    this.normalMapBindGroupLayout = new BindGroupLayoutBuilder('normalmap-gen-layout')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')
      .storageTexture(2, 'rgba8snorm', 'compute', 'write-only')
      .build(this.ctx);
    
    this.normalMapPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'normalmap-pipeline',
      shader: ShaderSources.normalMapGeneration,
      entryPoint: 'main',
      bindGroupLayouts: [this.normalMapBindGroupLayout],
    });
    
    // Create uniform buffers
    // Noise params: 16 floats = 64 bytes (island params now separate)
    this.noiseParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'noise-params-buffer',
      size: 64,
    });
    
    this.normalParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'normal-params-buffer',
      size: 16, // 4 floats = 16 bytes
    });
    
    // Island mask params: 8 floats = 32 bytes (5 used + 3 padding for alignment)
    this.islandMaskParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'island-mask-params-buffer',
      size: 32,
    });
    
    // Create island mask pipeline (r32float supports storage writes)
    this.islandMaskBindGroupLayout = new BindGroupLayoutBuilder('island-mask-gen-layout')
      .uniformBuffer(0, 'compute')
      .storageTexture(1, 'r32float', 'compute', 'write-only')
      .build(this.ctx);
    
    this.islandMaskPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'island-mask-pipeline',
      shader: ShaderSources.islandMask,
      entryPoint: 'main',
      bindGroupLayouts: [this.islandMaskBindGroupLayout],
    });
  }
  
  /**
   * Generate a heightmap using configurable warped FBM noise
   * 
   * The noise type is controlled via params:
   * - warpStrength = 0, ridgeWeight = 0 → Pure FBM
   * - warpStrength = 0, ridgeWeight = 1 → Pure Ridged
   * - warpStrength > 0 → Domain warped noise
   * 
   * @param generateMipmaps - If true, generates mip levels for LOD sampling (default: true)
   */
  generateHeightmap(
    resolution: number,
    params: Partial<NoiseParams> = {},
    generateMipmaps = true
  ): UnifiedGPUTexture {
    const fullParams = { ...createDefaultNoiseParams(), ...params };
    
    // Calculate mip levels for LOD
    const mipLevelCount = generateMipmaps 
      ? Math.floor(Math.log2(resolution)) + 1
      : 1;
    
    // Create output texture with mip levels
    const heightmap = UnifiedGPUTexture.create2D(this.ctx, {
      label: `heightmap-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      mipLevelCount,
      storage: true,
      sampled: true,
      copyDst: false,
      copySrc: true,
    });
    
    // Update uniform buffer with params
    // Must match WGSL struct layout (island params removed - now separate):
    // struct GenerationParams {
    //   offset: vec2f,           // 0-1  (f32)
    //   scale: vec2f,            // 2-3  (f32)
    //   octaves: u32,            // 4    (u32)
    //   persistence: f32,        // 5    (f32)
    //   lacunarity: f32,         // 6    (f32)
    //   seed: f32,               // 7    (f32)
    //   warpStrength: f32,       // 8    (f32)
    //   warpScale: f32,          // 9    (f32)
    //   warpOctaves: u32,        // 10   (u32)
    //   ridgeWeight: f32,        // 11   (f32)
    //   rotateOctaves: u32,      // 12   (u32)
    //   octaveRotation: f32,     // 13   (f32)
    //   _pad0: f32,              // 14   (f32)
    //   _pad1: f32,              // 15   (f32)
    // }
    const buffer = new ArrayBuffer(64); // 16 * 4 bytes
    const floatView = new Float32Array(buffer);
    const uintView = new Uint32Array(buffer);
    
    floatView[0] = fullParams.offsetX;
    floatView[1] = fullParams.offsetY;
    floatView[2] = fullParams.scaleX;
    floatView[3] = fullParams.scaleY;
    uintView[4] = fullParams.octaves;
    floatView[5] = fullParams.persistence;
    floatView[6] = fullParams.lacunarity;
    floatView[7] = fullParams.seed;
    floatView[8] = fullParams.warpStrength;
    floatView[9] = fullParams.warpScale;
    uintView[10] = fullParams.warpOctaves;
    floatView[11] = fullParams.ridgeWeight;
    uintView[12] = fullParams.rotateOctaves ? 1 : 0;
    floatView[13] = fullParams.octaveRotation;
    floatView[14] = 0; // _pad0
    floatView[15] = 0; // _pad1
    
    this.noiseParamsBuffer!.write(this.ctx, floatView);
    
    // Use unified pipeline (noise type controlled via params)
    if (!this.fbmPipeline || !this.noiseBindGroupLayout) {
      return heightmap;
    }
    
    // Create a view for just mip level 0 (storage textures require single mip)
    const mip0View = heightmap.texture.createView({
      label: `heightmap-${resolution}-mip0-view`,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    
    // Create bind group with mip-0 view for storage texture
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'noise-gen-bind-group',
      layout: this.noiseBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.noiseParamsBuffer!.buffer } },
        { binding: 1, resource: mip0View },
      ],
    });
    
    // Dispatch compute
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'heightmap-generation-encoder',
    });
    
    const pass = encoder.beginComputePass({
      label: 'heightmap-generation-pass',
    });
    
    pass.setPipeline(this.fbmPipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = calculateWorkgroupCount2D(
      resolution, resolution, 8, 8
    );
    pass.dispatchWorkgroups(workgroups.x, workgroups.y);
    
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
    
    // Generate mipmaps immediately after base heightmap generation
    if (generateMipmaps && mipLevelCount > 1 && this.mipmapGenerator) {
      this.mipmapGenerator.generateMipmapsInPlace(heightmap);
    }
    
    return heightmap;
  }
  
  /**
   * Generate a normal map from a heightmap
   * 
   * @param heightmap The source heightmap texture
   * @param terrainWorldSize The world space size of the terrain (e.g., 4096)
   * @param heightScale The height scale factor (e.g., 512)
   * @param strength Additional strength multiplier (default 1.0)
   */
  generateNormalMap(
    heightmap: UnifiedGPUTexture,
    terrainWorldSize: number,
    heightScale: number,
    strength: number = 1.0
  ): UnifiedGPUTexture {
    // Create output normal map
    const normalMap = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'normalmap',
      width: heightmap.width,
      height: heightmap.height,
      format: 'rgba8snorm',
      storage: true,
      sampled: true,
    });
    
    if (!this.normalMapPipeline || !this.normalMapBindGroupLayout) {
      return normalMap;
    }
    
    // Calculate world-space texel size
    // This is the distance in world units between adjacent heightmap texels
    const texelSizeX = terrainWorldSize / heightmap.width;
    const texelSizeY = terrainWorldSize / heightmap.height;
    
    // Pack params to match shader struct:
    // struct NormalParams {
    //   texelSize: vec2<f32>,  // World space size per texel
    //   heightScale: f32,      // Terrain height scale
    //   _padding: f32,
    // }
    const paramsData = new Float32Array([
      texelSizeX,               // texelSize.x
      texelSizeY,               // texelSize.y
      heightScale * strength,   // heightScale (with strength multiplier)
      0,                        // _padding
    ]);
    this.normalParamsBuffer!.write(this.ctx, paramsData);
    
    // Create bind group
    const bindGroup = new BindGroupBuilder('normalmap-gen-bind-group')
      .buffer(0, this.normalParamsBuffer!)
      .texture(1, heightmap)
      .texture(2, normalMap)
      .build(this.ctx, this.normalMapBindGroupLayout);
    
    // Dispatch compute
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'normalmap-generation-encoder',
    });
    
    const pass = encoder.beginComputePass({
      label: 'normalmap-generation-pass',
    });
    
    pass.setPipeline(this.normalMapPipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = calculateWorkgroupCount2D(
      heightmap.width, heightmap.height, 8, 8
    );
    pass.dispatchWorkgroups(workgroups.x, workgroups.y);
    
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
    
    return normalMap;
  }
  
  /**
   * Generate an island mask texture
   * The mask is used by CDLOD to blend terrain height with sea floor
   * 
   * @param resolution The mask resolution (typically matches heightmap)
   * @param params Island mask parameters
   * @returns R8 texture where 1.0 = land, 0.0 = ocean
   */
  generateIslandMask(
    resolution: number,
    params: Partial<IslandMaskParams> = {}
  ): UnifiedGPUTexture {
    const fullParams = { ...createDefaultIslandMaskParams(), ...params };
    
    // Destroy previous mask if exists
    if (this.islandMaskTexture) {
      this.islandMaskTexture.destroy();
    }
    
    // Create output texture (r32float for storage write support)
    this.islandMaskTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: `island-mask-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
    });
    
    if (!this.islandMaskPipeline || !this.islandMaskBindGroupLayout) {
      return this.islandMaskTexture;
    }
    
    // Update uniform buffer
    // struct IslandParams {
    //   seed: f32,
    //   islandRadius: f32,
    //   coastNoiseScale: f32,
    //   coastNoiseStrength: f32,
    //   coastFalloff: f32,
    //   _pad1: f32,
    //   _pad2: f32,
    //   _pad3: f32,
    // }
    const paramsData = new Float32Array([
      fullParams.seed,
      fullParams.islandRadius,
      fullParams.coastNoiseScale,
      fullParams.coastNoiseStrength,
      fullParams.coastFalloff,
      0, // _pad1
      0, // _pad2
      0, // _pad3
    ]);
    this.islandMaskParamsBuffer!.write(this.ctx, paramsData);
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'island-mask-gen-bind-group',
      layout: this.islandMaskBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.islandMaskParamsBuffer!.buffer } },
        { binding: 1, resource: this.islandMaskTexture.view },
      ],
    });
    
    // Dispatch compute
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'island-mask-generation-encoder',
    });
    
    const pass = encoder.beginComputePass({
      label: 'island-mask-generation-pass',
    });
    
    pass.setPipeline(this.islandMaskPipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = calculateWorkgroupCount2D(resolution, resolution, 8, 8);
    pass.dispatchWorkgroups(workgroups.x, workgroups.y);
    
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
    
    return this.islandMaskTexture;
  }
  
  /**
   * Get the current island mask texture (if generated)
   */
  getIslandMaskTexture(): UnifiedGPUTexture | null {
    return this.islandMaskTexture;
  }
  
  /**
   * Generate both heightmap and normal map
   */
  generateTerrain(
    resolution: number,
    terrainWorldSize: number,
    heightScale: number,
    params: Partial<NoiseParams> = {},
    normalStrength: number = 1.0
  ): { heightmap: UnifiedGPUTexture; normalMap: UnifiedGPUTexture } {
    const heightmap = this.generateHeightmap(resolution, params);
    const normalMap = this.generateNormalMap(heightmap, terrainWorldSize, heightScale, normalStrength);
    
    return { heightmap, normalMap };
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.noiseParamsBuffer?.destroy();
    this.normalParamsBuffer?.destroy();
    this.islandMaskParamsBuffer?.destroy();
    this.islandMaskTexture?.destroy();
    this.mipmapGenerator?.destroy();
    
    this.noiseParamsBuffer = null;
    this.normalParamsBuffer = null;
    this.islandMaskParamsBuffer = null;
    this.islandMaskTexture = null;
    this.fbmPipeline = null;
    this.normalMapPipeline = null;
    this.islandMaskPipeline = null;
    this.noiseBindGroupLayout = null;
    this.normalMapBindGroupLayout = null;
    this.islandMaskBindGroupLayout = null;
    this.mipmapGenerator = null;
  }
}
