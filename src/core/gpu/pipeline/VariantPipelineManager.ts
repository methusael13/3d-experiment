/**
 * VariantPipelineManager — creates and caches GPURenderPipelines for
 * composed shader variants.
 *
 * Each variant is identified by a feature key (e.g., "ibl+shadow+textured").
 * The manager composes WGSL via ShaderVariantCache, builds variant-specific
 * bind group layouts for Groups 2 (textures) and 3 (environment), and creates
 * a GPURenderPipeline with explicit 4-group layout.
 *
 * Groups 0 (global) and 1 (per-mesh model+material) are reused across all
 * variants from ObjectRendererGPU's existing layouts.
 */

import type { GPUContext } from '../GPUContext';
import type { ComposedShader, ShaderResource } from '../shaders/composition/types';
import { ShaderVariantCache } from '../shaders/composition/ShaderVariantCache';
import type { ShaderVariantEntry } from '../shaders/composition/ShaderVariantCache';
import { SceneEnvironment } from '../renderers/shared/SceneEnvironment';
import { RES } from '../shaders/composition/resourceNames';
import { ENVIRONMENT_BINDINGS, ENV_BINDING_MASK } from '../renderers/shared/types';
import type { EnvironmentBindingMask } from '../renderers/shared/types';
import type { VariantMeshPool } from './VariantMeshPool';
import { PlaceholderTextures } from '../renderers/shared/PlaceholderTextures';

/**
 * Cached pipeline entry for a specific variant + cull mode combination.
 */
export interface VariantPipelineEntry {
  /** The composed shader metadata */
  composed: ComposedShader;
  /** The compiled GPU shader module */
  shaderModule: GPUShaderModule;
  /** GPU render pipeline */
  pipeline: GPURenderPipeline;
  /** Bind group layout for Group 2 (textures) — variant-specific */
  textureBindGroupLayout: GPUBindGroupLayout;
  /** Bind group layout for Group 3 (environment) — variant-specific */
  environmentBindGroupLayout: GPUBindGroupLayout;
  /** Environment binding mask for SceneEnvironment.getBindGroupForMask() */
  environmentMask: EnvironmentBindingMask;
  /** Whether this variant has any texture bindings in group 2 */
  hasTextureBindings: boolean;
  /** Whether this variant has any environment bindings in group 3 */
  hasEnvironmentBindings: boolean;
}

/**
 * Cached depth-only pipeline entry (for shadow / depth pre-pass).
 * Uses the same composed vs_main (with wind displacement) but no fragment stage.
 */
export interface DepthOnlyPipelineEntry {
  /** GPU render pipeline (depth-only, no fragment) */
  pipeline: GPURenderPipeline;
  /** The composed shader metadata */
  composed: ComposedShader;
  /** The compiled GPU shader module (same as color variant) */
  shaderModule: GPUShaderModule;
}

/**
 * Maps a composed shader's resource names to ENVIRONMENT_BINDINGS indices
 * and computes the ENV_BINDING_MASK for SceneEnvironment.
 */
function computeEnvironmentMask(composed: ComposedShader): EnvironmentBindingMask {
  let mask: EnvironmentBindingMask = 0;

  // The composed shader stores environment resources in its bindingLayout
  // with group === 'environment'. We also need to check the deduplicateResources
  // output. Since ComposedShader only has `bindingLayout` (which contains group 2 textures),
  // we need to re-derive from the features.
  // Actually, the ShaderComposer produces environmentBindings separately but they end up
  // in the composed WGSL. We need to look at the features to determine what environment
  // resources are needed.
  //
  // Approach: map well-known resource names to ENV_BINDING_MASK bits.
  const features = composed.features;

  if (features.includes('shadow')) {
    mask |= ENV_BINDING_MASK.SHADOW_MAP;
    mask |= ENV_BINDING_MASK.SHADOW_SAMPLER;
    mask |= ENV_BINDING_MASK.CSM_SHADOW_ARRAY;
    mask |= ENV_BINDING_MASK.CSM_UNIFORMS;
    mask |= ENV_BINDING_MASK.CLOUD_SHADOW;
  }

  if (features.includes('ibl')) {
    mask |= ENV_BINDING_MASK.IBL_DIFFUSE;
    mask |= ENV_BINDING_MASK.IBL_SPECULAR;
    mask |= ENV_BINDING_MASK.BRDF_LUT;
    mask |= ENV_BINDING_MASK.IBL_CUBE_SAMPLER;
    mask |= ENV_BINDING_MASK.IBL_LUT_SAMPLER;
  }
  if (features.includes('ssr')) {
    mask |= ENV_BINDING_MASK.SSR_TEXTURE;
  }
  if (features.includes('multi-light')) {
    mask |= ENV_BINDING_MASK.MULTI_LIGHT;
    mask |= ENV_BINDING_MASK.SPOT_SHADOW;
    mask |= ENV_BINDING_MASK.COOKIE;
  }
  // reflection-probe resources are now in Group 2 (textures), not Group 3 (environment)

  return mask;
}

