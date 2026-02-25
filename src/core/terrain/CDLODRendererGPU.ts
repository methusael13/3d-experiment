/**
 * CDLODRendererGPU - WebGPU-based CDLOD Terrain Renderer
 * 
 * Uses the GPU abstraction layer (UnifiedGPUBuffer, UnifiedGPUTexture, RenderPipelineWrapper)
 * to render terrain using CDLOD (Continuous Distance-Dependent LOD) with WebGPU.
 */

import { mat4, vec3 } from 'gl-matrix';
import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  UniformBuilder,
  RenderPipelineWrapper,
  CommonVertexLayouts,
  SamplerFactory,
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  ShaderSources,
  VertexBufferLayoutDesc,
  loadTextureFromURL,
} from '../gpu';
import { SceneEnvironment, ENV_BINDING_MASK, PlaceholderTextures } from '../gpu/renderers/shared';
import cdlodShadowShader from '../gpu/shaders/terrain/cdlod-shadow.wgsl?raw';
import {
  TerrainQuadtree,
  TerrainNode,
  type QuadtreeConfig,
  type SelectionResult,
} from './TerrainQuadtree';
import {
  type BiomeTextureSet,
  type TerrainMaterialParams,
} from './types';
import { TerrainBiomeTextureResources, type BiomeType, type TextureType } from './TerrainBiomeTextureResources';

/**
 * CDLOD GPU Renderer configuration
 */
export interface CDLODGPUConfig {
  /** Grid vertices per side (e.g., 33, 65, 129) */
  gridSize: number;
  /** Maximum instances per draw call */
  maxInstances: number;
  /** Debug visualization mode */
  debugMode: boolean;
  /** Use procedural heightmap (for testing) */
  useProceduralHeight: boolean;
  /** Enable skirt geometry to prevent gaps between patches */
  enableSkirts: boolean;
  /** Skirt depth multiplier (relative to patch scale) */
  skirtDepthMultiplier: number;
  
  // Procedural detail parameters (for close-up terrain viewing)
  /** Base frequency for procedural detail noise (cycles/meter) */
  detailFrequency: number;
  /** Maximum amplitude for procedural detail displacement (meters) */
  detailAmplitude: number;
  /** Number of FBM octaves for detail noise */
  detailOctaves: number;
  /** Distance where detail starts fading (meters) */
  detailFadeStart: number;
  /** Distance where detail is fully faded (meters) */
  detailFadeEnd: number;
  /** How much slope affects detail amount (0-1) */
  detailSlopeInfluence: number;
}

/**
 * Terrain material configuration (3 biomes: grass, rock, forest)
 * Biome weights are sourced from biome mask texture (R=grass, G=rock, B=forest)
 */
export interface TerrainMaterial {
  // Biome fallback colors (RGB 0-1)
  grassColor: [number, number, number];
  rockColor: [number, number, number];
  forestColor: [number, number, number];
  
  // Optional biome texture sets (grass, rock, forest)
  grassTexture?: BiomeTextureSet;
  rockTexture?: BiomeTextureSet;
  forestTexture?: BiomeTextureSet;
}

/**
 * Shadow parameters for terrain rendering
 */
export interface TerrainShadowParams {
  enabled: boolean;
  softShadows: boolean;
  shadowRadius: number;
  lightSpaceMatrix: mat4;
  shadowMap: UnifiedGPUTexture | null;
  /** Enable Cascaded Shadow Maps (requires CSM resources in SceneEnvironment) */
  csmEnabled?: boolean;
}

/**
 * Island mode parameters for terrain rendering
 */
export interface IslandRenderParams {
  /** Enable island mode */
  enabled: boolean;
  /** Ocean floor depth (normalized, e.g., -0.3) */
  seaFloorDepth: number;
  /** Island mask texture (R8, 1=land, 0=ocean) */
  maskTexture?: UnifiedGPUTexture | null;
}

/**
 * Render parameters for CDLOD terrain
 */
export interface CDLODRenderParams {
  viewProjectionMatrix: mat4;
  modelMatrix: mat4;
  cameraPosition: vec3;
  sceneViewProjectionMatrix?: mat4;
  sceneCameraPosition?: vec3;
  terrainSize: number;
  heightScale: number;
  heightmapTexture?: UnifiedGPUTexture;
  normalMapTexture?: UnifiedGPUTexture;
  biomeMaskTexture?: UnifiedGPUTexture;
  material?: Partial<TerrainMaterial>;
  lightDirection?: vec3;
  lightColor?: vec3;
  ambientIntensity?: number;
  /** @deprecated Selection is now handled via separate outline pass */
  isSelected?: boolean;
  /** Enable wireframe rendering to visualize LOD grid density */
  wireframe?: boolean;
  /** Shadow parameters */
  shadow?: TerrainShadowParams;
  /** Island mode parameters */
  island?: IslandRenderParams;
  /** Scene environment for IBL (optional - provides ambient lighting from sky) */
  sceneEnvironment?: SceneEnvironment | null;
}

/**
 * Default renderer configuration
 */
export function createDefaultCDLODGPUConfig(): CDLODGPUConfig {
  return {
    gridSize: 129,       // 64 cells per patch
    maxInstances: 256,
    debugMode: false,
    useProceduralHeight: true,
    enableSkirts: true,
    skirtDepthMultiplier: 0.1,
    // Procedural detail defaults - tuned for 1km terrain with 1024 heightmap
    detailFrequency: 0.5,       // 0.5 cycles/meter = 2m wavelength (fills gap from ~1m texel)
    detailAmplitude: 0.3,       // 0.3m max displacement
    detailOctaves: 3,           // 3 octaves gives 2m, 1m, 0.5m detail scales
    detailFadeStart: 100,        // Start fading at 50m from camera
    detailFadeEnd: 150,         // Fully faded at 150m
    detailSlopeInfluence: 0.5,  // 50% slope influence (rocky slopes get more detail)
  };
}

/**
 * Default terrain material (3 biomes)
 */
export function createDefaultTerrainMaterial(): TerrainMaterial {
  return {
    // Primary biome colors (grass, rock, forest)
    grassColor: [0.3, 0.5, 0.2],
    rockColor: [0.4, 0.35, 0.3],
    forestColor: [0.35, 0.28, 0.18]
  };
}

/** HDR intermediate format used for all terrain rendering */
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** Shared vertex buffer layouts for CDLOD pipelines */
const CDLOD_VERTEX_BUFFER_LAYOUTS: GPUVertexBufferLayout[] = [
  // Grid vertices (position vec2 + uv vec2 + isSkirt float) = 5 floats
  {
    arrayStride: 5 * 4,
    stepMode: 'vertex',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 0 },  // position
      { format: 'float32x2', offset: 8, shaderLocation: 1 },  // uv
      { format: 'float32', offset: 16, shaderLocation: 6 },   // isSkirt
    ],
  },
  // Instance data (offset vec2 + scale + morph + lod)
  {
    arrayStride: 5 * 4,
    stepMode: 'instance',
    attributes: [
      { format: 'float32x2', offset: 0, shaderLocation: 2 },  // nodeOffset
      { format: 'float32', offset: 8, shaderLocation: 3 },    // nodeScale
      { format: 'float32', offset: 12, shaderLocation: 4 },   // nodeMorph
      { format: 'float32', offset: 16, shaderLocation: 5 },   // nodeLOD
    ],
  },
];

