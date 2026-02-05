/**
 * SSAOEffect - Screen-Space Ambient Occlusion as a plugin effect
 * 
 * Computes ambient occlusion from depth buffer and outputs to an 'ao' texture.
 * Uses reconstructed normals from depth derivatives.
 */

import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import { UnifiedGPUTexture } from '../../GPUTexture';
import ssaoShader from '../shaders/ssao.wgsl?raw';
import ssaoBlurShader from '../shaders/ssao-blur.wgsl?raw';

/**
 * SSAO configuration parameters
 */
export interface SSAOEffectConfig {
  /** Sample radius in view space */
  radius?: number;
  /** Effect intensity multiplier */
  intensity?: number;
  /** Depth bias to prevent self-occlusion */
  bias?: number;
  /** Number of sample directions (8, 16, 32, 64) */
  samples?: number;
  /** Whether to apply edge-aware blur */
  blur?: boolean;
}

const DEFAULT_CONFIG: Required<SSAOEffectConfig> = {
  radius: 1.0,
  intensity: 0.5,
  bias: 0.025,
  samples: 16,
  blur: true,
};

/**
 * SSAOEffect - Plugin-based SSAO implementation
 */
export class SSAOEffect extends BaseEffect {
  readonly name = 'ssao';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs = ['ao'];
  
  private config: Required<SSAOEffectConfig>;
  
  // GPU resources
  private ssaoPipeline: GPURenderPipeline | null = null;
  private blurPipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private blurUniformBuffer: GPUBuffer | null = null;
  private sampleKernelBuffer: GPUBuffer | null = null;
  
  // Internal textures (owned by this effect)
  private aoRawTexture: UnifiedGPUTexture | null = null;
  
  constructor(config: SSAOEffectConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Declare output format (single-channel for AO)
    this.outputFormats.set('ao', 'r8unorm');
  }
  
  /**
   * Configure SSAO parameters
   */
  setConfig(config: Partial<SSAOEffectConfig>): void {
    Object.assign(this.config, config);
  }
  
  /**
   * Get current configuration
   */
  getConfig(): Required<SSAOEffectConfig> {
    return { ...this.config };
  }
  
  protected onInit(): void {
    this.createPipelines();
    this.createResources();
  }
  
