/**
 * WaterRendererGPU - WebGPU-based Water Surface Renderer
 * 
 * Renders a stylized water plane with animated Gerstner waves, Fresnel effect,
 * and depth-based transparency. Designed to render as a transparent overlay
 * after terrain rendering.
 */

import { mat4, vec3 } from 'gl-matrix';
import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  UniformBuilder,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  RenderPipelineWrapper,
  CommonBlendStates,
} from '../index';
import { SceneEnvironment, PlaceholderTextures } from './shared';
import waterShaderSource from '../shaders/water.wgsl?raw';
import { registerWGSLShader, unregisterWGSLShader, getWGSLShaderSource } from '@/demos/sceneBuilder/shaderManager';
import { SSRConfig } from '../pipeline/SSRConfig';
import type { GlobalDistanceField } from '../sdf/GlobalDistanceField';
import type { FFTOceanSpectrum } from '../../ocean/FFTOceanSpectrum';

/**
 * Water configuration
 * Note: Enabled state is controlled by presence/absence of OceanSceneObject in scene
 */
export interface WaterConfig {
  /** Water surface Y level (normalized -0.5 to 0.5, scaled by heightScale) */
  waterLevel: number;
  /** Water surface color (shallow areas) — used when usePhysicalColor is false */
  waterColor: [number, number, number];
  /** Deep water color — used when usePhysicalColor is false */
  deepColor: [number, number, number];
  /** Foam color (shoreline/crests) */
  foamColor: [number, number, number];
  /** Wave animation scale (0 = flat, 1 = normal, >1 = stormy) */
  waveScale: number;
  /** Base opacity (0-1) */
  opacity: number;
  /** Fresnel power (higher = more reflection at edges) — used when usePhysicalColor is false */
  fresnelPower: number;
  /** Specular power for sun reflection */
  specularPower: number;
  /** Depth threshold for foam effect */
  foamThreshold: number;
  /** How quickly water becomes opaque with depth — used when usePhysicalColor is false */
  depthFalloff: number;
  /** Base wavelength in world units (smaller = more waves, larger = bigger swells) */
  wavelength: number;
  /** High-frequency normal detail strength (0 = none, 1 = full) */
  detailStrength: number;
  /** Refraction strength for shallow water (0 = none, 0.5-1.5 = typical) */
  refractionStrength: number;
  
  // === Physical Appearance (W1) ===
  /** Use physically-based water color from absorption + IBL (default: true for new scenes) */
  usePhysicalColor: boolean;
  /** RGB absorption coefficients per meter (pure water: R=0.45, G=0.064, B=0.0145) */
  absorptionCoeffs: [number, number, number];
  /** Turbidity multiplier for absorption (1=clear, 5=muddy) */
  turbidity: number;
  /** Suspended particle scatter tint color (visible in deep water) */
  scatterTint: [number, number, number];
  
  // Grid placement parameters
  /** Grid center X coordinate in world units */
  gridCenterX: number;
  /** Grid center Z coordinate in world units */
  gridCenterZ: number;
  /** Grid width in world units */
  gridSizeX: number;
  /** Grid depth in world units */
  gridSizeZ: number;
  /** Cell size in world units (smaller = smoother waves, more triangles) */
  cellSize: number;
  
  // === Projected Grid (W6) ===
  /** Grid mode: 'uniform' = world-space grid, 'projected' = screen-space projected grid */
  gridMode: 'uniform' | 'projected';
  /** Max projection distance for projected grid in meters (default: 50000) */
  projectedMaxDistance: number;
}

/**
 * Render parameters for water
 */
export interface WaterRenderParams {
  viewProjectionMatrix: mat4;
  modelMatrix: mat4;
  cameraPosition: vec3;
  terrainSize: number;
  heightScale: number;
  time: number;
  sunDirection?: vec3;
  sunIntensity?: number;
  ambientIntensity?: number;
  depthTexture: UnifiedGPUTexture;
  /** Camera near plane distance (default: 0.1) */
  near?: number;
  /** Camera far plane distance (default: 1000) */
  far?: number;
  /** Scene environment for IBL reflections (optional) */
  sceneEnvironment?: SceneEnvironment | null;
  /** Scene color texture for refraction (rendered terrain/objects) */
  sceneColorTexture?: UnifiedGPUTexture | null;
  /** Screen width in pixels (for refraction UV calculation) */
  screenWidth?: number;
  /** Screen height in pixels (for refraction UV calculation) */
  screenHeight?: number;
  /** Light-space matrix for shadow mapping */
  lightSpaceMatrix?: mat4 | Float32Array;
  /** Whether shadows are enabled */
  shadowEnabled?: boolean;
  /** Shadow bias */
  shadowBias?: number;
  /** Whether CSM is enabled */
  csmEnabled?: boolean;
  /** Camera projection matrix (for inline SSR ray marching) */
  projectionMatrix?: Float32Array;
  /** Inverse projection matrix (for inline SSR view-space reconstruction) */
  inverseProjectionMatrix?: Float32Array;
  /** Camera view matrix (for inline SSR world→view-space normal transform) */
  viewMatrix?: Float32Array;
  /** Whether SSR is globally enabled (user toggle) */
  ssrEnabled?: boolean;
  /** SSR ray march settings (from SSRConfig quality preset) */
  ssrConfig?: Omit<SSRConfig, 'enabled' | 'quality'>;
  /** Global Distance Field for SDF-based contact foam (optional, G1) */
  globalDistanceField?: GlobalDistanceField | null;
  /** FFT ocean spectrum for GPU-computed waves (optional, W2) */
  fftSpectrum?: FFTOceanSpectrum | null;
  /** Inverse projector matrix for projected grid (W6) — computed by ProjectedGridBuilder */
  projectorInverse?: Float32Array;
}