/**
 * WebGPU-based CDLOD Terrain Renderer
 */
export class CDLODRendererGPU {
  private ctx: GPUContext;
  private config: CDLODGPUConfig;
  private quadtree: TerrainQuadtree;
  
  // Debug: unique instance ID
  private readonly instanceId = Math.random().toString(36).substr(2, 9);
  
  // Pipeline
  private pipeline: RenderPipelineWrapper | null = null;
  private wireframePipeline: GPURenderPipeline | null = null;
  private shadowPipeline: GPURenderPipeline | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowBindGroup: GPUBindGroup | null = null;
  private shadowUniformBuffer: UnifiedGPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  
  // Dynamic uniform buffer for CSM shadow passes (same approach as ObjectRendererGPU)
  // Each slot is 256-byte aligned (WebGPU requirement for dynamic offsets)
  // Slot layout: [cascade0, cascade1, cascade2, cascade3, singleMap]
  private static readonly SHADOW_SLOT_SIZE = 256; // Must be 256-byte aligned
  private static readonly MAX_SHADOW_SLOTS = 5;   // 4 cascades + 1 single map
  
  // Buffers using unified abstraction
  private gridVertexBuffer: UnifiedGPUBuffer | null = null;
  private gridIndexBuffer: UnifiedGPUBuffer | null = null;
  private wireframeIndexBuffer: UnifiedGPUBuffer | null = null;
  private instanceBuffer: UnifiedGPUBuffer | null = null;
  private uniformBuffer: UnifiedGPUBuffer | null = null;
  private materialBuffer: UnifiedGPUBuffer | null = null;
  
  // Bind groups
  private bindGroup: GPUBindGroup | null = null;
  
  // Grid mesh data
  private gridIndexCount: number = 0;
  private wireframeIndexCount: number = 0;
  
  // Instance data array (CPU side)
  private instanceData: Float32Array;
  
  // Samplers
  private linearSampler: GPUSampler | null = null;
  private shadowSampler: GPUSampler | null = null;
  
  // Default textures using unified abstraction
  private defaultHeightmap: UnifiedGPUTexture | null = null;
  private defaultNormalMap: UnifiedGPUTexture | null = null;
  private defaultShadowMap: UnifiedGPUTexture | null = null;
  private defaultIslandMask: UnifiedGPUTexture | null = null;
  
  // Placeholder textures singleton (for biome mask, etc.)
  private placeholders: PlaceholderTextures | null = null;
  
  // Biome texture splatting resources (Group 1)
  private biomeResources: TerrainBiomeTextureResources | null = null;
  
  // Last selection (for debugging)
  private lastSelection: SelectionResult | null = null;
  
  // Last camera position from render() - used for shadow pass LOD selection
  private lastCameraPosition: vec3 = vec3.create();
  
  // Shadow-specific instance buffer (separate from camera view)
  private shadowInstanceBuffer: UnifiedGPUBuffer | null = null;
  private shadowInstanceData: Float32Array;
  
  // Uniform builders for efficient updates
  private uniformBuilder: UniformBuilder;
  private materialBuilder: UniformBuilder;
  
  // Current material state for live updates
  private currentMaterial: TerrainMaterial;
  
  // Shared SceneEnvironment for IBL (passed from pipeline)
  private sceneEnvironment: SceneEnvironment | null = null;
  
  constructor(
    ctx: GPUContext,
    quadtreeConfig?: Partial<QuadtreeConfig>,
    rendererConfig?: Partial<CDLODGPUConfig>,
    sceneEnvironment?: SceneEnvironment
  ) {
    this.ctx = ctx;
    this.config = { ...createDefaultCDLODGPUConfig(), ...rendererConfig };
    this.sceneEnvironment = sceneEnvironment ?? null;
    
    // Instance data: offsetX, offsetZ, scale, morphFactor, lodLevel (5 floats per instance)
    this.instanceData = new Float32Array(this.config.maxInstances * 5);
    this.shadowInstanceData = new Float32Array(this.config.maxInstances * 5);
    
    // Uniform builders (52 floats for uniforms including detail + island params, 56 floats for material with beach + shadows)
    this.uniformBuilder = new UniformBuilder(52);
    this.materialBuilder = new UniformBuilder(44); // Expanded for biome color shadow params + lightSpaceMatrix
    
    // Initialize material with defaults
    this.currentMaterial = createDefaultTerrainMaterial();
    
    // Create quadtree
    this.quadtree = new TerrainQuadtree(quadtreeConfig);
    
    // Initialize GPU resources
    this.initializeResources();
  }
  
  /**
   * Initialize all GPU resources
   */
  private initializeResources(): void {
    // Get shared placeholder textures
    this.placeholders = PlaceholderTextures.get(this.ctx);
    
    this.createGridMesh();
    this.createBuffers();
    this.createSamplers();
    this.createDefaultTextures();
    
    // Create biome texture resources (Group 1)
    this.biomeResources = new TerrainBiomeTextureResources(this.ctx);
    
    this.createPipeline();
    this.createShadowPipeline();
  }
  
