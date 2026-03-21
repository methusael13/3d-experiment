/**
 * CloudCompositeEffect — Post-process effect that composites volumetric cloud
 * ray march output into the scene color buffer.
 *
 * Reads the cloud texture (RGB = scattered light, A = transmittance) and
 * blends it with the scene, respecting scene depth so clouds appear behind
 * opaque geometry but in front of the sky.
 *
 * Phase 3: The cloud texture is now at half resolution. The composite shader
 * performs bilateral upscale to full resolution, using scene depth for
 * edge-preserving filtering at geometry boundaries.
 *
 * Inserted at order 125 in the PostProcessPipeline (before AtmosphericFog @150).
 */

import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import compositeShader from '../shaders/cloud-composite.wgsl?raw';

// Uniform size: mat4x4f (64) + { near, far, cloudTexWidth, cloudTexHeight, cirrusOpacity, cirrusWindX, cirrusWindY, pad } (32) = 96 bytes
const UNIFORM_SIZE = 96;

export class CloudCompositeEffect extends BaseEffect {
  readonly name = 'cloudComposite';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs: string[] = [];

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Cloud texture view set externally each frame
  private _cloudTextureView: GPUTextureView | null = null;

  // Cloud texture dimensions (half-res, set externally)
  private _cloudTexWidth = 0;
  private _cloudTexHeight = 0;

  // Cirrus params (Phase 5)
  private _cirrusOpacity = 0;
  private _cirrusWindOffsetX = 0;
  private _cirrusWindOffsetY = 0;

  // Inverse view-projection matrix for world-space cirrus projection
  private _inverseViewProj: Float32Array = new Float32Array(16);

  constructor() {
    super();
  }

  /**
   * Set the cloud texture view and its dimensions.
   * Called by the pipeline each frame before execute.
   * @param view  The cloud texture view (half-res, temporally filtered)
   * @param width  Half-res cloud texture width
   * @param height Half-res cloud texture height
   */
  setCloudTexture(view: GPUTextureView | null, width?: number, height?: number): void {
    this._cloudTextureView = view;
    if (width !== undefined) this._cloudTexWidth = width;
    if (height !== undefined) this._cloudTexHeight = height;
  }

  /**
   * Set cirrus layer parameters (Phase 5).
   * @param opacity 0 = no cirrus, 1 = dense cirrus
   * @param windOffsetX Wind-driven UV offset X (accumulated over time)
   * @param windOffsetY Wind-driven UV offset Y
   */
  setCirrusParams(opacity: number, windOffsetX: number, windOffsetY: number): void {
    this._cirrusOpacity = opacity;
    this._cirrusWindOffsetX = windOffsetX;
    this._cirrusWindOffsetY = windOffsetY;
  }

  /**
   * Set the inverse view-projection matrix for world-space cirrus projection.
   * Called each frame by the pipeline before execute.
   */
  setInverseViewProj(matrix: Float32Array): void {
    this._inverseViewProj.set(matrix);
  }

  // ========== Lifecycle ==========

  protected onInit(): void {
    this.createPipeline();
    this.createResources();
  }

  protected onDestroy(): void {
    this.uniformBuffer?.destroy();
  }

  // ========== Execute ==========

  execute(ctx: EffectContext): void {
    if (!this.pipeline || !this.sampler || !this.uniformBuffer) return;
    if (!this._cloudTextureView) return;

    const { encoder, uniforms } = ctx;
    const colorTexture = ctx.getTexture('color');
    const depthTexture = ctx.getTexture('depth');

    // Upload uniforms: mat4x4f inverseViewProj (64 bytes) + scalars (32 bytes) = 96 bytes
    // Write mat4 at offset 0
    this.ctx.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      this._inverseViewProj.buffer,
      this._inverseViewProj.byteOffset,
      this._inverseViewProj.byteLength
    );
    // Write scalars at offset 64
    const scalars = new Float32Array(8);
    scalars[0] = uniforms.near;
    scalars[1] = uniforms.far;
    scalars[2] = this._cloudTexWidth;
    scalars[3] = this._cloudTexHeight;
    scalars[4] = this._cirrusOpacity;
    scalars[5] = this._cirrusWindOffsetX;
    scalars[6] = this._cirrusWindOffsetY;
    scalars[7] = 0; // _pad
    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 64, scalars);

    // Copy scene color to temp buffer (scene-color-hdr has copySrc usage)
    const tempBuffer = ctx.acquireBuffer('rgba16float', 'cloud-composite-input');
    encoder.copyTextureToTexture(
      { texture: colorTexture.texture },
      { texture: tempBuffer.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'cloud-composite-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempBuffer.view },
        { binding: 1, resource: depthTexture.view },
        { binding: 2, resource: this._cloudTextureView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });

    // Render to scene color texture
    const pass = encoder.beginRenderPass({
      label: 'cloud-composite-pass',
      colorAttachments: [{
        view: colorTexture.view,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    ctx.fullscreenQuad.draw(pass);
    pass.end();

    ctx.releaseBuffer(tempBuffer);
  }

  // ========== Private ==========

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'cloud-composite-shader',
      code: compositeShader,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'cloud-composite-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private createResources(): void {
    this.sampler = this.ctx.device.createSampler({
      label: 'cloud-composite-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'cloud-composite-uniforms',
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}
