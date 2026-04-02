/**
 * FFTOceanSpectrum - GPU-computed FFT ocean wave system (Phase W2)
 *
 * Manages the full per-frame compute pipeline:
 *   1. Spectrum generation (once on parameter change) → H₀(k) texture
 *   2. Spectrum animation (every frame) → time-evolved H(k,t) textures
 *   3. Inverse FFT (every frame) → spatial-domain displacement fields
 *   4. Finalize (every frame) → displacement map + normal map
 *
 * Supports multiple cascades for different wavelength ranges.
 */

import { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUBuffer } from '../gpu/GPUBuffer';
import { FFTButterflyPass } from './FFTButterflyPass';
import type { DebugTextureManager } from '../gpu/renderers/DebugTextureManager';

import spectrumSource from '../gpu/shaders/ocean/ocean-spectrum.wgsl?raw';
import animateSource from '../gpu/shaders/ocean/ocean-animate.wgsl?raw';
import finalizeSource from '../gpu/shaders/ocean/ocean-finalize.wgsl?raw';

// ============================================================================
// Types
// ============================================================================

export type SpectrumType = 'phillips' | 'jonswap' | 'pierson-moskowitz';

export interface FFTOceanConfig {
  /** FFT resolution per cascade (must be power of 2) */
  resolution: 128 | 256 | 512;
  /** Number of cascades (1–3) */
  cascadeCount: 1 | 2 | 3;
  /** Tile sizes per cascade in meters [cascade0, cascade1, cascade2] */
  tileSizes: [number, number, number];
  /** Wind speed in m/s */
  windSpeed: number;
  /** Wind direction (normalized [x, z]) */
  windDirection: [number, number];
  /** Fetch distance in meters (affects spectrum shape) */
  fetch: number;
  /** Spectrum model */
  spectrumType: SpectrumType;
  /** Directional spread exponent (1=broad, 32=narrow) */
  directionalSpread: number;
  /** Global amplitude multiplier */
  amplitudeScale: number;
  /** Horizontal displacement strength */
  choppiness: number;
}

export function createDefaultFFTOceanConfig(): FFTOceanConfig {
  return {
    resolution: 256,
    cascadeCount: 3,
    tileSizes: [250, 37, 5],
    windSpeed: 8,
    windDirection: [1, 0],
    fetch: 10000,
    spectrumType: 'jonswap',
    directionalSpread: 8,
    amplitudeScale: 1.0,
    choppiness: 1.5,
  };
}

/** Per-cascade GPU resources */
interface CascadeResources {
  /** Initial spectrum H₀(k): rgba16float */
  spectrumTexture: GPUTexture;
  spectrumView: GPUTextureView;

  /** Animated frequency-domain textures (rg32float each) */
  dyFreqTexture: GPUTexture;
  dxFreqTexture: GPUTexture;
  dzFreqTexture: GPUTexture;

  /** IFFT output textures (rg32float, spatial domain) */
  dySpatialTexture: GPUTexture;
  dxSpatialTexture: GPUTexture;
  dzSpatialTexture: GPUTexture;

  /** Analytical slope frequency-domain textures (rg32float each) */
  slopeXFreqTexture: GPUTexture;
  slopeZFreqTexture: GPUTexture;

  /** Analytical slope IFFT output textures (rg32float, spatial domain) */
  slopeXSpatialTexture: GPUTexture;
  slopeZSpatialTexture: GPUTexture;

  /** Final output: displacement map (rgba16float: xyz = displacement) */
  displacementTexture: GPUTexture;
  displacementView: GPUTextureView;

  /** Final output: normal map (rgba16float: xyz = normal packed 0-1) */
  normalTexture: GPUTexture;
  normalView: GPUTextureView;

  /** FFT butterfly pass instance for this cascade */
  fftPass: FFTButterflyPass;

  /** Whether the spectrum needs regeneration */
  spectrumDirty: boolean;
}

// ============================================================================
// FFTOceanSpectrum
// ============================================================================

