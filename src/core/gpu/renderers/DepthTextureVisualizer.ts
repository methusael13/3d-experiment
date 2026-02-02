/**
 * DepthTextureVisualizer - Utility for visualizing depth textures as thumbnails
 * 
 * Renders a depth texture (like shadow maps) as a grayscale thumbnail overlay.
 * Reusable for any depth texture debugging.
 */

import { GPUContext } from '../GPUContext';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import { RenderPipelineWrapper } from '../GPURenderPipeline';

/**
 * Visualizes depth textures as grayscale thumbnails
 */
export class DepthTextureVisualizer {
  private ctx: GPUContext;
  private pipelineWrapper: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  
  // Cache bind groups per texture view
  private bindGroupCache = new WeakMap<GPUTextureView, GPUBindGroup>();
  
  /** Debug shader for visualizing depth texture */
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

@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let depth = textureSample(depthTexture, depthSampler, input.uv);
  // Linearize depth for better visualization (depth is 0-1, closer = darker)
  let linearDepth = pow(depth, 0.4); // Gamma correction for better visibility
  return vec4f(linearDepth, linearDepth, linearDepth, 1.0);
}
`;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.initialize();
  }
  
  private initialize(): void {
    // Use BindGroupLayoutBuilder with depth texture and non-filtering sampler
    this.bindGroupLayout = new BindGroupLayoutBuilder('depth-visualizer-bind-group-layout')
      .depthTexture(0, 'fragment')              // binding 0: depth texture
      .sampler(1, 'fragment', 'non-filtering')  // binding 1: non-filtering sampler (required for depth)
      .build(this.ctx);
    
    // Use RenderPipelineWrapper for consistent pipeline creation
    this.pipelineWrapper = RenderPipelineWrapper.create(this.ctx, {
      label: 'depth-visualizer-pipeline',
      vertexShader: DepthTextureVisualizer.SHADER,
      // fragmentShader uses same module (combined shader)
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none', // No culling for fullscreen quad
      // No depth testing for overlay
    });
    
    // Non-filtering sampler for depth textures
    this.sampler = this.ctx.device.createSampler({
      label: 'depth-visualizer-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
  }
  
  /**
   * Get or create bind group for a depth texture view
   */
  private getBindGroup(depthTextureView: GPUTextureView): GPUBindGroup {
    let bindGroup = this.bindGroupCache.get(depthTextureView);
    if (!bindGroup) {
      // Use BindGroupBuilder for consistency
      bindGroup = new BindGroupBuilder('depth-visualizer-bind-group')
        .texture(0, depthTextureView)
        .sampler(1, this.sampler!)
        .build(this.ctx, this.bindGroupLayout!);
      
      this.bindGroupCache.set(depthTextureView, bindGroup);
    }
    return bindGroup;
  }
  
  /**
   * Render depth texture as a thumbnail overlay
   * 
   * @param encoder - Command encoder
   * @param targetView - The render target view to draw on
   * @param depthTextureView - The depth texture to visualize
   * @param x - X position (from left) in pixels
   * @param y - Y position (from bottom) in pixels
   * @param size - Thumbnail size in pixels
   * @param screenWidth - Full screen width
   * @param screenHeight - Full screen height
   */
  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    depthTextureView: GPUTextureView,
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number
  ): void {
    if (!this.pipelineWrapper) return;
    
    const bindGroup = this.getBindGroup(depthTextureView);
    
    // Create a separate render pass for the thumbnail
    const passEncoder = encoder.beginRenderPass({
      label: 'depth-visualizer-pass',
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
    
    passEncoder.setPipeline(this.pipelineWrapper.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3); // Fullscreen triangle
    
    passEncoder.end();
  }
  
  /**
   * Clear cached bind groups (call when depth texture is recreated)
   */
  clearCache(): void {
    this.bindGroupCache = new WeakMap();
  }
  
  destroy(): void {
    this.pipelineWrapper = null;
    this.bindGroupLayout = null;
    this.sampler = null;
    this.bindGroupCache = new WeakMap();
  }
}
