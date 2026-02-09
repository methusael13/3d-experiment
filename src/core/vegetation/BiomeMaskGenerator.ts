/**
 * BiomeMaskGenerator - GPU-based biome mask generation
 * 
 * Generates an RGBA texture encoding biome probabilities from terrain data:
 * - R channel: Grassland (moderate height, low slope, optimal flow)
 * - G channel: Rock/Cliff (high slope)
 * - B channel: Forest Edge (good flow, moderate terrain)
 * - A channel: Reserved for future biomes
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  calculateWorkgroupCount2D,
} from '../gpu';
import {
  BiomeParams,
  BiomeParamsGPU,
  biomeParamsToGPU,
  createDefaultBiomeParams,
  BIOME_PARAMS_GPU_SIZE,
} from './types';

// Import shader source
import biomeMaskShader from '../gpu/shaders/vegetation/biome-mask.wgsl?raw';

/**
 * BiomeMaskGenerator - Generates biome probability masks using WebGPU compute shaders
 */
export class BiomeMaskGenerator {
  private ctx: GPUContext;
  
  // Compute pipeline
  private pipeline: ComputePipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Uniform buffer
  private paramsBuffer: UnifiedGPUBuffer | null = null;
  
  // Current parameters
  private currentParams: BiomeParams;
  
  // Cached biome mask texture
  private biomeMask: UnifiedGPUTexture | null = null;
  
  // Dummy texture for when flow map is null
  private dummyFlowTexture: UnifiedGPUTexture | null = null;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.currentParams = createDefaultBiomeParams();
    this.initializePipeline();
  }
  
  /**
   * Initialize the compute pipeline
   */
  private initializePipeline(): void {
    // Create bind group layout:
    // binding 0: uniform buffer (BiomeParams)
    // binding 1: heightmap texture (r32float)
    // binding 2: flow map texture (r32float)
    // binding 3: biome mask output (rgba8unorm storage)
    this.bindGroupLayout = new BindGroupLayoutBuilder('biome-mask-gen-layout')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')  // heightmap
      .texture(2, 'compute', 'unfilterable-float')  // flowMap
      .storageTexture(3, 'rgba8unorm', 'compute', 'write-only')  // biomeMaskOut
      .build(this.ctx);
    
    // Create compute pipeline
    this.pipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'biome-mask-pipeline',
      shader: biomeMaskShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    // Create uniform buffer
    this.paramsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'biome-params-buffer',
      size: BIOME_PARAMS_GPU_SIZE,
    });
    
    // Create 1x1 dummy flow texture for when flow map is null
    this.dummyFlowTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'dummy-flow-texture',
      width: 1,
      height: 1,
      format: 'r32float',
      sampled: true,
    });
  }
  
  /**
   * Update the biome parameters
   */
  setParams(params: Partial<BiomeParams>): void {
    this.currentParams = { ...this.currentParams, ...params };
  }
  
  /**
   * Get current biome parameters
   */
  getParams(): BiomeParams {
    return { ...this.currentParams };
  }
  
  /**
   * Generate a biome mask from heightmap and optional flow map
   * 
   * @param heightmap The terrain heightmap (r32float texture)
   * @param flowMap Optional water flow map from erosion (r32float texture)
   * @param params Optional parameter overrides
   * @returns RGBA8 biome probability texture
   */
  generate(
    heightmap: UnifiedGPUTexture,
    flowMap: UnifiedGPUTexture | null = null,
    params?: Partial<BiomeParams>
  ): UnifiedGPUTexture {
    // Merge params
    const finalParams = params 
      ? { ...this.currentParams, ...params }
      : this.currentParams;
    
    // Clean up existing biome mask if different size
    if (this.biomeMask && 
        (this.biomeMask.width !== heightmap.width || 
         this.biomeMask.height !== heightmap.height)) {
      this.biomeMask.destroy();
      this.biomeMask = null;
    }
    
    // Create output texture if needed
    if (!this.biomeMask) {
      this.biomeMask = UnifiedGPUTexture.create2D(this.ctx, {
        label: `biome-mask-${heightmap.width}x${heightmap.height}`,
        width: heightmap.width,
        height: heightmap.height,
        format: 'rgba8unorm',
        storage: true,
        sampled: true,
        copySrc: true,  // Enable COPY_SRC for preview readback
      });
    }
    
    if (!this.pipeline || !this.bindGroupLayout || !this.paramsBuffer) {
      console.warn('[BiomeMaskGenerator] Pipeline not initialized');
      return this.biomeMask;
    }
    
    // Update uniform buffer
    this.writeParamsToBuffer(finalParams);
    
    // Use dummy texture if no flow map provided
    const flowTexture = flowMap ?? this.dummyFlowTexture!;
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'biome-mask-gen-bind-group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer.buffer } },
        { binding: 1, resource: heightmap.view },
        { binding: 2, resource: flowTexture.view },
        { binding: 3, resource: this.biomeMask.view },
      ],
    });
    
    // Dispatch compute shader
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'biome-mask-generation-encoder',
    });
    
    const pass = encoder.beginComputePass({
      label: 'biome-mask-generation-pass',
    });
    
    pass.setPipeline(this.pipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    
    const workgroups = calculateWorkgroupCount2D(
      heightmap.width, 
      heightmap.height, 
      8, 8
    );
    pass.dispatchWorkgroups(workgroups.x, workgroups.y);
    
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
    
    console.log(
      `[BiomeMaskGenerator] Generated ${heightmap.width}x${heightmap.height} biome mask`,
      flowMap ? '(with flow map)' : '(no flow map)'
    );
    
    return this.biomeMask;
  }
  
  /**
   * Regenerate biome mask with updated parameters (uses cached textures)
   */
  regenerate(params?: Partial<BiomeParams>): UnifiedGPUTexture | null {
    if (!this.biomeMask) {
      console.warn('[BiomeMaskGenerator] No biome mask to regenerate - call generate() first');
      return null;
    }
    
    // This method assumes the heightmap and flow map haven't changed
    // For full regeneration with new textures, use generate()
    
    if (params) {
      this.setParams(params);
    }
    
    // Note: This requires the caller to provide heightmap/flowMap again
    // Consider caching texture references if needed
    return this.biomeMask;
  }
  
  /**
   * Get the current biome mask texture (may be null if not generated)
   */
  getBiomeMask(): UnifiedGPUTexture | null {
    return this.biomeMask;
  }
  
  /**
   * Write params to GPU uniform buffer
   */
  private writeParamsToBuffer(params: BiomeParams): void {
    if (!this.paramsBuffer) return;
    
    const gpuParams = biomeParamsToGPU(params);
    
    // Create typed array matching struct layout
    const data = new Float32Array([
      gpuParams.heightInfluence,
      gpuParams.slopeInfluence,
      gpuParams.flowInfluence,
      gpuParams.seed,
      
      gpuParams.grassHeightMin,
      gpuParams.grassHeightMax,
      gpuParams.grassSlopeMax,
      gpuParams.rockSlopeMin,
      
      gpuParams.forestFlowMin,
      gpuParams.forestFlowMax,
      gpuParams.forestHeightMin,
      gpuParams.forestHeightMax,
      
      gpuParams.defaultFlowValue,
      gpuParams._padding1,
      gpuParams._padding2,
      gpuParams._padding3,
    ]);
    
    this.paramsBuffer.write(this.ctx, data);
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    this.paramsBuffer?.destroy();
    this.biomeMask?.destroy();
    this.dummyFlowTexture?.destroy();
    
    this.paramsBuffer = null;
    this.biomeMask = null;
    this.dummyFlowTexture = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
