/**
 * DynamicSkyIBL - Image-Based Lighting from Procedural Sky
 * 
 * Captures the procedural Nishita sky to a cubemap and generates:
 * - Diffuse irradiance cubemap (64×64×6) - hemisphere convolution
 * - Specular prefilter cubemap (128×128×6 with 6 mip levels) - GGX importance sampling
 * - BRDF LUT (512×512 RG16F) - pre-computed split-sum approximation
 * 
 * Uses double-buffering and incremental updates to avoid frame time spikes:
 * - Updates are spread across ~25 frames
 * - Blends between old and new IBL during transition
 * - Only updates when sun direction changes significantly (>0.5°)
 * 
 * Architecture:
 *   SkyRendererGPU → DynamicSkyIBL → ObjectRendererGPU
 *   (Nishita sky)    (cubemap+conv)    (IBL sampling)
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { UnifiedGPUTexture } from '../GPUTexture';

// Import shaders
import skyToCubemapShader from '../shaders/ibl/sky-to-cubemap.wgsl?raw';
import diffuseConvolutionShader from '../shaders/ibl/diffuse-convolution.wgsl?raw';
import specularPrefilterShader from '../shaders/ibl/specular-prefilter.wgsl?raw';
import brdfLutShader from '../shaders/ibl/brdf-lut.wgsl?raw';

// ============================================================================
// Types
// ============================================================================

/**
 * IBL task types for incremental update queue
 */
export type IBLTask = 
  | { type: 'face'; faceIndex: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'diffuse'; faceIndex: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'specular'; faceIndex: 0 | 1 | 2 | 3 | 4 | 5; mipLevel: number }
  | { type: 'swap' };

/**
 * IBL state for double-buffering
 */
interface IBLState {
  /** Current sun direction (normalized) */
  sunDirection: [number, number, number];
  /** Sun intensity */
  sunIntensity: number;
  /** Is an update in progress? */
  updating: boolean;
  /** Task queue for incremental updates */
  updateQueue: IBLTask[];
  /** Blend factor between old (0) and new (1) IBL */
  blendFactor: number;
  /** Target blend factor */
  targetBlendFactor: number;
  /** Frame counter for debugging */
  frameCount: number;
}

/**
 * IBL configuration options
 */
export interface DynamicSkyIBLOptions {
  /** Sky cubemap resolution (default: 256) */
  skyResolution?: number;
  /** Diffuse irradiance resolution (default: 64) */
  diffuseResolution?: number;
  /** Specular prefilter base resolution (default: 128) */
  specularResolution?: number;
  /** Number of specular mip levels (default: 6) */
  specularMipLevels?: number;
  /** BRDF LUT resolution (default: 512) */
  brdfLutResolution?: number;
  /** Sun direction change threshold in degrees (default: 0.5) */
  dirtyThreshold?: number;
  /** Blend speed (units per second, default: 2.0 = 0.5s transition) */
  blendSpeed?: number;
}

/**
 * IBL textures for rendering
 */
export interface IBLTextures {
  /** Diffuse irradiance cubemap */
  diffuse: GPUTextureView;
  /** Specular prefiltered cubemap (with mips) */
  specular: GPUTextureView;
  /** BRDF lookup table */
  brdfLut: GPUTextureView;
  /** Cubemap sampler */
  cubemapSampler: GPUSampler;
  /** 2D sampler for BRDF LUT */
  lutSampler: GPUSampler;
  /** Current blend factor (0-1) */
  blendFactor: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OPTIONS: Required<DynamicSkyIBLOptions> = {
  skyResolution: 256,
  diffuseResolution: 64,
  specularResolution: 128,
  specularMipLevels: 6,
  brdfLutResolution: 512,
  dirtyThreshold: 0.5,
  blendSpeed: 2.0,
};

// ============================================================================
// DynamicSkyIBL Class
// ============================================================================

export class DynamicSkyIBL {
  private ctx: GPUContext;
  private options: Required<DynamicSkyIBLOptions>;
  
