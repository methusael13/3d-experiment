/**
 * SSAOPass - Screen-Space Ambient Occlusion effect
 * 
 * Implements SSAO with:
 * - Hemisphere sampling in view-space
 * - Random rotation per pixel to reduce banding
 * - Bilateral blur to preserve edges
 */

import { GPUContext } from '../../GPUContext';
import { UnifiedGPUTexture, SamplerFactory } from '../../GPUTexture';
import { PostProcessPass, PostProcessInputs, PostProcessUniforms } from '../PostProcessPass';
import { FullscreenQuad } from '../FullscreenQuad';
import ssaoShaderSource from '../shaders/ssao.wgsl?raw';
import ssaoBlurShaderSource from '../shaders/ssao-blur.wgsl?raw';

/**
 * SSAO configuration parameters
 */
export interface SSAOConfig {
  /** Sampling radius in world units (default: 1.0) */
  radius?: number;
  /** Intensity/strength (default: 1.5) */
  intensity?: number;
  /** Bias to prevent self-occlusion (default: 0.025) */
  bias?: number;
  /** Number of samples (8, 16, 32, or 64) (default: 16) */
  samples?: number;
  /** Enable bilateral blur (default: true) */
  blur?: boolean;
}

/**
 * SSAO post-process pass
 */
export class SSAOPass extends PostProcessPass {
  private config: Required<SSAOConfig>;
  private width: number;
  private height: number;
  
  // GPU resources
  private fullscreenQuad: FullscreenQuad;
  
  // SSAO pipeline
  private ssaoPipeline: GPURenderPipeline | null = null;
  private ssaoBindGroupLayout: GPUBindGroupLayout | null = null;
  private ssaoParamsBuffer: GPUBuffer | null = null;
  private sampleKernelBuffer: GPUBuffer | null = null;
  
  // Blur pipeline
  private blurPipeline: GPURenderPipeline | null = null;
  private blurBindGroupLayout: GPUBindGroupLayout | null = null;
  private blurParamsBuffer: GPUBuffer | null = null;
  
  // Intermediate textures
  private ssaoRawTexture: UnifiedGPUTexture | null = null;
  private ssaoBlurredTexture: UnifiedGPUTexture | null = null;
  
  // Samplers
  private linearSampler: GPUSampler;
  private nearestSampler: GPUSampler;
  
  constructor(ctx: GPUContext, width: number, height: number, config: SSAOConfig = {}) {
    super(ctx, 'SSAO');
    
    this.config = {
      radius: config.radius ?? 1.0,
      intensity: config.intensity ?? 1.5,
      bias: config.bias ?? 0.025,
      samples: config.samples ?? 16,
      blur: config.blur ?? true,
    };
    
    this.width = width;
    this.height = height;
    
    this.fullscreenQuad = new FullscreenQuad(ctx);
    this.linearSampler = SamplerFactory.linear(ctx, 'ssao-linear-sampler');
    this.nearestSampler = SamplerFactory.nearest(ctx, 'ssao-nearest-sampler');
    
    this.createResources();
  }
  
  /**
   * Create all GPU resources
   */
  private createResources(): void {
    this.createSSAOPipeline();
    this.createBlurPipeline();
    this.createTextures();
    this.generateSampleKernel();
  }
  
