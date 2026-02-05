/**
 * CompositeEffect - Final compositing effect
 * 
 * Combines scene color with AO, applies tonemapping and gamma correction.
 * This effect outputs directly to the final output (swap chain).
 * 
 * Has two modes:
 * - With AO: multiplies color by AO texture, then tonemaps + gamma corrects
 * - Without AO (passthrough): just tonemaps + gamma corrects
 */

import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import { GPUContext } from '../../GPUContext';
import compositeShader from '../shaders/composite.wgsl?raw';

/**
 * Composite effect configuration
 */
export interface CompositeEffectConfig {
  /** Tonemapping operator (0=none, 1=Reinhard, 2=Uncharted2, 3=ACES) */
  tonemapping?: number;
  /** Gamma correction value */
  gamma?: number;
  /** Exposure adjustment */
  exposure?: number;
}

const DEFAULT_CONFIG: Required<CompositeEffectConfig> = {
  tonemapping: 3, // ACES by default
  gamma: 2.2,
  exposure: 1.0,
};

/**
 * CompositeEffect - Final composition with tonemapping
 */
export class CompositeEffect extends BaseEffect {
  readonly name = 'composite';
  readonly inputs: (StandardInput | string)[] = ['color', 'ao'];
  readonly outputs: string[] = []; // Outputs directly to final
  
  private config: Required<CompositeEffectConfig>;
  
  // GPU resources - two pipelines for with/without AO
  private pipelineWithAO: GPURenderPipeline | null = null;
  private pipelinePassthrough: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  
  // Output format (swap chain format)
  private outputFormat: GPUTextureFormat;
  
  constructor(outputFormat: GPUTextureFormat = 'bgra8unorm', config: CompositeEffectConfig = {}) {
    super();
    this.outputFormat = outputFormat;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Configure composite parameters
   */
  setConfig(config: Partial<CompositeEffectConfig>): void {
    Object.assign(this.config, config);
    this.uploadConfig();
  }
  
  /**
   * Get current configuration
   */
  getConfig(): Required<CompositeEffectConfig> {
    return { ...this.config };
  }
  
  protected onInit(): void {
    this.createPipelines();
    this.createResources();
  }
  
  protected onDestroy(): void {
    // Pipelines are managed by the device, no explicit destroy needed
  }
  
  execute(ctx: EffectContext): void {
    if (!this.pipelineWithAO || !this.pipelinePassthrough || !this.sampler) {
      return;
    }
    
    const { encoder } = ctx;
    const colorTexture = ctx.getTexture('color');
    
    // Check for AO texture using O(1) Map lookup (no exception overhead)
    const hasAO = ctx.hasTexture('ao');
    const aoTexture = hasAO ? ctx.getTexture('ao') : null;
    
    const finalOutput = ctx.getOutputView();
    
    // Select pipeline based on AO availability
    const pipeline = hasAO ? this.pipelineWithAO : this.pipelinePassthrough;
    
    const bindGroup = this.createBindGroup(pipeline, colorTexture, aoTexture);
    
    // Render to final output
    const pass = encoder.beginRenderPass({
      label: hasAO ? 'composite-with-ao-pass' : 'composite-passthrough-pass',
      colorAttachments: [{
        view: finalOutput,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    ctx.fullscreenQuad.draw(pass);
    pass.end();
  }
  
  // ========== Private Methods ==========
  
  private createPipelines(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'composite-shader',
      code: compositeShader,
    });
    
    // Pipeline WITH AO - uses fs_main which multiplies by AO
    // Bind group layout: color (0), ao (1), sampler (2)
    this.pipelineWithAO = this.ctx.device.createRenderPipeline({
      label: 'composite-pipeline-with-ao',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: this.outputFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
    
    // Pipeline WITHOUT AO (passthrough) - uses fs_passthrough_copy
    // Bind group layout: color (0), sampler (2) - no AO texture
    this.pipelinePassthrough = this.ctx.device.createRenderPipeline({
      label: 'composite-pipeline-passthrough',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
      },
      fragment: {
        module,
        entryPoint: 'fs_passthrough_copy',
        targets: [{ format: this.outputFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }
  
  private createResources(): void {
    this.sampler = this.ctx.device.createSampler({
      label: 'composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    
    // Create uniform buffer (16 bytes aligned: u32 + 3 floats)
    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'composite-uniforms',
      size: 16, // tonemapping (u32) + gamma (f32) + exposure (f32) + padding (f32)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Upload initial config
    this.uploadConfig();
  }
  
  /**
   * Upload current config to GPU uniform buffer
   */
  private uploadConfig(): void {
    if (!this.uniformBuffer) return;
    
    const data = new ArrayBuffer(16);
    const u32View = new Uint32Array(data, 0, 1);
    const f32View = new Float32Array(data, 4, 3);
    
    u32View[0] = this.config.tonemapping;
    f32View[0] = this.config.gamma;
    f32View[1] = this.config.exposure;
    f32View[2] = 0; // padding
    
    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }
  
  private createBindGroup(
    pipeline: GPURenderPipeline,
    colorTexture: { view: GPUTextureView },
    aoTexture: { view: GPUTextureView } | null
  ): GPUBindGroup {
    if (aoTexture) {
      // With AO: binding 0 = color, binding 1 = ao, binding 2 = sampler, binding 3 = uniforms
      return this.ctx.device.createBindGroup({
        label: 'composite-bind-group-with-ao',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: colorTexture.view },
          { binding: 1, resource: aoTexture.view },
          { binding: 2, resource: this.sampler! },
          { binding: 3, resource: { buffer: this.uniformBuffer! } },
        ],
      });
    } else {
      // Passthrough: binding 0 = color, binding 2 = sampler, binding 3 = uniforms
      return this.ctx.device.createBindGroup({
        label: 'composite-bind-group-passthrough',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: colorTexture.view },
          { binding: 2, resource: this.sampler! },
          { binding: 3, resource: { buffer: this.uniformBuffer! } },
        ],
      });
    }
  }
}