/**
 * Build a GPUBindGroupLayout for Group 2 (textures) from the composed shader's
 * texture binding layout.
 */
function buildTextureBindGroupLayout(
  device: GPUDevice,
  composed: ComposedShader,
  featureKey: string,
): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [];

  for (const [_name, res] of composed.bindingLayout) {
    if (res.group !== 'textures') continue;

    if (res.kind === 'texture') {
      const viewDimension = getTextureViewDimension(res.textureType);
      const sampleType = getTextureSampleType(res.textureType);
      entries.push({
        binding: res.bindingIndex,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: { sampleType, viewDimension },
      });
    } else if (res.kind === 'sampler') {
      const type = res.samplerType === 'sampler_comparison' ? 'comparison' : 'filtering';
      entries.push({
        binding: res.bindingIndex,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        sampler: { type },
      });
    } else if (res.kind === 'storage') {
      // Read-only storage buffers (e.g., bone matrices for skeletal skinning)
      entries.push({
        binding: res.bindingIndex,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      });
    }
  }

  return device.createBindGroupLayout({
    label: `variant-texture-layout-${featureKey}`,
    entries,
  });
}

function getTextureViewDimension(
  textureType?: string,
): GPUTextureViewDimension {
  if (!textureType) return '2d';
  if (textureType.includes('cube')) return 'cube';
  if (textureType.includes('2d_array')) return '2d-array';
  return '2d';
}

function getTextureSampleType(
  textureType?: string,
): GPUTextureSampleType {
  if (!textureType) return 'float';
  if (textureType.includes('depth')) return 'depth';
  if (textureType.includes('<i32>')) return 'sint';
  if (textureType.includes('<u32>')) return 'uint';
  return 'float';
}

export class VariantPipelineManager {
  private ctx: GPUContext;
  private variantCache: ShaderVariantCache;

  // Cache: key = `${featureKey}:${cullMode}` → pipeline entry
  private pipelineCache = new Map<string, VariantPipelineEntry>();

  // Shared bind group layouts from VariantMeshPool (Groups 0 and 1)
  private globalBindGroupLayout: GPUBindGroupLayout;
  private modelBindGroupLayout: GPUBindGroupLayout;
  /** VariantMeshPool reference — used for empty bind group fallback in depth-only. */
  private meshPool: VariantMeshPool;

  constructor(
    ctx: GPUContext,
    globalBindGroupLayout: GPUBindGroupLayout,
    modelBindGroupLayout: GPUBindGroupLayout,
    meshPool: VariantMeshPool,
    variantCache?: ShaderVariantCache,
  ) {
    this.ctx = ctx;
    this.globalBindGroupLayout = globalBindGroupLayout;
    this.modelBindGroupLayout = modelBindGroupLayout;
    this.meshPool = meshPool;
    this.variantCache = variantCache ?? new ShaderVariantCache();
  }