/**
 * Default water configuration
 */
export function createDefaultWaterConfig(): WaterConfig {
  return {
    waterLevel: 0.2,  // Slightly below center
    // Deep ocean colors - rich saturated blue like Cliffs of Moher
    waterColor: [0.12, 0.35, 0.55],    // Teal-blue for shallow/surface  
    deepColor: [0.04, 0.15, 0.35],     // Rich navy blue for deep water (not black!)
    foamColor: [0.9, 0.95, 1.0],
    waveScale: 1.0,
    opacity: 0.92,    // Higher default opacity for deep ocean look
    fresnelPower: 3.0,
    specularPower: 64.0,
    foamThreshold: 3.0,  // Shore foam distance in world units (meters)
    depthFalloff: 1.5,   // Reduced for slower color transition (keeps blue longer)
    wavelength: 20.0,  // 20 world units - good default for visible waves
    detailStrength: 0.3, // High-frequency normal detail (0-1)
    refractionStrength: 0.8, // Subtle refraction for shallow water visibility
    // Physical appearance defaults (W1)
    usePhysicalColor: true,
    absorptionCoeffs: [0.45, 0.064, 0.0145], // Pure water absorption (red absorbs fastest)
    turbidity: 1.0,           // Clear water
    scatterTint: [0.03, 0.07, 0.17], // Deep blue-green scatter
    // Grid placement defaults - will be set to match terrain size on first render
    gridCenterX: 0,
    gridCenterZ: 0,
    gridSizeX: 1024,  // Will be overridden by terrain size
    gridSizeZ: 1024,
    cellSize: 4.0,    // 4 world units per cell (256 cells for 1024 terrain)
    // Projected grid defaults (W6)
    gridMode: 'uniform',     // Default to uniform (bounded) grid; user can enable projected for infinite ocean
    projectedMaxDistance: 50000,
  };
}

/**
 * WebGPU Water Renderer
 */
export class WaterRendererGPU {
  private ctx: GPUContext;
  private config: WaterConfig;
  
  // Pipeline
  private pipeline: GPURenderPipeline | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Default SceneEnvironment for fallback (provides Group 3 layout + placeholder bind group)
  private defaultSceneEnvironment: SceneEnvironment;
  
  // Deprecated: kept for compatibility during transition
  private pipelineWrapper: RenderPipelineWrapper | null = null;
  
  // Buffers
  private vertexBuffer: UnifiedGPUBuffer | null = null;
  private indexBuffer: UnifiedGPUBuffer | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private materialBuffer: UnifiedGPUBuffer | null = null;
  
  // Bind groups
  private bindGroup: GPUBindGroup | null = null;
  
  // SDF (Group 1) resources
  private sdfBindGroupLayout: GPUBindGroupLayout | null = null;
  private sdfPlaceholderBindGroup: GPUBindGroup | null = null;
  private sdfPlaceholderTexture: GPUTexture | null = null;
  private sdfPlaceholderUniformBuffer: UnifiedGPUBuffer | null = null;
  
  // FFT (Group 2) resources
  private fftBindGroupLayout: GPUBindGroupLayout | null = null;
  private fftPlaceholderBindGroup: GPUBindGroup | null = null;
  private fftPlaceholderTexture: GPUTexture | null = null;
  private fftPlaceholderUniformBuffer: UnifiedGPUBuffer | null = null;
  private fftPlaceholderSampler: GPUSampler | null = null;
  
  // Mesh data
  private indexCount: number = 0;
  private currentCellsX: number = 0;
  private currentCellsZ: number = 0;
  
