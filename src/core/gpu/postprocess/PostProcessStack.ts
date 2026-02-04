/**
 * PostProcessStack - Manages post-processing effect chain
 * 
 * Handles:
 * - HDR scene render target
 * - View-space normal buffer (for SSAO)
 * - Ping-pong buffers for effect chaining
 * - Final composite to screen
 */

import { GPUContext } from '../GPUContext';
import { UnifiedGPUTexture } from '../GPUTexture';
import { FullscreenQuad } from './FullscreenQuad';
import { PostProcessPass, PostProcessInputs, PostProcessUniforms } from './PostProcessPass';

/**
 * Configuration for the post-process stack
 */
export interface PostProcessStackConfig {
  /** Enable HDR rendering (rgba16float vs rgba8unorm) */
  hdr?: boolean;
  /** Generate view-space normals for SSAO */
  generateNormals?: boolean;
}

/**
 * Render targets used by the post-process stack
 */
export interface PostProcessTargets {
  /** HDR color buffer (scene renders here) */
  color: UnifiedGPUTexture;
  /** View-space normals (for SSAO) */
  normals: UnifiedGPUTexture | null;
  /** Depth buffer (shared with main pipeline) */
  depth: UnifiedGPUTexture;
  /** Ping buffer for effect chaining */
  pingBuffer: UnifiedGPUTexture;
  /** Pong buffer for effect chaining */
  pongBuffer: UnifiedGPUTexture;
}

/**
 * Post-processing stack manager
 */
export class PostProcessStack {
  private ctx: GPUContext;
  private width: number;
  private height: number;
  private config: PostProcessStackConfig;
  
  // Render targets
  private colorBuffer: UnifiedGPUTexture;
  private normalBuffer: UnifiedGPUTexture | null = null;
  private pingBuffer: UnifiedGPUTexture;
  private pongBuffer: UnifiedGPUTexture;
  
  // External depth buffer reference (from forward pipeline)
  private depthBuffer: UnifiedGPUTexture | null = null;
  
  // Effect chain
  private passes: PostProcessPass[] = [];
  
  // Fullscreen rendering utility
  private fullscreenQuad: FullscreenQuad;
  
  // Final composite pipeline
  private compositePipeline: GPURenderPipeline | null = null;
  private compositeBindGroupLayout: GPUBindGroupLayout | null = null;
  
  constructor(ctx: GPUContext, width: number, height: number, config: PostProcessStackConfig = {}) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.config = {
      hdr: true,
      generateNormals: true,
      ...config,
    };
    
    this.fullscreenQuad = new FullscreenQuad(ctx);
    
    // Create render targets
    this.colorBuffer = this.createColorBuffer();
    this.pingBuffer = this.createPingPongBuffer('ping');
    this.pongBuffer = this.createPingPongBuffer('pong');
    
    if (this.config.generateNormals) {
      this.normalBuffer = this.createNormalBuffer();
    }
    