  /**
   * Get or create a pipeline for the given feature set and cull mode.
   *
   * @param featureIds - Active feature IDs (e.g., ['shadow', 'ibl', 'textured'])
   * @param cullMode - Pipeline cull mode ('back' for single-sided, 'none' for double-sided)
   * @param sceneEnvironment - SceneEnvironment for building variant-specific env layouts
   * @returns Cached or newly-created pipeline entry
   */
  getOrCreate(
    featureIds: string[],
    cullMode: GPUCullMode = 'back',
    sceneEnvironment: SceneEnvironment,
  ): VariantPipelineEntry {
    const variantEntry = this.variantCache.getOrCreate(featureIds, this.ctx);
    const cacheKey = `${variantEntry.composed.featureKey}:${cullMode}`;

    const cached = this.pipelineCache.get(cacheKey);
    if (cached) return cached;

    const entry = this.createPipelineEntry(
      variantEntry,
      cullMode,
      sceneEnvironment,
    );
    this.pipelineCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Create a new pipeline entry for a variant.
   */
  private createPipelineEntry(
    variantEntry: ShaderVariantEntry,
    cullMode: GPUCullMode,
    sceneEnvironment: SceneEnvironment,
  ): VariantPipelineEntry {
    const { composed, shaderModule } = variantEntry;
    const device = this.ctx.device;

    // For Group 2, ALWAYS build the layout from the composed shader's bindingLayout.
    // VariantMeshPool builds bind groups dynamically by name, so the layout must match
    // the composed shader's resource declarations exactly.
    const hasTextureBindings = composed.bindingLayout.size > 0;
    let textureBindGroupLayout: GPUBindGroupLayout;
    if (hasTextureBindings) {
      textureBindGroupLayout = buildTextureBindGroupLayout(device, composed, composed.featureKey);
    } else {
      textureBindGroupLayout = device.createBindGroupLayout({
        label: `variant-texture-empty-${composed.featureKey}`,
        entries: [],
      });
    }

    const environmentMask = computeEnvironmentMask(composed);
    const hasEnvironmentBindings = environmentMask !== 0;

    // Get environment bind group layout from SceneEnvironment's mask system
    // If no environment bindings needed, use an empty layout
    let environmentBindGroupLayout: GPUBindGroupLayout;
    if (hasEnvironmentBindings) {
      environmentBindGroupLayout = sceneEnvironment.getLayoutForMask(environmentMask);
    } else {
      environmentBindGroupLayout = device.createBindGroupLayout({
        label: `variant-env-empty-${composed.featureKey}`,
        entries: [],
      });
    }

    // Create pipeline layout with 4 groups
    const pipelineLayout = device.createPipelineLayout({
      label: `variant-pipeline-layout-${composed.featureKey}-${cullMode}`,
      bindGroupLayouts: [
        this.globalBindGroupLayout,     // group 0
        this.modelBindGroupLayout,      // group 1
        textureBindGroupLayout,         // group 2
        environmentBindGroupLayout,     // group 3
      ],
    });

    // Build vertex buffer descriptors.
    // Buffer 0: standard interleaved (position + normal + uv) — always present.
    // Buffer 1: skinning data (joint indices + weights) — only for skinned variants.
    const colorVertexBuffers: GPUVertexBufferLayout[] = [
      {
        // Interleaved: position (3) + normal (3) + uv (2) = 8 floats = 32 bytes
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },   // position
          { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },  // normal
          { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },  // uv
        ],
      },
    ];

    if (composed.features.includes('skinning')) {
      colorVertexBuffers.push({
        arrayStride: 20, // uint8x4 (4 bytes) + float32x4 (16 bytes)
        attributes: [
          { shaderLocation: 5, offset: 0, format: 'uint8x4' as GPUVertexFormat },     // jointIndices
          { shaderLocation: 6, offset: 4, format: 'float32x4' as GPUVertexFormat },   // jointWeights
        ],
      });
    }