export class FFTOceanSpectrum {
  private ctx: GPUContext;
  private config: FFTOceanConfig;

  // Compute pipelines
  private spectrumPipeline: GPUComputePipeline | null = null;
  private spectrumBindGroupLayout: GPUBindGroupLayout | null = null;
  private animatePipeline: GPUComputePipeline | null = null;
  private animateBindGroupLayout: GPUBindGroupLayout | null = null;
  private finalizePipeline: GPUComputePipeline | null = null;
  private finalizeBindGroupLayout: GPUBindGroupLayout | null = null;

  // Uniform buffers
  private spectrumUniformBuffer: UnifiedGPUBuffer | null = null;
  // Per-cascade uniform buffers — each cascade needs its own buffer because
  // queue.writeBuffer() takes effect immediately (last-writer-wins race).
  // With a shared buffer, only the last cascade's values would be used by all dispatches.
  private animateUniformBuffers: UnifiedGPUBuffer[] = [];
  private finalizeUniformBuffers: UnifiedGPUBuffer[] = [];

  // Per-cascade resources
  private cascades: CascadeResources[] = [];

  // Sampler for displacement/normal map sampling in render shader
  private _sampler: GPUSampler | null = null;

  // Random seed (fixed per spectrum generation for deterministic waves)
  private seed: [number, number] = [Math.random() * 100, Math.random() * 100];

  private isInitialized = false;

  constructor(ctx: GPUContext, config?: Partial<FFTOceanConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultFFTOceanConfig(), ...config };
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  initialize(): void {
    if (this.isInitialized) return;

    this.createPipelines();
    this.createUniformBuffers();
    this.createCascadeResources();
    this.createSampler();

    this.isInitialized = true;
    console.log(`[FFTOceanSpectrum] Initialized: ${this.config.cascadeCount} cascades @ ${this.config.resolution}²`);
  }

