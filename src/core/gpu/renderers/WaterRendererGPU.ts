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
import waterShaderSource from '../shaders/water.wgsl?raw';
import { registerWGSLShader, unregisterWGSLShader, getWGSLShaderSource } from '@/demos/sceneBuilder/shaderManager';

/**
 * Water configuration
 */
export interface WaterConfig {
  /** Enable water rendering */
  enabled: boolean;
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
}

/**
 * Default water configuration
 */
export function createDefaultWaterConfig(): WaterConfig {
  return {
    enabled: false,
    waterLevel: 0.2,  // Slightly below center
    waterColor: [0.1, 0.4, 0.6],
    deepColor: [0.02, 0.1, 0.2],
    foamColor: [0.9, 0.95, 1.0],
    waveScale: 1.0,
    opacity: 0.85,
    fresnelPower: 3.0,
    specularPower: 64.0,
    foamThreshold: 0.5,
    depthFalloff: 2.0,
  };
}

/**
 * WebGPU Water Renderer
 */
export class WaterRendererGPU {
  private ctx: GPUContext;
  private config: WaterConfig;
  
  // Pipeline
  private pipelineWrapper: RenderPipelineWrapper | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  
  // Buffers
  private vertexBuffer: UnifiedGPUBuffer | null = null;
  private indexBuffer: UnifiedGPUBuffer | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private materialBuffer: UnifiedGPUBuffer | null = null;
  
  // Bind groups
  private bindGroup: GPUBindGroup | null = null;
  
  // Mesh data
  private indexCount: number = 0;
  
  // Uniform builders
  private uniformBuilder: UniformBuilder;
  private materialBuilder: UniformBuilder;
  
  // Sampler
  private sampler: GPUSampler | null = null;
  
  // Track last depth texture for bind group rebuild
  private lastDepthTexture: UnifiedGPUTexture | null = null;
  
  // Current shader source (for hot-reloading)
  private currentShaderSource: string = waterShaderSource;
  
  constructor(ctx: GPUContext, config?: Partial<WaterConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultWaterConfig(), ...config };
    