    // Create render pipeline
    const pipeline = device.createRenderPipeline({
      label: `variant-pipeline-${composed.featureKey}-${cullMode}`,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: colorVertexBuffers,
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          { format: 'rgba16float' },  // @location(0): HDR scene color
          { format: 'rgba16float' },  // @location(1): normals G-buffer (packed world normal + metallic)
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode,
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'greater',  // Reversed-Z
      },
    });

    return {
      composed,
      shaderModule,
      pipeline,
      textureBindGroupLayout,
      environmentBindGroupLayout,
      environmentMask,
      hasTextureBindings,
      hasEnvironmentBindings,
    };
  }

  // ===================== Depth-Only Pipeline =====================

  // Cache: key = `${featureKey}:depth` → depth-only pipeline
  private depthOnlyCache = new Map<string, DepthOnlyPipelineEntry>();

  /**
   * Get or create a depth-only pipeline for shadow / depth pre-pass rendering.
   * Uses the same composed vs_main (with wind vertex displacement) but no fragment.
   *
   * The depth-only pipeline reuses:
   * - Group 0: globalBindGroupLayout (write light VP to globals.viewProjection)
   * - Group 1: modelBindGroupLayout (per-mesh model matrix + material with wind uniforms)
   * - Group 2: empty layout (textures not needed for depth)
   * - Group 3: empty layout (environment not needed for depth)
   */
  getOrCreateDepthOnly(
    featureIds: string[],
    depthFormat: GPUTextureFormat = 'depth32float',
    depthCompare: GPUCompareFunction = 'less',
  ): DepthOnlyPipelineEntry {
    const variantEntry = this.variantCache.getOrCreate(featureIds, this.ctx);
    const cacheKey = `${variantEntry.composed.featureKey}:depth`;

    const cached = this.depthOnlyCache.get(cacheKey);
    if (cached) return cached;

    const entry = this.createDepthOnlyPipeline(variantEntry, depthFormat, depthCompare);
    this.depthOnlyCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Create a depth-only render pipeline from a composed shader variant.
   */
  private createDepthOnlyPipeline(
    variantEntry: ShaderVariantEntry,
    depthFormat: GPUTextureFormat,
    depthCompare: GPUCompareFunction,
  ): DepthOnlyPipelineEntry {
    const { composed, shaderModule } = variantEntry;
    const device = this.ctx.device;

    // For Group 2, build from composed shader's bindingLayout (same as color path)
    // so that VariantMeshPool.buildTextureBindGroup() can create compatible bind groups.
    const hasTextureBindings = composed.bindingLayout.size > 0;
    const emptyLayout2 = hasTextureBindings
      ? buildTextureBindGroupLayout(device, composed, composed.featureKey + '-depth')
      : device.createBindGroupLayout({ label: `variant-depth-tex-empty-${composed.featureKey}`, entries: [] });
    const emptyLayout3 = device.createBindGroupLayout({
      label: `variant-depth-env-empty-${composed.featureKey}`,
      entries: [],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: `variant-depth-pipeline-layout-${composed.featureKey}`,
      bindGroupLayouts: [
        this.globalBindGroupLayout,     // group 0: global uniforms (light VP written here)
        this.modelBindGroupLayout,      // group 1: model matrix + material (wind uniforms)
        emptyLayout2,                   // group 2: textures (bone matrices storage buffer for skinning)
        emptyLayout3,                   // group 3: environment (unused but declared in WGSL)
      ],
    });

    // Build vertex buffer descriptors.
    // Buffer 0: standard interleaved (position + normal + uv) — always present.
    // Buffer 1: skinning data (joint indices + weights) — only for skinned variants.
    const isSkinned = composed.features.includes('skinning');
    const vertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
          { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
          { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },
        ],
      },
    ];

    if (isSkinned) {
      vertexBuffers.push({
        arrayStride: 20, // uint8x4 (4 bytes) + float32x4 (16 bytes)
        attributes: [
          { shaderLocation: 5, offset: 0, format: 'uint8x4' as GPUVertexFormat },     // jointIndices
          { shaderLocation: 6, offset: 4, format: 'float32x4' as GPUVertexFormat },   // jointWeights
        ],
      });
    }

    // For textured variants, use fs_shadow_main fragment stage to perform alpha testing
    // (discard transparent pixels in shadow maps for grass/foliage). Non-textured variants
    // use no fragment stage for maximum shadow rendering performance.
    const isTextured = composed.features.includes('textured');

    const pipelineDescriptor: GPURenderPipelineDescriptor = {
      label: `variant-depth-pipeline-${composed.featureKey}`,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: vertexBuffers,
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none', // Shadow maps render both sides
      },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare,
      },
    };

    // Add fragment stage with alpha test for textured variants
    if (isTextured) {
      pipelineDescriptor.fragment = {
        module: shaderModule,
        entryPoint: 'fs_shadow_main',
        targets: [], // No color output — depth only with discard
      };
    }

    const pipeline = device.createRenderPipeline(pipelineDescriptor);

    return { pipeline, composed, shaderModule };
  }

  /**
   * Invalidate all cached pipelines (e.g., after shader hot-reload).
   */
  invalidateAll(): void {
    this.pipelineCache.clear();
    this.depthOnlyCache.clear();
    this.variantCache.invalidate();
  }

  /**
   * Get cache statistics.
   */
  getStats(): { pipelineCount: number; variantCount: number } {
    return {
      pipelineCount: this.pipelineCache.size,
      variantCount: this.variantCache.getStats().totalVariants,
    };
  }

  /**
   * Destroy all cached resources.
   */
  destroy(): void {
    this.pipelineCache.clear();
    this.depthOnlyCache.clear();
    this.variantCache.destroy();
  }
}