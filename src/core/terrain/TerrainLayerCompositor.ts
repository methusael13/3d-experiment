/**
 * TerrainLayerCompositor — Orchestrates layer-based heightmap compositing
 *
 * The compositor is **layer-type-agnostic**. It delegates heightmap generation
 * to registered ITerrainLayerGenerator implementations via a registry.
 *
 * Responsibilities:
 * 1. Maintain a registry of layer generators (one per TerrainLayerType)
 * 2. For each layer, call the registered generator to produce a heightmap
 * 3. Run the GPU blend pass to composite all layers onto the base heightmap
 * 4. Produce both a composited heightmap and an erosion mask texture
 * 5. Cache individual layer heightmaps for incremental updates
 *
 * To add a new layer type: implement ITerrainLayerGenerator and call
 * compositor.registerGenerator(new MyLayerGenerator(...)).
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
  calculateWorkgroupCount2D,
} from '../gpu';

import {
  TerrainLayer,
  TerrainLayerType,
  TerrainBlendMode,
  MAX_COMPOSITOR_LAYERS_PER_PASS,
} from './types';

import type { ITerrainLayerGenerator } from './layers/ITerrainLayerGenerator';

// Import shaders
import compositorShader from '../gpu/shaders/terrain/terrain-layer-composite.wgsl?raw';
import normalizeShader from '../gpu/shaders/terrain/heightmap-normalize.wgsl?raw';

// ============================================================================
// Blend mode → u32 mapping (must match WGSL constants)
// ============================================================================
const BLEND_MODE_MAP: Record<TerrainBlendMode, number> = {
  additive: 0,
  multiply: 1,
  replace: 2,
  max: 3,
  min: 4,
};

// ============================================================================
// Uniform size constants
// ============================================================================

// LayerParams in WGSL: 5 × vec4f = 80 bytes (bounds + config + flags + heightCurve + slopeCurve)
const LAYER_PARAMS_BYTES = 80;

// CompositorUniforms header: layerCount(u32) + worldSize(f32) + 2×pad(f32) = 16 bytes
const COMPOSITOR_HEADER_BYTES = 16;

// Total uniform size: header + MAX_LAYERS × LayerParams
const COMPOSITOR_UNIFORM_SIZE =
  COMPOSITOR_HEADER_BYTES + MAX_COMPOSITOR_LAYERS_PER_PASS * LAYER_PARAMS_BYTES;

/**
 * Result of a compositor run
 */
export interface CompositorResult {
  /** The composited heightmap (r32float, same resolution as base) */
  heightmap: UnifiedGPUTexture;
  /** Erosion mask: 1.0 = erodable, 0.0 = protected (r32float) */
  erosionMask: UnifiedGPUTexture;
}

/**
 * TerrainLayerCompositor — Layer-type-agnostic heightmap blending pipeline
 */
export class TerrainLayerCompositor {
  private ctx: GPUContext;

  // ---- Generator registry (one per layer type) ----
  private generators = new Map<TerrainLayerType, ITerrainLayerGenerator>();

  // ---- Compositor blend pipeline ----
  private compositorPipeline: ComputePipelineWrapper | null = null;
  private compositorGroup0Layout: GPUBindGroupLayout | null = null;
  private compositorGroup1Layout: GPUBindGroupLayout | null = null;
  private compositorUniformBuffer: UnifiedGPUBuffer | null = null;

  // ---- Layer heightmap cache ----
  private layerHeightmaps = new Map<string, UnifiedGPUTexture>();

  // ---- Dummy 1×1 texture for unused layer slots ----
  private dummyTexture: UnifiedGPUTexture | null = null;

  // ---- Normalization pipeline (min/max reduction + remap to [-0.5, 0.5]) ----
  private reduceMinMaxPipeline: ComputePipelineWrapper | null = null;
  private reduceMinMaxLayout: GPUBindGroupLayout | null = null;
  private normalizePipeline: ComputePipelineWrapper | null = null;
  private normalizeLayout: GPUBindGroupLayout | null = null;
  private normalizeParamsBuffer: UnifiedGPUBuffer | null = null;
  private minMaxBuffer: UnifiedGPUBuffer | null = null;
  private normalizedHeightmap: UnifiedGPUTexture | null = null;