  /**
   * Create SSAO render pipeline
   * Note: Normals are reconstructed from depth derivatives in the shader
   */
  private createSSAOPipeline(): void {
    // Create bind group layout (matches ssao.wgsl bindings)
    this.ssaoBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'ssao-bind-group-layout',
      entries: [
        // Depth texture (binding 0)
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        // Sampler (binding 1)
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
        // SSAO params uniform (binding 2)
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        // Sample kernel storage (binding 3)
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    
    // Create params buffer (3 vec4f = 48 bytes)
    this.ssaoParamsBuffer = this.ctx.device.createBuffer({
      label: 'ssao-params-buffer',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Create pipeline
    const pipeline = this.fullscreenQuad.createPipeline({
      label: 'ssao-pipeline',
      fragmentShader: ssaoShaderSource,
      fragmentEntry: 'fs_ssao',
      colorFormat: 'r8unorm', // Single channel output
      bindGroupLayouts: [this.ssaoBindGroupLayout],
    });
    
    this.ssaoPipeline = pipeline.pipeline;
  }
  
  /**
   * Create blur pipeline
   */
  private createBlurPipeline(): void {
    // Create bind group layout
    this.blurBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'ssao-blur-bind-group-layout',
      entries: [
        // SSAO texture
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // Depth texture
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        // Sampler
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // Blur params uniform
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    
    // Create params buffer (1 vec4f = 16 bytes)
    this.blurParamsBuffer = this.ctx.device.createBuffer({
      label: 'ssao-blur-params-buffer',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Create pipeline
    const pipeline = this.fullscreenQuad.createPipeline({
      label: 'ssao-blur-pipeline',
      fragmentShader: ssaoBlurShaderSource,
      fragmentEntry: 'fs_blur',
      colorFormat: 'r8unorm',
      bindGroupLayouts: [this.blurBindGroupLayout],
    });
    
    this.blurPipeline = pipeline.pipeline;
  }
  
  /**
   * Create intermediate textures
   */
  private createTextures(): void {
    // Raw SSAO output
    this.ssaoRawTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'ssao-raw-texture',
      width: this.width,
      height: this.height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
    });
    
    // Blurred SSAO
    this.ssaoBlurredTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'ssao-blurred-texture',
      width: this.width,
      height: this.height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
    });
  }
  
  /**
   * Generate hemisphere sample kernel
   */
  private generateSampleKernel(): void {
    const numSamples = this.config.samples;
    const kernel = new Float32Array(numSamples * 4); // vec4f per sample
    
    for (let i = 0; i < numSamples; i++) {
      // Random point in hemisphere
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random();
      const height = Math.random();
      
      // Convert to hemisphere point
      const x = Math.cos(angle) * radius * Math.sqrt(1 - height * height);
      const y = Math.sin(angle) * radius * Math.sqrt(1 - height * height);
      const z = height; // Always positive (hemisphere)
      
      // Normalize
      const len = Math.sqrt(x * x + y * y + z * z);
      
      // Scale - more samples near the center for better quality
      const scale = (i + 1) / numSamples;
      const scaledScale = 0.1 + scale * scale * 0.9; // lerp(0.1, 1.0, scale^2)
      
      kernel[i * 4 + 0] = x / len;
      kernel[i * 4 + 1] = y / len;
      kernel[i * 4 + 2] = z / len;
      kernel[i * 4 + 3] = scaledScale;
    }
    
    // Create buffer
    this.sampleKernelBuffer = this.ctx.device.createBuffer({
      label: 'ssao-sample-kernel',
      size: kernel.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    this.ctx.queue.writeBuffer(this.sampleKernelBuffer, 0, kernel);
  }
  
  /**
   * Update SSAO parameters
   */
  setConfig(config: Partial<SSAOConfig>): void {
    if (config.radius !== undefined) this.config.radius = config.radius;
    if (config.intensity !== undefined) this.config.intensity = config.intensity;
    if (config.bias !== undefined) this.config.bias = config.bias;
    if (config.blur !== undefined) this.config.blur = config.blur;
    
    // Regenerate kernel if sample count changes
    if (config.samples !== undefined && config.samples !== this.config.samples) {
      this.config.samples = config.samples;
      this.generateSampleKernel();
    }
  }
  
  /**
   * Get current configuration
   */
  getConfig(): Required<SSAOConfig> {
    return { ...this.config };
  }
  
  /**
   * Resize textures
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    
    this.width = width;
    this.height = height;
    
    this.ssaoRawTexture?.destroy();
    this.ssaoBlurredTexture?.destroy();
    this.createTextures();
  }
  
  /**
   * Render SSAO effect
   * Note: Normals are reconstructed from depth derivatives in the shader
   */
  render(
    encoder: GPUCommandEncoder,
    inputs: PostProcessInputs,
    output: GPUTextureView,
    uniforms: PostProcessUniforms
  ): void {
    if (!this.ssaoPipeline || !this.blurPipeline || !this.ssaoRawTexture || !this.ssaoBlurredTexture) {
      return;
    }
    
    if (!inputs.depth) {
      console.warn('[SSAOPass] Depth buffer required for SSAO');
      return;
    }
    
    // Update SSAO params
    const ssaoParams = new Float32Array([
      // viewportParams
      1.0 / this.width, 1.0 / this.height, this.width, this.height,
      // ssaoParams
      this.config.radius, this.config.intensity, this.config.bias, this.config.samples,
      // projParams
      uniforms.near, uniforms.far,
      uniforms.projectionMatrix[0], // projM[0][0]
      uniforms.projectionMatrix[5], // projM[1][1]
    ]);
    this.ctx.queue.writeBuffer(this.ssaoParamsBuffer!, 0, ssaoParams);
    
    // Create SSAO bind group (normals reconstructed from depth in shader)
    const ssaoBindGroup = this.ctx.device.createBindGroup({
      label: 'ssao-bind-group',
      layout: this.ssaoBindGroupLayout!,
      entries: [
        { binding: 0, resource: inputs.depth.view },
        { binding: 1, resource: this.nearestSampler },
        { binding: 2, resource: { buffer: this.ssaoParamsBuffer! } },
        { binding: 3, resource: { buffer: this.sampleKernelBuffer! } },
      ],
    });
    
    // Pass 1: SSAO
    {
      const pass = encoder.beginRenderPass({
        label: 'ssao-pass',
        colorAttachments: [{
          view: this.ssaoRawTexture.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
        }],
      });
      
      pass.setPipeline(this.ssaoPipeline);
      pass.setBindGroup(0, ssaoBindGroup);
      this.fullscreenQuad.draw(pass);
      pass.end();
    }
    
    // Pass 2: Blur (optional)
    if (this.config.blur) {
      // Horizontal blur
      this.blurPass(encoder, this.ssaoRawTexture, this.ssaoBlurredTexture, inputs.depth, false);
      // Vertical blur
      this.blurPass(encoder, this.ssaoBlurredTexture, this.ssaoRawTexture, inputs.depth, true);
    }
    
    // Pass 3: Composite (AO * color)
    this.compositePass(encoder, inputs.color, this.ssaoRawTexture, output);
  }
  
  /**
   * Blur pass (horizontal or vertical)
   */
  private blurPass(
    encoder: GPUCommandEncoder,
    input: UnifiedGPUTexture,
    output: UnifiedGPUTexture,
    depth: UnifiedGPUTexture,
    vertical: boolean
  ): void {
    // Update blur params
    const blurParams = new Float32Array([
      1.0 / this.width, 1.0 / this.height,
      vertical ? 1.0 : 0.0, 0.0,
    ]);
    this.ctx.queue.writeBuffer(this.blurParamsBuffer!, 0, blurParams);
    
    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: `ssao-blur-${vertical ? 'v' : 'h'}-bind-group`,
      layout: this.blurBindGroupLayout!,
      entries: [
        { binding: 0, resource: input.view },
        { binding: 1, resource: depth.view },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: { buffer: this.blurParamsBuffer! } },
      ],
    });
    
    const pass = encoder.beginRenderPass({
      label: `ssao-blur-${vertical ? 'v' : 'h'}-pass`,
      colorAttachments: [{
        view: output.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      }],
    });
    
    pass.setPipeline(this.blurPipeline!);
    pass.setBindGroup(0, bindGroup);
    this.fullscreenQuad.draw(pass);
    pass.end();
  }
  
  /**
   * Final composite pass (color * AO)
   */
  private compositePass(
    encoder: GPUCommandEncoder,
    color: UnifiedGPUTexture,
    ao: UnifiedGPUTexture,
    output: GPUTextureView
  ): void {
    // TODO: Create composite pipeline that multiplies color by AO
    // For now, this is a simplified version that outputs directly
    // The actual implementation would blend color * ao and apply tonemapping
    
    // This will be handled by a separate CompositePass in the stack
  }
  
  /**
   * Get the SSAO result texture (for debugging)
   */
  getSSAOTexture(): UnifiedGPUTexture | null {
    return this.config.blur ? this.ssaoRawTexture : this.ssaoBlurredTexture;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.ssaoRawTexture?.destroy();
    this.ssaoBlurredTexture?.destroy();
    this.ssaoParamsBuffer?.destroy();
    this.sampleKernelBuffer?.destroy();
    this.blurParamsBuffer?.destroy();
    this.fullscreenQuad.destroy();
  }
}
