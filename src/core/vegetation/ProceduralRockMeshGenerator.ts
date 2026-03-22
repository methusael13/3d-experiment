/**
 * ProceduralRockMeshGenerator
 * 
 * Generates procedural rock meshes on the GPU via compute shaders.
 * Produces a ProceduralRockRef containing 4 LOD-tier meshes (icosphere subdivisions 0-3)
 * plus baked albedo+AO and normal map textures.
 * 
 * Usage:
 *   const generator = new ProceduralRockMeshGenerator(ctx);
 *   const rockRef = generator.generate(seed, [0.5, 0.5, 0.5]);
 *   // rockRef.lodMeshes[0..3] are VegetationMesh objects
 *   // rockRef.albedoTexture / normalTexture are 128×128 rgba8unorm
 * 
 * The generated meshes use the standard interleaved vertex layout
 * (pos+normal+uv = 32 bytes/vertex) and are directly compatible with
 * VegetationMeshVariantRenderer → VariantMeshPool → PBR pipeline.
 */

import {
  GPUContext,
  UnifiedGPUBuffer,
  UnifiedGPUTexture,
  ComputePipelineWrapper,
  BindGroupLayoutBuilder,
} from '../gpu';
import type { ProceduralRockRef, VegetationMesh, VegetationSubMesh } from './types';
import { ROCK_LOD_TIER_COUNT, ROCK_SUBDIVISION_LEVELS } from './types';

import rockMeshGenShader from '../gpu/shaders/vegetation/rock-mesh-gen.wgsl?raw';
import rockTextureGenShader from '../gpu/shaders/vegetation/rock-texture-gen.wgsl?raw';

// ==================== Constants ====================

/** Texture size for procedural rock albedo + normal maps */
const ROCK_TEXTURE_SIZE = 128;

/** Displacement amplitude (0-1 range, controls how "bumpy" the rock is) 
 * Higher values = more angular, craggy shapes. 0.7 produces convincing boulders. */
const DEFAULT_DISPLACEMENT_SCALE = 0.7;

/** Base radius of the rock mesh (before displacement) */
const DEFAULT_BASE_RADIUS = 0.5;

/** Moss threshold (normal.y above this gets moss) */
const DEFAULT_MOSS_THRESHOLD = 0.6;

/** Moss blending strength */
const DEFAULT_MOSS_STRENGTH = 0.4;

/** AO intensity */
const DEFAULT_AO_STRENGTH = 0.5;

/** Uniform buffer size for rock mesh gen (must match RockGenParams in WGSL) */
const MESH_GEN_PARAMS_SIZE = 16; // 4 × f32/u32 = 16 bytes

/** Uniform buffer size for rock texture gen (must match RockTexParams in WGSL) 
 * Layout with vec3f alignment: seed(4) + pad(12) + baseColor(12) + mossThreshold(4) + 
 * mossStrength(4) + aoStrength(4) + passIndex(4) + textureSize(4) + pad(12) = 64 bytes */
const TEX_GEN_PARAMS_SIZE = 64;

// ==================== Icosphere Generation ====================

/**
 * Icosphere vertex/index data for a given subdivision level.
 * Generated on CPU, uploaded to GPU storage buffer for compute shader input.
 */
interface IcosphereData {
  /** Vertex positions as flat Float32Array [x,y,z, x,y,z, ...] */
  positions: Float32Array;
  /** Triangle indices as Uint32Array */
  indices: Uint32Array;
  /** Number of vertices */
  vertexCount: number;
  /** Number of indices (triangles × 3) */
  indexCount: number;
}

/**
 * Generate an icosphere by recursive subdivision of a base icosahedron.
 * Each subdivision splits every triangle into 4 sub-triangles and projects
 * new vertices onto the unit sphere.
 * 
 * Subdivision levels:
 *   0: 12 vertices, 60 indices (20 triangles)
 *   1: 42 vertices, 240 indices (80 triangles)
 *   2: 162 vertices, 960 indices (320 triangles)
 *   3: 642 vertices, 3840 indices (1280 triangles)
 */
