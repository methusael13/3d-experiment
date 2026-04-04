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
import type { GlobalDistanceField } from '../../sdf/GlobalDistanceField';
import debugViewShaderSource from '../../shaders/debug-view.wgsl?raw';

export type DebugViewMode = 'off' | 'depth' | 'normals' | 'ssr' | 'sdf';

const MODE_MAP: Record<DebugViewMode, number> = {
  off: 0,
  depth: 1,
  normals: 2,
  ssr: 3,
  sdf: 4,
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

  /** GDF reference for SDF debug visualization (set by GPUForwardPipeline) */
  private _gdf: GlobalDistanceField | null = null;

  // SDF visualization resources
  private sdfUniformBuffer: GPUBuffer | null = null;
  private sdfPlaceholder3D: GPUTexture | null = null;
  private sdfPlaceholder3DView: GPUTextureView | null = null;
  private sdfSampler: GPUSampler | null = null;

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

  /** Set the GDF reference for SDF debug visualization */
  setGDF(gdf: GlobalDistanceField | null): void {
    this._gdf = gdf;
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

    // Update uniforms: vec4(mode, near, far, sdfAvailable)
    const data = new Float32Array(4);
    data[0] = MODE_MAP[this.mode];
    data[1] = ctx.near;
    data[2] = ctx.far;
    data[3] = (this.mode === 'sdf' && this._gdf?.isReady) ? 1.0 : 0.0;
    this.ctx.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Update SDF uniforms for world position reconstruction + SDF sampling
    if (this.sdfUniformBuffer) {
      // Layout: mat4 inverseVP (64 bytes) + vec4 sdfCenter (16) + vec4 sdfExtent+voxelSize (16) = 96 bytes
      const sdfData = new Float32Array(24);
      // InverseVP matrix (for world position reconstruction from depth)
      if (ctx.inverseViewProjectionMatrix) {
        sdfData.set(new Float32Array(ctx.inverseViewProjectionMatrix.buffer, ctx.inverseViewProjectionMatrix.byteOffset, 16), 0);
      }
      // SDF params from GDF
      if (this._gdf?.isReady && this._gdf.consumerUniformBuffer) {
        // Consumer uniform is 8 floats: center(3)+pad, extent(3)+voxelSize
        // We read it from the GDF consumer uniform buffer data
        // For now, write directly from GDF cascade 0 info via getSampleView check
        const config = this._gdf.getConfig();
        const ext = config.cascadeExtents[0];
        // Center is dynamic (camera-following), but we can approximate with 0,0,0
        // Actually we need the actual center — let's just pass zeros and the shader
        // will read from the SDF uniform buffer in the bind group
      }
      // Placeholder SDF params (actual values come from the GDF consumer uniform in bind group)
      sdfData[16] = 0; sdfData[17] = 0; sdfData[18] = 0; sdfData[19] = 0; // center
      sdfData[20] = 32; sdfData[21] = 16; sdfData[22] = 32; sdfData[23] = 0.5; // extent + voxelSize
      this.ctx.queue.writeBuffer(this.sdfUniformBuffer, 0, sdfData);
    }

    // Get SDF 3D texture view (or placeholder)
    let sdf3DView = this.sdfPlaceholder3DView!;
    let sdfSamplerResource = this.sdfSampler!;
    let sdfParamsBuffer = this.sdfUniformBuffer!;
    if (this.mode === 'sdf' && this._gdf?.isReady) {
      sdf3DView = this._gdf.getSampleView(0) ?? this.sdfPlaceholder3DView!;
      sdfSamplerResource = this._gdf.sampler ?? this.sdfSampler!;
      sdfParamsBuffer = this._gdf.consumerUniformBuffer?.buffer ?? this.sdfUniformBuffer!;
    }

    // Create bind group
    // Note: binding 5 (sampler) is excluded — the shader uses textureLoad (not textureSampleLevel)
    // for r32float SDF textures, so the auto-layout doesn't include a sampler binding.
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'debug-view-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: depthView },
        { binding: 2, resource: normalsView ?? placeholderView },
        { binding: 3, resource: ssrView ?? placeholderView },
        // SDF resources (bindings 4, 6, 7 — no sampler needed for textureLoad)
        { binding: 4, resource: sdf3DView },
        { binding: 6, resource: { buffer: sdfParamsBuffer } },
        { binding: 7, resource: { buffer: this.sdfUniformBuffer! } }, // inverseVP + extra params
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
    this.sdfUniformBuffer?.destroy();
    this.sdfUniformBuffer = null;
    this.sdfPlaceholder3D?.destroy();
    this.sdfPlaceholder3D = null;
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

    // SDF debug resources
    this.sdfUniformBuffer = this.ctx.device.createBuffer({
      label: 'debug-view-sdf-uniforms',
      size: 96, // mat4 inverseVP (64) + vec4 center (16) + vec4 extent+voxel (16)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Placeholder 2×2×2 r32float 3D texture (SDF not available = max distance)
    this.sdfPlaceholder3D = this.ctx.device.createTexture({
      label: 'debug-sdf-placeholder-3d',
      size: [2, 2, 2],
      format: 'r32float',
      dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const placeholderData = new Float32Array(8).fill(999.0);
    this.ctx.queue.writeTexture(
      { texture: this.sdfPlaceholder3D },
      placeholderData,
      { bytesPerRow: 2 * 4, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 2 },
    );
    this.sdfPlaceholder3DView = this.sdfPlaceholder3D.createView({ dimension: '3d' });

    this.sdfSampler = this.ctx.device.createSampler({
      label: 'debug-sdf-sampler',
    });
  }
}