  protected onResize(): void {
    // Recreate raw AO texture at new size
    this.aoRawTexture?.destroy();
    this.aoRawTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'ssao-raw',
      width: this.width,
      height: this.height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
      copySrc: true,  // Needed for non-blur fallback path
    });
  }
  
  protected onDestroy(): void {
    this.aoRawTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.blurUniformBuffer?.destroy();
    this.sampleKernelBuffer?.destroy();
  }
  
  execute(ctx: EffectContext): void {
    if (!this.ssaoPipeline || !this.blurPipeline || 
        !this.uniformBuffer || !this.sampleKernelBuffer) {
      return;
    }
    
    const { encoder, uniforms } = ctx;
    const depthTexture = ctx.getTexture('depth');
    const aoOutput = ctx.getTexture('ao');  // Pipeline-managed output texture
    
    // Update uniform buffer
    this.updateUniforms(uniforms);
    
    // === SSAO Pass ===
    // Shader uses textureLoad() - NO sampler needed!
    // binding 0: depthTexture (texture_2d<f32>)
    // binding 2: params (uniform)
    // binding 3: sampleKernel (storage buffer)
    const ssaoBindGroup = this.ctx.device.createBindGroup({
      label: 'ssao-bind-group',
      layout: this.ssaoPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depthTexture.view },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
        { binding: 3, resource: { buffer: this.sampleKernelBuffer } },
      ],
    });
    
    const ssaoPass = encoder.beginRenderPass({
      label: 'ssao-effect-pass',
      colorAttachments: [{
        view: this.aoRawTexture!.view,
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    
    ssaoPass.setPipeline(this.ssaoPipeline);
    ssaoPass.setBindGroup(0, ssaoBindGroup);
    ctx.fullscreenQuad.draw(ssaoPass);
    ssaoPass.end();
    
    // === Blur Pass ===
    if (this.config.blur && this.blurUniformBuffer) {
      // Update blur uniforms
      this.updateBlurUniforms(uniforms);
      
      // Blur shader uses textureLoad() - NO sampler needed!
      // binding 0: ssaoTexture (texture_2d<f32>)
      // binding 1: depthTexture (texture_2d<f32>)
      // binding 3: blurParams (uniform)
      const blurBindGroup = this.ctx.device.createBindGroup({
        label: 'ssao-blur-bind-group',
        layout: this.blurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.aoRawTexture!.view },
          { binding: 1, resource: depthTexture.view },
          { binding: 3, resource: { buffer: this.blurUniformBuffer } },
        ],
      });
      
      const blurPass = encoder.beginRenderPass({
        label: 'ssao-blur-pass',
        colorAttachments: [{
          view: aoOutput.view,
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      
      blurPass.setPipeline(this.blurPipeline);
      blurPass.setBindGroup(0, blurBindGroup);
      ctx.fullscreenQuad.draw(blurPass);
      blurPass.end();
    } else {
      // Copy raw AO directly to output
      encoder.copyTextureToTexture(
        { texture: this.aoRawTexture!.texture },
        { texture: aoOutput.texture },
        { width: this.width, height: this.height, depthOrArrayLayers: 1 }
      );
    }
  }
  
  // ========== Private Methods ==========
  
  private createPipelines(): void {
    // SSAO pipeline
    const ssaoModule = this.ctx.device.createShaderModule({
      label: 'ssao-shader',
      code: ssaoShader,
    });
    
    this.ssaoPipeline = this.ctx.device.createRenderPipeline({
      label: 'ssao-pipeline',
      layout: 'auto',
      vertex: {
        module: ssaoModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: ssaoModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'r8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    
    // Blur pipeline
    const blurModule = this.ctx.device.createShaderModule({
      label: 'ssao-blur-shader',
      code: ssaoBlurShader,
    });
    
    this.blurPipeline = this.ctx.device.createRenderPipeline({
      label: 'ssao-blur-pipeline',
      layout: 'auto',
      vertex: {
        module: blurModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: blurModule,
        entryPoint: 'fs_blur',
        targets: [{ format: 'r8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }
  
  private createResources(): void {
    // Uniform buffer (for SSAOParams struct)
    // SSAOParams: viewportParams (vec4f) + ssaoParams (vec4f) + projParams (vec4f) = 48 bytes
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'ssao-uniforms',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Blur uniform buffer (BlurParams: params + params2 = 32 bytes)
    this.blurUniformBuffer = this.ctx.device.createBuffer({
      label: 'ssao-blur-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Sample kernel storage buffer (pre-generated hemisphere samples)
    this.sampleKernelBuffer = this.createSampleKernel();
    
    // Raw AO texture
    this.aoRawTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'ssao-raw',
      width: this.width,
      height: this.height,
      format: 'r8unorm',
      renderTarget: true,
      sampled: true,
      copySrc: true,  // Needed for non-blur fallback path
    });
  }
  
  /**
   * Create hemisphere sample kernel for SSAO
   */
  private createSampleKernel(): GPUBuffer {
    const numSamples = 64; // Max samples
    const data = new Float32Array(numSamples * 4); // vec4f per sample
    
    for (let i = 0; i < numSamples; i++) {
      // Generate random point in hemisphere (tangent space)
      // Using stratified sampling for better distribution
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - 2 * Math.random()) / 2; // Hemisphere only
      
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.sin(phi) * Math.sin(theta);
      const z = Math.cos(phi); // Always positive (hemisphere)
      
      // Scale samples to be closer to origin (more samples near surface)
      let scale = (i + 1) / numSamples;
      scale = 0.1 + scale * scale * 0.9; // lerp(0.1, 1.0, scale^2)
      
      data[i * 4 + 0] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = z;
      data[i * 4 + 3] = scale; // Store scale in w component
    }
    
    const buffer = this.ctx.device.createBuffer({
      label: 'ssao-sample-kernel',
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    
    this.ctx.queue.writeBuffer(buffer, 0, data);
    
    return buffer;
  }
  
  private updateBlurUniforms(uniforms: EffectContext['uniforms']): void {
    if (!this.blurUniformBuffer) return;
    
    // Pack BlurParams: params (vec4f) + params2 (vec4f)
    const data = new Float32Array(8);
    
    // params: xy = texel size, z = direction, w = width
    data[0] = 1.0 / uniforms.width;   // texelSize.x
    data[1] = 1.0 / uniforms.height;  // texelSize.y
    data[2] = 0.0;                     // direction (0 = horizontal)
    data[3] = uniforms.width;          // viewport width
    
    // params2: x = height, yzw = unused
    data[4] = uniforms.height;         // viewport height
    data[5] = 0.0;
    data[6] = 0.0;
    data[7] = 0.0;
    
    this.ctx.queue.writeBuffer(this.blurUniformBuffer, 0, data);
  }
  
  private updateUniforms(uniforms: EffectContext['uniforms']): void {
    if (!this.uniformBuffer) return;
    
    // Pack SSAOParams: viewportParams + ssaoParams + projParams = 12 floats
    const data = new Float32Array(12);
    
    // viewportParams: xy = inverse viewport size, zw = viewport size
    data[0] = 1.0 / uniforms.width;
    data[1] = 1.0 / uniforms.height;
    data[2] = uniforms.width;
    data[3] = uniforms.height;
    
    // ssaoParams: x = radius, y = intensity, z = bias, w = samples
    data[4] = this.config.radius;
    data[5] = this.config.intensity;
    data[6] = this.config.bias;
    data[7] = this.config.samples;
    
    // projParams: x = near, y = far, z = projM[0][0], w = projM[1][1]
    data[8] = uniforms.near;
    data[9] = uniforms.far;
    data[10] = uniforms.projectionMatrix[0]; // projM[0][0]
    data[11] = uniforms.projectionMatrix[5]; // projM[1][1]
    
    this.ctx.queue.writeBuffer(this.uniformBuffer, 0, data);
  }
}