  // Uniform builders (116 floats for uniforms, 28 floats for material)
  private uniformBuilder: UniformBuilder;
  private materialBuilder: UniformBuilder;
  
  // Sampler
  private sampler: GPUSampler | null = null;
  
  // Track textures for bind group rebuild
  private lastDepthTexture: UnifiedGPUTexture | null = null;
  private lastSceneColorTexture: GPUTextureView | null = null;
  
  // Current shader source (for hot-reloading)
  private currentShaderSource: string = waterShaderSource;
  
  // Track whether FFT was active last frame (for mesh resolution decisions)
  // Default to true since FFT is always active when OceanManager initializes
  private _lastFFTEnabled: boolean = true;
  
  constructor(ctx: GPUContext, config?: Partial<WaterConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultWaterConfig(), ...config };
    
    // Uniform builders: 7 mat4 (112) + 5 vec4 (20) = 132 floats for uniforms, 44 for material
    // Added projectorInverse mat4 (16 floats) for W6 projected grid
    this.uniformBuilder = new UniformBuilder(132);
    this.materialBuilder = new UniformBuilder(44); // 11 vec4 = 44 floats (7 base + 2 SSR + 2 physical color)
    
    // Create default SceneEnvironment for Group 3 layout and placeholder bind group
    this.defaultSceneEnvironment = new SceneEnvironment(ctx);
    
