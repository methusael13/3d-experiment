/**
 * FloatTextureVisualizer - Utility for visualizing float textures as thumbnails
 * 
 * Renders a float texture (like flow maps, heightmaps) as a grayscale or heat-mapped thumbnail overlay.
 * Supports r32float and rgba16float/rgba32float formats.
 */

import { GPUContext } from '../GPUContext';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import { RenderPipelineWrapper } from '../GPURenderPipeline';

export type FloatTextureColormap = 'grayscale' | 'grayscale-inverted' | 'heat' | 'viridis';

/**
 * Visualizes float textures as colored thumbnails
 */
export class FloatTextureVisualizer {
  private ctx: GPUContext;
  private pipelineWrapper: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  
  // Cache bind groups per texture view
  private bindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();
  
  /** Shader for visualizing float texture using textureLoad (works with unfilterable r32float) */
  private static readonly SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle positions
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@group(0) @binding(0) var floatTexture: texture_2d<f32>;

// Heat colormap: blue -> cyan -> green -> yellow -> red
fn heatColormap(t: f32) -> vec3f {
  let r = clamp(1.5 - abs(2.0 * t - 1.0), 0.0, 1.0);
  let g = clamp(1.5 - abs(2.0 * t - 0.5) * 2.0, 0.0, 1.0);
  let b = clamp(1.5 - abs(2.0 * t) * 2.0, 0.0, 1.0);
  
  // Blue at 0, cyan at 0.25, green at 0.5, yellow at 0.75, red at 1.0
  if (t < 0.25) {
    return mix(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 1.0), t * 4.0);
  } else if (t < 0.5) {
    return mix(vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
  } else if (t < 0.75) {
    return mix(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
  } else {
    return mix(vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
  }
}

// Viridis-like colormap: purple -> blue -> teal -> green -> yellow
fn viridisColormap(t: f32) -> vec3f {
  if (t < 0.25) {
    return mix(vec3f(0.267, 0.004, 0.329), vec3f(0.282, 0.140, 0.458), t * 4.0);
  } else if (t < 0.5) {
    return mix(vec3f(0.282, 0.140, 0.458), vec3f(0.127, 0.566, 0.551), (t - 0.25) * 4.0);
  } else if (t < 0.75) {
    return mix(vec3f(0.127, 0.566, 0.551), vec3f(0.369, 0.789, 0.383), (t - 0.5) * 4.0);
  } else {
    return mix(vec3f(0.369, 0.789, 0.383), vec3f(0.993, 0.906, 0.144), (t - 0.75) * 4.0);
  }
}

// Load texture value at UV coordinate (uses textureLoad for unfilterable r32float)
fn loadValue(uv: vec2f) -> f32 {
  let texSize = textureDimensions(floatTexture, 0);
  // Clamp UV to [0, 1) range to prevent out-of-bounds access
  let clampedUV = clamp(uv, vec2f(0.0), vec2f(0.99999));
  let texCoord = vec2u(clampedUV * vec2f(texSize));
  return textureLoad(floatTexture, texCoord, 0).r;
}

@fragment
fn fs_grayscale(input: VertexOutput) -> @location(0) vec4f {
  let value = loadValue(input.uv);
  // Clamp to 0-1 range (flow map is already normalized)
  let v = clamp(value, 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}

@fragment
fn fs_grayscale_inverted(input: VertexOutput) -> @location(0) vec4f {
  let value = loadValue(input.uv);
  // Inverted: high values = dark, low values = light (black flow on white background)
  let v = 1.0 - clamp(value, 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}

@fragment
fn fs_heat(input: VertexOutput) -> @location(0) vec4f {
  let value = loadValue(input.uv);
  let v = clamp(value, 0.0, 1.0);
  return vec4f(heatColormap(v), 1.0);
}

@fragment
fn fs_viridis(input: VertexOutput) -> @location(0) vec4f {
  let value = loadValue(input.uv);
  let v = clamp(value, 0.0, 1.0);
  return vec4f(viridisColormap(v), 1.0);
}
`;
  
  // Pipelines for different colormaps
  private grayscalePipeline: RenderPipelineWrapper | null = null;
  private grayscaleInvertedPipeline: RenderPipelineWrapper | null = null;
  private heatPipeline: RenderPipelineWrapper | null = null;
  private viridisPipeline: RenderPipelineWrapper | null = null;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.initialize();
  }
  
  private initialize(): void {
    // Create bind group layout for unfilterable float texture (no sampler needed)
    this.bindGroupLayout = new BindGroupLayoutBuilder('float-visualizer-bind-group-layout')
      .texture(0, 'fragment', 'unfilterable-float', '2d')   // binding 0: unfilterable float texture (r32float)
      .build(this.ctx);
    
    // Create grayscale pipeline
    this.grayscalePipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'float-visualizer-grayscale-pipeline',
      vertexShader: FloatTextureVisualizer.SHADER,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_grayscale',
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    // Create grayscale inverted pipeline (black on white)
    this.grayscaleInvertedPipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'float-visualizer-grayscale-inverted-pipeline',
      vertexShader: FloatTextureVisualizer.SHADER,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_grayscale_inverted',
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    // Create heat pipeline
    this.heatPipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'float-visualizer-heat-pipeline',
      vertexShader: FloatTextureVisualizer.SHADER,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_heat',
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    // Create viridis pipeline
    this.viridisPipeline = RenderPipelineWrapper.create(this.ctx, {
      label: 'float-visualizer-viridis-pipeline',
      vertexShader: FloatTextureVisualizer.SHADER,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_viridis',
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none',
    });
    
    // No sampler needed - textureLoad is used for unfilterable textures
  }
  
  /**
   * Get or create bind group for a texture view
   */
  private getBindGroup(textureView: GPUTextureView): GPUBindGroup {
    let bindGroup = this.bindGroupCache.get(textureView);
    if (!bindGroup) {
      bindGroup = new BindGroupBuilder('float-visualizer-bind-group')
        .texture(0, textureView)
        .build(this.ctx, this.bindGroupLayout!);
      
      this.bindGroupCache.set(textureView, bindGroup);
    }
    return bindGroup;
  }
  
  /**
   * Get pipeline for colormap
   */
  private getPipeline(colormap: FloatTextureColormap): RenderPipelineWrapper | null {
    switch (colormap) {
      case 'grayscale': return this.grayscalePipeline;
      case 'grayscale-inverted': return this.grayscaleInvertedPipeline;
      case 'heat': return this.heatPipeline;
      case 'viridis': return this.viridisPipeline;
      default: return this.grayscalePipeline;
    }
  }
  
  /**
   * Render float texture as a thumbnail overlay
   * 
   * @param encoder - Command encoder
   * @param targetView - The render target view to draw on
   * @param textureView - The float texture to visualize
   * @param x - X position (from left) in pixels
   * @param y - Y position (from bottom) in pixels
   * @param size - Thumbnail size in pixels
   * @param screenWidth - Full screen width
   * @param screenHeight - Full screen height
   * @param colormap - Color mapping to use (default: grayscale)
   */
  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    textureView: GPUTextureView,
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number,
    colormap: FloatTextureColormap = 'grayscale'
  ): number {
    const pipeline = this.getPipeline(colormap);
    if (!pipeline) return 0;
    
    const bindGroup = this.getBindGroup(textureView);
    
    // Create a separate render pass for the thumbnail
    const passEncoder = encoder.beginRenderPass({
      label: `float-visualizer-pass-${colormap}`,
      colorAttachments: [{
        view: targetView,
        loadOp: 'load', // Don't clear - overlay on existing content
        storeOp: 'store',
      }],
    });
    
    // Set viewport to thumbnail region (y from bottom)
    const viewportY = screenHeight - y - size;
    passEncoder.setViewport(x, viewportY, size, size, 0, 1);
    passEncoder.setScissorRect(Math.floor(x), Math.floor(viewportY), Math.ceil(size), Math.ceil(size));
    
    passEncoder.setPipeline(pipeline.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3); // Fullscreen triangle
    
    passEncoder.end();
    return 1;
  }
  
  /**
   * Clear cached bind groups (call when texture is recreated)
   */
  clearCache(): void {
    this.bindGroupCache = new WeakMap();
  }
  
  destroy(): void {
    this.grayscalePipeline = null;
    this.grayscaleInvertedPipeline = null;
    this.heatPipeline = null;
    this.viridisPipeline = null;
    this.bindGroupLayout = null;
    this.bindGroupCache = new WeakMap();
  }
}
