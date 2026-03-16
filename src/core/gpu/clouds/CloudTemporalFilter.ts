/**
 * CloudTemporalFilter — Temporal reprojection for volumetric clouds
 *
 * Phase 3: Manages ping-pong history buffers and dispatches the temporal
 * reprojection compute shader. Merges the current frame's checkerboard
 * ray march result with the previous frame's history for smooth, stable
 * cloud rendering at half the ray march cost.
 *
 * The filter also generates a 128×128 blue noise texture used by the
 * ray marcher for dithered ray start offsets.
 */

import { GPUContext } from '../GPUContext';
import { CLOUD_TEMPORAL_UNIFORM_SIZE, BLUE_NOISE_SIZE } from './types';

import temporalShader from '../shaders/clouds/cloud-temporal.wgsl?raw';

export class CloudTemporalFilter {
  private ctx: GPUContext;

  // Half-resolution dimensions (set during init)
  private width = 0;
  private height = 0;

  // Full-resolution dimensions
  private fullWidth = 0;
  private fullHeight = 0;

  // Ping-pong history textures (A and B)
  private historyTextureA: GPUTexture | null = null;
  private historyTextureB: GPUTexture | null = null;
  private historyViewA: GPUTextureView | null = null;
  private historyViewB: GPUTextureView | null = null;

  // Output texture (the resolved cloud result, same as half-res)
  private _outputTexture: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  // Frame counter for ping-pong and checkerboard pattern
  private _frameIndex = 0;

  // Pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffer
  private uniformBuffer: GPUBuffer | null = null;

  // Blue noise texture for dithering
  private _blueNoiseTexture: GPUTexture | null = null;
  private _blueNoiseView: GPUTextureView | null = null;

  // Temporal blend weight (0.65 = 65% history, 35% current — fast convergence during motion)
  private blendWeight = 0.65;

  // Checkerboard enabled
  private checkerboardEnabled = true;

  // Previous frame's view-projection matrix (for motion vector generation)
  private _prevViewProj = new Float32Array(16);
  // Current frame's inverse view-projection matrix
  private _inverseViewProj = new Float32Array(16);
  // Whether prevViewProj has been set at least once (first frame has no valid history)
  private _hasPrevViewProj = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ========== Accessors ==========

  get outputView(): GPUTextureView | null { return this._outputView; }
  get blueNoiseView(): GPUTextureView | null { return this._blueNoiseView; }
  get frameIndex(): number { return this._frameIndex; }

  /** Get the current history texture view (for debug visualization) */
  get historyView(): GPUTextureView | null {
    // The "current history" is the one we just wrote to (output),
    // so the "old history" is the one we read from this frame.
    return (this._frameIndex % 2 === 0) ? this.historyViewA : this.historyViewB;
  }

  // ========== Initialization ==========

