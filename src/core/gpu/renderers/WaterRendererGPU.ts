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
  lightDirection?: vec3;
  lightColor?: vec3;
  ambientIntensity?: number;
  depthTexture: UnifiedGPUTexture;
}

/**
 * Default water configuration
 */
export function createDefaultWaterConfig(): WaterConfig {
  return {
    enabled: false,
    waterLevel: -0.2,  // Slightly below center
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
  
  constructor(ctx: GPUContext, config?: Partial<WaterConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultWaterConfig(), ...config };
    
    // Uniform builders (40 floats for uniforms, 24 floats for material)
    this.uniformBuilder = new UniformBuilder(10);  // 10 vec4s
    this.materialBuilder = new UniformBuilder(24);
    
    this.initializeResources();
  }
  
  /**
   * Initialize GPU resources
   */
  private initializeResources(): void {
    this.createMesh();
    this.createBuffers();
    this.createSampler();
    this.createPipeline();
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
    
    // Material buffer: 24 floats = 96 bytes
    this.materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'water-material',
      size: 96,
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
   * Create render pipeline using RenderPipelineWrapper
   */
  private createPipeline(): void {
    // Create bind group layout
    this.bindGroupLayout = new BindGroupLayoutBuilder('water-bind-group-layout')
      .uniformBuffer(0, 'all')        // Uniforms
      .uniformBuffer(1, 'all')        // Material
      .depthTexture(2, 'fragment')    // Depth texture for depth-based effects
      .sampler(3, 'fragment', 'filtering')  // Sampler
      .build(this.ctx);
    
    // Create render pipeline using RenderPipelineWrapper
    this.pipelineWrapper = RenderPipelineWrapper.create(this.ctx, {
      label: 'water-pipeline',
      vertexShader: waterShaderSource,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      bindGroupLayouts: [this.bindGroupLayout],
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
      blendStates: [CommonBlendStates.alpha()],
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
      .build(this.ctx, this.bindGroupLayout);
  }
  
  /**
   * Render water surface
   */
  render(passEncoder: GPURenderPassEncoder, params: WaterRenderParams): void {
    if (!this.config.enabled || !this.pipelineWrapper || !this.uniformBuffer || 
        !this.materialBuffer || !this.vertexBuffer || !this.indexBuffer) {
      return;
    }
    
    // Update uniforms
    this.updateUniforms(params);
    this.updateMaterial(params);
    
    // Update bind group with current depth texture
    this.updateBindGroup(params.depthTexture);
    
    if (!this.bindGroup) {
      return;
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
    
    this.uniformBuilder.reset()
      .mat4(params.viewProjectionMatrix as Float32Array)  // 0-15
      .mat4(params.modelMatrix as Float32Array)           // 16-31
      .vec3(params.cameraPosition[0], params.cameraPosition[1], params.cameraPosition[2]) // 32-34
      .float(params.time)                                 // 35
      .vec4(params.terrainSize, waterLevelWorld, params.heightScale, 0); // 36-39
    
    this.uniformBuffer!.write(this.ctx, this.uniformBuilder.build());
  }
  
  /**
   * Update material buffer
   */
  private updateMaterial(params: WaterRenderParams): void {
    const lightDir = params.lightDirection || [0.5, 1, 0.5];
    const lightColor = params.lightColor || [1, 1, 1];
    
    this.materialBuilder.reset()
      // waterColor (vec4)
      .vec4(this.config.waterColor[0], this.config.waterColor[1], this.config.waterColor[2], 1.0)
      // deepColor (vec4)
      .vec4(this.config.deepColor[0], this.config.deepColor[1], this.config.deepColor[2], 1.0)
      // lightDir (vec3) + waveScale (f32)
      .vec4(lightDir[0], lightDir[1], lightDir[2], this.config.waveScale)
      // lightColor (vec3) + specularPower (f32)
      .vec4(lightColor[0], lightColor[1], lightColor[2], this.config.specularPower)
      // foamColor (vec3) + foamThreshold (f32)
      .vec4(this.config.foamColor[0], this.config.foamColor[1], this.config.foamColor[2], this.config.foamThreshold)
      // ambientIntensity, opacity, fresnelPower, depthFalloff
      .vec4(params.ambientIntensity ?? 0.3, this.config.opacity, this.config.fresnelPower, this.config.depthFalloff);
    
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
