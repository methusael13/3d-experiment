/**
 * FroxelGodRayEffect — Froxel-based volumetric scattering (directional light only)
 *
 * High-quality volumetric god rays using a frustum-aligned voxel (froxel) grid.
 * Each froxel samples CSM shadow maps and cloud shadow maps to determine sun
 * visibility, then accumulates Rayleigh + Mie scattering. A front-to-back
 * integration pass produces a 3D lookup texture that any pixel can sample.
 *
 * Grid: 160×90×64 with exponential depth slicing
 * Cost: ~0.5-1.5ms (directional light only in this Phase 4 version)
 *
 * Inserted at order 131 in the PostProcessPipeline (same slot as screen-space
 * god rays, but only one should be active at a time).
 */

import { mat4 } from 'gl-matrix';
import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import applyShader from '../shaders/froxel-god-rays-apply.wgsl?raw';
import scatterShader from '../shaders/froxel-god-rays.wgsl?raw';

// ========== Constants ==========

const FROXEL_WIDTH = 160;
const FROXEL_HEIGHT = 90;
const FROXEL_DEPTH = 64;

/** Uniform buffer size for froxel scatter pass (must match FroxelUniforms in WGSL, including alignment padding) */
const FROXEL_UNIFORM_SIZE = 224; // 56 floats × 4 bytes (rounded up for WGSL struct alignment)

/** Apply pass uniform size */
const APPLY_UNIFORM_SIZE = 16; // 4 floats × 4 bytes

// ========== Effect Class ==========

export class FroxelGodRayEffect extends BaseEffect {
  readonly name = 'froxelGodRays';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs: string[] = [];

  // GPU resources — 3D textures
  private scatterTexture: GPUTexture | null = null;
  private scatterTextureView: GPUTextureView | null = null;
  private integratedTexture: GPUTexture | null = null;
  private integratedTextureView: GPUTextureView | null = null;

  // Compute pipelines
  private scatterPipeline: GPUComputePipeline | null = null;
  private integratePipeline: GPUComputePipeline | null = null;

  // Render pipeline (apply pass)
  private applyPipeline: GPURenderPipeline | null = null;

  // Samplers and uniform buffers
  private linearSampler: GPUSampler | null = null;
  private comparisonSampler: GPUSampler | null = null;
  private froxelUniformBuffer: GPUBuffer | null = null;
  private csmUniformBuffer: GPUBuffer | null = null; // copy of CSM uniforms for compute
  private applyUniformBuffer: GPUBuffer | null = null;

  // Placeholder textures for when CSM/cloud shadow not available
  private placeholderDepthArray: GPUTexture | null = null;
  private placeholderDepthArrayView: GPUTextureView | null = null;
  private placeholderCloudShadow: GPUTexture | null = null;
  private placeholderCloudShadowView: GPUTextureView | null = null;

  // Per-frame data set by pipeline
  private sunDirection: [number, number, number] = [0.3, 0.8, 0.5];
  private sunColor: [number, number, number] = [1, 1, 0.95];
  private sunIntensity = 20;
  private sunVisibility = 1.0;
  private intensity = 0.5;

  // External resources (set per frame)
  private _csmShadowArrayView: GPUTextureView | null = null;
  private _csmUniformData: Float32Array | null = null;
  private _cloudShadowView: GPUTextureView | null = null;
  private _cloudShadowBounds: [number, number, number, number] = [0, 0, 1, 1]; // minX, minZ, maxX, maxZ
  private _cloudsEnabled = false;
  private _csmEnabled = false;

  constructor() {
    super();
  }

  // ========== Public API ==========

  setSunData(
    direction: [number, number, number],
    color: [number, number, number],
    intensity: number,
    visibility: number,
  ): void {
    this.sunDirection = direction;
    this.sunColor = color;
    this.sunIntensity = intensity;
    this.sunVisibility = visibility;
  }

  setIntensity(intensity: number): void {
    this.intensity = intensity;
  }

  /** Set CSM shadow resources for froxel shadow sampling */
  setCSMResources(
    shadowArrayView: GPUTextureView | null,
    uniformData: Float32Array | null,
  ): void {
    this._csmShadowArrayView = shadowArrayView;
    this._csmUniformData = uniformData;
    this._csmEnabled = shadowArrayView !== null && uniformData !== null;
  }