function generateIcosphere(subdivisions: number): IcosphereData {
  // Golden ratio
  const t = (1 + Math.sqrt(5)) / 2;

  // Base icosahedron vertices (normalized to unit sphere)
  const baseVerts: number[] = [];
  const addVert = (x: number, y: number, z: number) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    baseVerts.push(x / len, y / len, z / len);
  };

  addVert(-1, t, 0);
  addVert(1, t, 0);
  addVert(-1, -t, 0);
  addVert(1, -t, 0);
  addVert(0, -1, t);
  addVert(0, 1, t);
  addVert(0, -1, -t);
  addVert(0, 1, -t);
  addVert(t, 0, -1);
  addVert(t, 0, 1);
  addVert(-t, 0, -1);
  addVert(-t, 0, 1);

  // Base icosahedron triangles (20 faces)
  let indices: number[] = [
    0, 11, 5,  0, 5, 1,  0, 1, 7,  0, 7, 10,  0, 10, 11,
    1, 5, 9,  5, 11, 4,  11, 10, 2,  10, 7, 6,  7, 1, 8,
    3, 9, 4,  3, 4, 2,  3, 2, 6,  3, 6, 8,  3, 8, 9,
    4, 9, 5,  2, 4, 11,  6, 2, 10,  8, 6, 7,  9, 8, 1,
  ];

  let positions = [...baseVerts];

  // Midpoint cache for edge deduplication
  const midpointCache = new Map<string, number>();

  const getMidpoint = (i1: number, i2: number): number => {
    const key = i1 < i2 ? `${i1}_${i2}` : `${i2}_${i1}`;
    const cached = midpointCache.get(key);
    if (cached !== undefined) return cached;

    const x = (positions[i1 * 3] + positions[i2 * 3]) / 2;
    const y = (positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 2;
    const z = (positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 2;

    // Normalize to unit sphere
    const len = Math.sqrt(x * x + y * y + z * z);
    const idx = positions.length / 3;
    positions.push(x / len, y / len, z / len);

    midpointCache.set(key, idx);
    return idx;
  };

  // Recursive subdivision
  for (let level = 0; level < subdivisions; level++) {
    midpointCache.clear();
    const newIndices: number[] = [];

    for (let i = 0; i < indices.length; i += 3) {
      const v0 = indices[i];
      const v1 = indices[i + 1];
      const v2 = indices[i + 2];

      const a = getMidpoint(v0, v1);
      const b = getMidpoint(v1, v2);
      const c = getMidpoint(v2, v0);

      newIndices.push(
        v0, a, c,
        v1, b, a,
        v2, c, b,
        a, b, c,
      );
    }

    indices = newIndices;
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
    indexCount: indices.length,
  };
}

// ==================== ProceduralRockMeshGenerator ====================

export class ProceduralRockMeshGenerator {
  private ctx: GPUContext;

  // GPU pipelines (lazily initialized)
  private meshGenPipeline: ComputePipelineWrapper | null = null;
  private meshGenLayout: GPUBindGroupLayout | null = null;
  private texGenPipeline: ComputePipelineWrapper | null = null;
  private texGenLayout: GPUBindGroupLayout | null = null;

  // Pre-generated icosphere data per subdivision level (cached)
  private icosphereCache: Map<number, IcosphereData> = new Map();

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
  }

  // ==================== Pipeline Initialization ====================

  private ensureMeshGenPipeline(): void {
    if (this.meshGenPipeline) return;

    this.meshGenLayout = new BindGroupLayoutBuilder('rock-mesh-gen-layout')
      .uniformBuffer(0, 'compute')        // RockGenParams
      .storageBuffer(1, 'compute')      // baseVertices (read-only)
      .storageBufferRW(2, 'compute')      // outputVertices (read-write)
      .build(this.ctx);

    this.meshGenPipeline = ComputePipelineWrapper.create(this.ctx, {
      label: 'rock-mesh-gen-pipeline',
      shader: rockMeshGenShader,
      entryPoint: 'main',
      bindGroupLayouts: [this.meshGenLayout],
    });
  }

  private ensureTexGenPipeline(): void {
    if (this.texGenPipeline) return;

    this.texGenLayout = this.ctx.device.createBindGroupLayout({
      label: 'rock-texture-gen-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });

    const shaderModule = this.ctx.device.createShaderModule({
      label: 'rock-texture-gen-shader',
      code: rockTextureGenShader,
    });

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: 'rock-texture-gen-pipeline-layout',
      bindGroupLayouts: [this.texGenLayout],
    });

    this.texGenPipeline = {
      pipeline: this.ctx.device.createComputePipeline({
        label: 'rock-texture-gen-pipeline',
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint: 'main' },
      }),
    } as ComputePipelineWrapper;
  }

  // ==================== Icosphere Cache ====================

  private getIcosphere(subdivisions: number): IcosphereData {
    const cached = this.icosphereCache.get(subdivisions);
    if (cached) return cached;

    const data = generateIcosphere(subdivisions);
    this.icosphereCache.set(subdivisions, data);

    console.log(`[RockMeshGen] Generated icosphere subdiv=${subdivisions}: ${data.vertexCount} verts, ${data.indexCount / 3} tris`);
    return data;
  }

  // ==================== Main Generation ====================

  /**
   * Generate a complete ProceduralRockRef with 4 LOD-tier meshes and 2 textures.
   * 
   * This runs synchronously (GPU compute dispatches are fire-and-forget).
   * The returned GPU buffers will contain valid data after the GPU finishes
   * executing the queued commands.
   * 
   * @param seed - Shape seed (different values = different rock shapes)
   * @param fallbackColor - Base color [R, G, B] in linear space (0-1)
   * @returns ProceduralRockRef with 4 LOD meshes + albedo + normal textures
   */
  generate(
    seed: number,
    fallbackColor: [number, number, number],
  ): ProceduralRockRef {
    console.log(`[RockMeshGen] Generating rock mesh (seed=${seed}, color=[${fallbackColor}])`);
    const startTime = performance.now();

    this.ensureMeshGenPipeline();
    this.ensureTexGenPipeline();

    // Generate 4 LOD tiers
    const lodMeshes: VegetationMesh[] = [];
    for (let tier = 0; tier < ROCK_LOD_TIER_COUNT; tier++) {
      const subdivLevel = ROCK_SUBDIVISION_LEVELS[tier];
      const mesh = this.generateMeshForLOD(seed, subdivLevel, tier);
      lodMeshes.push(mesh);
    }

    // Generate textures
    const albedoTexture = this.generateTexture(seed, fallbackColor, 0);
    const normalTexture = this.generateTexture(seed, fallbackColor, 1);

    // Assign textures to all LOD tier sub-meshes
    for (const mesh of lodMeshes) {
      for (const sub of mesh.subMeshes) {
        sub.baseColorTexture = albedoTexture;
        sub.normalTexture = normalTexture;
      }
    }

    const elapsed = performance.now() - startTime;
    console.log(`[RockMeshGen] Rock generated in ${elapsed.toFixed(1)}ms (4 LODs + 2 textures)`);

    return {
      seed,
      bakedColor: [...fallbackColor],
      lodMeshes: lodMeshes as [VegetationMesh, VegetationMesh, VegetationMesh, VegetationMesh],
      albedoTexture,
      normalTexture,
    };
  }

  // ==================== Mesh Generation (per LOD tier) ====================

  private generateMeshForLOD(
    seed: number,
    subdivLevel: number,
    tier: number,
  ): VegetationMesh {
    const icosphere = this.getIcosphere(subdivLevel);

    // Create GPU buffers
    const baseVertexBuffer = this.ctx.device.createBuffer({
      label: `rock-base-verts-lod${tier}`,
      size: icosphere.positions.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.ctx.queue.writeBuffer(baseVertexBuffer, 0, icosphere.positions.buffer as ArrayBuffer);

    // Output: 8 floats per vertex (pos + normal + uv)
    const outputSize = icosphere.vertexCount * 8 * 4; // 32 bytes per vertex
    const outputBuffer = this.ctx.device.createBuffer({
      label: `rock-output-verts-lod${tier}`,
      size: outputSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Params uniform
    const paramsData = new ArrayBuffer(MESH_GEN_PARAMS_SIZE);
    const paramsF32 = new Float32Array(paramsData);
    const paramsU32 = new Uint32Array(paramsData);
    paramsF32[0] = seed;
    paramsF32[1] = DEFAULT_DISPLACEMENT_SCALE;
    paramsF32[2] = DEFAULT_BASE_RADIUS;
    paramsU32[3] = icosphere.vertexCount;

    const paramsBuffer = this.ctx.device.createBuffer({
      label: `rock-mesh-params-lod${tier}`,
      size: MESH_GEN_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.ctx.queue.writeBuffer(paramsBuffer, 0, new Float32Array(paramsData));

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: `rock-mesh-gen-bg-lod${tier}`,
      layout: this.meshGenLayout!,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: baseVertexBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
      ],
    });

    // Dispatch compute
    const workgroups = Math.ceil(icosphere.vertexCount / 64);
    const encoder = this.ctx.device.createCommandEncoder({ label: `rock-mesh-gen-lod${tier}` });
    const pass = encoder.beginComputePass({ label: `rock-mesh-gen-pass-lod${tier}` });
    pass.setPipeline(this.meshGenPipeline!.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);

    // Create index buffer (copied directly from CPU icosphere data)
    const indexByteSize = Math.ceil(icosphere.indices.byteLength / 4) * 4;
    const indexBuffer = this.ctx.device.createBuffer({
      label: `rock-ib-lod${tier}`,
      size: indexByteSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    const alignedIndexData = new Uint8Array(indexByteSize);
    alignedIndexData.set(new Uint8Array(icosphere.indices.buffer, icosphere.indices.byteOffset, icosphere.indices.byteLength));
    this.ctx.queue.writeBuffer(indexBuffer, 0, alignedIndexData);

    // Clean up temporary buffers (base vertices + params)
    // Note: we keep outputBuffer (it's the vertex buffer) and indexBuffer
    baseVertexBuffer.destroy();
    paramsBuffer.destroy();

    const subMesh: VegetationSubMesh = {
      vertexBuffer: outputBuffer,
      indexBuffer,
      indexCount: icosphere.indexCount,
      indexFormat: 'uint32',
      baseColorTexture: null,           // Set later after texture generation
      normalTexture: null,              // Set later after texture generation
      metallicRoughnessTexture: null,   // Rocks use material uniform values
      occlusionTexture: null,           // AO baked into albedo alpha
      emissiveTexture: null,            // No emissive for rocks
      windMultiplier: 0,                // Rocks don't sway in wind
    };

    return {
      id: `procedural-rock-lod${tier}`,
      name: `Procedural Rock LOD ${tier}`,
      subMeshes: [subMesh],
    };
  }

  // ==================== Texture Generation ====================

  /**
   * Generate a 128×128 rgba8unorm texture via compute shader.
   * @param pass - 0 for albedo+AO, 1 for normal map
   */
  private generateTexture(
    seed: number,
    fallbackColor: [number, number, number],
    passIndex: number,
  ): UnifiedGPUTexture {
    const label = passIndex === 0 ? 'rock-albedo' : 'rock-normal';

    // Create output texture
    const texture = UnifiedGPUTexture.create2D(this.ctx, {
      label,
      width: ROCK_TEXTURE_SIZE,
      height: ROCK_TEXTURE_SIZE,
      format: 'rgba8unorm',
      mipLevelCount: Math.floor(Math.log2(ROCK_TEXTURE_SIZE)) + 1,
      storage: true,
      sampled: true,
      copyDst: true,
      renderTarget: true, // Needed for mipmap generation
    });

    // Storage view for compute write (only mip 0)
    const storageView = texture.texture.createView({
      label: `${label}-storage-view`,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    // Params uniform — must match WGSL struct layout with alignment rules:
    //   offset 0:  seed (f32)             — 4 bytes
    //   offset 4:  baseColor (vec3f)      — 12 bytes (vec3f has alignment 16, but follows f32 so packs at 4)
    //     NOTE: WGSL vec3<f32> has alignment 16. So baseColor starts at offset 16, not 4!
    //   offset 16: baseColor.x (f32)
    //   offset 20: baseColor.y (f32)  
    //   offset 24: baseColor.z (f32)
    //   offset 28: mossThreshold (f32)
    //   offset 32: mossStrength (f32)
    //   offset 36: aoStrength (f32)
    //   offset 40: passIndex (u32)
    //   offset 44: textureSize (u32)
    //   offset 48: _pad0 (f32)
    //   offset 52: _pad1 (f32)
    //   offset 56: _pad2 (f32)
    //   offset 60: implicit pad to 64 (struct size rounds to 16)
    const paramsData = new ArrayBuffer(TEX_GEN_PARAMS_SIZE);
    const f32 = new Float32Array(paramsData);
    const u32 = new Uint32Array(paramsData);

    // f32 index = byte offset / 4
    f32[0] = seed;                     // offset 0: seed
    // f32[1..3] = padding (alignment gap before vec3f)
    f32[4] = fallbackColor[0];         // offset 16: baseColor.x
    f32[5] = fallbackColor[1];         // offset 20: baseColor.y
    f32[6] = fallbackColor[2];         // offset 24: baseColor.z
    f32[7] = DEFAULT_MOSS_THRESHOLD;   // offset 28: mossThreshold
    f32[8] = DEFAULT_MOSS_STRENGTH;    // offset 32: mossStrength
    f32[9] = DEFAULT_AO_STRENGTH;      // offset 36: aoStrength
    u32[10] = passIndex;               // offset 40: passIndex
    u32[11] = ROCK_TEXTURE_SIZE;       // offset 44: textureSize
    f32[12] = 0;                       // offset 48: _pad0
    f32[13] = 0;                       // offset 52: _pad1
    f32[14] = 0;                       // offset 56: _pad2
    // f32[15] = implicit 0            // offset 60: struct padding to 64

    const paramsBuffer = this.ctx.device.createBuffer({
      label: `${label}-params`,
      size: TEX_GEN_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.ctx.queue.writeBuffer(paramsBuffer, 0, new Float32Array(paramsData));

    // Create bind group
    const bindGroup = this.ctx.device.createBindGroup({
      label: `${label}-bg`,
      layout: this.texGenLayout!,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: storageView },
      ],
    });

    // Dispatch compute (8×8 workgroups for 128×128 texture)
    const workgroupsPerDim = Math.ceil(ROCK_TEXTURE_SIZE / 8);
    const encoder = this.ctx.device.createCommandEncoder({ label: `${label}-gen` });
    const pass = encoder.beginComputePass({ label: `${label}-pass` });
    pass.setPipeline(this.texGenPipeline!.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroupsPerDim, workgroupsPerDim);
    pass.end();
    this.ctx.queue.submit([encoder.finish()]);

    // Generate mipmaps
    texture.generateMipmaps(this.ctx);

    // Clean up params buffer
    paramsBuffer.destroy();

    return texture;
  }

  // ==================== Cleanup ====================

  /**
   * Destroy a ProceduralRockRef's GPU resources.
   * Call when the plant type is removed or the rock is regenerated.
   */
  static destroyRockRef(ref: ProceduralRockRef): void {
    for (const mesh of ref.lodMeshes) {
      for (const sub of mesh.subMeshes) {
        sub.vertexBuffer.destroy();
        sub.indexBuffer.destroy();
      }
    }
    ref.albedoTexture.destroy();
    ref.normalTexture.destroy();
  }

  /**
   * Destroy the generator's GPU pipelines and cached data.
   */
  destroy(): void {
    this.meshGenPipeline = null;
    this.meshGenLayout = null;
    this.texGenPipeline = null;
    this.texGenLayout = null;
    this.icosphereCache.clear();
  }
}
