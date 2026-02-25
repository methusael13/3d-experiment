/**
 * SelectionOutlineRendererGPU - Fullscreen post-process renderer for selection outline
 * 
 * Reads a selection mask texture (r8unorm, 1=selected, 0=not) and uses Sobel edge
 * detection to composite an orange outline onto the backbuffer.
 * 
 * Usage:
 *   1. ObjectRendererGPU.renderSelectionMask() writes selected objects to the mask
 *   2. This renderer reads that mask and draws the outline
 * 
 * The outline pass should be called as a viewport-category pass (after post-processing)
 * so the outline is never affected by tonemapping, bloom, etc.
 */

import { GPUContext } from '../GPUContext';
import type { UnifiedGPUTexture } from '../GPUTexture';
import selectionOutlineShaderSource from '../shaders/selection-outline.wgsl?raw';

export interface SelectionOutlineParams {
  /** The r8unorm mask texture produced by ObjectRendererGPU.renderSelectionMask() */
  maskTexture: UnifiedGPUTexture;
  /** Output backbuffer view to composite onto */
  outputView: GPUTextureView;
  /** Viewport width in pixels */
  width: number;
  /** Viewport height in pixels */
  height: number;
  /** Outline thickness in pixels (default 2) */
  outlineWidth?: number;
  /** Outline color RGBA (default orange [1, 0.5, 0, 1]) */
  outlineColor?: [number, number, number, number];
}

/**
 * SelectionOutlineRendererGPU
 * 
 * Owns the outline pipeline, sampler, and uniform buffer.
 * Stateless per-frame — call render() each frame with fresh params.
 */
export class SelectionOutlineRendererGPU {
  private ctx: GPUContext;
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ---- Lazy pipeline init ----

  private ensurePipeline(): void {
    if (this.pipeline) return;

    const device = this.ctx.device;

    const shaderModule = device.createShaderModule({
      label: 'selection-outline-shader',
      code: selectionOutlineShaderSource,
    });

    this.pipeline = device.createRenderPipeline({
      label: 'selection-outline-pipeline',
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.ctx.format,
          blend: {
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
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = device.createSampler({
      label: 'selection-outline-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // OutlineParams: texelSize(vec2f) + outlineWidth(f32) + pad(f32) + outlineColor(vec4f) = 32 bytes
    this.uniformBuffer = device.createBuffer({
      label: 'selection-outline-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ---- Public API ----

  /**
   * Render the selection outline onto the backbuffer.
   * 
   * @param encoder - Active command encoder
   * @param params - Mask texture, output view, dimensions, optional style overrides
   */
  render(encoder: GPUCommandEncoder, params: SelectionOutlineParams): number {
    this.ensurePipeline();
    if (!this.pipeline || !this.sampler || !this.uniformBuffer) return 0;

    const outlineWidth = params.outlineWidth ?? 2.0;
    const outlineColor = params.outlineColor ?? [1.0, 0.5, 0.0, 1.0];

    // Write uniforms
    const data = new Float32Array(8);
    data[0] = 1.0 / params.width;
    data[1] = 1.0 / params.height;
    data[2] = outlineWidth;
    data[3] = 0.0; // pad
    data[4] = outlineColor[0];
    data[5] = outlineColor[1];
    data[6] = outlineColor[2];
    data[7] = outlineColor[3];
    this.ctx.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Create bind group for this frame (mask texture may change on resize)
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'selection-outline-bindgroup',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: params.maskTexture.view },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: 'selection-outline-pass',
      colorAttachments: [{
        view: params.outputView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
    
    return 1;
  }

  // ---- Cleanup ----

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.pipeline = null;
    this.sampler = null;
    this.uniformBuffer = null;
  }
}