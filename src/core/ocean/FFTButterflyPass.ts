/**
 * FFTButterflyPass - Reusable 2D inverse FFT via Cooley-Tukey butterfly compute passes.
 *
 * Performs log₂(N) horizontal passes + log₂(N) vertical passes on a ping-pong
 * pair of rg32float textures to compute a 2D IFFT.
 *
 * Usage:
 *   1. Write frequency-domain data to the input texture
 *   2. Call execute(encoder, inputView, outputView) — result lands in the output texture
 *   3. The output contains real values in .r, imaginary (≈0) in .g
 */

import { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUBuffer } from '../gpu/GPUBuffer';
import fftButterflySource from '../gpu/shaders/ocean/fft-butterfly.wgsl?raw';

export class FFTButterflyPass {
  private ctx: GPUContext;
  private resolution: number;
  private logN: number;

  // Compute pipeline
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Per-pass uniform buffers — one for each butterfly dispatch.
  // We need 2 * logN total (logN horizontal + logN vertical).
  // Using separate buffers avoids the queue.writeBuffer() race where a single
  // buffer gets overwritten before the GPU reads previous values.
  private passUniformBuffers: UnifiedGPUBuffer[] = [];

  // Ping-pong textures (owned externally or created here)
  private pingTexture: GPUTexture | null = null;
  private pongTexture: GPUTexture | null = null;
  private pingView: GPUTextureView | null = null;
  private pongView: GPUTextureView | null = null;

  constructor(ctx: GPUContext, resolution: number) {
    this.ctx = ctx;
    this.resolution = resolution;
    this.logN = Math.log2(resolution);

    if (!Number.isInteger(this.logN)) {
      throw new Error(`FFT resolution must be power of 2, got ${resolution}`);
    }

    this.createPipeline();
    this.createPassUniformBuffers();
    this.createPingPongTextures();
  }

  private createPipeline(): void {
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'fft-butterfly-shader',
      code: fftButterflySource,
    });

    this.bindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'fft-butterfly-bind-group-layout',
      entries: [
        // binding 0: input texture (read)
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        // binding 1: output texture (write)
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
        // binding 2: uniform buffer
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'fft-butterfly-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.ctx.device.createComputePipeline({
      label: 'fft-butterfly-pipeline',
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });
  }

  /**
   * Create one uniform buffer per butterfly dispatch (2 * logN total).
   * Each buffer is pre-written with the correct passIndex / isVertical / etc.
   * values so we never have to call queue.writeBuffer() at render time.
   */
  private createPassUniformBuffers(): void {
    const totalPasses = 2 * this.logN;

    for (let i = 0; i < totalPasses; i++) {
      const isVertical = i >= this.logN;
      const passIndex = isVertical ? (i - this.logN) : i;

      const buf = UnifiedGPUBuffer.createUniform(this.ctx, {
        label: `fft-butterfly-uniforms-${isVertical ? 'v' : 'h'}-${passIndex}`,
        size: 16, // 1 vec4 = 4 floats
      });

      buf.write(this.ctx, new Float32Array([
        this.resolution,
        passIndex,
        isVertical ? 1.0 : 0.0,
        this.logN,
      ]));

      this.passUniformBuffers.push(buf);
    }
  }

  private createPingPongTextures(): void {
    const desc: GPUTextureDescriptor = {
      label: 'fft-ping-pong',
      size: [this.resolution, this.resolution],
      format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    };

    this.pingTexture = this.ctx.device.createTexture({ ...desc, label: 'fft-ping' });
    this.pongTexture = this.ctx.device.createTexture({ ...desc, label: 'fft-pong' });
    this.pingView = this.pingTexture.createView({ label: 'fft-ping-view' });
    this.pongView = this.pongTexture.createView({ label: 'fft-pong-view' });
  }

  /**
   * Execute 2D IFFT on a frequency-domain texture.
   *
   * @param encoder - GPU command encoder (compute passes recorded inline)
   * @param inputTexture - Source rg32float texture (frequency domain, complex data)
   * @param outputTexture - Destination rg32float texture (spatial domain, real in .r)
   *
   * The method copies inputTexture → ping, runs horizontal butterfly passes
   * (ping ↔ pong), then vertical butterfly passes, and copies the result to outputTexture.
   */
  execute(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (!this.pipeline || !this.bindGroupLayout || !this.pingTexture || !this.pongTexture) {
      return;
    }

    const N = this.resolution;

    // Copy input → ping (starting point for butterfly passes)
    encoder.copyTextureToTexture(
      { texture: inputTexture },
      { texture: this.pingTexture },
      [N, N],
    );

    // Run all 2 * logN butterfly passes using pre-created uniform buffers
    const totalPasses = 2 * this.logN;
    for (let i = 0; i < totalPasses; i++) {
      const readFromPing = i % 2 === 0;
      const readView = readFromPing ? this.pingView! : this.pongView!;
      const writeView = readFromPing ? this.pongView! : this.pingView!;

      const bindGroup = this.ctx.device.createBindGroup({
        label: `fft-butterfly-bg-${i}`,
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: readView },
          { binding: 1, resource: writeView },
          { binding: 2, resource: { buffer: this.passUniformBuffers[i].buffer } },
        ],
      });

      const computePass = encoder.beginComputePass({
        label: `fft-butterfly-pass-${i}`,
      });
      computePass.setPipeline(this.pipeline!);
      computePass.setBindGroup(0, bindGroup);
      // Dispatch: N threads along FFT axis, N rows/columns perpendicular
      computePass.dispatchWorkgroups(
        Math.ceil(this.resolution / 256),
        this.resolution,
      );
      computePass.end();
    }

    // Copy result → output
    // After totalPasses dispatches, result is in ping if totalPasses is even, pong if odd
    const resultTexture = totalPasses % 2 === 0 ? this.pingTexture : this.pongTexture;

    encoder.copyTextureToTexture(
      { texture: resultTexture },
      { texture: outputTexture },
      [N, N],
    );
  }

  /**
   * Get the resolution of this FFT pass
   */
  getResolution(): number {
    return this.resolution;
  }

  destroy(): void {
    this.pingTexture?.destroy();
    this.pongTexture?.destroy();
    for (const buf of this.passUniformBuffers) {
      buf.destroy();
    }
    this.passUniformBuffers = [];
    this.pingTexture = null;
    this.pongTexture = null;
    this.pingView = null;
    this.pongView = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
