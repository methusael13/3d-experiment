/**
 * FullscreenQuad - Utility for rendering fullscreen effects
 * 
 * Uses a single triangle that covers the entire screen (more efficient than a quad).
 * Vertices are generated from vertex index - no vertex buffer needed.
 */

import { GPUContext } from '../GPUContext';
import { RenderPipelineWrapper, RenderPipelineOptions } from '../GPURenderPipeline';
import { SamplerFactory } from '../GPUTexture';
import fullscreenShaderSource from './shaders/fullscreen.wgsl?raw';

/**
 * Options for creating a fullscreen post-process pipeline
 */
export interface FullscreenPipelineOptions {
  /** Fragment shader WGSL source code (will be combined with fullscreen vertex shader) */
  fragmentShader: string;
  /** Fragment shader entry point (default: 'fs_main') */
  fragmentEntry?: string;
  /** Output color format */
  colorFormat?: GPUTextureFormat;
  /** Bind group layouts for the pipeline */
  bindGroupLayouts?: GPUBindGroupLayout[];
  /** Label for debugging */
  label?: string;
  /** Enable blending */
  blend?: boolean;
  /** Depth format (undefined = no depth test) */
  depthFormat?: GPUTextureFormat;
  /** Depth compare function */
  depthCompare?: 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
}

/**
 * Creates and manages fullscreen render pipelines for post-processing
 * Leverages existing RenderPipelineWrapper and SamplerFactory abstractions
 */
export class FullscreenQuad {
  private ctx: GPUContext;
  private linearSampler: GPUSampler;
  private nearestSampler: GPUSampler;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Cache common samplers using existing SamplerFactory
    this.linearSampler = SamplerFactory.linear(ctx, 'fullscreen-linear-sampler');
    this.nearestSampler = SamplerFactory.nearest(ctx, 'fullscreen-nearest-sampler');
  }
  
  /**
   * Get the fullscreen vertex shader source
   * Can be combined with custom fragment shaders
   */
  getVertexShaderSource(): string {
    return fullscreenShaderSource;
  }
  
  /**
   * Create a fullscreen render pipeline using existing RenderPipelineWrapper
   */
  createPipeline(options: FullscreenPipelineOptions): RenderPipelineWrapper {
    const {
      fragmentShader,
      fragmentEntry = 'fs_main',
      colorFormat = this.ctx.format,
      bindGroupLayouts = [],
      label = 'fullscreen-pipeline',
      blend = false,
      depthFormat,
      depthCompare = 'always',
    } = options;
    
    // Combine fullscreen vertex shader with custom fragment shader
    const combinedShader = `${fullscreenShaderSource}\n\n${fragmentShader}`;
    
    const pipelineOptions: RenderPipelineOptions = {
      label,
      vertexShader: combinedShader,
      fragmentShader: combinedShader,
      vertexEntryPoint: 'vs_fullscreen',
      fragmentEntryPoint: fragmentEntry,
      // No vertex buffers - vertices generated from vertex index
      vertexBuffers: [],
      bindGroupLayouts,
      topology: 'triangle-list',
      cullMode: 'none', // No culling for fullscreen triangle
      colorFormats: [colorFormat],
      depthFormat,
      depthCompare,
      depthWriteEnabled: false, // Post-process passes typically don't write depth
    };
    
    // Add alpha blending if requested
    if (blend) {
      pipelineOptions.blendStates = [{
        color: {
          srcFactor: 'src-alpha',
          dstFactor: 'one-minus-src-alpha',
          operation: 'add',
        },
        alpha: {
          srcFactor: 'one',
          dstFactor: 'one-minus-src-alpha',
          operation: 'add',
        },
      }];
    }
    
    return RenderPipelineWrapper.create(this.ctx, pipelineOptions);
  }
  
  /**
   * Draw a fullscreen triangle
   * Call this after setting up render pass and binding groups
   */
  draw(pass: GPURenderPassEncoder): void {
    // Draw 3 vertices (single triangle covering screen)
    pass.draw(3, 1, 0, 0);
  }
  
  /**
   * Create a bind group layout for texture + sampler
   * Common pattern: binding 0 = texture, binding 1 = sampler
   */
  createTextureSamplerLayout(label: string = 'texture-sampler-layout'): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });
  }
  
  /**
   * Create a bind group layout for depth texture sampling
   */
  createDepthTextureLayout(label: string = 'depth-texture-layout'): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });
  }
  
  /**
   * Create a bind group for texture + sampler
   */
  createTextureSamplerBindGroup(
    layout: GPUBindGroupLayout,
    textureView: GPUTextureView,
    useLinearSampler: boolean = true,
    label: string = 'texture-sampler-bind-group'
  ): GPUBindGroup {
    return this.ctx.device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: textureView },
        { binding: 1, resource: useLinearSampler ? this.linearSampler : this.nearestSampler },
      ],
    });
  }
  
  /**
   * Get the cached linear sampler
   */
  getLinearSampler(): GPUSampler {
    return this.linearSampler;
  }
  
  /**
   * Get the cached nearest sampler
   */
  getNearestSampler(): GPUSampler {
    return this.nearestSampler;
  }
  
  destroy(): void {
    // Samplers are cached in SamplerFactory, don't need to destroy
  }
}