  private createPipelines(): void {
    // ---- Spectrum generation pipeline ----
    this.spectrumBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'ocean-spectrum-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.spectrumPipeline = this.ctx.device.createComputePipeline({
      label: 'ocean-spectrum-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.spectrumBindGroupLayout],
      }),
      compute: {
        module: this.ctx.device.createShaderModule({ code: spectrumSource, label: 'ocean-spectrum-shader' }),
        entryPoint: 'main',
      },
    });

    // ---- Animation pipeline ----
    this.animateBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'ocean-animate-bgl',
      entries: [
        // Spectrum texture is rgba16float which is 'float' (filterable), NOT 'unfilterable-float'
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        // Analytical slope outputs for frequency-domain normals (Tessendorf method)
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
      ],
    });

    this.animatePipeline = this.ctx.device.createComputePipeline({
      label: 'ocean-animate-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.animateBindGroupLayout],
      }),
      compute: {
        module: this.ctx.device.createShaderModule({ code: animateSource, label: 'ocean-animate-shader' }),
        entryPoint: 'main',
      },
    });

    // ---- Finalize pipeline ----
    this.finalizeBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'ocean-finalize-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        // Analytical slope spatial-domain inputs (IFFT'd from frequency-domain slopes)
        { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    this.finalizePipeline = this.ctx.device.createComputePipeline({
      label: 'ocean-finalize-pipeline',
      layout: this.ctx.device.createPipelineLayout({
        bindGroupLayouts: [this.finalizeBindGroupLayout],
      }),
      compute: {
        module: this.ctx.device.createShaderModule({ code: finalizeSource, label: 'ocean-finalize-shader' }),
        entryPoint: 'main',
      },
    });
  }

  private createUniformBuffers(): void {
    // Spectrum: 4 vec4 = 64 bytes
    this.spectrumUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'ocean-spectrum-uniforms',
      size: 64,
    });

    // Per-cascade animate + finalize uniform buffers (created in createCascadeResources)
    // These are created per-cascade to avoid queue.writeBuffer() race conditions
    // where multiple cascades overwrite the same buffer before the encoder submits.
  }

  private createCascadeResources(): void {
    const N = this.config.resolution;
    const count = this.config.cascadeCount;

    for (let i = 0; i < count; i++) {
      const label = `ocean-cascade-${i}`;

      // rg32float textures for frequency/spatial domain (complex data)
      const rg32Desc: GPUTextureDescriptor = {
        size: [N, N],
        format: 'rg32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      };

      // rgba16float textures for final output (displacement, normal) + spectrum
      const rgba16StorageDesc: GPUTextureDescriptor = {
        size: [N, N],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      };

      const spectrumTexture = this.ctx.device.createTexture({ ...rgba16StorageDesc, label: `${label}-spectrum` });
      const dyFreqTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dy-freq` });
      const dxFreqTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dx-freq` });
      const dzFreqTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dz-freq` });
      const dySpatialTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dy-spatial` });
      const dxSpatialTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dx-spatial` });
      const dzSpatialTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-dz-spatial` });
      const displacementTexture = this.ctx.device.createTexture({ ...rgba16StorageDesc, label: `${label}-displacement` });
      const normalTexture = this.ctx.device.createTexture({ ...rgba16StorageDesc, label: `${label}-normal` });

      // Analytical slope textures for frequency-domain normals (Tessendorf method)
      const slopeXFreqTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-slopeX-freq` });
      const slopeZFreqTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-slopeZ-freq` });
      const slopeXSpatialTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-slopeX-spatial` });
      const slopeZSpatialTexture = this.ctx.device.createTexture({ ...rg32Desc, label: `${label}-slopeZ-spatial` });

      this.cascades.push({
        spectrumTexture,
        spectrumView: spectrumTexture.createView(),
        dyFreqTexture,
        dxFreqTexture,
        dzFreqTexture,
        dySpatialTexture,
        dxSpatialTexture,
        dzSpatialTexture,
        slopeXFreqTexture,
        slopeZFreqTexture,
        slopeXSpatialTexture,
        slopeZSpatialTexture,
        displacementTexture,
        displacementView: displacementTexture.createView(),
        normalTexture,
        normalView: normalTexture.createView(),
        fftPass: new FFTButterflyPass(this.ctx, N),
        spectrumDirty: true,
      });

      // Create per-cascade animate + finalize uniform buffers
      this.animateUniformBuffers.push(UnifiedGPUBuffer.createUniform(this.ctx, {
        label: `ocean-animate-uniforms-${i}`,
        size: 16,
      }));
      this.finalizeUniformBuffers.push(UnifiedGPUBuffer.createUniform(this.ctx, {
        label: `ocean-finalize-uniforms-${i}`,
        size: 16,
      }));
    }
  }

  private createSampler(): void {
    this._sampler = this.ctx.device.createSampler({
      label: 'ocean-fft-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
  }

  // ============================================================================
  // Per-Frame Update
  // ============================================================================

  /**
   * Run the full FFT ocean compute pipeline for the current frame.
   * Records compute passes into the provided command encoder.
   *
   * Spectrum generation (when dirty) is submitted as a separate command buffer
   * to avoid a WebGPU resource hazard: the spectrum storage texture must be fully
   * flushed before the animate pass can read it via textureLoad(). Submitting a
   * separate encoder + device.queue.submit() guarantees this.
   */
  update(encoder: GPUCommandEncoder, time: number): void {
    if (!this.isInitialized) return;

    const N = this.config.resolution;
    const workgroups = Math.ceil(N / 8);

    // Step 1: If any cascade needs spectrum regeneration, do it in a separate
    // command buffer submission to ensure the storage texture write is visible
    // to subsequent compute passes that read it as a sampled texture.
    let anyDirty = false;
    for (const cascade of this.cascades) {
      if (cascade.spectrumDirty) { anyDirty = true; break; }
    }

    if (anyDirty) {
      const specEncoder = this.ctx.device.createCommandEncoder({ label: 'ocean-spectrum-encoder' });
      for (let i = 0; i < this.cascades.length; i++) {
        const cascade = this.cascades[i];
        if (!cascade.spectrumDirty) continue;
        const tileSize = this.config.tileSizes[i] ?? this.config.tileSizes[0];
        this.dispatchSpectrum(specEncoder, cascade, tileSize, workgroups);
        cascade.spectrumDirty = false;
      }
      // Submit spectrum generation immediately — this creates an implicit GPU barrier
      // ensuring the storage texture writes are fully committed before any subsequent
      // encoder reads the spectrum as a sampled texture.
      this.ctx.device.queue.submit([specEncoder.finish()]);
    }

    for (let i = 0; i < this.cascades.length; i++) {
      const cascade = this.cascades[i];
      const tileSize = this.config.tileSizes[i] ?? this.config.tileSizes[0];

      // Step 2: Animate spectrum with time (reads spectrum texture, writes freq textures)
      this.dispatchAnimate(encoder, i, cascade, tileSize, time, workgroups);

      // Step 3: IFFT butterfly for each displacement component + slope components
      // Transforms frequency-domain complex data → spatial-domain displacement
      cascade.fftPass.execute(encoder, cascade.dyFreqTexture, cascade.dySpatialTexture);
      cascade.fftPass.execute(encoder, cascade.dxFreqTexture, cascade.dxSpatialTexture);
      cascade.fftPass.execute(encoder, cascade.dzFreqTexture, cascade.dzSpatialTexture);
      // IFFT analytical slope fields for frequency-domain normals (Tessendorf method)
      cascade.fftPass.execute(encoder, cascade.slopeXFreqTexture, cascade.slopeXSpatialTexture);
      cascade.fftPass.execute(encoder, cascade.slopeZFreqTexture, cascade.slopeZSpatialTexture);

      // Step 4: Finalize — produce displacement + normal maps from spatial-domain data
      this.dispatchFinalize(encoder, i, cascade, tileSize, workgroups);
    }
  }

  private dispatchSpectrum(
    encoder: GPUCommandEncoder,
    cascade: CascadeResources,
    tileSize: number,
    workgroups: number,
  ): void {
    const N = this.config.resolution;
    const spectrumTypeIndex = this.config.spectrumType === 'phillips' ? 0 :
                              this.config.spectrumType === 'jonswap' ? 1 : 2;

    this.spectrumUniformBuffer!.write(this.ctx, new Float32Array([
      // params0: resolution, tileSize, windSpeed, windDirX
      N, tileSize, this.config.windSpeed, this.config.windDirection[0],
      // params1: windDirZ, fetch, spectrumType, directionalSpread
      this.config.windDirection[1], this.config.fetch, spectrumTypeIndex, this.config.directionalSpread,
      // params2: swellMix, swellDirX, swellDirZ, swellWavelength (unused for now)
      0, 0, 0, 0,
      // params3: seed0, seed1, amplitudeScale, unused
      this.seed[0], this.seed[1], this.config.amplitudeScale, 0,
    ]));

    const bindGroup = this.ctx.device.createBindGroup({
      layout: this.spectrumBindGroupLayout!,
      entries: [
        { binding: 0, resource: cascade.spectrumView },
        { binding: 1, resource: { buffer: this.spectrumUniformBuffer!.buffer } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'ocean-spectrum-pass' });
    pass.setPipeline(this.spectrumPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups, workgroups);
    pass.end();
  }

  private dispatchAnimate(
    encoder: GPUCommandEncoder,
    cascadeIndex: number,
    cascade: CascadeResources,
    tileSize: number,
    time: number,
    workgroups: number,
  ): void {
    const N = this.config.resolution;
    const uniformBuffer = this.animateUniformBuffers[cascadeIndex];

    uniformBuffer.write(this.ctx, new Float32Array([
      N, tileSize, time, this.config.choppiness,
    ]));

    const bindGroup = this.ctx.device.createBindGroup({
      layout: this.animateBindGroupLayout!,
      entries: [
        { binding: 0, resource: cascade.spectrumView },
        { binding: 1, resource: cascade.dyFreqTexture.createView() },
        { binding: 2, resource: cascade.dxFreqTexture.createView() },
        { binding: 3, resource: cascade.dzFreqTexture.createView() },
        { binding: 4, resource: { buffer: uniformBuffer.buffer } },
        { binding: 5, resource: cascade.slopeXFreqTexture.createView() },
        { binding: 6, resource: cascade.slopeZFreqTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: `ocean-animate-pass-${cascadeIndex}` });
    pass.setPipeline(this.animatePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups, workgroups);
    pass.end();
  }

  private dispatchFinalize(
    encoder: GPUCommandEncoder,
    cascadeIndex: number,
    cascade: CascadeResources,
    tileSize: number,
    workgroups: number,
  ): void {
    const N = this.config.resolution;
    const uniformBuffer = this.finalizeUniformBuffers[cascadeIndex];

    uniformBuffer.write(this.ctx, new Float32Array([
      N, tileSize, this.config.amplitudeScale, 1.0 / N,
    ]));

    const bindGroup = this.ctx.device.createBindGroup({
      layout: this.finalizeBindGroupLayout!,
      entries: [
        { binding: 0, resource: cascade.dySpatialTexture.createView() },
        { binding: 1, resource: cascade.dxSpatialTexture.createView() },
        { binding: 2, resource: cascade.dzSpatialTexture.createView() },
        { binding: 3, resource: cascade.displacementView },
        { binding: 4, resource: cascade.normalView },
        { binding: 5, resource: { buffer: uniformBuffer.buffer } },
        { binding: 6, resource: cascade.slopeXSpatialTexture.createView() },
        { binding: 7, resource: cascade.slopeZSpatialTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: `ocean-finalize-pass-${cascadeIndex}` });
    pass.setPipeline(this.finalizePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups, workgroups);
    pass.end();
  }

  // ============================================================================
  // Public API — texture access for water shader
  // ============================================================================

  /** Get displacement map texture view for a cascade (rgba16float) */
  getDisplacementView(cascade: number): GPUTextureView | null {
    return this.cascades[cascade]?.displacementView ?? null;
  }

  /** Get normal map texture view for a cascade (rgba16float) */
  getNormalView(cascade: number): GPUTextureView | null {
    return this.cascades[cascade]?.normalView ?? null;
  }

  /** Get the repeat sampler for FFT textures */
  get sampler(): GPUSampler | null {
    return this._sampler;
  }

  /** Get current config */
  getConfig(): FFTOceanConfig {
    return { ...this.config };
  }

  /** Get tile size for a cascade */
  getTileSize(cascade: number): number {
    return this.config.tileSizes[cascade] ?? this.config.tileSizes[0];
  }

  /** Get number of active cascades */
  getCascadeCount(): number {
    return this.cascades.length;
  }

  /** Whether the FFT system is ready */
  get isReady(): boolean {
    return this.isInitialized && this.cascades.length > 0;
  }

  /**
   * Register FFT pipeline textures with DebugTextureManager for visual debugging.
   * Registers spectrum H₀(k), animate Dy freq, IFFT Dy spatial, displacement, and normal
   * for cascade 0 (primary ocean waves).
   */
  registerDebugTextures(debugManager: DebugTextureManager): void {
    if (this.cascades.length === 0) return;

    // Cascade 0 textures (250m primary waves)
    debugManager.register('fft-spectrum', 'float',
      () => this.cascades[0]?.spectrumView ?? null,
      { colormap: 'heat' });

    debugManager.register('fft-dy-freq', 'float',
      () => this.cascades[0]?.dyFreqTexture.createView() ?? null,
      { colormap: 'heat' });

    debugManager.register('fft-dy-spatial', 'float',
      () => this.cascades[0]?.dySpatialTexture.createView() ?? null,
      { colormap: 'heat' });

    debugManager.register('fft-displacement', 'float',
      () => this.cascades[0]?.displacementView ?? null,
      { colormap: 'color' });

    debugManager.register('fft-normal', 'float',
      () => this.cascades[0]?.normalView ?? null,
      { colormap: 'color' });
  }

  /**
   * Unregister debug textures (call before destroy)
   */
  unregisterDebugTextures(debugManager: { unregister: (name: string) => void }): void {
    debugManager.unregister('fft-spectrum');
    debugManager.unregister('fft-dy-freq');
    debugManager.unregister('fft-dy-spatial');
    debugManager.unregister('fft-displacement');
    debugManager.unregister('fft-normal');
  }

  // ============================================================================
  // Configuration updates
  // ============================================================================

  /**
   * Update wind/spectrum parameters. Marks spectrum as dirty for regeneration.
   */
  setWindSpeed(speed: number): void {
    if (this.config.windSpeed !== speed) {
      this.config.windSpeed = speed;
      this.markSpectrumDirty();
    }
  }

  setWindDirection(dir: [number, number]): void {
    if (this.config.windDirection[0] !== dir[0] || this.config.windDirection[1] !== dir[1]) {
      this.config.windDirection = dir;
      this.markSpectrumDirty();
    }
  }

  setFetch(fetch: number): void {
    if (this.config.fetch !== fetch) {
      this.config.fetch = fetch;
      this.markSpectrumDirty();
    }
  }

  setSpectrumType(type: SpectrumType): void {
    if (this.config.spectrumType !== type) {
      this.config.spectrumType = type;
      this.markSpectrumDirty();
    }
  }

  setDirectionalSpread(spread: number): void {
    if (this.config.directionalSpread !== spread) {
      this.config.directionalSpread = spread;
      this.markSpectrumDirty();
    }
  }

  setAmplitudeScale(scale: number): void {
    this.config.amplitudeScale = scale;
    // Amplitude scale is applied in finalize, no need to regenerate spectrum
  }

  setChoppiness(choppiness: number): void {
    this.config.choppiness = choppiness;
    // Applied in animate shader, no spectrum regen needed
  }

  /** Set gust factor (temporary amplitude boost, e.g. from wind system) */
  setGustFactor(factor: number): void {
    // Temporarily boost amplitude scale; caller is responsible for resetting
    this.config.amplitudeScale *= factor;
  }

  private markSpectrumDirty(): void {
    for (const cascade of this.cascades) {
      cascade.spectrumDirty = true;
    }
    // New seed for visual variation when parameters change
    this.seed = [Math.random() * 100, Math.random() * 100];
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  destroy(): void {
    for (const cascade of this.cascades) {
      cascade.spectrumTexture.destroy();
      cascade.dyFreqTexture.destroy();
      cascade.dxFreqTexture.destroy();
      cascade.dzFreqTexture.destroy();
      cascade.dySpatialTexture.destroy();
      cascade.dxSpatialTexture.destroy();
      cascade.dzSpatialTexture.destroy();
      cascade.slopeXFreqTexture.destroy();
      cascade.slopeZFreqTexture.destroy();
      cascade.slopeXSpatialTexture.destroy();
      cascade.slopeZSpatialTexture.destroy();
      cascade.displacementTexture.destroy();
      cascade.normalTexture.destroy();
      cascade.fftPass.destroy();
    }
    this.cascades = [];

    this.spectrumUniformBuffer?.destroy();
    for (const buf of this.animateUniformBuffers) { buf.destroy(); }
    for (const buf of this.finalizeUniformBuffers) { buf.destroy(); }
    this.animateUniformBuffers = [];
    this.finalizeUniformBuffers = [];

    this.spectrumPipeline = null;
    this.animatePipeline = null;
    this.finalizePipeline = null;
    this._sampler = null;

    this.isInitialized = false;
    console.log('[FFTOceanSpectrum] Destroyed');
  }
}
