/**
 * GodRayEffect — Screen-space radial blur god rays (volumetric light scattering)
 *
 * Projects the sun position to screen space, then performs a radial blur
 * sampling depth + cloud transmittance to produce light shafts through
 * cloud gaps and terrain features.
 *
 * Inserted at order 130 in the PostProcessPipeline:
 *   - After CloudComposite @125 (needs composited cloud transmittance)
 *   - Before AtmosphericFog @150
 *
 * Inputs: 'color' (scene HDR), 'depth' (scene depth)
 * Also reads cloud texture (set externally each frame).
 *
 * Cost: ~0.1-0.3ms at half-res with 64 samples.
 */

import { mat4, vec4 } from 'gl-matrix';
import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import godRayShader from '../shaders/god-rays.wgsl?raw';

// ========== Config ==========

/**
 * God ray configuration exposed to UI
 */
export interface GodRayConfig {
  /** Master enable for god ray effect */
  enabled: boolean;
  /** Intensity multiplier (0–2) */
  intensity: number;
  /** Number of radial blur samples (32, 64, or 128) */
  samples: number;
  /** Exponential decay per sample (0.9–0.99) */
  decay: number;
  /** Weight per sample contribution */
  weight: number;
  /** Density: controls the length of god ray shafts (0.5–2.0) */
  density: number;
}

export const DEFAULT_GOD_RAY_CONFIG: Required<GodRayConfig> = {
  enabled: false,
  intensity: 1.0,
  samples: 64,
  decay: 0.97,
  weight: 1.0,
  density: 1.0,
};

/**
 * Uniform buffer size in bytes.
 * Must match GodRayUniforms struct in god-rays.wgsl.
 *
 * Layout (64 bytes):
 *   vec2f  sunScreenPos    [0..7]
 *   f32    intensity        [8..11]
 *   f32    numSamples       [12..15]
 *   vec3f  sunColor         [16..27]
 *   f32    decay            [28..31]
 *   f32    near             [32..35]
 *   f32    far              [36..39]
 *   f32    sunVisibility    [40..43]
 *   f32    hasCloudTexture  [44..47]
 *   f32    cloudTexWidth    [48..51]
 *   f32    cloudTexHeight   [52..55]
 *   f32    weight           [56..59]
 *   f32    density          [60..63]
 */
const UNIFORM_SIZE = 64;

// ========== Effect Class ==========

export class GodRayEffect extends BaseEffect {
  readonly name = 'godRays';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs: string[] = [];

  private config: Required<GodRayConfig>;

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Placeholder 1×1 cloud texture (used when clouds are disabled)
  private placeholderCloudTexture: GPUTexture | null = null;
  private placeholderCloudView: GPUTextureView | null = null;

  // Per-frame data (set by pipeline before execute)
  private sunDirection: [number, number, number] = [0.3, 0.8, 0.5];
  private sunColor: [number, number, number] = [1, 1, 0.95];
  private sunIntensity: number = 20;
  private sunVisibility: number = 1.0;

  // Cloud texture view (set externally each frame, optional)
  private _cloudTextureView: GPUTextureView | null = null;
  private _cloudTexWidth = 0;
  private _cloudTexHeight = 0;

  constructor(config: Partial<GodRayConfig> = {}) {
    super();
    this.config = { ...DEFAULT_GOD_RAY_CONFIG, ...config };
  }

  // ========== Public API ==========

  setConfig(config: Partial<GodRayConfig>): void {
    Object.assign(this.config, config);
  }

  getConfig(): Required<GodRayConfig> {
    return { ...this.config };
  }

  /**
   * Called by the pipeline each frame to provide current sun data.
   */
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

  /**
   * Set the cloud texture view for cloud occlusion in god rays.
   * Pass null when clouds are disabled.
   */
  setCloudTexture(view: GPUTextureView | null, width?: number, height?: number): void {
    this._cloudTextureView = view;
    if (width !== undefined) this._cloudTexWidth = width;
    if (height !== undefined) this._cloudTexHeight = height;
  }

  // ========== Lifecycle ==========

  protected onInit(): void {
    this.createPipeline();
    this.createResources();
  }

  protected onDestroy(): void {
    this.uniformBuffer?.destroy();
    this.placeholderCloudTexture?.destroy();
  }

  // ========== Execute ==========

  execute(ctx: EffectContext): void {
    if (!this.pipeline || !this.sampler || !this.uniformBuffer) return;

    const { encoder, uniforms } = ctx;
    const colorTexture = ctx.getTexture('color');
    const depthTexture = ctx.getTexture('depth');

    // Compute sun screen-space position
    const sunScreenPos = this.computeSunScreenPosition(uniforms);

    // Upload uniforms
    this.uploadUniforms(uniforms, sunScreenPos);

    // Copy scene color to temp buffer
    const tempBuffer = ctx.acquireBuffer('rgba16float', 'god-rays-input');
    encoder.copyTextureToTexture(
      { texture: colorTexture.texture },
      { texture: tempBuffer.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );

    // Determine cloud texture view (use placeholder if no cloud texture)
    const cloudView = this._cloudTextureView ?? this.placeholderCloudView!;

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'god-rays-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempBuffer.view },
        { binding: 1, resource: depthTexture.view },
        { binding: 2, resource: cloudView },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });

    // Render god rays to scene color texture
    const pass = encoder.beginRenderPass({
      label: 'god-rays-pass',
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

  /**
   * Compute the sun's screen-space UV position by projecting the sun direction
   * through the view-projection matrix.
   *
   * Returns [u, v] in [0, 1] range. The sun may be off-screen, which is fine —
   * the radial blur still works correctly since it just defines the convergence point.
   */
  private computeSunScreenPosition(uniforms: EffectContext['uniforms']): [number, number] {
    // Sun direction → a far-away point in world space
    const sunWorldPos = vec4.fromValues(
      this.sunDirection[0] * 10000.0,
      this.sunDirection[1] * 10000.0,
      this.sunDirection[2] * 10000.0,
      1.0,
    );

    // Compute view-projection matrix
    const vp = mat4.create();
    mat4.multiply(vp, uniforms.projectionMatrix as unknown as mat4, uniforms.viewMatrix as unknown as mat4);

    // Project to clip space
    const clipPos = vec4.create();
    vec4.transformMat4(clipPos, sunWorldPos, vp);

    // Perspective divide → NDC
    if (clipPos[3] <= 0.0) {
      // Sun is behind the camera — return off-screen position
      // Use the opposite direction so god rays still emanate correctly
      return [-this.sunDirection[0] * 2.0 + 0.5, -this.sunDirection[1] * 2.0 + 0.5];
    }

    const ndcX = clipPos[0] / clipPos[3];
    const ndcY = clipPos[1] / clipPos[3];

    // NDC [-1, 1] → UV [0, 1]
    const u = ndcX * 0.5 + 0.5;
    const v = 1.0 - (ndcY * 0.5 + 0.5); // Flip Y to match texture UV convention

    return [u, v];
  }

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'god-rays-shader',
      code: godRayShader,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'god-rays-pipeline',
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
      label: 'god-rays-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'god-rays-uniforms',
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create 1×1 placeholder cloud texture (fully transparent = transmittance 1.0)
    // Used when clouds are disabled so the shader always has a valid texture binding
    this.placeholderCloudTexture = this.ctx.device.createTexture({
      label: 'god-rays-placeholder-cloud',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.placeholderCloudView = this.placeholderCloudTexture.createView();

    // Write transmittance=1.0 (fully clear sky) to placeholder
    // Use Uint16Array with float16 encoding (Float16Array not available in standard JS)
    const placeholderData = new Uint16Array(4);
    placeholderData[0] = 0;      // R = 0
    placeholderData[1] = 0;      // G = 0
    placeholderData[2] = 0;      // B = 0
    placeholderData[3] = 0x3C00; // A = 1.0 in float16
    this.ctx.device.queue.writeTexture(
      { texture: this.placeholderCloudTexture },
      placeholderData.buffer,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
  }

  /**
   * Pack GodRayUniforms and upload to GPU.
   *
   * Layout matches the WGSL struct (64 bytes):
   *   vec2f  sunScreenPos    [0..1]   (float offset 0..1)
   *   f32    intensity        [2]
   *   f32    numSamples       [3]
   *   vec3f  sunColor         [4..6]
   *   f32    decay            [7]
   *   f32    near             [8]
   *   f32    far              [9]
   *   f32    sunVisibility    [10]
   *   f32    hasCloudTexture  [11]
   *   f32    cloudTexWidth    [12]
   *   f32    cloudTexHeight   [13]
   *   f32    weight           [14]
   *   f32    density          [15]
   */
  private uploadUniforms(
    uniforms: EffectContext['uniforms'],
    sunScreenPos: [number, number],
  ): void {
    if (!this.uniformBuffer) return;

    const data = new Float32Array(UNIFORM_SIZE / 4); // 16 floats

    // sunScreenPos (vec2f, offset 0)
    data[0] = sunScreenPos[0];
    data[1] = sunScreenPos[1];

    // intensity (f32, offset 2)
    data[2] = this.config.intensity;

    // numSamples (f32, offset 3)
    data[3] = this.config.samples;

    // sunColor (vec3f, offset 4) — pass sun color directly in HDR
    // The sun intensity drives how bright the god ray shafts are
    // For standard sun intensity of 20, this gives sunColor ~ [20, 20, 19]
    // which matches the HDR scene brightness and produces visible shafts
    data[4] = this.sunColor[0] * this.sunIntensity;
    data[5] = this.sunColor[1] * this.sunIntensity;
    data[6] = this.sunColor[2] * this.sunIntensity;

    // decay (f32, offset 7)
    data[7] = this.config.decay;

    // near (f32, offset 8)
    data[8] = uniforms.near;

    // far (f32, offset 9)
    data[9] = uniforms.far;

    // sunVisibility (f32, offset 10)
    data[10] = this.sunVisibility;

    // hasCloudTexture (f32, offset 11)
    data[11] = this._cloudTextureView ? 1.0 : 0.0;

    // cloudTexWidth (f32, offset 12)
    data[12] = this._cloudTexWidth;

    // cloudTexHeight (f32, offset 13)
    data[13] = this._cloudTexHeight;

    // weight (f32, offset 14)
    data[14] = this.config.weight;

    // density (f32, offset 15)
    data[15] = this.config.density;

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }
}