  // ---- Output textures (owned by compositor, destroyed on re-run) ----
  private outputHeightmap: UnifiedGPUTexture | null = null;
  private outputErosionMask: UnifiedGPUTexture | null = null;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.initializeBlendPipeline();
    this.initializeNormalizePipeline();
  }

  // ==========================================================================
  // Generator Registry
  // ==========================================================================

  /**
   * Register a layer generator for a specific layer type.
   * Only one generator per type is allowed — later registrations replace earlier ones.
   */
  registerGenerator(generator: ITerrainLayerGenerator): void {
    if (this.generators.has(generator.type)) {
      console.warn(
        `[TerrainLayerCompositor] Replacing existing generator for type "${generator.type}"`
      );
      this.generators.get(generator.type)?.destroy();
    }
    this.generators.set(generator.type, generator);
    console.log(`[TerrainLayerCompositor] Registered generator: ${generator.type}`);
  }

  /**
   * Check if a generator is registered for the given type.
   */
  hasGenerator(type: TerrainLayerType): boolean {
    return this.generators.has(type);
  }

  /**
   * Get the registered generator for a type (or undefined).
   */
  getGenerator(type: TerrainLayerType): ITerrainLayerGenerator | undefined {
    return this.generators.get(type);
  }

  // ==========================================================================
  // Initialization (blend pipeline only — generators are registered externally)
  // ==========================================================================

  private initializeBlendPipeline(): void {
    // Create dummy 1×1 r32float texture for unused layer texture slots
    this.dummyTexture = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'compositor-dummy-1x1',
      width: 1,
      height: 1,
      format: 'r32float',
      sampled: true,
      storage: false,
      copyDst: true,
    });

    // Group 0: uniforms + base heightmap + output heightmap + output erosion mask
    this.compositorGroup0Layout = new BindGroupLayoutBuilder('compositor-group0')
      .uniformBuffer(0, 'compute')
      .texture(1, 'compute', 'unfilterable-float')
      .storageTexture(2, 'r32float', 'compute', 'write-only')
      .storageTexture(3, 'r32float', 'compute', 'write-only')
      .build(this.ctx);

    // Group 1: 8 layer textures
    this.compositorGroup1Layout = new BindGroupLayoutBuilder('compositor-group1')
      .texture(0, 'compute', 'unfilterable-float')
      .texture(1, 'compute', 'unfilterable-float')
      .texture(2, 'compute', 'unfilterable-float')
      .texture(3, 'compute', 'unfilterable-float')
      .texture(4, 'compute', 'unfilterable-float')
      .texture(5, 'compute', 'unfilterable-float')
      .texture(6, 'compute', 'unfilterable-float')
      .texture(7, 'compute', 'unfilterable-float')
      .build(this.ctx);

    this.compositorPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'terrain-layer-compositor',
      shader: compositorShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.compositorGroup0Layout, this.compositorGroup1Layout],
    });

    this.compositorUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'compositor-uniform-buffer',
      size: COMPOSITOR_UNIFORM_SIZE,
    });
  }

  /**
   * Initialize the normalization pipeline (min/max reduction + remap).
   * Two entry points from the same shader:
   *   - reduceMinMax: parallel reduction to find min/max per workgroup
   *   - normalize: reads global min/max, remaps all values to [-0.5, 0.5]
   */
  private initializeNormalizePipeline(): void {
    // TILE_SIZE in the shader = 16, workgroup = 16×16
    const REDUCE_TILE = 16;

    // Pass 1 layout: texture_2d<f32> + storage buffer (read_write)
    this.reduceMinMaxLayout = new BindGroupLayoutBuilder('reduce-minmax-layout')
      .texture(0, 'compute', 'unfilterable-float')     // inputHeightmap
      .storageBufferRW(1, 'compute')                    // minMaxBuffer
      .build(this.ctx);

    this.reduceMinMaxPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'reduce-minmax-pipeline',
      shader: normalizeShader,
      entryPoint: 'reduceMinMax',
      bindGroupLayouts: [this.reduceMinMaxLayout],
    });

    // Pass 2 layout: storage buffer (read) + texture_2d + storage texture + uniform
    this.normalizeLayout = new BindGroupLayoutBuilder('normalize-layout')
      .storageBuffer(0, 'compute')                              // minMaxResults (read)
      .texture(1, 'compute', 'unfilterable-float')              // normalizeInput
      .storageTexture(2, 'r32float', 'compute', 'write-only')  // normalizeOutput
      .uniformBuffer(3, 'compute')                               // normalizeParams
      .build(this.ctx);

    this.normalizePipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'normalize-pipeline',
      shader: normalizeShader,
      entryPoint: 'normalize',
      bindGroupLayouts: [this.normalizeLayout],
    });

    // NormalizeParams uniform: totalWorkgroups(u32) + 3 pad(u32) = 16 bytes
    this.normalizeParamsBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'normalize-params-buffer',
      size: 16,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Generate per-layer heightmaps and composite them onto the base heightmap.
   *
   * @param baseHeightmap  The base terrain heightmap (from HeightmapGenerator)
   * @param layers         Array of layers to apply (will be filtered & sorted)
   * @param worldSize      Terrain world size (for bounds UV conversion)
   * @param resolution     Heightmap resolution (must match base)
   * @returns Composited heightmap and erosion mask
   */
  composite(
    baseHeightmap: UnifiedGPUTexture,
    layers: TerrainLayer[],
    worldSize: number,
    resolution: number,
  ): CompositorResult {
    // Filter to enabled layers, sorted by order
    const enabledLayers = layers
      .filter(l => l.enabled)
      .sort((a, b) => a.order - b.order);

    // If no layers, pass through the base heightmap with a fully-erodable mask
    if (enabledLayers.length === 0) {
      return this.passThrough(baseHeightmap, resolution);
    }

    // Step 1: Generate per-layer heightmaps via registered generators
    for (const layer of enabledLayers) {
      if (!this.layerHeightmaps.has(layer.id)) {
        const generator = this.generators.get(layer.type);
        if (!generator) {
          console.warn(
            `[TerrainLayerCompositor] No generator registered for layer type "${layer.type}" — skipping layer "${layer.name}"`
          );
          continue;
        }
        const tex = generator.generate(layer, resolution, this.ctx);
        this.layerHeightmaps.set(layer.id, tex);
      }
    }

    // Step 2: Create output textures
    this.ensureOutputTextures(resolution);

    // Step 3: Run compositor in batches of MAX_COMPOSITOR_LAYERS_PER_PASS
    // Filter out layers that didn't produce a heightmap (no generator registered)
    const layersWithHeightmaps = enabledLayers.filter(l => this.layerHeightmaps.has(l.id));

    if (layersWithHeightmaps.length === 0) {
      return this.passThrough(baseHeightmap, resolution);
    }

    const batchCount = Math.ceil(layersWithHeightmaps.length / MAX_COMPOSITOR_LAYERS_PER_PASS);
    let currentBase = baseHeightmap;

    for (let batch = 0; batch < batchCount; batch++) {
      const start = batch * MAX_COMPOSITOR_LAYERS_PER_PASS;
      const end = Math.min(start + MAX_COMPOSITOR_LAYERS_PER_PASS, layersWithHeightmaps.length);
      const batchLayers = layersWithHeightmaps.slice(start, end);

      this.runBlendPass(currentBase, batchLayers, worldSize, resolution);

      // For multi-pass: subsequent passes would use the output as input
      // (would need ping-pong; single pass handles ≤8 layers)
    }

    // Step 4: Normalize the composited heightmap to [-0.5, 0.5]
    // This ensures the output range is consistent regardless of how many
    // additive layers are stacked.
    this.normalizeHeightmap(resolution);

    return {
      heightmap: this.normalizedHeightmap!,
      erosionMask: this.outputErosionMask!,
    };
  }

  /**
   * Invalidate a specific layer's cached heightmap.
   * Call this when a layer's parameters change.
   */
  invalidateLayer(layerId: string): void {
    const tex = this.layerHeightmaps.get(layerId);
    if (tex) {
      tex.destroy();
      this.layerHeightmaps.delete(layerId);
    }
  }

  /**
   * Invalidate all cached layer heightmaps.
   */
  invalidateAllLayers(): void {
    for (const tex of this.layerHeightmaps.values()) {
      tex.destroy();
    }
    this.layerHeightmaps.clear();
  }

  /**
   * Get the erosion mask from the last composite run.
   */
  getErosionMask(): UnifiedGPUTexture | null {
    return this.outputErosionMask;
  }

  /**
   * Get the composited heightmap from the last composite run.
   */
  getCompositedHeightmap(): UnifiedGPUTexture | null {
    return this.outputHeightmap;
  }

  // ==========================================================================
  // Blend Pass (GPU Compute)
  // ==========================================================================

  private runBlendPass(
    baseHeightmap: UnifiedGPUTexture,
    layers: TerrainLayer[],
    worldSize: number,
    resolution: number,
  ): void {
    if (!this.compositorPipeline || !this.compositorGroup0Layout ||
        !this.compositorGroup1Layout || !this.compositorUniformBuffer) {
      return;
    }

    // Build uniform data
    const uniformData = this.buildCompositorUniforms(layers, worldSize);
    this.compositorUniformBuffer.write(this.ctx, uniformData);

    // Build group 0 bind group
    const group0 = this.ctx.device.createBindGroup({
      label: 'compositor-group0',
      layout: this.compositorGroup0Layout,
      entries: [
        { binding: 0, resource: { buffer: this.compositorUniformBuffer.buffer } },
        { binding: 1, resource: baseHeightmap.view },
        { binding: 2, resource: this.outputHeightmap!.view },
        { binding: 3, resource: this.outputErosionMask!.view },
      ],
    });

    // Build group 1 bind group (8 layer textures)
    const layerTexViews: GPUTextureView[] = [];
    for (let i = 0; i < MAX_COMPOSITOR_LAYERS_PER_PASS; i++) {
      if (i < layers.length) {
        const tex = this.layerHeightmaps.get(layers[i].id);
        layerTexViews.push(tex ? tex.view : this.dummyTexture!.view);
      } else {
        layerTexViews.push(this.dummyTexture!.view);
      }
    }

    const group1 = this.ctx.device.createBindGroup({
      label: 'compositor-group1',
      layout: this.compositorGroup1Layout,
      entries: layerTexViews.map((view, i) => ({
        binding: i,
        resource: view,
      })),
    });

    // Dispatch
    const encoder = this.ctx.device.createCommandEncoder({ label: 'compositor-encoder' });
    const pass = encoder.beginComputePass({ label: 'compositor-pass' });
    pass.setPipeline(this.compositorPipeline.pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    const wg = calculateWorkgroupCount2D(resolution, resolution, 8, 8);
    pass.dispatchWorkgroups(wg.x, wg.y);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);
  }

  /**
   * Pack compositor uniform data matching the WGSL CompositorUniforms struct.
   */
  private buildCompositorUniforms(
    layers: TerrainLayer[],
    worldSize: number,
  ): Float32Array {
    const buffer = new ArrayBuffer(COMPOSITOR_UNIFORM_SIZE);
    const f = new Float32Array(buffer);
    const u = new Uint32Array(buffer);

    // Header
    u[0] = layers.length;
    f[1] = worldSize;
    f[2] = 0; // _pad0
    f[3] = 0; // _pad1

    // Per-layer params (20 floats = 5 × vec4f per layer)
    const FLOATS_PER_LAYER = 20;
    for (let i = 0; i < Math.min(layers.length, MAX_COMPOSITOR_LAYERS_PER_PASS); i++) {
      const layer = layers[i];
      const base = 4 + i * FLOATS_PER_LAYER; // 4 header floats + 20 floats per layer

      // vec4f bounds: centerX, centerZ, halfExtentX, halfExtentZ
      const b = layer.bounds;
      f[base + 0] = b ? b.centerX : 0;
      f[base + 1] = b ? b.centerZ : 0;
      f[base + 2] = b ? b.halfExtentX : 0;
      f[base + 3] = b ? b.halfExtentZ : 0;

      // vec4f config: rotation, featherWidth, blendFactor, blendMode
      f[base + 4] = b ? (b.rotation * Math.PI / 180) : 0;
      f[base + 5] = b ? b.featherWidth : 0;
      f[base + 6] = layer.blendFactor;
      u[base + 7] = BLEND_MODE_MAP[layer.blendMode] ?? 0;

      // vec4f flags: hasBounds, erodable, unused, unused
      f[base + 8] = b ? 1.0 : 0.0;
      f[base + 9] = layer.erodable ? 1.0 : 0.0;
      f[base + 10] = 0;
      f[base + 11] = 0;

      // vec4f heightCurve: heightMin, heightMax, heightEnabled, heightInvert
      const c = layer.blendCurve;
      f[base + 12] = c?.heightMin ?? 0;
      f[base + 13] = c?.heightMax ?? 0.5;
      f[base + 14] = (c?.heightEnabled) ? 1.0 : 0.0;
      f[base + 15] = (c?.heightInvert) ? 1.0 : 0.0;

      // vec4f slopeCurve: slopeMin, slopeMax, slopeEnabled, slopeInvert
      f[base + 16] = c?.slopeMin ?? 0;
      f[base + 17] = c?.slopeMax ?? 0.5;
      f[base + 18] = (c?.slopeEnabled) ? 1.0 : 0.0;
      f[base + 19] = (c?.slopeInvert) ? 1.0 : 0.0;
    }

    return f;
  }

  // ==========================================================================
  // Pass-Through (no layers)
  // ==========================================================================

  private passThrough(
    baseHeightmap: UnifiedGPUTexture,
    resolution: number,
  ): CompositorResult {
    this.ensureOutputTextures(resolution);

    // Copy base → output heightmap
    const encoder = this.ctx.device.createCommandEncoder({ label: 'compositor-passthrough' });
    encoder.copyTextureToTexture(
      { texture: baseHeightmap.texture },
      { texture: this.outputHeightmap!.texture },
      [resolution, resolution, 1],
    );
    this.ctx.queue.submit([encoder.finish()]);

    // Fill erosion mask with 1.0 (fully erodable)
    const ones = new Float32Array(resolution * resolution);
    ones.fill(1.0);
    this.ctx.queue.writeTexture(
      { texture: this.outputErosionMask!.texture },
      ones.buffer,
      { bytesPerRow: resolution * 4, rowsPerImage: resolution },
      { width: resolution, height: resolution },
    );

    return {
      heightmap: this.outputHeightmap!,
      erosionMask: this.outputErosionMask!,
    };
  }

  // ==========================================================================
  // Normalization (min/max reduction → remap to [-0.5, 0.5])
  // ==========================================================================

  /**
   * Normalize the composited heightmap from arbitrary range to [-0.5, 0.5].
   * Two GPU dispatches:
   *   1. reduceMinMax: parallel reduction to find per-workgroup min/max
   *   2. normalize: serial scan of workgroup results + per-texel remap
   */
  private normalizeHeightmap(resolution: number): void {
    if (!this.reduceMinMaxPipeline || !this.reduceMinMaxLayout ||
        !this.normalizePipeline || !this.normalizeLayout ||
        !this.normalizeParamsBuffer || !this.outputHeightmap) {
      return;
    }

    const REDUCE_TILE = 16; // Must match TILE_SIZE in shader
    const wgX = Math.ceil(resolution / REDUCE_TILE);
    const wgY = Math.ceil(resolution / REDUCE_TILE);
    const totalWorkgroups = wgX * wgY;

    // Ensure minMax buffer is large enough: 2 floats (min, max) per workgroup
    const requiredBufferSize = totalWorkgroups * 8; // 2 × f32 = 8 bytes per entry
    if (!this.minMaxBuffer || this.minMaxBuffer.size < requiredBufferSize) {
      this.minMaxBuffer?.destroy();
      this.minMaxBuffer = UnifiedGPUBuffer.createStorage(this.ctx, {
        label: 'minmax-reduction-buffer',
        size: requiredBufferSize,
      });
    }

    // Ensure normalized output texture exists
    if (!this.normalizedHeightmap || this.normalizedHeightmap.width !== resolution) {
      this.normalizedHeightmap?.destroy();
      this.normalizedHeightmap = UnifiedGPUTexture.create2D(this.ctx, {
        label: `normalized-heightmap-${resolution}`,
        width: resolution,
        height: resolution,
        format: 'r32float',
        storage: true,
        sampled: true,
        copySrc: true,
        copyDst: true,
      });
    }

    // --- Pass 1: Min/Max Reduction ---
    const reduceBindGroup = this.ctx.device.createBindGroup({
      label: 'reduce-minmax-bind-group',
      layout: this.reduceMinMaxLayout,
      entries: [
        { binding: 0, resource: this.outputHeightmap.view },
        { binding: 1, resource: { buffer: this.minMaxBuffer.buffer } },
      ],
    });

    const encoder1 = this.ctx.device.createCommandEncoder({ label: 'reduce-minmax-encoder' });
    const pass1 = encoder1.beginComputePass({ label: 'reduce-minmax-pass' });
    pass1.setPipeline(this.reduceMinMaxPipeline.pipeline);
    pass1.setBindGroup(0, reduceBindGroup);
    pass1.dispatchWorkgroups(wgX, wgY);
    pass1.end();
    this.ctx.queue.submit([encoder1.finish()]);

    // --- Pass 2: Normalize ---
    // Write totalWorkgroups to uniform
    const paramsData = new Uint32Array([totalWorkgroups, 0, 0, 0]);
    this.normalizeParamsBuffer.write(this.ctx, new Float32Array(paramsData.buffer));

    const normalizeBindGroup = this.ctx.device.createBindGroup({
      label: 'normalize-bind-group',
      layout: this.normalizeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.minMaxBuffer.buffer } },
        { binding: 1, resource: this.outputHeightmap.view },
        { binding: 2, resource: this.normalizedHeightmap.view },
        { binding: 3, resource: { buffer: this.normalizeParamsBuffer.buffer } },
      ],
    });

    const encoder2 = this.ctx.device.createCommandEncoder({ label: 'normalize-encoder' });
    const pass2 = encoder2.beginComputePass({ label: 'normalize-pass' });
    pass2.setPipeline(this.normalizePipeline.pipeline);
    pass2.setBindGroup(0, normalizeBindGroup);
    const normWg = calculateWorkgroupCount2D(resolution, resolution, 8, 8);
    pass2.dispatchWorkgroups(normWg.x, normWg.y);
    pass2.end();
    this.ctx.queue.submit([encoder2.finish()]);

    console.log(`[TerrainLayerCompositor] Normalized heightmap (${totalWorkgroups} workgroups)`);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private ensureOutputTextures(resolution: number): void {
    if (this.outputHeightmap && this.outputHeightmap.width === resolution) {
      return;
    }

    this.outputHeightmap?.destroy();
    this.outputErosionMask?.destroy();

    this.outputHeightmap = UnifiedGPUTexture.create2D(this.ctx, {
      label: `composited-heightmap-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
      copySrc: true,
      copyDst: true,
    });

    this.outputErosionMask = UnifiedGPUTexture.create2D(this.ctx, {
      label: `erosion-mask-${resolution}`,
      width: resolution,
      height: resolution,
      format: 'r32float',
      storage: true,
      sampled: true,
      copyDst: true,
    });
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  destroy(): void {
    // Destroy all registered generators
    for (const gen of this.generators.values()) {
      gen.destroy();
    }
    this.generators.clear();

    this.invalidateAllLayers();
    this.outputHeightmap?.destroy();
    this.outputErosionMask?.destroy();
    this.normalizedHeightmap?.destroy();
    this.dummyTexture?.destroy();
    this.compositorUniformBuffer?.destroy();
    this.normalizeParamsBuffer?.destroy();
    this.minMaxBuffer?.destroy();

    this.outputHeightmap = null;
    this.outputErosionMask = null;
    this.normalizedHeightmap = null;
    this.dummyTexture = null;
    this.compositorPipeline = null;
    this.compositorUniformBuffer = null;
    this.compositorGroup0Layout = null;
    this.compositorGroup1Layout = null;
    this.reduceMinMaxPipeline = null;
    this.reduceMinMaxLayout = null;
    this.normalizePipeline = null;
    this.normalizeLayout = null;
    this.normalizeParamsBuffer = null;
    this.minMaxBuffer = null;
  }
}
