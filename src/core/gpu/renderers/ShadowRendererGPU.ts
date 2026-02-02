/**
 * ShadowRendererGPU - WebGPU Shadow Map Renderer with Unified Grid
 * 
 * Uses its own dense grid mesh (not CDLOD) to eliminate LOD boundary artifacts.
 * The grid follows the camera and covers the shadow radius area.
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext, UnifiedGPUBuffer, UnifiedGPUTexture, UniformBuilder, BindGroupLayoutBuilder, BindGroupBuilder } from '../index';
import { DepthTextureVisualizer } from './DepthTextureVisualizer';
import shadowShaderSource from '../shaders/shadow.wgsl?raw';

/** Shadow renderer configuration */
export interface ShadowConfig {
  /** Shadow map resolution (512-4096, default: 2048) */
  resolution: number;
  /** Radius of shadow coverage around camera (default: 200) */
  shadowRadius: number;
  /** Depth bias to prevent shadow acne (default: 0.5) */
  depthBias: number;
  /** Normal-based bias for slopes (default: 0.02) */
  normalBias: number;
  /** Enable soft shadows via PCF (default: true) */
  softShadows: boolean;
  /** PCF kernel size: 3, 5, or 7 (default: 3) */
  pcfKernelSize: number;
  /** Forward offset ratio (0.0-0.8) */
  forwardOffset: number;
  /** Grid resolution for shadow mesh (vertices per side, default: 256) */
  gridResolution: number;
}

/** Parameters for rendering shadow pass */
export interface ShadowRenderParams {
  lightDirection: vec3;
  cameraPosition: vec3;
  cameraForward?: vec3;
  heightScale: number;
  terrainSize: number;
  gridSize: number;
}

/** Interface for objects that can cast shadows */
export interface ShadowCaster {
  canCastShadows: boolean;
  renderToShadowPass(passEncoder: GPURenderPassEncoder, options: ShadowPassOptions): void;
}

/** Options passed to shadow casters */
export interface ShadowPassOptions {
  lightSpaceMatrix: mat4;
  lightDirection: [number, number, number];
  cameraPosition: [number, number, number];
}

/** Default shadow configuration */
export function createDefaultShadowConfig(): ShadowConfig {
  return {
    resolution: 2048,
    shadowRadius: 200,
    depthBias: 4,         // Hardware depth bias in integer units (small values work best)
    normalBias: 2.0,      // Slope scale bias for angled surfaces
    softShadows: true,
    pcfKernelSize: 3,
    forwardOffset: 0.0,
    gridResolution: 512, // 512x512 grid = 262144 vertices - matches or exceeds heightmap density
  };
}

/**
 * WebGPU Shadow Renderer with Unified Grid
 * Renders terrain depth from light perspective using its own mesh
 */
export class ShadowRendererGPU {
  private ctx: GPUContext;
  private config: ShadowConfig;
  
  // Shadow map texture (depth only)
  private shadowMap: UnifiedGPUTexture | null = null;
  
  // Pipeline
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  
  // Grid mesh buffers
  private gridVertexBuffer: UnifiedGPUBuffer | null = null;
  private gridIndexBuffer: UnifiedGPUBuffer | null = null;
  private gridIndexCount = 0;
  
  // Uniform buffer
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private uniformBuilder: UniformBuilder;
  
  // Light space matrix (computed each frame)
  private lightSpaceMatrix = mat4.create();
  private lightViewMatrix = mat4.create();
  private lightProjMatrix = mat4.create();
  
  // Shadow center (updated each frame)
  private shadowCenter: [number, number] = [0, 0];
  
  // Heightmap texture reference
  private heightmapTexture: UnifiedGPUTexture | null = null;
  
  // Terrain params
  private heightScale = 50;
  private terrainSize = 1000;
  
  // Debug visualization
  private depthVisualizer: DepthTextureVisualizer | null = null;
  
  constructor(ctx: GPUContext, config?: Partial<ShadowConfig>) {
    this.ctx = ctx;
    this.config = { ...createDefaultShadowConfig(), ...config };
    this.uniformBuilder = new UniformBuilder(40);
    
    this.initialize();
  }
  
  private initialize(): void {
    this.createShadowMap();
    this.createGridMesh();
    this.createBuffers();
    this.createPipeline();
  }
  
  /** Create depth-only shadow map texture */
  private createShadowMap(): void {
    this.shadowMap?.destroy();
    
    this.shadowMap = UnifiedGPUTexture.createDepth(
      this.ctx,
      this.config.resolution,
      this.config.resolution,
      'depth32float',
      'shadow-map'
    );
    
    console.log(`[ShadowRendererGPU] Created ${this.config.resolution}x${this.config.resolution} shadow map`);
  }
  