    // Uniform builders (40 floats for uniforms, 20 floats for material)
    this.uniformBuilder = new UniformBuilder(40);  // 2 mat4 (32) + 2 vec4 (8) = 40 floats
    this.materialBuilder = new UniformBuilder(20); // 5 vec4 = 20 floats
    
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
   * Create water plane mesh (subdivided quad for wave animation)
   * Higher subdivision = smoother waves but more vertices
   * 256x256 gives ~4 units per quad on a 1024-unit terrain (131K triangles)
   */
  private createMesh(): void {
    const subdivisions = 256; // 256x256 grid = 65536 quads = 131K triangles
    const vertCount = (subdivisions + 1) * (subdivisions + 1);
    
    // Vertices: position (vec2) + uv (vec2) = 4 floats per vertex
    const vertices = new Float32Array(vertCount * 4);
    
    let vi = 0;
    for (let z = 0; z <= subdivisions; z++) {
      for (let x = 0; x <= subdivisions; x++) {
        // Position (-0.5 to 0.5)
        vertices[vi++] = (x / subdivisions) - 0.5;
        vertices[vi++] = (z / subdivisions) - 0.5;
        // UV (0 to 1)
        vertices[vi++] = x / subdivisions;
        vertices[vi++] = z / subdivisions;
      }
    }
    
    // Indices for triangles
    const indexCount = subdivisions * subdivisions * 6;
    const indices = new Uint32Array(indexCount);
    
    let ii = 0;
    for (let z = 0; z < subdivisions; z++) {
      for (let x = 0; x < subdivisions; x++) {
        const tl = z * (subdivisions + 1) + x;
        const tr = tl + 1;
        const bl = tl + (subdivisions + 1);
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
    
    // Create buffers
    this.vertexBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'water-vertices',
      data: vertices,
    });
    
    this.indexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
      label: 'water-indices',
      data: indices,
    });
  }
  
  /**
   * Create uniform buffers
   */
  private createBuffers(): void {
    // Uniform buffer: mat4(16) + mat4(16) + vec4(cameraPos+time) + vec4(params) = 40 floats
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-uniforms',
      size: 160, // 40 * 4 bytes
    });
    
    // Material buffer: 5 vec4s = 20 floats = 80 bytes
    this.materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-material',
      size: 80,
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
      .build(this.ctx);
  }
  
  /**
   * Create render pipeline using RenderPipelineWrapper
   * Can be called with custom shader source for hot-reloading
   */
  private createRenderPipeline(shaderSource: string = this.currentShaderSource): void {
    if (!this.bindGroupLayout) {
      this.createBindGroupLayout();
    }
    
    this.pipelineWrapper = RenderPipelineWrapper.create(this.ctx, {
      label: 'water-pipeline',
      vertexShader: shaderSource,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      bindGroupLayouts: [this.bindGroupLayout!],
      vertexBuffers: [{
        arrayStride: 16, // 4 floats * 4 bytes
        attributes: [
          { format: 'float32x2', offset: 0, shaderLocation: 0 },  // position
          { format: 'float32x2', offset: 8, shaderLocation: 1 },  // uv
        ],
      }],
      topology: 'triangle-list',
      cullMode: 'none',  // Water visible from both sides
      frontFace: 'ccw',
      depthFormat: 'depth24plus',
      depthWriteEnabled: false,  // Don't write depth (transparent)
      depthCompare: 'less',      // But still test against terrain depth
      colorFormats: ['rgba16float'], // HDR intermediate format
      blendStates: [CommonBlendStates.alpha()],
    });
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
   * Update bind group with depth texture
   */
  private updateBindGroup(depthTexture: UnifiedGPUTexture): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.materialBuffer || !this.sampler) {
      return;
    }
    
    // Only rebuild if depth texture changed
    if (depthTexture === this.lastDepthTexture && this.bindGroup) {
      return;
    }
    
    this.lastDepthTexture = depthTexture;
    
    this.bindGroup = new BindGroupBuilder('water-bind-group')
      .buffer(0, this.uniformBuffer)
      .buffer(1, this.materialBuffer)
      .texture(2, depthTexture)
      .sampler(3, this.sampler)
      .build(this.ctx, this.bindGroupLayout!);
  }
  
  // Debug: log once flag
  private debugLogged = false;
  
  /**
   * Render water surface
   */
  render(passEncoder: GPURenderPassEncoder, params: WaterRenderParams): void {
    // Debug logging
    if (!this.debugLogged) {
      console.log('[WaterRendererGPU] render() called');
      console.log('[WaterRendererGPU] config.enabled:', this.config.enabled);
      console.log('[WaterRendererGPU] pipelineWrapper:', !!this.pipelineWrapper);
      console.log('[WaterRendererGPU] uniformBuffer:', !!this.uniformBuffer);
      console.log('[WaterRendererGPU] materialBuffer:', !!this.materialBuffer);
      console.log('[WaterRendererGPU] vertexBuffer:', !!this.vertexBuffer);
      console.log('[WaterRendererGPU] indexBuffer:', !!this.indexBuffer);
      console.log('[WaterRendererGPU] indexCount:', this.indexCount);
      console.log('[WaterRendererGPU] params:', {
        terrainSize: params.terrainSize,
        heightScale: params.heightScale,
        waterLevel: this.config.waterLevel,
        time: params.time,
        cameraPosition: Array.from(params.cameraPosition),
        depthTexture: !!params.depthTexture,
      });
    }
    
    if (!this.config.enabled || !this.pipelineWrapper || !this.uniformBuffer || 
        !this.materialBuffer || !this.vertexBuffer || !this.indexBuffer) {
      if (!this.debugLogged) {
        console.log('[WaterRendererGPU] Early return - missing resources');
        this.debugLogged = true;
      }
      return;
    }
    
    // Update uniforms
    this.updateUniforms(params);
    this.updateMaterial(params);
    
    // Update bind group with current depth texture
    this.updateBindGroup(params.depthTexture);
    
    if (!this.bindGroup) {
      if (!this.debugLogged) {
        console.log('[WaterRendererGPU] Early return - no bind group');
        this.debugLogged = true;
      }
      return;
    }
    
    if (!this.debugLogged) {
      console.log('[WaterRendererGPU] Drawing', this.indexCount, 'indices');
      console.log('[WaterRendererGPU] Pipeline:', this.pipelineWrapper.pipeline);
      console.log('[WaterRendererGPU] BindGroup:', this.bindGroup);
      this.debugLogged = true;
    }
    
    // Render
    passEncoder.setPipeline(this.pipelineWrapper.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer.buffer);
    passEncoder.setIndexBuffer(this.indexBuffer.buffer, 'uint32');
    passEncoder.drawIndexed(this.indexCount);
  }
  
  /**
   * Update uniform buffer
   */
  private updateUniforms(params: WaterRenderParams): void {
    // Calculate actual water level in world units
    const waterLevelWorld = this.config.waterLevel * params.heightScale;
    const sunIntensity = params.sunIntensity ?? 1.0;
    
    // WGSL struct layout:
    // mat4 viewProjectionMatrix (64 bytes, indices 0-15)
    // mat4 modelMatrix (64 bytes, indices 16-31)
    // vec4 cameraPositionTime (16 bytes, indices 32-35): xyz = camera, w = time
    // vec4 params (16 bytes, indices 36-39): x = terrainSize, y = waterLevel, z = heightScale, w = sunIntensity
    this.uniformBuilder.reset()
      .mat4(params.viewProjectionMatrix as Float32Array)  // 0-15
      .mat4(params.modelMatrix as Float32Array)           // 16-31
      .vec4(params.cameraPosition[0], params.cameraPosition[1], params.cameraPosition[2], params.time) // 32-35: cameraPos + time
      .vec4(params.terrainSize, waterLevelWorld, params.heightScale, sunIntensity); // 36-39: params
    
    this.uniformBuffer!.write(this.ctx, this.uniformBuilder.build());
  }
  
  /**
   * Update material buffer
   * Matches WaterMaterial struct in water.wgsl:
   *   sunDirection: vec4f,   // xyz = sun dir, w = unused
   *   scatterColor: vec4f,   // subsurface scattering color (deep water tint)
   *   foamColor: vec4f,      // shoreline foam
   *   params1: vec4f,        // x = waveScale, y = foamThreshold, z = fresnelPower, w = opacity
   *   params2: vec4f,        // x = ambientIntensity, y = depthFalloff, z/w = unused
   */
  private updateMaterial(params: WaterRenderParams): void {
    const sunDir = params.sunDirection || [0.5, 0.8, 0.3];
    
    this.materialBuilder.reset()
      // sunDirection (vec4)
      .vec4(sunDir[0], sunDir[1], sunDir[2], 0.0)
      // scatterColor (vec4) - deep water tint for subsurface scattering
      .vec4(this.config.deepColor[0], this.config.deepColor[1], this.config.deepColor[2], 1.0)
      // foamColor (vec4)
      .vec4(this.config.foamColor[0], this.config.foamColor[1], this.config.foamColor[2], 1.0)
      // params1: waveScale, foamThreshold, fresnelPower, opacity
      .vec4(this.config.waveScale, this.config.foamThreshold, this.config.fresnelPower, this.config.opacity)
      // params2: ambientIntensity, depthFalloff, unused, unused
      .vec4(params.ambientIntensity ?? 0.3, this.config.depthFalloff, 0.0, 0.0);
    
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
   * Enable/disable water
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
  
  /**
   * Set water level (normalized -0.5 to 0.5)
   */
  setWaterLevel(level: number): void {
    this.config.waterLevel = Math.max(-0.5, Math.min(0.5, level));
  }
  
  /**
   * Check if water is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
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
  }
}