    this.initializeResources();
  }
  
  /**
   * Initialize GPU resources
   */
  private initializeResources(): void {
    this.createMesh();
    this.createBuffers();
    this.createSampler();
    this.createBindGroupLayout();
    this.createSDFBindGroupLayout();
    this.createFFTBindGroupLayout();
    this.createRenderPipeline();
    this.registerShader();
  }
  
  /**
   * Create water plane mesh with specified cell counts
   * Grid vertices use normalized 0-1 coordinates; shader transforms to world space
   */
  private createMesh(cellsX: number = 256, cellsZ: number = 256): void {
    // Store current dimensions for change detection
    this.currentCellsX = cellsX;
    this.currentCellsZ = cellsZ;
    
    const vertCountX = cellsX + 1;
    const vertCountZ = cellsZ + 1;
    const vertCount = vertCountX * vertCountZ;
    
    // Vertices: position (vec2) + uv (vec2) = 4 floats per vertex
    const vertices = new Float32Array(vertCount * 4);
    
    let vi = 0;
    for (let z = 0; z < vertCountZ; z++) {
      for (let x = 0; x < vertCountX; x++) {
        // Position (0 to 1) - shader will transform to world space
        vertices[vi++] = x / cellsX;
        vertices[vi++] = z / cellsZ;
        // UV (0 to 1)
        vertices[vi++] = x / cellsX;
        vertices[vi++] = z / cellsZ;
      }
    }
    
    // Indices for triangles
    const indexCount = cellsX * cellsZ * 6;
    const indices = new Uint32Array(indexCount);
    
    let ii = 0;
    for (let z = 0; z < cellsZ; z++) {
      for (let x = 0; x < cellsX; x++) {
        const tl = z * vertCountX + x;
        const tr = tl + 1;
        const bl = tl + vertCountX;
        const br = bl + 1;
        
        indices[ii++] = tl;
        indices[ii++] = bl;
        indices[ii++] = tr;
        indices[ii++] = tr;
        indices[ii++] = bl;
        indices[ii++] = br;
      }
    }
    
    this.indexCount = indexCount;
    
    // Destroy old buffers if they exist
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    
    // Create new buffers
    this.vertexBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'water-vertices',
      data: vertices,
    });
    
    this.indexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
      label: 'water-indices',
      data: indices,
    });
    
    console.log(`[WaterRendererGPU] Mesh created: ${cellsX}x${cellsZ} cells = ${cellsX * cellsZ} quads`);
  }
  
  /**
   * Rebuild mesh if grid dimensions changed
   * Returns true if mesh was rebuilt
   */
  private rebuildMeshIfNeeded(): boolean {
    // When FFT is active, use a fixed grid resolution (256×256) to properly resolve
    // wave displacement textures, independent of the cellSize UI control.
    // cellSize only affects grid density for the legacy Gerstner path.
    const fftActive = this._lastFFTEnabled;
    const cellsX = fftActive
      ? 256
      : Math.max(1, Math.ceil(this.config.gridSizeX / this.config.cellSize));
    const cellsZ = fftActive
      ? 256
      : Math.max(1, Math.ceil(this.config.gridSizeZ / this.config.cellSize));
    
    // Limit to reasonable max to prevent memory issues
    const maxCells = 2048;
    const clampedCellsX = Math.min(cellsX, maxCells);
    const clampedCellsZ = Math.min(cellsZ, maxCells);
    
    if (clampedCellsX !== this.currentCellsX || clampedCellsZ !== this.currentCellsZ) {
      this.createMesh(clampedCellsX, clampedCellsZ);
      return true;
    }
    return false;
  }
  
  /**
   * Create uniform buffers
   */
  private createBuffers(): void {
    // Uniform buffer: 7 mat4 (112) + 5 vec4 (20) = 132 floats = 528 bytes
    // Added projectorInverse mat4 for W6 projected grid
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-uniforms',
      size: 528, // 132 * 4 bytes
    });
    
    // Material buffer: 11 vec4s = 44 floats = 176 bytes (7 base + 2 SSR + 2 physical color)
    this.materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-material',
      size: 176,
    });
  }
  
  /**
   * Create texture sampler
   */
  private createSampler(): void {
    this.sampler = this.ctx.device.createSampler({
      label: 'water-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }
  
  /**
   * Create bind group layout (shared between pipeline creations)
   */
  private createBindGroupLayout(): void {
    this.bindGroupLayout = new BindGroupLayoutBuilder('water-bind-group-layout')
      .uniformBuffer(0, 'all')        // Uniforms (includes projection matrices for inline SSR)
      .uniformBuffer(1, 'all')        // Material
      .depthTexture(2, 'fragment')    // Depth texture for depth-based effects + SSR ray march
      .sampler(3, 'fragment', 'filtering')  // Sampler
      .texture(4, 'fragment', 'float')      // Scene color texture for refraction + SSR
      .build(this.ctx);
  }
  
  /**
   * Create SDF bind group layout (Group 1) and placeholder resources
   * Provides a fallback bind group when no GDF is available
   */
  private createSDFBindGroupLayout(): void {
    // Group 1 layout: 3D texture + sampler + uniform buffer
    // r32float textures are 'unfilterable-float' in WebGPU, requiring non-filtering samplers
    this.sdfBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'water-sdf-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // Create a tiny 2×2×2 placeholder 3D texture filled with 999.0 (max distance = no contact foam)
    this.sdfPlaceholderTexture = this.ctx.device.createTexture({
      label: 'water-sdf-placeholder',
      size: [2, 2, 2],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    });
    // Fill placeholder with 999.0 (8 voxels × 4 bytes = 32 bytes, row alignment: 256)
    // WebGPU requires bytesPerRow to be a multiple of 256 for writeTexture
    const placeholderData = new Float32Array(2 * 2 * 2);
    placeholderData.fill(999.0);
    this.ctx.queue.writeTexture(
      { texture: this.sdfPlaceholderTexture },
      placeholderData,
      { bytesPerRow: 2 * 4, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 2 },
    );

    // Placeholder uniform: center=0, extent=1, voxelSize=1 (returns 999 for all queries)
    this.sdfPlaceholderUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-sdf-placeholder-uniforms',
      size: 32, // 8 floats
    });
    this.sdfPlaceholderUniformBuffer.write(this.ctx, new Float32Array([
      0, 0, 0, 0,  // center + pad
      1, 1, 1, 1,  // extent + voxelSize
    ]));

    const placeholderSampler = this.ctx.device.createSampler({
      label: 'water-sdf-placeholder-sampler',
      // Non-filtering sampler required for unfilterable-float (r32float) textures
    });

    this.sdfPlaceholderBindGroup = this.ctx.device.createBindGroup({
      label: 'water-sdf-placeholder-bind-group',
      layout: this.sdfBindGroupLayout,
      entries: [
        { binding: 0, resource: this.sdfPlaceholderTexture.createView({ dimension: '3d' }) },
        { binding: 1, resource: placeholderSampler },
        { binding: 2, resource: { buffer: this.sdfPlaceholderUniformBuffer.buffer } },
      ],
    });
  }
  
  /**
   * Create FFT bind group layout (Group 2) and placeholder resources.
   * Group 2 provides FFT displacement + normal maps from the compute pipeline.
   * When FFT is not ready, placeholders provide flat water (fftEnabled=0).
   */
  private createFFTBindGroupLayout(): void {
    // Group 2 layout: 6 textures (3 displacement + 3 normal) + sampler + uniform
    this.fftBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'water-fft-bind-group-layout',
      entries: [
        // Displacement maps (rgba16float) for 3 cascades
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // Normal maps (rgba16float) for 3 cascades
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        // Sampler (linear, repeat)
        { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // FFT params uniform
        { binding: 7, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    // Create 2x2 placeholder rgba16float texture
    // Use rgba16float to match live FFT textures. Default uninitialized content is fine
    // because fftEnabled=0 in the uniform means shader takes Gerstner path, never reads these.
    this.fftPlaceholderTexture = this.ctx.device.createTexture({
      label: 'water-fft-placeholder',
      size: [2, 2],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Write zeros as raw bytes (rgba16float: 4 channels × 2 bytes = 8 bytes/pixel, 2×2 = 32 bytes)
    const placeholderBytes = new Uint16Array(2 * 2 * 4); // 4 pixels × 4 channels, all zeros (float16 zero = 0x0000)
    this.ctx.queue.writeTexture(
      { texture: this.fftPlaceholderTexture },
      placeholderBytes,
      { bytesPerRow: 2 * 4 * 2 }, // 2 pixels × 4 channels × 2 bytes = 16 bytes/row
      { width: 2, height: 2 },
    );

    this.fftPlaceholderSampler = this.ctx.device.createSampler({
      label: 'water-fft-placeholder-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });

    // FFT params uniform: tileSizes=(1,1,1,0=cascadeCount), params=(1,1,0=fftDisabled,0)
    this.fftPlaceholderUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-fft-placeholder-uniforms',
      size: 32, // 2 vec4 = 8 floats
    });
    this.fftPlaceholderUniformBuffer.write(this.ctx, new Float32Array([
      1.0, 1.0, 1.0, 0.0,   // tileSizes: x,y,z, cascadeCount=0 (disabled)
      1.0, 1.0, 0.0, 0.0,   // params: amplitudeScale, choppiness, fftEnabled=0, unused
    ]));

    const placeholderView = this.fftPlaceholderTexture.createView();
    this.fftPlaceholderBindGroup = this.ctx.device.createBindGroup({
      label: 'water-fft-placeholder-bind-group',
      layout: this.fftBindGroupLayout,
      entries: [
        { binding: 0, resource: placeholderView },
        { binding: 1, resource: placeholderView },
        { binding: 2, resource: placeholderView },
        { binding: 3, resource: placeholderView },
        { binding: 4, resource: placeholderView },
        { binding: 5, resource: placeholderView },
        { binding: 6, resource: this.fftPlaceholderSampler },
        { binding: 7, resource: { buffer: this.fftPlaceholderUniformBuffer.buffer } },
      ],
    });
  }
  
  /**
   * Build a live FFT bind group from FFTOceanSpectrum data.
   * Returns the placeholder bind group if FFT is not ready.
   */
  buildFFTBindGroup(fftSpectrum: FFTOceanSpectrum | null): GPUBindGroup {
    if (!fftSpectrum?.isReady || !this.fftBindGroupLayout || !this.fftPlaceholderSampler) {
      return this.fftPlaceholderBindGroup!;
    }

    const config = fftSpectrum.getConfig();
    const cascadeCount = fftSpectrum.getCascadeCount();

    // Get views for each cascade (fall back to placeholder for missing cascades)
    const placeholderView = this.fftPlaceholderTexture!.createView();
    const dv0 = fftSpectrum.getDisplacementView(0) ?? placeholderView;
    const dv1 = cascadeCount >= 2 ? (fftSpectrum.getDisplacementView(1) ?? placeholderView) : placeholderView;
    const dv2 = cascadeCount >= 3 ? (fftSpectrum.getDisplacementView(2) ?? placeholderView) : placeholderView;
    const nv0 = fftSpectrum.getNormalView(0) ?? placeholderView;
    const nv1 = cascadeCount >= 2 ? (fftSpectrum.getNormalView(1) ?? placeholderView) : placeholderView;
    const nv2 = cascadeCount >= 3 ? (fftSpectrum.getNormalView(2) ?? placeholderView) : placeholderView;

    // Write FFT params uniform
    this.fftPlaceholderUniformBuffer!.write(this.ctx, new Float32Array([
      config.tileSizes[0], config.tileSizes[1], config.tileSizes[2], cascadeCount,
      config.amplitudeScale, config.choppiness, 1.0, 0.0, // fftEnabled=1.0
    ]));

    return this.ctx.device.createBindGroup({
      label: 'water-fft-live-bind-group',
      layout: this.fftBindGroupLayout,
      entries: [
        { binding: 0, resource: dv0 },
        { binding: 1, resource: dv1 },
        { binding: 2, resource: dv2 },
        { binding: 3, resource: nv0 },
        { binding: 4, resource: nv1 },
        { binding: 5, resource: nv2 },
        { binding: 6, resource: fftSpectrum.sampler ?? this.fftPlaceholderSampler },
        { binding: 7, resource: { buffer: this.fftPlaceholderUniformBuffer!.buffer } },
      ],
    });
  }
  
  /**
   * Create render pipeline with 4-group layout
   * - Group 0: Water-specific resources
   * - Group 1: SDF (Global Distance Field) for contact foam
   * - Group 3: SceneEnvironment (IBL + shadow) - uses SceneEnvironment.layout
   */
  private createRenderPipeline(shaderSource: string = this.currentShaderSource): void {
    if (!this.bindGroupLayout) {
      this.createBindGroupLayout();
    }
    if (!this.sdfBindGroupLayout) {
      this.createSDFBindGroupLayout();
    }
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'water-shader',
      code: shaderSource,
    });
    
    // Ensure FFT bind group layout exists
    if (!this.fftBindGroupLayout) {
      this.createFFTBindGroupLayout();
    }
    
    // Create 4-group pipeline layout
    // Group 0: Water uniforms/material, Group 1: SDF, Group 2: FFT ocean, Group 3: SceneEnvironment
    this.pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'water-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout!, this.sdfBindGroupLayout!, this.fftBindGroupLayout!, this.defaultSceneEnvironment.layout],
    });
    
    // Vertex buffer layout
    const vertexBuffers: GPUVertexBufferLayout[] = [{
      arrayStride: 16, // 4 floats * 4 bytes
      attributes: [
        { format: 'float32x2', offset: 0, shaderLocation: 0 },  // position
        { format: 'float32x2', offset: 8, shaderLocation: 1 },  // uv
      ],
    }];
    
    // Create pipeline
    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'water-pipeline',
      layout: this.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: vertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'zero', operation: 'add' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',  // Water visible from both sides
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater',   // Reversed-Z
      },
    });
    
    // Wrap for compatibility
    this.pipelineWrapper = { pipeline: this.pipeline } as RenderPipelineWrapper;
  }
  
  /**
   * Register shader with ShaderManager for live editing
   */
  private registerShader(): void {
    registerWGSLShader('Water', {
      device: this.ctx.device,
      source: waterShaderSource,
      label: 'water-shader',
      onRecompile: (_module: GPUShaderModule) => {
        // Get the new source from registry and rebuild pipeline
        const newSource = getWGSLShaderSource('Water');
        if (newSource) {
          console.log('[WaterRendererGPU] Hot-reloading shader...');
          this.currentShaderSource = newSource;
          
          // Invalidate bind group (will be recreated on next render)
          this.bindGroup = null;
          this.lastDepthTexture = null;
          
          // Rebuild pipeline with new shader
          this.createRenderPipeline(newSource);
          console.log('[WaterRendererGPU] Shader hot-reload complete');
        }
      },
    });
  }
  
  /**
   * Update bind group with depth texture and scene color texture
   */
  private updateBindGroup(depthTexture: UnifiedGPUTexture, sceneColorView: GPUTextureView | null): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.materialBuffer || !this.sampler) {
      return;
    }
    
    // Use placeholder if no scene color provided
    const placeholders = PlaceholderTextures.get(this.ctx);
    const effectiveSceneColorView = sceneColorView ?? placeholders.sceneColorHDRView;
    
    // Only rebuild if textures changed
    if (depthTexture === this.lastDepthTexture && 
        effectiveSceneColorView === this.lastSceneColorTexture &&
        this.bindGroup) {
      return;
    }
    
    this.lastDepthTexture = depthTexture;
    this.lastSceneColorTexture = effectiveSceneColorView;
    
    this.bindGroup = this.ctx.device.createBindGroup({
      label: 'water-bind-group',
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer.buffer } },
        { binding: 1, resource: { buffer: this.materialBuffer.buffer } },
        { binding: 2, resource: depthTexture.view },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: effectiveSceneColorView },
      ],
    });
  }
  
  /**
   * Render water surface
   */
  render(passEncoder: GPURenderPassEncoder, params: WaterRenderParams): number {
    // Track FFT state for mesh resolution decisions
    this._lastFFTEnabled = !!(params.fftSpectrum?.isReady);
    
    // Rebuild mesh if grid dimensions changed
    this.rebuildMeshIfNeeded();

    if (!this.pipeline || !this.uniformBuffer || 
        !this.materialBuffer || !this.vertexBuffer || !this.indexBuffer) {
      return 0;
    }

    // Update uniforms
    this.updateUniforms(params);
    this.updateMaterial(params);
    
    // Update bind group with current depth texture and scene color
    const sceneColorView = params.sceneColorTexture?.view ?? null;
    this.updateBindGroup(params.depthTexture, sceneColorView);
    
    if (!this.bindGroup) {
      return 0;
    }
    
    // Render
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    
    // Set bind group 1 for SDF (contact foam)
    // Use live GDF if available, otherwise placeholder (returns 999 = no contact foam)
    const gdf = params.globalDistanceField;
    let sdfBindGroup = this.sdfPlaceholderBindGroup;
    if (gdf?.isReady && gdf.getSampleView() && gdf.sampler && gdf.consumerUniformBuffer && this.sdfBindGroupLayout) {
      sdfBindGroup = this.ctx.device.createBindGroup({
        label: 'water-sdf-live-bind-group',
        layout: this.sdfBindGroupLayout,
        entries: [
          { binding: 0, resource: gdf.getSampleView()! },
          { binding: 1, resource: gdf.sampler },
          { binding: 2, resource: { buffer: gdf.consumerUniformBuffer.buffer } },
        ],
      });
    }
    if (sdfBindGroup) {
      passEncoder.setBindGroup(1, sdfBindGroup);
    }
    
    // Set bind group 2 for FFT ocean displacement/normal maps
    const fftBindGroup = this.buildFFTBindGroup(params.fftSpectrum ?? null);
    passEncoder.setBindGroup(2, fftBindGroup);
    
    // Set bind group 3 for IBL reflections
    // Use provided SceneEnvironment or fall back to default (placeholder textures)
    const environment = params.sceneEnvironment ?? this.defaultSceneEnvironment;
    passEncoder.setBindGroup(3, environment.bindGroup);
    
    passEncoder.setVertexBuffer(0, this.vertexBuffer.buffer);
    passEncoder.setIndexBuffer(this.indexBuffer.buffer, 'uint32');
    passEncoder.drawIndexed(this.indexCount);
    return 1;
  }
  
  /**
   * Update uniform buffer
   */
  private updateUniforms(params: WaterRenderParams): void {
    // Calculate actual water level in world units
    const waterLevelWorld = this.config.waterLevel * params.heightScale;
    const sunIntensity = params.sunIntensity ?? 1.0;
    const near = params.near ?? 0.1;
    const far = params.far ?? 2000;
    
    // WGSL struct layout (116 floats = 464 bytes):
    // mat4 viewProjectionMatrix (64 bytes, indices 0-15)
    // mat4 modelMatrix (64 bytes, indices 16-31)
    // vec4 cameraPositionTime (16 bytes, indices 32-35)
    // vec4 params (16 bytes, indices 36-39)
    // vec4 gridCenter (16 bytes, indices 40-43)
    // vec4 gridScale (16 bytes, indices 44-47)
    // mat4 lightSpaceMatrix (64 bytes, indices 48-63)
    // vec4 shadowParams (16 bytes, indices 64-67)
    // mat4 projectionMatrix (64 bytes, indices 68-83)
    // mat4 inverseProjectionMatrix (64 bytes, indices 84-99)
    // mat4 viewMatrix (64 bytes, indices 100-115)
    
    const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const lightSpaceMatrix = params.lightSpaceMatrix 
      ? params.lightSpaceMatrix as Float32Array
      : identity;
    const projectionMatrix = params.projectionMatrix ?? identity;
    const inverseProjectionMatrix = params.inverseProjectionMatrix ?? identity;
    const viewMatrix = params.viewMatrix ?? identity;
    
    this.uniformBuilder.reset()
      .mat4(params.viewProjectionMatrix as Float32Array)  // 0-15
      .mat4(params.modelMatrix as Float32Array)           // 16-31
      .vec4(params.cameraPosition[0], params.cameraPosition[1], params.cameraPosition[2], params.time) // 32-35
      .vec4(params.terrainSize, waterLevelWorld, params.heightScale, sunIntensity) // 36-39
      .vec4(this.config.gridCenterX, this.config.gridCenterZ, this.config.gridMode === 'projected' ? 1.0 : 0.0, this.config.projectedMaxDistance) // 40-43: gridCenter.xy, gridMode, projectedMaxDist
      .vec4(this.config.gridSizeX, this.config.gridSizeZ, near, far)    // 44-47
      .mat4(lightSpaceMatrix)                             // 48-63
      .vec4(params.shadowEnabled ? 1.0 : 0.0, params.shadowBias ?? 0.002, params.csmEnabled ? 1.0 : 0.0, params.ssrEnabled ? 1.0 : 0.0) // 64-67: shadow + SSR enabled
      .mat4(projectionMatrix)                             // 68-83
      .mat4(inverseProjectionMatrix)                      // 84-99
      .mat4(viewMatrix)                                   // 100-115
      .mat4(params.projectorInverse ?? identity);         // 116-131: projectorInverse for projected grid (W6)
    
    this.uniformBuffer!.write(this.ctx, this.uniformBuilder.build());
  }
  
  /**
   * Update material buffer
   * Matches WaterMaterial struct in water.wgsl:
   *   sunDirection: vec4f,   // xyz = sun dir, w = unused
   *   waterColor: vec4f,     // shallow water tint (artistic)
   *   scatterColor: vec4f,   // subsurface scattering color (deep water tint)
   *   foamColor: vec4f,      // shoreline foam
   *   params1: vec4f,        // x = waveScale, y = foamThreshold, z = fresnelPower, w = opacity
   *   params2: vec4f,        // x = ambientIntensity, y = depthFalloff, z = wavelength, w = detailStrength
   *   params3: vec4f,        // x = refractionStrength, y = screenWidth, z = screenHeight, w = unused
   */
  private updateMaterial(params: WaterRenderParams): void {
    const sunDir = params.sunDirection || [0.5, 0.8, 0.3];
    const screenWidth = params.screenWidth ?? 1920;
    const screenHeight = params.screenHeight ?? 1080;
    
    // If no scene color texture provided, disable refraction
    const refractionStrength = params.sceneColorTexture ? this.config.refractionStrength : 0.0;
    
    this.materialBuilder.reset()
      // sunDirection (vec4)
      .vec4(sunDir[0], sunDir[1], sunDir[2], 0.0)
      // waterColor (vec4) - shallow water tint
      .vec4(this.config.waterColor[0], this.config.waterColor[1], this.config.waterColor[2], 1.0)
      // scatterColor (vec4) - deep water tint for subsurface scattering
      .vec4(this.config.deepColor[0], this.config.deepColor[1], this.config.deepColor[2], 1.0)
      // foamColor (vec4)
      .vec4(this.config.foamColor[0], this.config.foamColor[1], this.config.foamColor[2], 1.0)
      // params1: waveScale, foamThreshold, fresnelPower, opacity
      .vec4(this.config.waveScale, this.config.foamThreshold, this.config.fresnelPower, this.config.opacity)
      // params2: ambientIntensity, depthFalloff, wavelength, detailStrength
      .vec4(params.ambientIntensity ?? 0.3, this.config.depthFalloff, this.config.wavelength, this.config.detailStrength)
      // params3: refractionStrength, screenWidth, screenHeight, unused
      .vec4(refractionStrength, screenWidth, screenHeight, 0.0)
      // ssrParams1: maxSteps, refinementSteps, maxDistance, stepSize
      .vec4(
        params.ssrConfig?.maxSteps ?? 64,
        params.ssrConfig?.refinementSteps ?? 4,
        params.ssrConfig?.maxDistance ?? 200,
        params.ssrConfig?.stepSize ?? 0.3
      )
      // ssrParams2: thickness, edgeFade, jitter, unused
      .vec4(
        params.ssrConfig?.thickness ?? 0.3,
        params.ssrConfig?.edgeFade ?? 0.15,
        (params.ssrConfig?.jitter ?? false) ? 1.0 : 0.0,
        0.0
      )
      // absorptionCoeffs: xyz = RGB absorption per meter, w = turbidity
      .vec4(
        this.config.absorptionCoeffs[0],
        this.config.absorptionCoeffs[1],
        this.config.absorptionCoeffs[2],
        this.config.turbidity
      )
      // scatterTint: xyz = scatter tint color, w = usePhysicalColor flag
      .vec4(
        this.config.scatterTint[0],
        this.config.scatterTint[1],
        this.config.scatterTint[2],
        this.config.usePhysicalColor ? 1.0 : 0.0
      );
    
    this.materialBuffer!.write(this.ctx, this.materialBuilder.build());
  }
  
  // ============ Configuration ============
  
  /**
   * Set water configuration for live updates
   */
  setConfig(config: Partial<WaterConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Get current water configuration
   */
  getConfig(): WaterConfig {
    return { ...this.config };
  }
  
  /**
   * Set water level (normalized -0.5 to 0.5)
   */
  setWaterLevel(level: number): void {
    this.config.waterLevel = Math.max(-0.5, Math.min(0.5, level));
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    // Unregister from shader manager
    unregisterWGSLShader('Water');
    
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.materialBuffer?.destroy();
    this.sdfPlaceholderTexture?.destroy();
    this.sdfPlaceholderUniformBuffer?.destroy();
    this.fftPlaceholderTexture?.destroy();
    this.fftPlaceholderUniformBuffer?.destroy();
    
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.uniformBuffer = null;
    this.materialBuffer = null;
    this.pipelineWrapper = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.sdfBindGroupLayout = null;
    this.sdfPlaceholderBindGroup = null;
    this.sdfPlaceholderTexture = null;
    this.sdfPlaceholderUniformBuffer = null;
    this.fftBindGroupLayout = null;
    this.fftPlaceholderBindGroup = null;
    this.fftPlaceholderTexture = null;
    this.fftPlaceholderUniformBuffer = null;
    this.fftPlaceholderSampler = null;
    this.sampler = null;
    this.lastDepthTexture = null;
    this.lastSceneColorTexture = null;
  }
}