    // Create composite pipeline for final output
    this.createCompositePipeline();
  }
  
  /**
   * Create HDR color buffer
   */
  private createColorBuffer(): UnifiedGPUTexture {
    const format = this.config.hdr ? 'rgba16float' : 'rgba8unorm';
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'postprocess-color-buffer',
      width: this.width,
      height: this.height,
      format,
      renderTarget: true,
      sampled: true,
      copyDst: false,
      copySrc: true,
    });
  }
  
  /**
   * Create view-space normal buffer for SSAO
   */
  private createNormalBuffer(): UnifiedGPUTexture {
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: 'postprocess-normal-buffer',
      width: this.width,
      height: this.height,
      format: 'rgba8snorm',
      renderTarget: true,
      sampled: true,
      copyDst: false,
      copySrc: false,
    });
  }
  
  /**
   * Create ping-pong buffer for effect chaining
   */
  private createPingPongBuffer(name: string): UnifiedGPUTexture {
    const format = this.config.hdr ? 'rgba16float' : 'rgba8unorm';
    return UnifiedGPUTexture.create2D(this.ctx, {
      label: `postprocess-${name}-buffer`,
      width: this.width,
      height: this.height,
      format,
      renderTarget: true,
      sampled: true,
      copyDst: false,
      copySrc: false,
    });
  }
  
  /**
   * Create the final composite pipeline
   */
  private createCompositePipeline(): void {
    this.compositeBindGroupLayout = this.fullscreenQuad.createTextureSamplerLayout('composite-bind-group-layout');
    
    // Simple passthrough/tonemap shader
    const compositeShader = `
      @group(0) @binding(0) var inputTexture: texture_2d<f32>;
      @group(0) @binding(1) var inputSampler: sampler;
      
      @fragment
      fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
        let color = textureSample(inputTexture, inputSampler, uv);
        
        // Simple Reinhard tonemapping for HDR
        let mapped = color.rgb / (color.rgb + vec3f(1.0));
        
        // Gamma correction
        let gamma = pow(mapped, vec3f(1.0 / 2.2));
        
        return vec4f(gamma, color.a);
      }
    `;
    
    const pipeline = this.fullscreenQuad.createPipeline({
      label: 'composite-pipeline',
      fragmentShader: compositeShader,
      colorFormat: this.ctx.format,
      bindGroupLayouts: [this.compositeBindGroupLayout],
    });
    
    this.compositePipeline = pipeline.pipeline;
  }
  
  /**
   * Set the depth buffer reference from the forward pipeline
   */
  setDepthBuffer(depth: UnifiedGPUTexture): void {
    this.depthBuffer = depth;
  }
  
  /**
   * Get render targets for scene rendering
   */
  getSceneTargets(): { color: GPUTextureView; normals: GPUTextureView | null } {
    return {
      color: this.colorBuffer.view,
      normals: this.normalBuffer?.view ?? null,
    };
  }
  
  /**
   * Get the HDR color buffer (scene renders to this)
   */
  getColorBuffer(): UnifiedGPUTexture {
    return this.colorBuffer;
  }
  
  /**
   * Get the normal buffer (for MRT output)
   */
  getNormalBuffer(): UnifiedGPUTexture | null {
    return this.normalBuffer;
  }
  
  /**
   * Add a post-process effect to the chain
   */
  addPass(pass: PostProcessPass): void {
    this.passes.push(pass);
  }
  
  /**
   * Remove a post-process effect
   */
  removePass(pass: PostProcessPass): void {
    const index = this.passes.indexOf(pass);
    if (index !== -1) {
      this.passes.splice(index, 1);
    }
  }
  
  /**
   * Get a pass by name
   */
  getPass<T extends PostProcessPass>(name: string): T | null {
    const pass = this.passes.find(p => p.getName() === name);
    return pass as T | null;
  }
  
  /**
   * Get all passes
   */
  getPasses(): PostProcessPass[] {
    return [...this.passes];
  }
  
  /**
   * Resize all render targets
   */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) {
      return;
    }
    
    this.width = width;
    this.height = height;
    
    // Recreate render targets
    this.colorBuffer.destroy();
    this.colorBuffer = this.createColorBuffer();
    
    this.pingBuffer.destroy();
    this.pingBuffer = this.createPingPongBuffer('ping');
    
    this.pongBuffer.destroy();
    this.pongBuffer = this.createPingPongBuffer('pong');
    
    if (this.normalBuffer) {
      this.normalBuffer.destroy();
      this.normalBuffer = this.createNormalBuffer();
    }
    
    // Notify all passes
    for (const pass of this.passes) {
      pass.resize(width, height);
    }
  }
  
  /**
   * Execute all enabled post-process effects and composite to screen
   * @param encoder - Command encoder
   * @param finalOutput - Final output texture view (swap chain)
   * @param uniforms - Camera and viewport uniforms
   */
  render(
    encoder: GPUCommandEncoder,
    finalOutput: GPUTextureView,
    uniforms: PostProcessUniforms
  ): void {
    if (!this.depthBuffer) {
      console.warn('[PostProcessStack] No depth buffer set');
      return;
    }
    
    // Get enabled passes
    const enabledPasses = this.passes.filter(p => p.isEnabled());
    
    // If no passes, just copy color to output with tonemapping
    if (enabledPasses.length === 0) {
      this.compositeToScreen(encoder, this.colorBuffer, finalOutput);
      return;
    }
    
    // Prepare inputs
    const inputs: PostProcessInputs = {
      color: this.colorBuffer,
      depth: this.depthBuffer,
      normals: this.normalBuffer ?? undefined,
    };
    
    // Execute passes with ping-pong buffering
    let currentInput = this.colorBuffer;
    let currentOutput = this.pingBuffer;
    let usePing = true;
    
    for (let i = 0; i < enabledPasses.length; i++) {
      const pass = enabledPasses[i];
      const isLast = i === enabledPasses.length - 1;
      
      // Update inputs with current color
      inputs.color = currentInput;
      
      // Last pass renders directly to final output
      if (isLast) {
        pass.render(encoder, inputs, finalOutput, uniforms);
      } else {
        pass.render(encoder, inputs, currentOutput.view, uniforms);
        
        // Swap buffers
        currentInput = currentOutput;
        currentOutput = usePing ? this.pongBuffer : this.pingBuffer;
        usePing = !usePing;
      }
    }
  }
  
  /**
   * Simple copy with tonemapping to screen
   */
  private compositeToScreen(
    encoder: GPUCommandEncoder,
    source: UnifiedGPUTexture,
    output: GPUTextureView
  ): void {
    if (!this.compositePipeline || !this.compositeBindGroupLayout) {
      return;
    }
    
    const bindGroup = this.fullscreenQuad.createTextureSamplerBindGroup(
      this.compositeBindGroupLayout,
      source.view,
      true,
      'composite-bind-group'
    );
    
    const pass = encoder.beginRenderPass({
      label: 'composite-pass',
      colorAttachments: [{
        view: output,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, bindGroup);
    this.fullscreenQuad.draw(pass);
    pass.end();
  }
  
  /**
   * Clean up all resources
   */
  destroy(): void {
    this.colorBuffer.destroy();
    this.normalBuffer?.destroy();
    this.pingBuffer.destroy();
    this.pongBuffer.destroy();
    this.fullscreenQuad.destroy();
    
    for (const pass of this.passes) {
      pass.destroy();
    }
    this.passes = [];
  }
}

// Re-export for convenience
export { PostProcessPass } from './PostProcessPass';
export type { PostProcessInputs, PostProcessUniforms } from './PostProcessPass';
export { FullscreenQuad } from './FullscreenQuad';
export type { FullscreenPipelineOptions } from './FullscreenQuad';
