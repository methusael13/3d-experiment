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
import type { ObjectRendererGPU } from '../renderers/ObjectRendererGPU';

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
  }

  if (features.includes('ibl')) {
    mask |= ENV_BINDING_MASK.IBL_DIFFUSE;
    mask |= ENV_BINDING_MASK.IBL_SPECULAR;
    mask |= ENV_BINDING_MASK.BRDF_LUT;
    mask |= ENV_BINDING_MASK.IBL_CUBE_SAMPLER;
    mask |= ENV_BINDING_MASK.IBL_LUT_SAMPLER;
  }

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
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType, viewDimension },
      });
    } else if (res.kind === 'sampler') {
      const type = res.samplerType === 'sampler_comparison' ? 'comparison' : 'filtering';
      entries.push({
        binding: res.bindingIndex,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type },
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

  // Shared bind group layouts from ObjectRendererGPU (Groups 0, 1, and 2)
  private globalBindGroupLayout: GPUBindGroupLayout;
  private modelBindGroupLayout: GPUBindGroupLayout;
  /** ObjectRendererGPU's existing texture bind group layout (Group 2).
   * Used for textured variants so existing per-mesh texture bind groups are compatible. */
  private existingTextureBindGroupLayout: GPUBindGroupLayout;

  constructor(
    ctx: GPUContext,
    globalBindGroupLayout: GPUBindGroupLayout,
    modelBindGroupLayout: GPUBindGroupLayout,
    existingTextureBindGroupLayout: GPUBindGroupLayout,
    variantCache?: ShaderVariantCache,
  ) {
    this.ctx = ctx;
    this.globalBindGroupLayout = globalBindGroupLayout;
    this.modelBindGroupLayout = modelBindGroupLayout;
    this.existingTextureBindGroupLayout = existingTextureBindGroupLayout;
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

    // For Group 2, reuse ObjectRendererGPU's existing texture layout when textures are present.
    // This is critical: per-mesh texture bind groups were created with that layout, so the
    // pipeline's Group 2 layout must be the exact same GPUBindGroupLayout object.
    const hasTextureBindings = composed.bindingLayout.size > 0;
    const textureBindGroupLayout = hasTextureBindings
      ? this.existingTextureBindGroupLayout
      : device.createBindGroupLayout({
          label: `variant-texture-empty-${composed.featureKey}`,
          entries: [],
        });

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

    // Create render pipeline
    const pipeline = device.createRenderPipeline({
      label: `variant-pipeline-${composed.featureKey}-${cullMode}`,
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // Interleaved: position (3) + normal (3) + uv (2) = 8 floats = 32 bytes
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
              { shaderLocation: 1, offset: 12, format: 'float32x3' },  // normal
              { shaderLocation: 2, offset: 24, format: 'float32x2' },  // uv
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],  // HDR intermediate
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

  /**
   * Invalidate all cached pipelines (e.g., after shader hot-reload).
   */
  invalidateAll(): void {
    this.pipelineCache.clear();
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
    this.variantCache.destroy();
  }
}