  // Double-buffered textures
  private skyCubemapA: GPUTexture;
  private skyCubemapB: GPUTexture;
  private skyCubemapViewA: GPUTextureView;
  private skyCubemapViewB: GPUTextureView;
  
  private diffuseCubemapA: GPUTexture;
  private diffuseCubemapB: GPUTexture;
  private diffuseCubemapViewA: GPUTextureView;
  private diffuseCubemapViewB: GPUTextureView;
  
  private specularCubemapA: GPUTexture;
  private specularCubemapB: GPUTexture;
  private specularCubemapViewA: GPUTextureView;
  private specularCubemapViewB: GPUTextureView;
  
  // BRDF LUT (only one - environment independent)
  private brdfLutTexture: GPUTexture;
  private brdfLutView: GPUTextureView;
  
  // Samplers
  private cubemapSampler: GPUSampler;
  private lutSampler: GPUSampler;
  
  // Compute pipelines
  private skyToCubemapPipeline: GPUComputePipeline;
  private diffuseConvolutionPipeline: GPUComputePipeline;
  private specularPrefilterPipeline: GPUComputePipeline;
  private brdfLutPipeline: GPUComputePipeline;
  
  // Bind group layouts
  private skyToCubemapLayout: GPUBindGroupLayout;
  private diffuseConvolutionLayout: GPUBindGroupLayout;
  private specularPrefilterLayout: GPUBindGroupLayout;
  private brdfLutLayout: GPUBindGroupLayout;
  
  // Uniform buffers
  private skyToCubemapUniforms: UnifiedGPUBuffer;
  private diffuseConvolutionUniforms: UnifiedGPUBuffer;
  private specularPrefilterUniforms: UnifiedGPUBuffer;
  
  // State
  private state: IBLState;
  private initialized = false;
  
  // Which buffer is "current" (A=true, B=false)
  private currentBufferA = true;
  
  constructor(ctx: GPUContext, options: DynamicSkyIBLOptions = {}) {
    this.ctx = ctx;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    
    // Initialize state
    this.state = {
      sunDirection: [0, 1, 0],
      sunIntensity: 20.0,
      updating: false,
      updateQueue: [],
      blendFactor: 1.0,
      targetBlendFactor: 1.0,
      frameCount: 0,
    };
    
    // Create textures
    this.skyCubemapA = this.createCubemap(this.options.skyResolution, 'sky-cubemap-A', false);
    this.skyCubemapB = this.createCubemap(this.options.skyResolution, 'sky-cubemap-B', false);
    this.skyCubemapViewA = this.skyCubemapA.createView({ dimension: 'cube' });
    this.skyCubemapViewB = this.skyCubemapB.createView({ dimension: 'cube' });
    
    this.diffuseCubemapA = this.createCubemap(this.options.diffuseResolution, 'diffuse-cubemap-A', false);
    this.diffuseCubemapB = this.createCubemap(this.options.diffuseResolution, 'diffuse-cubemap-B', false);
    this.diffuseCubemapViewA = this.diffuseCubemapA.createView({ dimension: 'cube' });
    this.diffuseCubemapViewB = this.diffuseCubemapB.createView({ dimension: 'cube' });
    
    this.specularCubemapA = this.createCubemap(this.options.specularResolution, 'specular-cubemap-A', true);
    this.specularCubemapB = this.createCubemap(this.options.specularResolution, 'specular-cubemap-B', true);
    this.specularCubemapViewA = this.specularCubemapA.createView({ dimension: 'cube' });
    this.specularCubemapViewB = this.specularCubemapB.createView({ dimension: 'cube' });
    
    this.brdfLutTexture = this.createBrdfLut();
    this.brdfLutView = this.brdfLutTexture.createView();
    
    // Create samplers
    this.cubemapSampler = ctx.device.createSampler({
      label: 'ibl-cubemap-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    
    this.lutSampler = ctx.device.createSampler({
      label: 'ibl-lut-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    
    // Create bind group layouts and pipelines
    this.skyToCubemapLayout = this.createSkyToCubemapLayout();
    this.diffuseConvolutionLayout = this.createDiffuseConvolutionLayout();
    this.specularPrefilterLayout = this.createSpecularPrefilterLayout();
    this.brdfLutLayout = this.createBrdfLutLayout();
    
    this.skyToCubemapPipeline = this.createSkyToCubemapPipeline();
    this.diffuseConvolutionPipeline = this.createDiffuseConvolutionPipeline();
    this.specularPrefilterPipeline = this.createSpecularPrefilterPipeline();
    this.brdfLutPipeline = this.createBrdfLutPipeline();
    
    // Create uniform buffers
    // SkyToCubemap: mat4x4f (64) + vec3f (12) + f32 (4) + u32 (4) + vec3u (12) = 96 bytes
    this.skyToCubemapUniforms = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'sky-to-cubemap-uniforms',
      size: 96,
    });
    
    // DiffuseConvolution: u32 (4) + vec3u (12) = 16 bytes
    this.diffuseConvolutionUniforms = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'diffuse-convolution-uniforms',
      size: 16,
    });
    
    // SpecularPrefilter: f32 (4) + u32 (4) + vec2u (8) = 16 bytes
    this.specularPrefilterUniforms = UnifiedGPUBuffer.createUniform(ctx, {
      label: 'specular-prefilter-uniforms',
      size: 16,
    });
  }
  
