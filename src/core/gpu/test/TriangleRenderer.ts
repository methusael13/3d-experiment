/**
 * TriangleRenderer - Minimal WebGPU test renderer
 * 
 * Renders a simple colored triangle to verify the pipeline works.
 * This is a diagnostic tool to ensure WebGPU device, surface, and
 * render pass are configured correctly before building more complex renderers.
 */

import { GPUContext } from '../GPUContext';
import { RenderPipelineWrapper } from '../GPURenderPipeline';

// Import shader
import triangleShader from '../shaders/test-triangle.wgsl?raw';

/**
 * Minimal triangle renderer for testing WebGPU setup
 */
export class TriangleRenderer {
  private ctx: GPUContext;
  private pipeline: RenderPipelineWrapper;
  
  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    
    // Create minimal render pipeline (no vertex buffers, no bind groups)
    this.pipeline = RenderPipelineWrapper.create(ctx, {
      label: 'test-triangle-pipeline',
      vertexShader: triangleShader,
      fragmentShader: triangleShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      // No vertex buffers - vertices are hardcoded in shader
      vertexBuffers: [],
      // No bind groups
      bindGroupLayouts: [],
      // No depth testing - omit depthFormat to disable
      depthWriteEnabled: false,
      // Render to screen
      colorFormats: [ctx.format],
      cullMode: 'none',
    });
  }
  
  /**
   * Render the triangle to a render pass
   * 
   * @param passEncoder - The render pass encoder to draw into
   */
  render(passEncoder: GPURenderPassEncoder): void {
    passEncoder.setPipeline(this.pipeline.pipeline);
    passEncoder.draw(3, 1, 0, 0); // 3 vertices, 1 instance
  }
  
  /**
   * Render directly to the canvas (standalone test)
   * Creates its own render pass and submits
   */
  renderToScreen(): void {
    if (!this.ctx.context) {
      throw new Error('Canvas not configured');
    }
    
    // Get the current swap chain texture
    const colorTexture = this.ctx.context.getCurrentTexture();
    const colorView = colorTexture.createView();
    
    // Create command encoder
    const encoder = this.ctx.device.createCommandEncoder({
      label: 'test-triangle-encoder',
    });
    
    // Begin render pass
    const passEncoder = encoder.beginRenderPass({
      label: 'test-triangle-pass',
      colorAttachments: [
        {
          view: colorView,
          clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    
    // Render triangle
    this.render(passEncoder);
    
    // End pass and submit
    passEncoder.end();
    this.ctx.queue.submit([encoder.finish()]);
  }
  
  /**
   * Static helper to create and run a single frame test
   */
  static async test(canvas: HTMLCanvasElement): Promise<boolean> {
    try {
      // Initialize WebGPU
      console.log('[TriangleRenderer] Initializing WebGPU...');
      const ctx = await GPUContext.getInstance(canvas);
      console.log('[TriangleRenderer] WebGPU initialized');
      
      // Create renderer
      const renderer = new TriangleRenderer(ctx);
      
      // Render one frame
      console.log('[TriangleRenderer] Rendering test triangle...');
      renderer.renderToScreen();
      
      console.log('[TriangleRenderer] ✅ Test passed - triangle rendered!');
      return true;
    } catch (error) {
      console.error('[TriangleRenderer] ❌ Test failed:', error);
      return false;
    }
  }
}
