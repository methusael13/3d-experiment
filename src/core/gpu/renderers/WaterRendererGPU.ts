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

/**
 * Water configuration
 * Note: Enabled state is controlled by presence/absence of OceanSceneObject in scene
 */
export interface WaterConfig {
  /** Water surface Y level (normalized -0.5 to 0.5, scaled by heightScale) */
  waterLevel: number;
  /** Water surface color (shallow areas) */
  waterColor: [number, number, number];
  /** Deep water color */
  deepColor: [number, number, number];
  /** Foam color (shoreline/crests) */
  foamColor: [number, number, number];
  /** Wave animation scale (0 = flat, 1 = normal, >1 = stormy) */
  waveScale: number;
  /** Base opacity (0-1) */
  opacity: number;
  /** Fresnel power (higher = more reflection at edges) */
  fresnelPower: number;
  /** Specular power for sun reflection */
  specularPower: number;
  /** Depth threshold for foam effect */
  foamThreshold: number;
  /** How quickly water becomes opaque with depth */
  depthFalloff: number;
  /** Base wavelength in world units (smaller = more waves, larger = bigger swells) */
  wavelength: number;
  /** High-frequency normal detail strength (0 = none, 1 = full) */
  detailStrength: number;
  /** Refraction strength for shallow water (0 = none, 0.5-1.5 = typical) */
  refractionStrength: number;
  
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
    // Grid placement defaults - will be set to match terrain size on first render
    gridCenterX: 0,
    gridCenterZ: 0,
    gridSizeX: 1024,  // Will be overridden by terrain size
    gridSizeZ: 1024,
    cellSize: 4.0,    // 4 world units per cell (256 cells for 1024 terrain)
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
  
  // Mesh data
  private indexCount: number = 0;
  private currentCellsX: number = 0;
  private currentCellsZ: number = 0;
  
  // Uniform builders (68 floats for uniforms, 28 floats for material)
  private uniformBuilder: UniformBuilder;
  private materialBuilder: UniformBuilder;
  
  // Sampler
  private sampler: GPUSampler | null = null;
  
  // Track textures for bind group rebuild
  private lastDepthTexture: UnifiedGPUTexture | null = null;
  private lastSceneColorTexture: GPUTextureView | null = null;
  
  // Current shader source (for hot-reloading)
  private currentShaderSource: string = waterShaderSource;
  
  constructor(ctx: GPUContext, config?: Partial<WaterConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultWaterConfig(), ...config };
    
    // Uniform builders: 3 mat4 (48) + 5 vec4 (20) = 68 floats for uniforms, 28 for material
    this.uniformBuilder = new UniformBuilder(68);
    this.materialBuilder = new UniformBuilder(28); // 7 vec4 = 28 floats
    
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
    const cellsX = Math.max(1, Math.ceil(this.config.gridSizeX / this.config.cellSize));
    const cellsZ = Math.max(1, Math.ceil(this.config.gridSizeZ / this.config.cellSize));
    
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
    // Uniform buffer: mat4(16) + mat4(16) + vec4 + vec4 + vec4 + vec4 + mat4(16) + vec4 = 68 floats
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-uniforms',
      size: 272, // 68 * 4 bytes
    });
    
    // Material buffer: 7 vec4s = 28 floats = 112 bytes
    this.materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-material',
      size: 112,
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
      .uniformBuffer(0, 'all')        // Uniforms
      .uniformBuffer(1, 'all')        // Material
      .depthTexture(2, 'fragment')    // Depth texture for depth-based effects
      .sampler(3, 'fragment', 'filtering')  // Sampler
      .texture(4, 'fragment', 'float')      // Scene color texture for refraction
      .build(this.ctx);
  }
  
  /**
   * Create render pipeline with 4-group layout
   * - Group 0: Water-specific resources
   * - Group 3: SceneEnvironment (IBL + shadow) - uses SceneEnvironment.layout
   */
  private createRenderPipeline(shaderSource: string = this.currentShaderSource): void {
    if (!this.bindGroupLayout) {
      this.createBindGroupLayout();
    }
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'water-shader',
      code: shaderSource,
    });
    
    // Create 4-group pipeline layout (Groups 1,2 unused)
    // Use SceneEnvironment.layout for Group 3 to ensure compatibility
    this.pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'water-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout!, undefined as any, undefined as any, this.defaultSceneEnvironment.layout],
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
    
    // Create bind group with raw GPUTextureView for scene color
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
    
    // WGSL struct layout (68 floats = 272 bytes):
    // mat4 viewProjectionMatrix (64 bytes, indices 0-15)
    // mat4 modelMatrix (64 bytes, indices 16-31)
    // vec4 cameraPositionTime (16 bytes, indices 32-35): xyz = camera, w = time
    // vec4 params (16 bytes, indices 36-39): x = terrainSize, y = waterLevel, z = heightScale, w = sunIntensity
    // vec4 gridCenter (16 bytes, indices 40-43): xy = center XZ, zw = unused
    // vec4 gridScale (16 bytes, indices 44-47): xy = scale XZ, z = near, w = far
    // mat4 lightSpaceMatrix (64 bytes, indices 48-63): for single shadow map
    // vec4 shadowParams (16 bytes, indices 64-67): x = shadowEnabled, y = shadowBias, z = csmEnabled, w = unused
    
    // Build lightSpaceMatrix (identity if not provided)
    const lightSpaceMatrix = params.lightSpaceMatrix 
      ? params.lightSpaceMatrix as Float32Array
      : new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    
    this.uniformBuilder.reset()
      .mat4(params.viewProjectionMatrix as Float32Array)  // 0-15
      .mat4(params.modelMatrix as Float32Array)           // 16-31
      .vec4(params.cameraPosition[0], params.cameraPosition[1], params.cameraPosition[2], params.time) // 32-35: cameraPos + time
      .vec4(params.terrainSize, waterLevelWorld, params.heightScale, sunIntensity) // 36-39: params
      .vec4(this.config.gridCenterX, this.config.gridCenterZ, 0.0, 0.0) // 40-43: gridCenter
      .vec4(this.config.gridSizeX, this.config.gridSizeZ, near, far)    // 44-47: gridScale + near/far
      .mat4(lightSpaceMatrix)                             // 48-63: lightSpaceMatrix
      .vec4(params.shadowEnabled ? 1.0 : 0.0, params.shadowBias ?? 0.002, params.csmEnabled ? 1.0 : 0.0, 0.0); // 64-67: shadowParams
    
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
      .vec4(refractionStrength, screenWidth, screenHeight, 0.0);
    
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
    
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.uniformBuffer = null;
    this.materialBuffer = null;
    this.pipelineWrapper = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.sampler = null;
    this.lastDepthTexture = null;
    this.lastSceneColorTexture = null;
  }
}
