/**
 * DebugViewPass — Fullscreen debug visualization overlay.
 * 
 * Renders the entire viewport showing depth, normals, or SSR buffers.
 * Category: viewport (renders AFTER post-processing, replaces backbuffer content).
 * Priority: after debug pass but before gizmos.
 */

import { BaseRenderPass, PassPriority, type PassCategory } from '../RenderPass';
import type { RenderContext } from '../RenderContext';
import { GPUContext } from '../../GPUContext';
import { UnifiedGPUTexture } from '../../GPUTexture';
import debugViewShaderSource from '../../shaders/debug-view.wgsl?raw';

export type DebugViewMode = 'off' | 'depth' | 'normals' | 'ssr';

const MODE_MAP: Record<DebugViewMode, number> = {
  off: 0,
  depth: 1,
  normals: 2,
  ssr: 3,
};

export class DebugViewPass extends BaseRenderPass {
  readonly name = 'debug-view';
  readonly priority = PassPriority.DEBUG + 50; // After debug textures, before gizmos
  readonly category: PassCategory = 'viewport';

  private ctx: GPUContext;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private mode: DebugViewMode = 'off';

  /** Provider for SSR texture (set by pipeline) */
  private ssrTextureProvider: (() => UnifiedGPUTexture | null) | null = null;

  constructor(ctx: GPUContext) {
    super();
    this.ctx = ctx;
    this.initGPU();
  }

  setMode(mode: DebugViewMode): void {
    this.mode = mode;
  }

  getMode(): DebugViewMode {
    return this.mode;
  }

  setSSRTextureProvider(provider: () => UnifiedGPUTexture | null): void {
    this.ssrTextureProvider = provider;
  }

  execute(ctx: RenderContext): void {
    if (this.mode === 'off' || !this.pipeline || !this.uniformBuffer) return;

    // Need depth copy for reading
    ctx.copyDepthForReading();

    // Get textures
    const depthView = ctx.depthTextureCopy.view;
    const normalsView = ctx.normalsTexture?.view;
    const ssrView = this.ssrTextureProvider?.()?.view;

    // Use placeholder for missing textures
    const placeholderView = ctx.sceneColorTexture?.view ?? ctx.outputView;

    // Update uniforms
    const data = new Float32Array(4);
    data[0] = MODE_MAP[this.mode];
    data[1] = ctx.near;
    data[2] = ctx.far;
    data[3] = 0;
    this.ctx.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'debug-view-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: depthView },
        { binding: 2, resource: normalsView ?? placeholderView },
        { binding: 3, resource: ssrView ?? placeholderView },
      ],
    });

    // Render fullscreen to backbuffer
    const pass = ctx.encoder.beginRenderPass({
      label: 'debug-view-pass',
      colorAttachments: [{
        view: ctx.outputView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();

    ctx.addDrawCalls(1);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
  }

  private initGPU(): void {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'debug-view-shader',
      code: debugViewShaderSource,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'debug-view-pipeline',
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.ctx.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'debug-view-uniforms',
      size: 16, // vec4f
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}