  // ============================================================================
  // Texture Creation
  // ============================================================================
  
  private createCubemap(size: number, label: string, withMips: boolean): GPUTexture {
    const mipLevelCount = withMips ? this.options.specularMipLevels : 1;
    
    return this.ctx.device.createTexture({
      label,
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      mipLevelCount,
      usage: 
        GPUTextureUsage.TEXTURE_BINDING | 
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
      dimension: '2d',
    });
  }
  
  private createBrdfLut(): GPUTexture {
    return this.ctx.device.createTexture({
      label: 'brdf-lut',
      size: { width: this.options.brdfLutResolution, height: this.options.brdfLutResolution },
      format: 'rg16float',
      usage: 
        GPUTextureUsage.TEXTURE_BINDING | 
        GPUTextureUsage.STORAGE_BINDING,
    });
  }
  
  // ============================================================================
  // Pipeline Creation
  // ============================================================================
  
  private createSkyToCubemapLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'sky-to-cubemap-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { 
          access: 'write-only', format: 'rgba16float', viewDimension: '2d' 
        }},
      ],
    });
  }
  
  private createDiffuseConvolutionLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'diffuse-convolution-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { 
          sampleType: 'float', viewDimension: 'cube' 
        }},
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { 
          access: 'write-only', format: 'rgba16float', viewDimension: '2d' 
        }},
      ],
    });
  }
  
  private createSpecularPrefilterLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'specular-prefilter-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { 
          sampleType: 'float', viewDimension: 'cube' 
        }},
        { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { 
          access: 'write-only', format: 'rgba16float', viewDimension: '2d' 
        }},
      ],
    });
  }
  
  private createBrdfLutLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'brdf-lut-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { 
          access: 'write-only', format: 'rg16float', viewDimension: '2d' 
        }},
      ],
    });
  }
  
  private createSkyToCubemapPipeline(): GPUComputePipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'sky-to-cubemap-shader',
      code: skyToCubemapShader,
    });
    
    return this.ctx.device.createComputePipeline({
      label: 'sky-to-cubemap-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.skyToCubemapLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'cs_main',
      },
    });
  }
  
  private createDiffuseConvolutionPipeline(): GPUComputePipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'diffuse-convolution-shader',
      code: diffuseConvolutionShader,
    });
    
    return this.ctx.device.createComputePipeline({
      label: 'diffuse-convolution-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.diffuseConvolutionLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'cs_main',
      },
    });
  }
  
  private createSpecularPrefilterPipeline(): GPUComputePipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'specular-prefilter-shader',
      code: specularPrefilterShader,
    });
    
    return this.ctx.device.createComputePipeline({
      label: 'specular-prefilter-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.specularPrefilterLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'cs_main',
      },
    });
  }
  
  private createBrdfLutPipeline(): GPUComputePipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'brdf-lut-shader',
      code: brdfLutShader,
    });
    
    return this.ctx.device.createComputePipeline({
      label: 'brdf-lut-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.brdfLutLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'cs_main',
      },
    });
  }
  
  // ============================================================================
  // Initialization
  // ============================================================================
  
  /**
   * Initialize IBL (generates BRDF LUT)
   * Call once at startup
   */
  initialize(encoder: GPUCommandEncoder): void {
    if (this.initialized) return;
    
    // Generate BRDF LUT (one-time)
    this.generateBrdfLut(encoder);
    
    this.initialized = true;
  }
  
  private generateBrdfLut(encoder: GPUCommandEncoder): void {
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'brdf-lut-bindgroup',
      layout: this.brdfLutLayout,
      entries: [
        { binding: 0, resource: this.brdfLutView },
      ],
    });
    
    const pass = encoder.beginComputePass({ label: 'brdf-lut-pass' });
    pass.setPipeline(this.brdfLutPipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroupsX = Math.ceil(this.options.brdfLutResolution / 8);
    const workgroupsY = Math.ceil(this.options.brdfLutResolution / 8);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
    pass.end();
  }
  
  // ============================================================================
  // Update Logic
  // ============================================================================
  
  /**
   * Check if sun direction has changed enough to trigger an update
   */
  private isDirty(sunDirection: [number, number, number], sunIntensity: number): boolean {
    // Calculate angle between current and new sun direction
    const [x1, y1, z1] = this.state.sunDirection;
    const [x2, y2, z2] = sunDirection;
    
    const dot = x1 * x2 + y1 * y2 + z1 * z2;
    const clampedDot = Math.max(-1, Math.min(1, dot));
    const angleDeg = Math.acos(clampedDot) * 180 / Math.PI;
    
    // Check intensity change (>5% change)
    const intensityRatio = Math.abs(sunIntensity - this.state.sunIntensity) / 
                           Math.max(this.state.sunIntensity, 0.01);
    
    return angleDeg > this.options.dirtyThreshold || intensityRatio > 0.05;
  }
  
  /**
   * Queue a full IBL update
   */
  private queueFullUpdate(sunDirection: [number, number, number], sunIntensity: number): void {
    // Store new parameters for the "next" buffer
    // We'll update the non-current buffer
    
    // Clear existing queue
    this.state.updateQueue = [];
    
    // Queue all 6 sky cubemap faces
    for (let i = 0; i < 6; i++) {
      this.state.updateQueue.push({ type: 'face', faceIndex: i as 0|1|2|3|4|5 });
    }
    
    // Queue diffuse convolution for all 6 faces
    for (let i = 0; i < 6; i++) {
      this.state.updateQueue.push({ type: 'diffuse', faceIndex: i as 0|1|2|3|4|5 });
    }
    
    // Queue specular prefilter for all mip levels and faces
    for (let mip = 0; mip < this.options.specularMipLevels; mip++) {
      for (let i = 0; i < 6; i++) {
        this.state.updateQueue.push({ 
          type: 'specular', 
          faceIndex: i as 0|1|2|3|4|5,
          mipLevel: mip 
        });
      }
    }
    
    // Queue swap at the end
    this.state.updateQueue.push({ type: 'swap' });
    
    // Update state
    this.state.sunDirection = [...sunDirection];
    this.state.sunIntensity = sunIntensity;
    this.state.updating = true;
    this.state.blendFactor = 0.0;
    this.state.targetBlendFactor = 1.0;
  }
  
  /**
   * Process one task from the update queue
   * Call once per frame to spread work
   */
  update(
    encoder: GPUCommandEncoder,
    sunDirection: [number, number, number],
    sunIntensity: number,
    deltaTime: number
  ): void {
    this.state.frameCount++;
    
    // Initialize if needed
    if (!this.initialized) {
      this.initialize(encoder);
      // Queue initial full update
      this.queueFullUpdate(sunDirection, sunIntensity);
    }
    
    // Check for dirty state
    if (!this.state.updating && this.isDirty(sunDirection, sunIntensity)) {
      this.queueFullUpdate(sunDirection, sunIntensity);
    }
    
    // Process one task per frame
    if (this.state.updateQueue.length > 0) {
      const task = this.state.updateQueue.shift()!;
      this.executeTask(encoder, task);
    }
    
    // Update blend factor
    if (this.state.blendFactor < this.state.targetBlendFactor) {
      this.state.blendFactor = Math.min(
        this.state.blendFactor + deltaTime * this.options.blendSpeed,
        this.state.targetBlendFactor
      );
    }
    
    // Mark update complete when queue is empty and blend is done
    if (this.state.updateQueue.length === 0 && this.state.blendFactor >= 1.0) {
      this.state.updating = false;
    }
  }
  
  /**
   * Execute a single IBL task
   */
  private executeTask(encoder: GPUCommandEncoder, task: IBLTask): void {
    switch (task.type) {
      case 'face':
        this.renderSkyCubemapFace(encoder, task.faceIndex);
        break;
      case 'diffuse':
        this.renderDiffuseConvolutionFace(encoder, task.faceIndex);
        break;
      case 'specular':
        this.renderSpecularPrefilterFace(encoder, task.faceIndex, task.mipLevel);
        break;
      case 'swap':
        this.swapBuffers();
        break;
    }
  }
  
  // ============================================================================
  // Task Execution
  // ============================================================================
  
  /**
   * Render sky to a single cubemap face
   */
  private renderSkyCubemapFace(encoder: GPUCommandEncoder, faceIndex: number): void {
    // Get target cubemap (non-current buffer)
    const targetCubemap = this.currentBufferA ? this.skyCubemapB : this.skyCubemapA;
    
    // Create view for this face
    const faceView = targetCubemap.createView({
      dimension: '2d',
      baseArrayLayer: faceIndex,
      arrayLayerCount: 1,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    
    // Write uniforms
    // Layout: mat4x4f viewMatrix (64) + vec3f sunDirection (12) + f32 sunIntensity (4) + 
    //         u32 faceIndex (4) + vec3u pad (12) = 96 bytes
    const data = new ArrayBuffer(96);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);
    
    // Identity view matrix (we handle face direction in shader)
    floatView.set([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], 0);
    
    // Sun direction
    floatView[16] = this.state.sunDirection[0];
    floatView[17] = this.state.sunDirection[1];
    floatView[18] = this.state.sunDirection[2];
    floatView[19] = this.state.sunIntensity;
    
    // Face index
    uintView[20] = faceIndex;
    
    this.skyToCubemapUniforms.write(this.ctx, new Float32Array(data));
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: `sky-to-cubemap-face-${faceIndex}`,
      layout: this.skyToCubemapLayout,
      entries: [
        { binding: 0, resource: { buffer: this.skyToCubemapUniforms.buffer } },
        { binding: 1, resource: faceView },
      ],
    });
    
    // Dispatch compute
    const pass = encoder.beginComputePass({ label: `sky-to-cubemap-face-${faceIndex}` });
    pass.setPipeline(this.skyToCubemapPipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = Math.ceil(this.options.skyResolution / 8);
    pass.dispatchWorkgroups(workgroups, workgroups, 1);
    pass.end();
  }
  
  /**
   * Render diffuse convolution for a single cubemap face
   */
  private renderDiffuseConvolutionFace(encoder: GPUCommandEncoder, faceIndex: number): void {
    // Source: sky cubemap we just rendered (non-current)
    // Target: diffuse cubemap (non-current)
    const sourceCubemapView = this.currentBufferA ? this.skyCubemapViewB : this.skyCubemapViewA;
    const targetCubemap = this.currentBufferA ? this.diffuseCubemapB : this.diffuseCubemapA;
    
    const faceView = targetCubemap.createView({
      dimension: '2d',
      baseArrayLayer: faceIndex,
      arrayLayerCount: 1,
    });
    
    // Write uniforms: u32 faceIndex (4) + vec3u pad (12) = 16 bytes
    const data = new Uint32Array(4);
    data[0] = faceIndex;
    this.diffuseConvolutionUniforms.write(this.ctx, new Float32Array(data.buffer));
    
    const bindGroup = this.ctx.device.createBindGroup({
      label: `diffuse-convolution-face-${faceIndex}`,
      layout: this.diffuseConvolutionLayout,
      entries: [
        { binding: 0, resource: { buffer: this.diffuseConvolutionUniforms.buffer } },
        { binding: 1, resource: sourceCubemapView },
        { binding: 2, resource: this.cubemapSampler },
        { binding: 3, resource: faceView },
      ],
    });
    
    const pass = encoder.beginComputePass({ label: `diffuse-convolution-face-${faceIndex}` });
    pass.setPipeline(this.diffuseConvolutionPipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = Math.ceil(this.options.diffuseResolution / 8);
    pass.dispatchWorkgroups(workgroups, workgroups, 1);
    pass.end();
  }
  
  /**
   * Render specular prefilter for a single cubemap face and mip level
   */
  private renderSpecularPrefilterFace(encoder: GPUCommandEncoder, faceIndex: number, mipLevel: number): void {
    // Source: sky cubemap we just rendered (non-current)
    // Target: specular cubemap (non-current) at specific mip level
    const sourceCubemapView = this.currentBufferA ? this.skyCubemapViewB : this.skyCubemapViewA;
    const targetCubemap = this.currentBufferA ? this.specularCubemapB : this.specularCubemapA;
    
    // Calculate mip resolution
    const mipSize = Math.max(1, this.options.specularResolution >> mipLevel);
    
    // Create view for this face and mip level
    const faceView = targetCubemap.createView({
      dimension: '2d',
      baseArrayLayer: faceIndex,
      arrayLayerCount: 1,
      baseMipLevel: mipLevel,
      mipLevelCount: 1,
    });
    
    // Calculate roughness for this mip level (0 = mirror, 1 = diffuse-like)
    const roughness = mipLevel / Math.max(1, this.options.specularMipLevels - 1);
    
    // Write uniforms: f32 roughness (4) + u32 faceIndex (4) + vec2u pad (8) = 16 bytes
    const data = new ArrayBuffer(16);
    const floatView = new Float32Array(data);
    const uintView = new Uint32Array(data);
    
    floatView[0] = roughness;
    uintView[1] = faceIndex;
    
    this.specularPrefilterUniforms.write(this.ctx, new Float32Array(data));
    
    const bindGroup = this.ctx.device.createBindGroup({
      label: `specular-prefilter-face-${faceIndex}-mip-${mipLevel}`,
      layout: this.specularPrefilterLayout,
      entries: [
        { binding: 0, resource: { buffer: this.specularPrefilterUniforms.buffer } },
        { binding: 1, resource: sourceCubemapView },
        { binding: 2, resource: this.cubemapSampler },
        { binding: 3, resource: faceView },
      ],
    });
    
    const pass = encoder.beginComputePass({ 
      label: `specular-prefilter-face-${faceIndex}-mip-${mipLevel}` 
    });
    pass.setPipeline(this.specularPrefilterPipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = Math.ceil(mipSize / 8);
    pass.dispatchWorkgroups(workgroups, workgroups, 1);
    pass.end();
  }
  
  /**
   * Swap double buffers after update is complete
   */
  private swapBuffers(): void {
    this.currentBufferA = !this.currentBufferA;
    // Reset blend factor to start blending to new textures
    this.state.blendFactor = 1.0;
  }
  
  // ============================================================================
  // Public API
  // ============================================================================
  
  /**
   * Get the current IBL textures for rendering
   * Returns views to the current (completed) buffer
   */
  getIBLTextures(): IBLTextures {
    // Return current buffer textures
    const diffuseView = this.currentBufferA ? this.diffuseCubemapViewA : this.diffuseCubemapViewB;
    const specularView = this.currentBufferA ? this.specularCubemapViewA : this.specularCubemapViewB;
    
    return {
      diffuse: diffuseView,
      specular: specularView,
      brdfLut: this.brdfLutView,
      cubemapSampler: this.cubemapSampler,
      lutSampler: this.lutSampler,
      blendFactor: this.state.blendFactor,
    };
  }
  
  /**
   * Get the BRDF LUT texture view
   * Useful for setting up object shader bindings
   */
  getBrdfLutView(): GPUTextureView {
    return this.brdfLutView;
  }
  
  /**
   * Get the diffuse irradiance cubemap view
   */
  getDiffuseCubemapView(): GPUTextureView {
    return this.currentBufferA ? this.diffuseCubemapViewA : this.diffuseCubemapViewB;
  }
  
  /**
   * Get the specular prefilter cubemap view (with mips)
   */
  getSpecularCubemapView(): GPUTextureView {
    return this.currentBufferA ? this.specularCubemapViewA : this.specularCubemapViewB;
  }
  
  /**
   * Get the cubemap sampler
   */
  getCubemapSampler(): GPUSampler {
    return this.cubemapSampler;
  }
  
  /**
   * Get the LUT sampler
   */
  getLutSampler(): GPUSampler {
    return this.lutSampler;
  }
  
  /**
   * Check if IBL is ready to be used for rendering
   */
  isReady(): boolean {
    return this.initialized && this.state.blendFactor >= 0.5;
  }
  
  /**
   * Check if an update is in progress
   */
  isUpdating(): boolean {
    return this.state.updating;
  }
  
  /**
   * Get current blend factor (0-1)
   * Can be used for smooth transitions in shaders
   */
  getBlendFactor(): number {
    return this.state.blendFactor;
  }
  
  /**
   * Force a full IBL update regardless of dirty state
   * Useful when environment changes externally
   */
  forceUpdate(sunDirection: [number, number, number], sunIntensity: number): void {
    this.queueFullUpdate(sunDirection, sunIntensity);
  }
  
  /**
   * Get debug info about current state
   */
  getDebugInfo(): {
    initialized: boolean;
    updating: boolean;
    queueLength: number;
    blendFactor: number;
    frameCount: number;
    sunDirection: [number, number, number];
    currentBuffer: 'A' | 'B';
  } {
    return {
      initialized: this.initialized,
      updating: this.state.updating,
      queueLength: this.state.updateQueue.length,
      blendFactor: this.state.blendFactor,
      frameCount: this.state.frameCount,
      sunDirection: [...this.state.sunDirection] as [number, number, number],
      currentBuffer: this.currentBufferA ? 'A' : 'B',
    };
  }
  
  // ============================================================================
  // Cleanup
  // ============================================================================
  
  /**
   * Destroy all GPU resources
   */
  destroy(): void {
    this.skyCubemapA.destroy();
    this.skyCubemapB.destroy();
    this.diffuseCubemapA.destroy();
    this.diffuseCubemapB.destroy();
    this.specularCubemapA.destroy();
    this.specularCubemapB.destroy();
    this.brdfLutTexture.destroy();
    
    this.skyToCubemapUniforms.destroy();
    this.diffuseConvolutionUniforms.destroy();
    this.specularPrefilterUniforms.destroy();
  }
}