  /** Set cloud shadow resources */
  setCloudShadowResources(
    view: GPUTextureView | null,
    boundsMinX: number, boundsMinZ: number,
    boundsMaxX: number, boundsMaxZ: number,
  ): void {
    this._cloudShadowView = view;
    this._cloudShadowBounds = [boundsMinX, boundsMinZ, boundsMaxX, boundsMaxZ];
    this._cloudsEnabled = view !== null;
  }

  // ========== Lifecycle ==========

  protected onInit(): void {
    this.createTextures();
    this.createSamplers();
    this.createUniformBuffers();
    this.createPlaceholders();
    this.createComputePipelines();
    this.createApplyPipeline();
  }

  protected onDestroy(): void {
    this.scatterTexture?.destroy();
    this.integratedTexture?.destroy();
    this.froxelUniformBuffer?.destroy();
    this.csmUniformBuffer?.destroy();
    this.applyUniformBuffer?.destroy();
    this.placeholderDepthArray?.destroy();
    this.placeholderCloudShadow?.destroy();
  }

  // ========== Execute ==========
  
  execute(ctx: EffectContext): void {
    if (!this.scatterPipeline || !this.integratePipeline || !this.applyPipeline) return;
    if (!this.scatterTexture || !this.integratedTexture) return;
   
    const { encoder, uniforms } = ctx;
    const colorTexture = ctx.getTexture('color');
    const depthTexture = ctx.getTexture('depth');

    // Upload froxel uniforms
    this.uploadFroxelUniforms(uniforms);

    // Upload CSM uniforms copy
    if (this._csmUniformData && this.csmUniformBuffer) {
      this.ctx.device.queue.writeBuffer(this.csmUniformBuffer, 0, this._csmUniformData.buffer, this._csmUniformData.byteOffset, this._csmUniformData.byteLength);
    }

    // ===== Pass 1: Scatter compute =====
    const scatterBindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-scatter-bind-group',
      layout: this.scatterPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.froxelUniformBuffer! } },
        { binding: 1, resource: this.scatterTextureView! },
        { binding: 2, resource: this._csmShadowArrayView ?? this.placeholderDepthArrayView! },
        { binding: 3, resource: this.comparisonSampler! },
        { binding: 4, resource: { buffer: this.csmUniformBuffer! } },
        { binding: 5, resource: this._cloudShadowView ?? this.placeholderCloudShadowView! },
        { binding: 6, resource: this.linearSampler! },
      ],
    });

    const scatterPass = encoder.beginComputePass({ label: 'froxel-scatter-pass' });
    scatterPass.setPipeline(this.scatterPipeline);
    scatterPass.setBindGroup(0, scatterBindGroup);
    // Dispatch: ceil(160/8) × ceil(90/8) × ceil(64/1) = 20 × 12 × 64
    scatterPass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      FROXEL_DEPTH,
    );
    scatterPass.end();

    // ===== Pass 2: Integrate compute =====
    // Need to read scatterTexture as texture_3d, write to integratedTexture
    const scatterReadView = this.scatterTexture.createView({
      label: 'scatter-read-view',
      dimension: '3d',
    });

    const integrateBindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-integrate-bind-group',
      layout: this.integratePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: scatterReadView },
        { binding: 1, resource: this.integratedTextureView! },
      ],
    });

    // Integration needs its own group 0 bind group (different pipeline layout)
    // The integratePass entry point only references `u` (FroxelUniforms) from group 0
    // — the auto-layout only includes binding 0 (uniform buffer)
    const integrateGroup0 = this.ctx.device.createBindGroup({
      label: 'froxel-integrate-group0',
      layout: this.integratePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.froxelUniformBuffer! } },
      ],
    });

    const integratePass = encoder.beginComputePass({ label: 'froxel-integrate-pass' });
    integratePass.setPipeline(this.integratePipeline);
    integratePass.setBindGroup(0, integrateGroup0);
    integratePass.setBindGroup(1, integrateBindGroup);
    // Dispatch: ceil(160/8) × ceil(90/8) × 1 (each thread walks 64 depth slices)
    integratePass.dispatchWorkgroups(
      Math.ceil(FROXEL_WIDTH / 8),
      Math.ceil(FROXEL_HEIGHT / 8),
      1,
    );
    integratePass.end();

    // ===== Pass 3: Apply (fullscreen render) =====
    // Upload apply uniforms
    const applyData = new Float32Array(4);
    applyData[0] = uniforms.near;
    applyData[1] = uniforms.far;
    applyData[2] = uniforms.width;
    applyData[3] = uniforms.height;
    this.ctx.device.queue.writeBuffer(this.applyUniformBuffer!, 0, applyData);

    // Copy scene color for reading
    const tempBuffer = ctx.acquireBuffer('rgba16float', 'froxel-godray-input');
    encoder.copyTextureToTexture(
      { texture: colorTexture.texture },
      { texture: tempBuffer.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );

    const integratedReadView = this.integratedTexture.createView({
      label: 'integrated-read-view',
      dimension: '3d',
    });

    const applyBindGroup = this.ctx.device.createBindGroup({
      label: 'froxel-apply-bind-group',
      layout: this.applyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempBuffer.view },
        { binding: 1, resource: depthTexture.view },
        { binding: 2, resource: integratedReadView },
        { binding: 3, resource: this.linearSampler! },
        { binding: 4, resource: { buffer: this.applyUniformBuffer! } },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      label: 'froxel-apply-pass',
      colorAttachments: [{
        view: colorTexture.view,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.setPipeline(this.applyPipeline);
    renderPass.setBindGroup(0, applyBindGroup);
    ctx.fullscreenQuad.draw(renderPass);
    renderPass.end();

    ctx.releaseBuffer(tempBuffer);
  }

  // ========== Private — Resource Creation ==========

  private createTextures(): void {
    // Scatter texture (written by scatter pass, read by integrate pass)
    this.scatterTexture = this.ctx.device.createTexture({
      label: 'froxel-scatter-3d',
      size: { width: FROXEL_WIDTH, height: FROXEL_HEIGHT, depthOrArrayLayers: FROXEL_DEPTH },
      format: 'rgba16float',
      dimension: '3d',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.scatterTextureView = this.scatterTexture.createView({
      label: 'froxel-scatter-storage-view',
      dimension: '3d',
    });

    // Integrated texture (written by integrate pass, read by apply pass)
    this.integratedTexture = this.ctx.device.createTexture({
      label: 'froxel-integrated-3d',
      size: { width: FROXEL_WIDTH, height: FROXEL_HEIGHT, depthOrArrayLayers: FROXEL_DEPTH },
      format: 'rgba16float',
      dimension: '3d',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.integratedTextureView = this.integratedTexture.createView({
      label: 'froxel-integrated-storage-view',
      dimension: '3d',
    });
  }

  private createSamplers(): void {
    this.linearSampler = this.ctx.device.createSampler({
      label: 'froxel-linear-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    this.comparisonSampler = this.ctx.device.createSampler({
      label: 'froxel-comparison-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  private createUniformBuffers(): void {
    this.froxelUniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-uniforms',
      size: FROXEL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // CSM uniforms copy for compute shader (matches CSMUniformsCompact)
    // 4 mat4 + 3 vec4 = 304 bytes
    this.csmUniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-csm-uniforms',
      size: 304,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.applyUniformBuffer = this.ctx.device.createBuffer({
      label: 'froxel-apply-uniforms',
      size: APPLY_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private createPlaceholders(): void {
    // 1×1×1 depth array (for when CSM is disabled)
    this.placeholderDepthArray = this.ctx.device.createTexture({
      label: 'froxel-placeholder-depth-array',
      size: { width: 1, height: 1, depthOrArrayLayers: 4 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.placeholderDepthArrayView = this.placeholderDepthArray.createView({
      dimension: '2d-array',
    });

    // 1×1 cloud shadow (fully lit)
    this.placeholderCloudShadow = this.ctx.device.createTexture({
      label: 'froxel-placeholder-cloud-shadow',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.placeholderCloudShadowView = this.placeholderCloudShadow.createView();

    // Write 1.0 transmittance
    const data = new Uint16Array(4);
    data[0] = 0x3C00; // 1.0 in float16
    data[1] = 0;
    data[2] = 0;
    data[3] = 0;
    this.ctx.device.queue.writeTexture(
      { texture: this.placeholderCloudShadow },
      data.buffer,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
  }

  private createComputePipelines(): void {
    const scatterModule = this.ctx.device.createShaderModule({
      label: 'froxel-scatter-module',
      code: scatterShader,
    });

    this.scatterPipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-scatter-pipeline',
      layout: 'auto',
      compute: { module: scatterModule, entryPoint: 'scatterPass' },
    });

    this.integratePipeline = this.ctx.device.createComputePipeline({
      label: 'froxel-integrate-pipeline',
      layout: 'auto',
      compute: { module: scatterModule, entryPoint: 'integratePass' },
    });
  }

  private createApplyPipeline(): void {
    const applyModule = this.ctx.device.createShaderModule({
      label: 'froxel-apply-module',
      code: applyShader,
    });

    this.applyPipeline = this.ctx.device.createRenderPipeline({
      label: 'froxel-apply-pipeline',
      layout: 'auto',
      vertex: { module: applyModule, entryPoint: 'vs_main' },
      fragment: {
        module: applyModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ========== Uniform Upload ==========

  private uploadFroxelUniforms(uniforms: EffectContext['uniforms']): void {
    if (!this.froxelUniformBuffer) return;

    const data = new Float32Array(FROXEL_UNIFORM_SIZE / 4); // 48 floats

    // Compute inverse view-projection matrix
    const invViewProj = mat4.create();
    const vp = mat4.create();
    mat4.multiply(vp, uniforms.projectionMatrix as unknown as Float32Array, uniforms.viewMatrix as unknown as Float32Array);
    mat4.invert(invViewProj, vp);

    // inverseViewProj (16 floats, offset 0)
    data.set(new Float32Array(invViewProj as unknown as ArrayBuffer), 0);

    // cameraPosition (vec3f, offset 16)
    const invView = uniforms.inverseViewMatrix;
    data[16] = invView[12];
    data[17] = invView[13];
    data[18] = invView[14];

    // near (offset 19)
    data[19] = uniforms.near;
    // far (offset 20)
    data[20] = uniforms.far;
    // sunVisibility (offset 21)
    data[21] = this.sunVisibility;
    // _pad0, _pad1 (offset 22, 23)

    // sunDirection (vec3f, offset 24)
    data[24] = this.sunDirection[0];
    data[25] = this.sunDirection[1];
    data[26] = this.sunDirection[2];
    // sunIntensity (offset 27)
    data[27] = this.sunIntensity;

    // sunColor (vec3f, offset 28)
    const colorScale = Math.min(this.sunIntensity / 20.0, 2.0);
    data[28] = this.sunColor[0] * colorScale;
    data[29] = this.sunColor[1] * colorScale;
    data[30] = this.sunColor[2] * colorScale;
    // mieG (offset 31)
    data[31] = 0.76;

    // betaR (vec3f, offset 32) — Rayleigh scattering coefficients (physical values)
    // NOTE: These produce correct atmospheric scattering at Earth scale (hundreds of km)
    // but are nearly invisible at game scale (meters to km). Phase 6 should revisit
    // with a decoupled scattering/extinction model or scene-adaptive scaling.
    data[32] = 5.8e-6;
    data[33] = 13.5e-6;
    data[34] = 33.1e-6;
    // betaM (offset 35) — Mie scattering (physical)
    data[35] = 21e-6;

    // cloudsEnabled (offset 36)
    data[36] = this._cloudsEnabled ? 1.0 : 0.0;
    // cloudShadowBoundsMin (vec2f, offset 37)
    data[37] = this._cloudShadowBounds[0];
    data[38] = this._cloudShadowBounds[1];
    // cloudShadowBoundsMax (vec2f, offset 39)
    data[39] = this._cloudShadowBounds[2];
    data[40] = this._cloudShadowBounds[3];

    // csmEnabled (offset 41)
    data[41] = this._csmEnabled ? 1.0 : 0.0;
    // _pad2, _pad3, _pad4 (offset 42, 43, 44)

    // viewportWidth (offset 45)
    data[45] = uniforms.width;
    // viewportHeight (offset 46)
    data[46] = uniforms.height;
    // intensity (offset 47)
    data[47] = this.intensity;

    this.ctx.device.queue.writeBuffer(this.froxelUniformBuffer, 0, data);
  }
}
