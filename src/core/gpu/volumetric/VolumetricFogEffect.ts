/**
 * VolumetricFogEffect — Post-process effect that applies froxel fog to the scene.
 *
 * Replaces AtmosphericFogEffect when volumetric fog is enabled.
 * Reads the integrated froxel 3D texture and composites accumulated
 * in-scattered light + transmittance with the scene color.
 *
 * The actual froxel compute passes (density injection, scattering, integration)
 * are orchestrated by VolumetricFogManager — this effect only handles the
 * final fullscreen application pass.
 *
 * Inserted at order 149 in PostProcessPipeline (just before AtmosphericFog at 150).
 */

import { BaseEffect, type EffectContext, type StandardInput } from '../postprocess/PostProcessPipeline';
import applyShader from '../shaders/volumetric/volumetric-fog-apply.wgsl?raw';

const APPLY_UNIFORM_SIZE = 16; // 4 floats

export class VolumetricFogEffect extends BaseEffect {
  readonly name = 'volumetricFog';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs: string[] = [];

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // External: set by VolumetricFogManager each frame
  private _integratedGridView: GPUTextureView | null = null;

  constructor() {
    super();
  }

  /** Set the integrated froxel 3D texture view for sampling */
  setIntegratedGrid(view: GPUTextureView | null): void {
    this._integratedGridView = view;
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
    if (!this._integratedGridView) return; // No froxel data — skip

    const { encoder, uniforms } = ctx;
    const colorTexture = ctx.getTexture('color');
    const depthTexture = ctx.getTexture('depth');

    // Upload apply uniforms
    const data = new Float32Array(4);
    data[0] = uniforms.near;
    data[1] = uniforms.far;
    data[2] = uniforms.width;
    data[3] = uniforms.height;
    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    // Copy scene color for reading
    const tempBuffer = ctx.acquireBuffer('rgba16float', 'volumetric-fog-input');
    encoder.copyTextureToTexture(
      { texture: colorTexture.texture },
      { texture: tempBuffer.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );

    const bindGroup = this.ctx.device.createBindGroup({
      label: 'volumetric-fog-apply-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempBuffer.view },
        { binding: 1, resource: depthTexture.view },
        { binding: 2, resource: this._integratedGridView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      label: 'volumetric-fog-apply-pass',
      colorAttachments: [{
        view: colorTexture.view,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, bindGroup);
    ctx.fullscreenQuad.draw(renderPass);
    renderPass.end();

    ctx.releaseBuffer(tempBuffer);
  }

  // ========== Private ==========

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'volumetric-fog-apply-shader',
      code: applyShader,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'volumetric-fog-apply-pipeline',
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
      label: 'volumetric-fog-apply-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'volumetric-fog-apply-uniforms',
      size: APPLY_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
}