  /**
   * Create the static grid mesh with optional skirt geometry
   * 
   * Vertex layout: position (vec2) + uv (vec2) + isSkirt (float) = 5 floats per vertex
   * The isSkirt flag (0 or 1) tells the vertex shader to offset Y downward
   */
  private createGridMesh(): void {
    const gridSize = this.config.gridSize;
    
    // Generate vertices: position (vec2) + uv (vec2) + isSkirt (float) = 5 floats per vertex
    const vertices: number[] = [];
    
    // Main grid vertices (isSkirt = 0)
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        // Position (normalized -0.5 to 0.5)
        vertices.push((x / (gridSize - 1)) - 0.5);
        vertices.push((z / (gridSize - 1)) - 0.5);
        // UV (0 to 1)
        vertices.push(x / (gridSize - 1));
        vertices.push(z / (gridSize - 1));
        // isSkirt flag
        vertices.push(0.0);
      }
    }
    
    const mainVertexCount = gridSize * gridSize;
    
    // Generate main grid indices
    const indices: number[] = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const tl = z * gridSize + x;
        const tr = tl + 1;
        const bl = tl + gridSize;
        const br = bl + 1;
        
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }
    
    // Add skirt geometry if enabled
    if (this.config.enableSkirts) {
      this.addSkirtGeometry(vertices, indices, gridSize, mainVertexCount);
    }
    
    this.gridIndexCount = indices.length;
    
    // Create wireframe indices (edges of triangles)
    const wireframeIndices = this.createWireframeIndices(indices);
    this.wireframeIndexCount = wireframeIndices.length;
    
    // Create vertex buffer using UnifiedGPUBuffer
    this.gridVertexBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'cdlod-grid-vertices',
      data: new Float32Array(vertices),
    });
    
    // Create index buffer using UnifiedGPUBuffer
    this.gridIndexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
      label: 'cdlod-grid-indices',
      data: new Uint32Array(indices),
    });
    
    // Create wireframe index buffer
    this.wireframeIndexBuffer = UnifiedGPUBuffer.createIndex(this.ctx, {
      label: 'cdlod-wireframe-indices',
      data: new Uint32Array(wireframeIndices),
    });
  }
  
  /**
   * Create wireframe indices from triangle indices
   * Converts each triangle into 3 line segments (edges)
   */
  private createWireframeIndices(triangleIndices: number[]): number[] {
    const lineIndices: number[] = [];
    
    // Each triangle (3 indices) produces 3 edges (6 indices for line-list)
    for (let i = 0; i < triangleIndices.length; i += 3) {
      const i0 = triangleIndices[i];
      const i1 = triangleIndices[i + 1];
      const i2 = triangleIndices[i + 2];
      
      // Edge 0-1
      lineIndices.push(i0, i1);
      // Edge 1-2
      lineIndices.push(i1, i2);
      // Edge 2-0
      lineIndices.push(i2, i0);
    }
    
    return lineIndices;
  }
  
  /**
   * Add skirt geometry around the edges of the terrain patch
   * 
   * Skirts are vertical strips of geometry that extend downward from each edge.
   * They prevent gaps between adjacent terrain patches at different LOD levels.
   */
  private addSkirtGeometry(
    vertices: number[],
    indices: number[],
    gridSize: number,
    mainVertexCount: number
  ): void {
    let skirtVertexOffset = mainVertexCount;
    
    // Helper to add a skirt vertex (same XZ as edge, but with isSkirt = 1)
    const addSkirtVertex = (x: number, z: number, u: number, v: number): number => {
      vertices.push(x, z, u, v, 1.0); // isSkirt = 1.0
      return skirtVertexOffset++;
    };
    
    // Bottom edge (z = 0): skirt extends in -Z direction
    for (let x = 0; x < gridSize; x++) {
      const edgeIdx = x; // z=0 row
      const px = (x / (gridSize - 1)) - 0.5;
      const pz = -0.5;
      const u = x / (gridSize - 1);
      const v = 0;
      const skirtIdx = addSkirtVertex(px, pz, u, v);
      
      // Create triangles connecting edge to skirt
      if (x < gridSize - 1) {
        const edgeNext = edgeIdx + 1;
        const skirtNext = skirtIdx + 1;
        // Triangle 1
        indices.push(edgeIdx, skirtIdx, edgeNext);
        // Triangle 2
        indices.push(edgeNext, skirtIdx, skirtNext);
      }
    }
    
    // Top edge (z = gridSize-1): skirt extends in +Z direction
    for (let x = 0; x < gridSize; x++) {
      const edgeIdx = (gridSize - 1) * gridSize + x; // z=gridSize-1 row
      const px = (x / (gridSize - 1)) - 0.5;
      const pz = 0.5;
      const u = x / (gridSize - 1);
      const v = 1;
      const skirtIdx = addSkirtVertex(px, pz, u, v);
      
      if (x < gridSize - 1) {
        const edgeNext = edgeIdx + 1;
        const skirtNext = skirtIdx + 1;
        // Triangle 1 (winding order reversed for correct facing)
        indices.push(edgeIdx, edgeNext, skirtIdx);
        // Triangle 2
        indices.push(edgeNext, skirtNext, skirtIdx);
      }
    }
    
    // Left edge (x = 0): skirt extends in -X direction
    for (let z = 0; z < gridSize; z++) {
      const edgeIdx = z * gridSize; // x=0 column
      const px = -0.5;
      const pz = (z / (gridSize - 1)) - 0.5;
      const u = 0;
      const v = z / (gridSize - 1);
      const skirtIdx = addSkirtVertex(px, pz, u, v);
      
      if (z < gridSize - 1) {
        const edgeNext = edgeIdx + gridSize;
        const skirtNext = skirtIdx + 1;
        // Triangle 1
        indices.push(edgeIdx, edgeNext, skirtIdx);
        // Triangle 2
        indices.push(edgeNext, skirtNext, skirtIdx);
      }
    }
    
    // Right edge (x = gridSize-1): skirt extends in +X direction
    for (let z = 0; z < gridSize; z++) {
      const edgeIdx = z * gridSize + (gridSize - 1); // x=gridSize-1 column
      const px = 0.5;
      const pz = (z / (gridSize - 1)) - 0.5;
      const u = 1;
      const v = z / (gridSize - 1);
      const skirtIdx = addSkirtVertex(px, pz, u, v);
      
      if (z < gridSize - 1) {
        const edgeNext = edgeIdx + gridSize;
        const skirtNext = skirtIdx + 1;
        // Triangle 1 (winding order reversed for correct facing)
        indices.push(edgeIdx, skirtIdx, edgeNext);
        // Triangle 2
        indices.push(edgeNext, skirtIdx, skirtNext);
      }
    }
  }
  
  /**
   * Create uniform and instance buffers using UnifiedGPUBuffer
   */
  private createBuffers(): void {
    // Instance buffer (5 floats per instance: offsetX, offsetZ, scale, morph, lod)
    this.instanceBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'cdlod-instances',
      size: this.config.maxInstances * 5 * 4,
    });
    
    // Separate instance buffer for shadow pass (independent of camera view)
    this.shadowInstanceBuffer = UnifiedGPUBuffer.createVertex(this.ctx, {
      label: 'cdlod-shadow-instances',
      size: this.config.maxInstances * 5 * 4,
    });
    
    // Uniform buffer for matrices and terrain params (208 bytes → 256 aligned)
    // 52 floats: mat4(16) + mat4(16) + vec4(cameraPos+pad) + vec4(terrain params) + vec4(detail params 1) + vec4(detail params 2) + vec4(island params)
    this.uniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'cdlod-uniforms',
      size: 208, // Will be aligned to 256
    });
    
    // Material buffer (224 bytes → 256 aligned)
    // 56 floats: vec4 grass + vec4 rock + vec4 snow + vec4 dirt + vec4 beach + 
    //           vec4 (snowLine, rockLine, maxGrassSlope, beachMaxHeight) +
    //           vec4 (lightDir + beachMaxSlope) + vec4 (lightColor + pad) +
    //           vec4 (ambient, selected, shadowEnabled, shadowSoftness) +
    //           vec4 (shadowRadius, shadowFadeStart, pad, pad) + mat4 lightSpaceMatrix
    this.materialBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'cdlod-material',
      size: 224, // Will be aligned to 256
    });
    
    // Shadow uniform buffer with dynamic offsets for CSM
    // Each slot: 96 bytes (mat4 + vec4 + vec4) padded to 256-byte alignment
    // Total: 5 slots × 256 bytes = 1280 bytes
    const totalShadowSize = CDLODRendererGPU.SHADOW_SLOT_SIZE * CDLODRendererGPU.MAX_SHADOW_SLOTS;
    this.shadowUniformBuffer = UnifiedGPUBuffer.createUniform(this.ctx, {
      label: 'cdlod-shadow-uniforms-dynamic',
      size: totalShadowSize,
    });
  }
  
  /**
   * Create texture samplers using SamplerFactory
   */
  private createSamplers(): void {
    this.linearSampler = SamplerFactory.linear(this.ctx, 'cdlod-linear-sampler');
    
    // Shadow comparison sampler for PCF filtering
    this.shadowSampler = this.ctx.device.createSampler({
      label: 'cdlod-shadow-sampler',
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }
  
  /**
   * Create default placeholder textures using UnifiedGPUTexture
   */
  private createDefaultTextures(): void {
    // Create default heightmap (r32float)
    this.defaultHeightmap = UnifiedGPUTexture.createHeightmap(this.ctx, 1, 1, 'cdlod-default-heightmap');
    this.defaultHeightmap.uploadData(this.ctx, new Float32Array([0.5]), 4);
    
    // Create default normal map (rgba8unorm pointing up)
    this.defaultNormalMap = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'cdlod-default-normalmap',
      width: 1,
      height: 1,
      format: 'rgba8unorm',
    });
    this.defaultNormalMap.uploadData(this.ctx, new Uint8Array([128, 128, 255, 255]), 4);
    
    // Create default shadow map (1x1 depth texture)
    this.defaultShadowMap = UnifiedGPUTexture.createDepth(this.ctx, 1, 1, 'depth32float', 'cdlod-default-shadowmap');
    
    // Create default island mask (1x1, fully land = 1.0, r32float for consistency)
    this.defaultIslandMask = UnifiedGPUTexture.create2D(this.ctx, {
      label: 'cdlod-default-island-mask',
      width: 1,
      height: 1,
      format: 'r32float',
    });
    this.defaultIslandMask.uploadData(this.ctx, new Float32Array([1.0]), 4); // 1.0 = land
  }
  
  /**
   * Create the render pipeline using RenderPipelineWrapper
   * 
   * Bind Group Layout:
   * - Group 0: Terrain-specific resources (uniforms, material, heightmap, normalmap, etc.)
   * - Group 3: SceneEnvironment (shadow + IBL) - shared across all renderers
   */
  private createPipeline(): void {
    // Create bind group layout using BindGroupLayoutBuilder
    this.bindGroupLayout = new BindGroupLayoutBuilder('cdlod-bind-group-layout')
      .uniformBuffer(0, 'all')                     // Uniforms (vertex + fragment)
      .uniformBuffer(1, 'all')                     // Material (vertex needs lightSpaceMatrix, fragment needs colors)
      .texture(2, 'all', 'unfilterable-float')     // Heightmap (r32float) - sampled in both vertex and fragment for debug
      .texture(3, 'all', 'float')                  // Normal map (sampled in vertex shader)
      .sampler(4, 'all', 'filtering')              // Linear sampler
      .depthTexture(5, 'fragment')                 // Shadow map (depth texture)
      .comparisonSampler(6, 'fragment')            // Shadow comparison sampler
      .texture(7, 'all', 'unfilterable-float')     // Island mask (r32float, sampled in vertex + fragment for beach)
      .texture(8, 'fragment', 'float')             // Biome mask (rgba8, R=grass, G=rock, B=forest weights)
      .build(this.ctx);
    
    // Get terrain-specific minimal environment layout from SceneEnvironment
    // Uses only diffuse IBL + sampler (bindings 2, 5) to stay within 16 texture limit
    const terrainEnvLayout = this.sceneEnvironment
      ? this.sceneEnvironment.getLayoutForMask(CDLODRendererGPU.TERRAIN_ENV_MASK)
      : this.ctx.device.createBindGroupLayout({
          label: 'cdlod-terrain-env-layout-fallback',
          entries: SceneEnvironment.getBindGroupLayoutEntriesForMask(CDLODRendererGPU.TERRAIN_ENV_MASK),
        });
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'cdlod-shader',
      code: ShaderSources.terrainCDLOD,
    });
    
    // Create pipeline layout with Groups 0, 1, and 3
    // Group 0: Terrain core resources
    // Group 1: Biome textures (splatting)
    // Group 2: unused
    // Group 3: Terrain-specific minimal environment (diffuse IBL only)
    this.pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'cdlod-pipeline-layout',
      bindGroupLayouts: [
        this.bindGroupLayout, 
        this.biomeResources!.bindGroupLayout!, 
        undefined as any, 
        terrainEnvLayout
      ],
    });
    
    // Create solid render pipeline
    const solidPipeline = this.ctx.device.createRenderPipeline({
      label: 'cdlod-render-pipeline',
      layout: this.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: CDLOD_VERTEX_BUFFER_LAYOUTS,
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reversed-Z: near=1, far=0
      },
    });
    
    // Wrap in RenderPipelineWrapper for consistency
    this.pipeline = { pipeline: solidPipeline } as RenderPipelineWrapper;
    
    // Create wireframe pipeline with line-list topology
    this.wireframePipeline = this.ctx.device.createRenderPipeline({
      label: 'cdlod-wireframe-pipeline',
      layout: this.pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: CDLOD_VERTEX_BUFFER_LAYOUTS,
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: 'rgba16float' as GPUTextureFormat, // HDR intermediate format
        }],
      },
      primitive: {
        topology: 'line-list',
        cullMode: 'none',  // No culling for wireframe
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',  // Reversed-Z: greater-equal to avoid z-fighting
      },
    });
  }
  
  /** Environment binding mask for terrain - diffuse IBL + CSM shadow maps */
  private static readonly TERRAIN_ENV_MASK = ENV_BINDING_MASK.DIFFUSE_IBL | ENV_BINDING_MASK.CSM_SHADOW;
  
  /**
   * Update the bind group with current textures using BindGroupBuilder
   */
  private updateBindGroup(
    heightmapTexture?: UnifiedGPUTexture,
    normalMapTexture?: UnifiedGPUTexture,
    shadowMapTexture?: UnifiedGPUTexture | null,
    islandMaskTexture?: UnifiedGPUTexture | null,
    biomeMaskView?: GPUTextureView | null
  ): void {
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.materialBuffer || 
        !this.linearSampler || !this.shadowSampler || !this.placeholders) {
      return;
    }
    
    const heightmap = heightmapTexture || this.defaultHeightmap!;
    const normalMap = normalMapTexture || this.defaultNormalMap!;
    const shadowMap = shadowMapTexture || this.defaultShadowMap!;
    const islandMask = islandMaskTexture || this.defaultIslandMask!;
    const biomeMask = biomeMaskView || this.placeholders.biomeMaskView;
    
    this.bindGroup = new BindGroupBuilder('cdlod-bind-group')
      .buffer(0, this.uniformBuffer)
      .buffer(1, this.materialBuffer)
      .texture(2, heightmap)
      .texture(3, normalMap)
      .sampler(4, this.linearSampler)
      .texture(5, shadowMap)
      .sampler(6, this.shadowSampler)
      .texture(7, islandMask)
      .texture(8, biomeMask)
      .build(this.ctx, this.bindGroupLayout);
  }
  
  /**
   * Render terrain using CDLOD
   */
  render(
    passEncoder: GPURenderPassEncoder,
    params: CDLODRenderParams
  ): number {
    if (!this.pipeline || !this.uniformBuffer || !this.materialBuffer || 
        !this.gridVertexBuffer || !this.gridIndexBuffer || !this.instanceBuffer) {
      return 0;
    }
    
    // Update quadtree config if terrain size changed
    const currentConfig = this.quadtree.getConfig();
    if (params.terrainSize !== currentConfig.worldSize || 
        params.heightScale * 2 !== currentConfig.maxHeight) {
      this.quadtree.setConfig({
        worldSize: params.terrainSize,
        minHeight: -params.heightScale * 0.5,
        maxHeight: params.heightScale * 2,
      });
    }
    
    const cameraPos = params.sceneCameraPosition ?? params.cameraPosition;
    const viewProjMat = params.sceneViewProjectionMatrix ?? params.viewProjectionMatrix;

    // Select visible nodes
    const selection = this.quadtree.select(cameraPos, viewProjMat);
    this.lastSelection = selection;
    
    // Store camera position for shadow pass LOD selection
    vec3.copy(this.lastCameraPosition, cameraPos);
    
    if (selection.nodes.length === 0) {
      return 0;
    }
    
    // Update buffers
    this.updateInstanceBuffer(selection.nodes);
    this.updateUniformBuffer(params);
    this.updateMaterialBuffer(params);
    
    // Update bind group with shadow map and island mask
    this.updateBindGroup(
      params.heightmapTexture, 
      params.normalMapTexture,
      params.shadow?.shadowMap,
      params.island?.maskTexture,
      params.biomeMaskTexture?.view
    );
    
    if (!this.bindGroup) {
      return 0;
    }
    
    // Choose between solid and wireframe rendering
    const useWireframe = params.wireframe && this.wireframePipeline && this.wireframeIndexBuffer;
    
    // Update biome params buffer if material has changed
    this.updateBiomeParams();
    
    if (useWireframe) {
      // Wireframe rendering - shows LOD grid density
      passEncoder.setPipeline(this.wireframePipeline!);
      passEncoder.setBindGroup(0, this.bindGroup);
      
      // Set bind group 1 for biome textures
      if (this.biomeResources?.bindGroup) {
        passEncoder.setBindGroup(1, this.biomeResources.bindGroup);
      }
      
      // Set bind group 3 for IBL using masked bind group (diffuse IBL only)
      if (params.sceneEnvironment) {
        passEncoder.setBindGroup(3, params.sceneEnvironment.getBindGroupForMask(CDLODRendererGPU.TERRAIN_ENV_MASK));
      }
      
      passEncoder.setVertexBuffer(0, this.gridVertexBuffer.buffer);
      passEncoder.setVertexBuffer(1, this.instanceBuffer.buffer);
      passEncoder.setIndexBuffer(this.wireframeIndexBuffer!.buffer, 'uint32');
      
      // Draw wireframe instanced
      passEncoder.drawIndexed(this.wireframeIndexCount, selection.nodes.length);
    } else {
      // Solid rendering
      passEncoder.setPipeline(this.pipeline.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      
      // Set bind group 1 for biome textures
      if (this.biomeResources?.bindGroup) {
        passEncoder.setBindGroup(1, this.biomeResources.bindGroup);
      }
      
      // Set bind group 3 for IBL using masked bind group (diffuse IBL only)
      if (params.sceneEnvironment) {
        passEncoder.setBindGroup(3, params.sceneEnvironment.getBindGroupForMask(CDLODRendererGPU.TERRAIN_ENV_MASK));
      }
      
      passEncoder.setVertexBuffer(0, this.gridVertexBuffer.buffer);
      passEncoder.setVertexBuffer(1, this.instanceBuffer.buffer);
      passEncoder.setIndexBuffer(this.gridIndexBuffer.buffer, 'uint32');
      
      // Draw instanced
      passEncoder.drawIndexed(this.gridIndexCount, selection.nodes.length);
    }

    return 1;
  }
  
  /**
   * Update instance buffer with selected nodes
   */
  private updateInstanceBuffer(nodes: TerrainNode[]): void {
    const count = Math.min(nodes.length, this.config.maxInstances);
    
    // Get maxLodLevels from quadtree config to invert the LOD level
    // Quadtree convention: lodLevel 0 = root (largest nodes, lowest detail)
    // Shader/mipmap convention: mipLevel 0 = highest resolution (highest detail)
    const maxLodLevels = this.quadtree.getConfig().maxLodLevels;
    
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      const offset = i * 5;
      
      this.instanceData[offset + 0] = node.center[0];     // offsetX
      this.instanceData[offset + 1] = node.center[2];     // offsetZ
      this.instanceData[offset + 2] = node.size / (this.config.gridSize - 1);  // scale
      this.instanceData[offset + 3] = node.morphFactor;   // morph
      
      // Invert lodLevel for shader mipmap sampling:
      // Root nodes (lodLevel=0, large, far away) should sample higher mipmaps (lower detail)
      // Leaf nodes (lodLevel=N, small, close) should sample mip 0 (highest detail)
      this.instanceData[offset + 4] = maxLodLevels - 1 - node.lodLevel;
    }
    
    // Use UnifiedGPUBuffer.write method
    this.instanceBuffer!.write(
      this.ctx,
      this.instanceData.subarray(0, count * 5)
    );
  }
  
  /**
   * Update uniform buffer with matrices and params using UniformBuilder
   * Layout matches shader Uniforms struct (52 floats = 208 bytes)
   */
  private updateUniformBuffer(params: CDLODRenderParams): void {
    const island = params.island;
    const cameraPos = params.sceneCameraPosition ?? params.cameraPosition;
    
    this.uniformBuilder.reset()
      // Always need to transform vertices via the current view proj mat
      .mat4(params.viewProjectionMatrix as Float32Array)  // 0-15
      .mat4(params.modelMatrix as Float32Array)           // 16-31
      .vec3(cameraPos[0], cameraPos[1], cameraPos[2]) // 32-35 (padded to vec4)
      .vec4(params.terrainSize, params.heightScale, this.config.gridSize, this.config.debugMode ? 1.0 : 0.0) // 36-39
      // Procedural detail parameters (40-47)
      .vec4(
        this.config.skirtDepthMultiplier,   // 40 - skirtDepth
        this.config.detailFrequency,        // 41 - detailFrequency  
        this.config.detailAmplitude,        // 42 - detailAmplitude
        this.config.detailOctaves           // 43 - detailOctaves
      )
      .vec4(
        this.config.detailFadeStart,        // 44 - detailFadeStart
        this.config.detailFadeEnd,          // 45 - detailFadeEnd
        this.config.detailSlopeInfluence,   // 46 - detailSlopeInfluence
        0.0                                 // 47 - _pad1
      )
      // Island mode parameters (48-51)
      .vec4(
        island?.enabled ? 1.0 : 0.0,        // 48 - islandEnabled
        island?.seaFloorDepth ?? -0.3,      // 49 - seaFloorDepth
        0.0,                                // 50 - _pad2
        0.0                                 // 51 - _pad3
      );
    
    this.uniformBuffer!.write(this.ctx, this.uniformBuilder.build());
  }
  
  /**
   * Update material buffer using UniformBuilder
   * Uses stored currentMaterial merged with render params
   * Layout matches shader Material struct (56 floats = 224 bytes)
   */
  private updateMaterialBuffer(params: CDLODRenderParams): void {
    const mat = { ...this.currentMaterial, ...params.material };
    const lightDir = params.lightDirection || [0.5, 1, 0.5];
    const lightColor = params.lightColor || [1, 1, 1];
    
    // Shadow parameters
    const shadow = params.shadow;
    const shadowEnabled = shadow?.enabled ? 1.0 : 0.0;
    const shadowSoftness = shadow?.softShadows ? 1.0 : 0.0;
    const shadowRadius = shadow?.shadowRadius ?? 200;
    const shadowFadeStart = shadowRadius * 0.8;
    const csmEnabled = shadow?.csmEnabled ? 1.0 : 0.0;
    const lightSpaceMatrix = shadow?.lightSpaceMatrix || mat4.create();
    
    this.materialBuilder.reset()
      .vec4(mat.grassColor[0], mat.grassColor[1], mat.grassColor[2], 1.0)     // 0-3
      .vec4(mat.rockColor[0], mat.rockColor[1], mat.rockColor[2], 1.0)        // 4-7
      .vec4(mat.forestColor[0], mat.forestColor[1], mat.forestColor[2], 1.0)  // 8-11
      .vec4(lightDir[0], lightDir[1], lightDir[2], 1.0)                       // 12-15
      .vec4(lightColor[0], lightColor[1], lightColor[2], 0)                   // 16-19
      .vec4(params.ambientIntensity ?? 0.3, 0.0 /* reserved (selection via outline pass) */, shadowEnabled, shadowSoftness) // 20-23
      .vec4(shadowRadius, shadowFadeStart, csmEnabled, 0)                     // 24-27 (csmEnabled at index 26)
      .mat4(lightSpaceMatrix as Float32Array);                                // 28-43
    
    this.materialBuffer!.write(this.ctx, this.materialBuilder.build());
  }
  
  // ============ Configuration ============
  
  setDebugMode(enabled: boolean): void {
    this.config.debugMode = enabled;
  }
  
  setUseProceduralHeight(enabled: boolean): void {
    this.config.useProceduralHeight = enabled;
  }
  
  /**
   * Set terrain material for live updates (without full regeneration)
   * Changes take effect on next render frame
   */
  setMaterial(material: Partial<TerrainMaterial>): void {
    this.currentMaterial = { ...this.currentMaterial, ...material };
  }
  
  /**
   * Update biome params from current material state
   */
  private updateBiomeParams(): void {
    if (!this.biomeResources) return;
    
    // Convert TerrainMaterial to TerrainMaterialParams format
    this.biomeResources.updateParams({
      grassColor: this.currentMaterial.grassColor,
      rockColor: this.currentMaterial.rockColor,
      forestColor: this.currentMaterial.forestColor,
      grassTexture: this.currentMaterial.grassTexture,
      rockTexture: this.currentMaterial.rockTexture,
      forestTexture: this.currentMaterial.forestTexture,
    });
    this.biomeResources.ensureBindGroup();
  }
  
  /**
   * Load and set a biome texture from a URL.
   * Validates that source is 4096x4096, downsamples to current resolution.
   * @param biome - Biome type ('grass', 'rock', 'snow', 'dirt', 'beach')
   * @param type - Texture type ('albedo' or 'normal')
   * @param url - URL path to texture file (must be 4096x4096)
   * @param tilingScale - Optional world-space tiling scale (meters per tile)
   * @returns true if loaded successfully, false if rejected (wrong size)
   */
  async setBiomeTexture(
    biome: BiomeType,
    type: TextureType,
    url: string,
    tilingScale?: number
  ): Promise<boolean> {
    if (!this.biomeResources) {
      console.warn('[CDLODRendererGPU] Biome resources not initialized');
      return false;
    }
    
    // Update tiling scale if provided
    if (tilingScale !== undefined) {
      this.biomeResources.setTiling(biome, tilingScale);
    }
    
    // Load texture via biome resources (handles validation, downsampling, caching)
    const success = await this.biomeResources.loadTextureFromURL(url, biome, type);
    return success;
  }
  
  /**
   * Clear a biome texture (revert to procedural color)
   * @param biome - Biome type to clear
   * @param type - Texture type to clear
   */
  clearBiomeTexture(biome: BiomeType, type: TextureType): void {
    this.biomeResources?.clearTexture(biome, type);
  }
  
  /**
   * Set biome tiling scale (world-space meters per texture tile)
   * @param biome - Biome type to update
   * @param scale - Tiling scale in world units
   */
  setBiomeTiling(biome: BiomeType, scale: number): void {
    this.biomeResources?.setTiling(biome, scale);
  }
  
  /**
   * Check if a biome texture is loaded
   */
  hasBiomeTexture(biome: BiomeType, type: TextureType): boolean {
    return this.biomeResources?.hasTexture(biome, type) ?? false;
  }
  
  /**
   * Set the biome texture resolution.
   * If changed, recreates arrays and re-downsamples all loaded textures.
   */
  async setBiomeResolution(resolution: 1024 | 2048 | 4096): Promise<void> {
    await this.biomeResources?.setResolution(resolution);
  }
  
  /**
   * Get current biome texture resolution
   */
  getBiomeResolution(): 1024 | 2048 | 4096 {
    return this.biomeResources?.resolution ?? 2048;
  }
  
  /**
   * Get the biome texture resources manager
   */
  getBiomeResources(): TerrainBiomeTextureResources | null {
    return this.biomeResources;
  }
  
  /**
   * Get current terrain material
   */
  getMaterial(): TerrainMaterial {
    return { ...this.currentMaterial };
  }
  
  getQuadtree(): TerrainQuadtree {
    return this.quadtree;
  }
  
  getLastSelection(): SelectionResult | null {
    return this.lastSelection;
  }
  
  getConfig(): CDLODGPUConfig {
    return { ...this.config };
  }
  
  /**
   * Get geometry buffers for external rendering (e.g., shadow pass)
   * Returns the vertex, index, and instance buffers along with counts
   */
  getGeometryBuffers(): {
    vertexBuffer: UnifiedGPUBuffer | null;
    indexBuffer: UnifiedGPUBuffer | null;
    instanceBuffer: UnifiedGPUBuffer | null;
    indexCount: number;
    instanceCount: number;
  } | null {
    if (!this.gridVertexBuffer || !this.gridIndexBuffer || !this.instanceBuffer) {
      return null;
    }
    
    return {
      vertexBuffer: this.gridVertexBuffer,
      indexBuffer: this.gridIndexBuffer,
      instanceBuffer: this.instanceBuffer,
      indexCount: this.gridIndexCount,
      instanceCount: this.lastSelection?.nodes.length ?? 0,
    };
  }
  
  /**
   * Set procedural detail configuration for live updates
   * Changes take effect on next render frame
   */
  setDetailConfig(detail: {
    frequency?: number;
    amplitude?: number;
    octaves?: number;
    fadeStart?: number;
    fadeEnd?: number;
    slopeInfluence?: number;
  }): void {
    if (detail.frequency !== undefined) this.config.detailFrequency = detail.frequency;
    if (detail.amplitude !== undefined) this.config.detailAmplitude = detail.amplitude;
    if (detail.octaves !== undefined) this.config.detailOctaves = detail.octaves;
    if (detail.fadeStart !== undefined) this.config.detailFadeStart = detail.fadeStart;
    if (detail.fadeEnd !== undefined) this.config.detailFadeEnd = detail.fadeEnd;
    if (detail.slopeInfluence !== undefined) this.config.detailSlopeInfluence = detail.slopeInfluence;
  }
  
  /**
   * Get current procedural detail configuration
   */
  getDetailConfig(): {
    frequency: number;
    amplitude: number;
    octaves: number;
    fadeStart: number;
    fadeEnd: number;
    slopeInfluence: number;
  } {
    return {
      frequency: this.config.detailFrequency,
      amplitude: this.config.detailAmplitude,
      octaves: this.config.detailOctaves,
      fadeStart: this.config.detailFadeStart,
      fadeEnd: this.config.detailFadeEnd,
      slopeInfluence: this.config.detailSlopeInfluence,
    };
  }
  
  // ============ Shader Hot Reload ============
  
  /**
   * Reload the shader with new WGSL source code
   * Recreates the render pipeline while preserving all other state
   * @param newSource New WGSL source code
   * @returns true if successful, false if compilation failed
   */
  reloadShader(newSource: string): boolean {
    if (!this.bindGroupLayout) {
      console.error('[CDLODRendererGPU] Cannot reload shader: bind group layout not initialized');
      return false;
    }
    
    try {
      // Recreate pipelines with new shader source
      this.recreatePipelines(newSource);
      console.log('[CDLODRendererGPU] Shader reloaded successfully');
      return true;
    } catch (e) {
      console.error('[CDLODRendererGPU] Shader reload failed:', e);
      return false;
    }
  }
  
  /**
   * Reload shader from a pre-compiled GPUShaderModule
   * Used by shader manager's onRecompile callback
   */
  reloadShaderFromModule(module: GPUShaderModule): boolean {
    if (!this.bindGroupLayout) {
      console.error('[CDLODRendererGPU] Cannot reload shader: bind group layout not initialized');
      return false;
    }
    
    try {
      // Recreate pipelines with pre-compiled module
      this.recreatePipelinesFromModule(module);
      console.log('[CDLODRendererGPU] Shader reloaded from module successfully');
      return true;
    } catch (e) {
      console.error('[CDLODRendererGPU] Shader reload from module failed:', e);
      return false;
    }
  }
  
  /**
   * Recreate both solid and wireframe pipelines from shader source
   * Uses shared constants for vertex layouts and formats
   */
  private recreatePipelines(shaderSource: string): void {
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'cdlod-shader',
      code: shaderSource,
    });
    
    this.recreatePipelinesFromModule(shaderModule);
  }
  
  /**
   * Recreate both solid and wireframe pipelines from pre-compiled module
   * Uses shared constants for vertex layouts and formats
   */
  private recreatePipelinesFromModule(module: GPUShaderModule): void {
    if (!this.bindGroupLayout) return;
    
    // Create or reuse pipeline layout
    if (!this.pipelineLayout) {
      this.pipelineLayout = this.ctx.device.createPipelineLayout({
        label: 'cdlod-pipeline-layout',
        bindGroupLayouts: [this.bindGroupLayout],
      });
    }
    
    // Create solid render pipeline
    const solidPipeline = this.ctx.device.createRenderPipeline({
      label: 'cdlod-render-pipeline',
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: CDLOD_VERTEX_BUFFER_LAYOUTS,
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reversed-Z: near=1, far=0
      },
    });
    
    // Create wireframe pipeline
    this.wireframePipeline = this.ctx.device.createRenderPipeline({
      label: 'cdlod-wireframe-pipeline',
      layout: this.pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: CDLOD_VERTEX_BUFFER_LAYOUTS,
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: HDR_FORMAT }],
      },
      primitive: {
        topology: 'line-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater-equal',  // Reversed-Z: greater-equal to avoid z-fighting
      },
    });
    
    // Wrap solid pipeline for consistency with RenderPipelineWrapper interface
    this.pipeline = { pipeline: solidPipeline } as RenderPipelineWrapper;
  }
  
  /**
   * Get current shader source for live editing
   * Note: Returns the statically imported source, not modified versions
   */
  getShaderSource(): string {
    return ShaderSources.terrainCDLOD;
  }
  
  // ============ Shadow Pass ============
  
  /**
   * Create shadow pass pipeline and resources
   * Uses depth-only rendering with the same vertex layout as main render
   */
  private createShadowPipeline(): void {
    // Create bind group layout for shadow pass (dynamic offset for CSM support)
    // Binding 0: uniforms with dynamic offset (lightSpaceMatrix, terrain params)
    // Binding 1: heightmap texture
    this.shadowBindGroupLayout = this.ctx.device.createBindGroupLayout({
      label: 'cdlod-shadow-bind-group-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    
    // Create pipeline layout
    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'cdlod-shadow-pipeline-layout',
      bindGroupLayouts: [this.shadowBindGroupLayout],
    });
    
    // Create shader module
    const shaderModule = this.ctx.device.createShaderModule({
      label: 'cdlod-shadow-shader',
      code: cdlodShadowShader,
    });
    
    // Create depth-only render pipeline
    this.shadowPipeline = this.ctx.device.createRenderPipeline({
      label: 'cdlod-shadow-pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_shadow',
        buffers: CDLOD_VERTEX_BUFFER_LAYOUTS,
      },
      // No fragment shader - depth-only rendering
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',  // No culling for shadow maps - ensures shadows cast even when light is inside geometry
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',  // Standard depth for shadow map (not reversed-Z)
      },
    });
  }
  
  /**
   * Update shadow bind group with current heightmap texture
   * Uses dynamic offset support - size must match shader's ShadowUniforms struct (96 bytes)
   */
  private updateShadowBindGroup(heightmapTexture?: UnifiedGPUTexture): void {
    if (!this.shadowBindGroupLayout || !this.shadowUniformBuffer) {
      return;
    }
    
    const heightmap = heightmapTexture || this.defaultHeightmap!;
    
    // Create bind group with explicit size (96 bytes = what shader expects)
    this.shadowBindGroup = this.ctx.device.createBindGroup({
      label: 'cdlod-shadow-bind-group',
      layout: this.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformBuffer.buffer, size: 96 } },
        { binding: 1, resource: heightmap.view },
      ],
    });
  }
  
  /**
   * Pre-write all shadow uniforms to the dynamic uniform buffer.
   * Must be called ONCE before recording any shadow render passes.
   * 
   * Each slot contains the full ShadowUniforms struct (96 bytes = 24 floats)
   * padded to 256-byte alignment.
   * 
   * @param matrices - Array of { lightSpaceMatrix, lightPosition } for each slot
   * @param terrainSize - Terrain world size
   * @param heightScale - Terrain height scale
   */
  writeShadowUniforms(
    matrices: { lightSpaceMatrix: mat4; lightPosition: vec3 }[],
    terrainSize: number,
    heightScale: number,
  ): void {
    if (!this.shadowUniformBuffer) return;
    
    const slotSize = CDLODRendererGPU.SHADOW_SLOT_SIZE;
    const floatsPerSlot = slotSize / 4; // 64 floats per 256-byte slot
    const totalFloats = floatsPerSlot * matrices.length;
    const data = new Float32Array(totalFloats);
    
    for (let i = 0; i < matrices.length; i++) {
      const base = i * floatsPerSlot;
      const { lightSpaceMatrix, lightPosition } = matrices[i];
      
      // mat4 lightSpaceMatrix (16 floats)
      data.set(lightSpaceMatrix as Float32Array, base);
      
      // vec3 cameraPosition + pad (4 floats)
      data[base + 16] = lightPosition[0];
      data[base + 17] = lightPosition[1];
      data[base + 18] = lightPosition[2];
      data[base + 19] = 0; // padding
      
      // terrainSize, heightScale, gridSize, skirtDepth (4 floats)
      data[base + 20] = terrainSize;
      data[base + 21] = heightScale;
      data[base + 22] = this.config.gridSize;
      data[base + 23] = this.config.skirtDepthMultiplier;
    }
    
    this.shadowUniformBuffer.write(this.ctx, data);
  }
  
  /**
   * Render terrain to shadow map using a pre-written uniform slot.
   * 
   * Call writeShadowUniforms() once before recording render passes,
   * then call this method for each cascade/single-map pass with the
   * appropriate slotIndex to select the correct light-space matrix
   * via dynamic uniform buffer offset.
   * 
   * LOD STRATEGY: Uses the CAMERA position for LOD distance calculation
   * but the LIGHT's view-projection matrix for frustum culling. This ensures:
   * - Terrain outside the camera view but inside the cascade volume is included
   *   (so off-screen terrain can still cast shadows into the visible area)
   * - LOD levels and morph factors are determined by camera distance, matching
   *   the main pass for terrain that appears in both views (eliminating
   *   self-shadowing artifacts from LOD/morph mismatch)
   * 
   * @param passEncoder - Shadow map render pass encoder
   * @param slotIndex - Index into the pre-written uniform slots (0-4)
   * @param lightSpaceMatrix - Light's view-projection matrix (used for frustum culling)
   * @param lightPosition - Light position (unused, kept for API compat)
   * @param heightmapTexture - Optional heightmap texture
   */
  renderShadowPass(
    passEncoder: GPURenderPassEncoder,
    slotIndex: number,
    lightSpaceMatrix: mat4,
    lightPosition: vec3,
    heightmapTexture?: UnifiedGPUTexture,
  ): void {
    if (!this.shadowPipeline || !this.shadowUniformBuffer ||
        !this.gridVertexBuffer || !this.gridIndexBuffer || !this.shadowInstanceBuffer) {
      return;
    }

    // Select nodes using CAMERA position for LOD + LIGHT frustum for culling.
    // - lightSpaceMatrix → frustum planes → includes off-screen terrain in cascade volume
    // - lastCameraPosition → LOD distance → matches main pass for visible terrain
    const shadowSelection = this.quadtree.select(this.lastCameraPosition, lightSpaceMatrix);
    if (shadowSelection.nodes.length === 0) {
      return;
    }
    
    // Update shadow instance buffer with camera-distance-based LOD + morph
    this.updateShadowInstanceBuffer(shadowSelection.nodes);
    
    // Update bind group with heightmap (bind group is reusable across slots)
    this.updateShadowBindGroup(heightmapTexture);
    
    if (!this.shadowBindGroup) {
      return;
    }
    
    // Calculate dynamic offset for this slot (256-byte aligned)
    const dynamicOffset = slotIndex * CDLODRendererGPU.SHADOW_SLOT_SIZE;
    
    // Draw shadow pass with shadow instance buffer (camera LOD, light frustum)
    passEncoder.setPipeline(this.shadowPipeline);
    passEncoder.setBindGroup(0, this.shadowBindGroup, [dynamicOffset]);
    passEncoder.setVertexBuffer(0, this.gridVertexBuffer.buffer);
    passEncoder.setVertexBuffer(1, this.shadowInstanceBuffer.buffer);
    passEncoder.setIndexBuffer(this.gridIndexBuffer.buffer, 'uint32');
    
    passEncoder.drawIndexed(this.gridIndexCount, shadowSelection.nodes.length);
  }

  /**
   * Update shadow instance buffer with selected nodes
   * Uses a separate buffer from camera rendering for independence
   */
  private updateShadowInstanceBuffer(nodes: TerrainNode[]): void {
    const count = Math.min(nodes.length, this.config.maxInstances);
    const maxLodLevels = this.quadtree.getConfig().maxLodLevels;
    
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      const offset = i * 5;
      
      this.shadowInstanceData[offset + 0] = node.center[0];     // offsetX
      this.shadowInstanceData[offset + 1] = node.center[2];     // offsetZ
      this.shadowInstanceData[offset + 2] = node.size / (this.config.gridSize - 1);  // scale
      this.shadowInstanceData[offset + 3] = node.morphFactor;   // morph
      this.shadowInstanceData[offset + 4] = maxLodLevels - 1 - node.lodLevel;
    }
    
    this.shadowInstanceBuffer!.write(
      this.ctx,
      this.shadowInstanceData.subarray(0, count * 5)
    );
  }

  // ============ Cleanup ============

  destroy(): void {
    this.gridVertexBuffer?.destroy();
    this.gridIndexBuffer?.destroy();
    this.wireframeIndexBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.shadowInstanceBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.materialBuffer?.destroy();
    this.shadowUniformBuffer?.destroy();
    this.defaultHeightmap?.destroy();
    this.defaultNormalMap?.destroy();
    this.defaultShadowMap?.destroy();
    this.defaultIslandMask?.destroy();
    this.biomeResources?.destroy();
    
    this.gridVertexBuffer = null;
    this.gridIndexBuffer = null;
    this.wireframeIndexBuffer = null;
    this.instanceBuffer = null;
    this.shadowInstanceBuffer = null;
    this.uniformBuffer = null;
    this.materialBuffer = null;
    this.shadowUniformBuffer = null;
    this.defaultHeightmap = null;
    this.defaultNormalMap = null;
    this.defaultShadowMap = null;
    this.defaultIslandMask = null;
    this.biomeResources = null;
    this.pipeline = null;
    this.wireframePipeline = null;
    this.shadowPipeline = null;
    this.bindGroup = null;
    this.shadowBindGroup = null;
    this.bindGroupLayout = null;
    this.shadowBindGroupLayout = null;
    this.linearSampler = null;
    this.shadowSampler = null;
  }
}