  /** Create a unified grid mesh for shadow rendering */
  private createGridMesh(): void {
    const res = this.config.gridResolution;
    
    // Create vertices: simple 2D positions in range [0, 1]
    const vertices = new Float32Array(res * res * 2);
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const idx = (z * res + x) * 2;
        vertices[idx] = x / (res - 1);     // U coordinate [0, 1]
        vertices[idx + 1] = z / (res - 1); // V coordinate [0, 1]
      }
    }
    
    // Create indices for triangle strip-like pattern (but as triangles)
    const numQuads = (res - 1) * (res - 1);
    const indices = new Uint32Array(numQuads * 6);
    let indexOffset = 0;
    
    for (let z = 0; z < res - 1; z++) {
      for (let x = 0; x < res - 1; x++) {
        const topLeft = z * res + x;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + res;
        const bottomRight = bottomLeft + 1;
        
        // First triangle
        indices[indexOffset++] = topLeft;
        indices[indexOffset++] = bottomLeft;
        indices[indexOffset++] = topRight;
        
        // Second triangle
        indices[indexOffset++] = topRight;
        indices[indexOffset++] = bottomLeft;
        indices[indexOffset++] = bottomRight;
      }
    }
    
    this.gridIndexCount = indices.length;
    
    // Create GPU buffers
    this.gridVertexBuffer?.destroy();
    this.gridIndexBuffer?.destroy();
    
    this.gridVertexBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'shadow-grid-vertices',
      data: vertices,
    });
    
    this.gridIndexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
      label: 'shadow-grid-indices',
      data: indices,
    });
    
    console.log(`[ShadowRendererGPU] Created ${res}x${res} shadow grid (${this.gridIndexCount / 3} triangles)`);
  }
  
  /** Create uniform buffer */
  private createBuffers(): void {
    // ShadowUniforms: mat4 + mat4 + vec2 + 6 floats = 40 floats = 160 bytes
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'shadow-uniforms',
      size: 160,
    });
  }
  
  /** Create shadow render pipeline */
  private createPipeline(): void {
    // Bind group layout: uniform buffer + heightmap texture
    this.bindGroupLayout = new BindGroupLayoutBuilder('shadow-bind-group-layout')
      .uniformBuffer(0, 'vertex')
      .texture(1, 'vertex', 'unfilterable-float')
      .build(this.ctx);
    
    // Compile shader
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'shadow-shader',
      code: shadowShaderSource,
    });
    
    // Pipeline layout
    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'shadow-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    });
    
    // Simple vertex buffer layout (just vec2 position)
    const vertexBufferLayouts: GPUVertexBufferLayout[] = [
      {
        arrayStride: 2 * 4, // 2 floats per vertex
        stepMode: 'vertex',
        attributes: [
          { format: 'float32x2', offset: 0, shaderLocation: 0 },
        ],
      },
    ];
    
    // Create depth-only render pipeline
    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'shadow-render-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: vertexBufferLayouts,
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back', // Cull back faces - terrain only has top surface visible to light
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: this.config.depthBias,
        depthBiasSlopeScale: this.config.normalBias,
      },
    });
  }
  
  /** Calculate light space matrix */
  private calculateLightMatrix(lightDir: vec3, cameraPos: vec3, cameraForward?: vec3): mat4 {
    const radius = this.config.shadowRadius;
    const forwardOffset = this.config.forwardOffset;
    
    // // Calculate shadow volume center
    // if (cameraForward && forwardOffset > 0) {
    //   const offsetDist = forwardOffset * radius;
    //   this.shadowCenter = [
    //     cameraPos[0] + cameraForward[0] * offsetDist,
    //     cameraPos[2] + cameraForward[2] * offsetDist,
    //   ];
    // } else {
    //   this.shadowCenter = [cameraPos[0], cameraPos[2]];
    // }
    this.shadowCenter = [0, 0];
    
    const center: vec3 = [this.shadowCenter[0], 0, this.shadowCenter[1]];
    
    // Light position: negate lightDir to get position opposite to light direction
    const lightDistance = radius * 2;
    const lightPos: vec3 = vec3.fromValues(
      center[0] + lightDir[0] * lightDistance,
      center[1] + lightDir[1] * lightDistance,
      center[2] + lightDir[2] * lightDistance
    );
    
    // Up vector
    let up: vec3 = [0, 1, 0];
    if (Math.abs(lightDir[1]) > 0.99) {
      up = [0, 0, 1];
    }
    
    mat4.lookAt(this.lightViewMatrix, lightPos, center, up);
    
    const near = 0.1;
    const far = radius * 3;
    mat4.ortho(this.lightProjMatrix, -radius, radius, -radius, radius, near, far);
    
    mat4.multiply(this.lightSpaceMatrix, this.lightProjMatrix, this.lightViewMatrix);
    
    return this.lightSpaceMatrix;
  }
  
  /** Update uniform buffer */
  private updateUniforms(params: ShadowRenderParams): void {
    const lightDir = params.lightDirection as vec3;
    const cameraPos = params.cameraPosition as vec3;
    const cameraFwd = params.cameraForward;
    
    this.heightScale = params.heightScale;
    this.terrainSize = params.terrainSize;
    
    this.calculateLightMatrix(lightDir, cameraPos, cameraFwd);
    
    // New uniform layout:
    // mat4 lightSpaceMatrix (16 floats)
    // mat4 modelMatrix (16 floats)  
    // vec2 shadowCenter (2 floats)
    // f32 shadowRadius
    // f32 heightScale
    // f32 terrainSize
    // f32 gridResolution
    // f32 depthBias
    // f32 _pad
    
    this.uniformBuilder.reset()
      .mat4(this.lightSpaceMatrix as Float32Array)
      .mat4(mat4.create() as Float32Array) // Identity model matrix
      .vec2(this.shadowCenter[0], this.shadowCenter[1])
      .float(this.config.shadowRadius)
      .float(this.heightScale)
      .float(this.terrainSize)
      .float(this.config.gridResolution)
      .float(this.config.depthBias)
      .float(0); // padding
    
    this.uniformBuffer!.write(this.ctx, this.uniformBuilder.build());
  }
  
  /** Update bind group with heightmap texture */
  updateBindGroup(heightmapTexture: UnifiedGPUTexture): void {
    if (!this.bindGroupLayout || !this.uniformBuffer) return;
    
    this.heightmapTexture = heightmapTexture;
    
    this.bindGroup = new BindGroupBuilder('shadow-bind-group')
      .buffer(0, this.uniformBuffer)
      .texture(1, heightmapTexture)
      .build(this.ctx, this.bindGroupLayout);
  }
  
  /** Render shadow map using unified grid (self-contained) */
  renderShadowMap(encoder: GPUCommandEncoder, params: ShadowRenderParams): void {
    if (!this.shadowMap || !this.pipeline || !this.bindGroup) {
      console.warn('[ShadowRendererGPU] Not ready to render shadow map');
      return;
    }
    
    this.updateUniforms(params);
    
    const passEncoder = encoder.beginRenderPass({
      label: 'shadow-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowMap.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    
    passEncoder.setViewport(0, 0, this.config.resolution, this.config.resolution, 0, 1);
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.gridVertexBuffer!.buffer);
    passEncoder.setIndexBuffer(this.gridIndexBuffer!.buffer, 'uint32');
    passEncoder.drawIndexed(this.gridIndexCount);
    passEncoder.end();
  }
  
  /** Begin shadow render pass (legacy interface for CDLOD - now just updates params) */
  beginShadowPass(encoder: GPUCommandEncoder, params: ShadowRenderParams): GPURenderPassEncoder {
    // Update uniforms but use our own rendering
    this.updateUniforms(params);
    
    // Return a pass encoder that external code can use, but we'll ignore it
    // and do our own rendering in renderShadowMap
    if (!this.shadowMap) {
      throw new Error('[ShadowRendererGPU] Shadow map not initialized');
    }
    
    return encoder.beginRenderPass({
      label: 'shadow-pass-external',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowMap.view,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
  }
  
  // ============ Getters ============
  
  getShadowMap(): UnifiedGPUTexture | null {
    return this.shadowMap;
  }
  
  getLightSpaceMatrix(): mat4 {
    return this.lightSpaceMatrix;
  }
  
  getConfig(): ShadowConfig {
    return { ...this.config };
  }
  
  // ============ Configuration ============
  
  setResolution(resolution: number): void {
    if (this.config.resolution !== resolution) {
      this.config.resolution = resolution;
      this.createShadowMap();
    }
  }
  
  setShadowRadius(radius: number): void {
    this.config.shadowRadius = radius;
  }
  
  setDepthBias(bias: number): void {
    this.config.depthBias = bias;
  }
  
  setNormalBias(bias: number): void {
    this.config.normalBias = bias;
  }
  
  setSoftShadows(enabled: boolean): void {
    this.config.softShadows = enabled;
  }
  
  setPcfKernelSize(size: number): void {
    this.config.pcfKernelSize = size;
  }
  
  setForwardOffset(offset: number): void {
    this.config.forwardOffset = Math.max(0, Math.min(0.8, offset));
  }
  
  setGridResolution(resolution: number): void {
    if (this.config.gridResolution !== resolution) {
      this.config.gridResolution = resolution;
      this.createGridMesh();
    }
  }
  
  // ============ Debug Thumbnail ============
  
  renderDebugThumbnail(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    x: number,
    y: number,
    size: number,
    screenWidth: number,
    screenHeight: number
  ): void {
    if (!this.shadowMap) return;
    
    if (!this.depthVisualizer) {
      this.depthVisualizer = new DepthTextureVisualizer(this.ctx);
    }
    
    this.depthVisualizer.render(
      encoder,
      targetView,
      this.shadowMap.view,
      x,
      y,
      size,
      screenWidth,
      screenHeight
    );
  }
  
  // ============ Cleanup ============
  
  destroy(): void {
    this.shadowMap?.destroy();
    this.uniformBuffer?.destroy();
    this.gridVertexBuffer?.destroy();
    this.gridIndexBuffer?.destroy();
    this.depthVisualizer?.destroy();
    this.shadowMap = null;
    this.uniformBuffer = null;
    this.gridVertexBuffer = null;
    this.gridIndexBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.depthVisualizer = null;
  }
}