  /**
   * Initialize the temporal filter.
   * @param halfWidth  Half-resolution width  (cloud ray march output width)
   * @param halfHeight Half-resolution height (cloud ray march output height)
   * @param fullWidth  Full viewport width
   * @param fullHeight Full viewport height
   */
  init(halfWidth: number, halfHeight: number, fullWidth: number, fullHeight: number): void {
    this.width = halfWidth;
    this.height = halfHeight;
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;

    const device = this.ctx.device;

    // Create ping-pong history textures
    this.createHistoryTextures();

    // Create output texture
    this.createOutputTexture();

    // Generate blue noise texture
    this.generateBlueNoise();

    // Bind group layout
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cloud-temporal-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
      ],
    });

    // Pipeline
    const module = device.createShaderModule({
      label: 'cloud-temporal-shader',
      code: temporalShader,
    });
    this.pipeline = device.createComputePipeline({
      label: 'cloud-temporal-pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: { module, entryPoint: 'main' },
    });

    // Uniform buffer
    this.uniformBuffer = device.createBuffer({
      label: 'cloud-temporal-uniform',
      size: CLOUD_TEMPORAL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ========== Texture Creation ==========

  private createHistoryTextures(): void {
    this.historyTextureA?.destroy();
    this.historyTextureB?.destroy();

    const desc: GPUTextureDescriptor = {
      label: 'cloud-history-A',
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    };

    this.historyTextureA = this.ctx.device.createTexture(desc);
    this.historyViewA = this.historyTextureA.createView({ label: 'cloud-history-A-view' });

    desc.label = 'cloud-history-B';
    this.historyTextureB = this.ctx.device.createTexture(desc);
    this.historyViewB = this.historyTextureB.createView({ label: 'cloud-history-B-view' });
  }

  private createOutputTexture(): void {
    this._outputTexture?.destroy();

    this._outputTexture = this.ctx.device.createTexture({
      label: 'cloud-temporal-output',
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this._outputView = this._outputTexture.createView({ label: 'cloud-temporal-output-view' });
  }

  // ========== Blue Noise ==========

  /**
   * Generate a 128×128 blue noise texture (r8unorm) using interleaved gradient
   * noise on the CPU. This is a simple but effective approximation — not true
   * blue noise, but combined with per-frame rotation it produces smooth results.
   */
  private generateBlueNoise(): void {
    this._blueNoiseTexture?.destroy();

    const size = BLUE_NOISE_SIZE;
    const data = new Uint8Array(size * size);

    // Generate using a hash-based approach that approximates blue noise distribution
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Interleaved gradient noise (Jimenez 2014)
        const v = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1.0)) % 1.0;
        // Additional hash pass for better distribution
        const hash = this.hashNoise(x, y);
        // Blend IGN with hash for a more uniform distribution
        const value = ((v + hash) * 0.5) % 1.0;
        data[y * size + x] = Math.floor(Math.abs(value) * 255);
      }
    }

    this._blueNoiseTexture = this.ctx.device.createTexture({
      label: 'blue-noise-128',
      size: { width: size, height: size },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.ctx.device.queue.writeTexture(
      { texture: this._blueNoiseTexture },
      data,
      { bytesPerRow: size },
      { width: size, height: size },
    );

    this._blueNoiseView = this._blueNoiseTexture.createView({ label: 'blue-noise-128-view' });
  }

  /** Simple integer hash for noise generation */
  private hashNoise(x: number, y: number): number {
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    n = n ^ (n >> 16);
    return (n & 0x7fffffff) / 0x7fffffff;
  }

  // ========== Resize ==========

  resize(halfWidth: number, halfHeight: number, fullWidth: number, fullHeight: number): void {
    if (this.width === halfWidth && this.height === halfHeight) return;
    this.width = halfWidth;
    this.height = halfHeight;
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
    this.createHistoryTextures();
    this.createOutputTexture();
    // Reset frame index to force fresh accumulation after resize
    this._frameIndex = 0;
  }

  // ========== Execute ==========

  /**
   * Set the matrices needed for motion vector generation.
   * Must be called before execute() each frame.
   * @param prevViewProj     Previous frame's view-projection matrix
   * @param inverseViewProj  Current frame's inverse view-projection matrix
   */
  setMatrices(prevViewProj: Float32Array, inverseViewProj: Float32Array): void {
    this._prevViewProj.set(prevViewProj);
    this._inverseViewProj.set(inverseViewProj);
    this._hasPrevViewProj = true;
  }

  /** Returns true once setMatrices has been called at least once (first frame has no valid prev VP) */
  get hasPrevViewProj(): boolean { return this._hasPrevViewProj; }

  /**
   * Dispatch the temporal reprojection compute shader.
   * @param encoder     GPU command encoder
   * @param currentView The current frame's ray march output view (half-res)
   */
  execute(encoder: GPUCommandEncoder, currentView: GPUTextureView): void {
    if (!this.pipeline || !this.uniformBuffer || !this._outputView) return;
    if (!this.historyViewA || !this.historyViewB) return;

    // Determine which history buffer is "read" (previous frame) and which is "write" (output)
    // Even frames: read from A, write output (which gets copied to B at end)
    // Odd frames:  read from B, write output (which gets copied to A at end)
    const readHistory = (this._frameIndex % 2 === 0) ? this.historyViewA : this.historyViewB;
    const writeHistoryTexture = (this._frameIndex % 2 === 0) ? this.historyTextureB! : this.historyTextureA!;

    // Upload uniforms
    this.uploadUniforms();

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'cloud-temporal-bg',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: currentView },
        { binding: 2, resource: readHistory },
        { binding: 3, resource: this._outputView },
      ],
    });

    // Dispatch
    const pass = encoder.beginComputePass({ label: 'cloud-temporal-pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    const wgX = Math.ceil(this.width / 8);
    const wgY = Math.ceil(this.height / 8);
    pass.dispatchWorkgroups(wgX, wgY);
    pass.end();

    // Copy output to the write history buffer for next frame
    encoder.copyTextureToTexture(
      { texture: this._outputTexture! },
      { texture: writeHistoryTexture },
      { width: this.width, height: this.height },
    );

    // Advance frame
    this._frameIndex++;
  }

  // ========== Uniform Upload ==========

  private uploadUniforms(): void {
    const data = new ArrayBuffer(CLOUD_TEMPORAL_UNIFORM_SIZE);
    const uint32 = new Uint32Array(data);
    const float32 = new Float32Array(data);

    // resolution (vec2u) [0..1]
    uint32[0] = this.width;
    uint32[1] = this.height;
    // frameIndex (u32) [2]
    uint32[2] = this._frameIndex;
    // blendWeight (f32) [3]
    float32[3] = this.blendWeight;
    // fullResolution (vec2u) [4..5]
    uint32[4] = this.fullWidth;
    uint32[5] = this.fullHeight;
    // checkerboard (u32) [6]
    uint32[6] = this.checkerboardEnabled ? 1 : 0;
    // _pad0 [7]
    float32[7] = 0;

    // prevViewProj (mat4x4f) [8..23] — 16 floats starting at byte offset 32
    float32.set(this._prevViewProj, 8);

    // inverseViewProj (mat4x4f) [24..39] — 16 floats starting at byte offset 96
    float32.set(this._inverseViewProj, 24);

    this.ctx.device.queue.writeBuffer(this.uniformBuffer!, 0, data);
  }

  // ========== Configuration ==========

  setBlendWeight(weight: number): void {
    this.blendWeight = Math.max(0, Math.min(1, weight));
  }

  setCheckerboardEnabled(enabled: boolean): void {
    this.checkerboardEnabled = enabled;
  }

  // ========== Cleanup ==========

  destroy(): void {
    this.historyTextureA?.destroy();
    this.historyTextureB?.destroy();
    this._outputTexture?.destroy();
    this._blueNoiseTexture?.destroy();
    this.uniformBuffer?.destroy();

    this.historyTextureA = null;
    this.historyTextureB = null;
    this.historyViewA = null;
    this.historyViewB = null;
    this._outputTexture = null;
    this._outputView = null;
    this._blueNoiseTexture = null;
    this._blueNoiseView = null;
    this.uniformBuffer = null;
  }
}
