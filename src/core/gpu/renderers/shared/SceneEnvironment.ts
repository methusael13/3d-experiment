/**
 * SceneEnvironment - Shared environment bind group manager
 * 
 * Manages the combined shadow + IBL bind group (Group 3) that is shared
 * across Object, Terrain, and Water renderers. This ensures consistent
 * environment lighting across all rendered surfaces.
 * 
 * Bind Group Layout (Group 3):
 * - Binding 0: Shadow depth texture
 * - Binding 1: Shadow comparison sampler
 * - Binding 2: IBL diffuse cubemap
 * - Binding 3: IBL specular cubemap
 * - Binding 4: BRDF LUT texture
 * - Binding 5: IBL cubemap sampler
 * - Binding 6: IBL LUT sampler
 */

import { GPUContext } from '../../GPUContext';
import { PlaceholderTextures } from './PlaceholderTextures';
import type { UnifiedGPUBuffer } from '../../GPUBuffer';
import { IBLResources, ENVIRONMENT_BINDINGS, ENV_BINDING_MASK, EnvironmentBindingMask } from './types';

/**
 * CSM (Cascaded Shadow Map) resources
 */
export interface CSMResources {
  /** 2D depth texture array view containing all cascade shadow maps */
  shadowArrayView: GPUTextureView;
  /** CSM uniform buffer with light matrices and split distances */
  uniformBuffer: UnifiedGPUBuffer;
}

/**
 * Manages the shared environment bind group for all renderers
 */
export class SceneEnvironment {
  private ctx: GPUContext;
  private placeholders: PlaceholderTextures;

  // Bind group layout (shared across all renderers)
  private _layout: GPUBindGroupLayout;

  // Current bind group (recreated when resources change)
  private _bindGroup: GPUBindGroup;

  // Current resource state
  private currentShadowMapView: GPUTextureView | null = null;
  private currentIBL: IBLResources | null = null;
  private currentCSM: CSMResources | null = null;

  // Track if bind group needs rebuild
  private needsRebuild: boolean = false;

  constructor(ctx: GPUContext) {
    this.ctx = ctx;
    this.placeholders = PlaceholderTextures.get(ctx);

    // Create the shared bind group layout
    this._layout = this.createLayout();

    // Create initial bind group with placeholders
    this._bindGroup = this.createBindGroup(null, null);
  }

  /**
   * Create the environment bind group layout
   * This layout is shared across Object, Terrain, and Water renderers
   */
  private createLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: 'shared-environment-layout',
      entries: SceneEnvironment.getDefaultBindGroupLayoutEntries(),
    });
  }

  /**
   * Create a bind group with the given resources (or placeholders)
   * Includes all 9 bindings (0-8) including CSM for compatibility with ALL mask
   */
  private createBindGroup(
    shadowMapView: GPUTextureView | null,
    ibl: IBLResources | null,
  ): GPUBindGroup {
    const shadow = shadowMapView ?? this.placeholders.shadowMapView;
    const diffuse = ibl?.diffuseCubemap ?? this.placeholders.cubemapView;
    const specular = ibl?.specularCubemap ?? this.placeholders.cubemapView;
    const brdf = ibl?.brdfLut ?? this.placeholders.brdfLutView;
    const cubeSampler = ibl?.cubemapSampler ?? this.placeholders.cubemapSampler;
    const lutSampler = ibl?.lutSampler ?? this.placeholders.lutSampler;
    
    // CSM resources (use placeholders if not set)
    const csmArray = this.currentCSM?.shadowArrayView ?? this.placeholders.csmArrayView;
    const csmBuffer = this.currentCSM?.uniformBuffer?.buffer ?? this.placeholders.csmUniformBuffer;

    return this.ctx.device.createBindGroup({
      label: 'shared-environment-bindgroup',
      layout: this._layout,
      entries: [
        { binding: ENVIRONMENT_BINDINGS.SHADOW_MAP, resource: shadow },
        { binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER, resource: this.placeholders.shadowSampler },
        { binding: ENVIRONMENT_BINDINGS.IBL_DIFFUSE, resource: diffuse },
        { binding: ENVIRONMENT_BINDINGS.IBL_SPECULAR, resource: specular },
        { binding: ENVIRONMENT_BINDINGS.BRDF_LUT, resource: brdf },
        { binding: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER, resource: cubeSampler },
        { binding: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER, resource: lutSampler },
        { binding: ENVIRONMENT_BINDINGS.CSM_SHADOW_ARRAY, resource: csmArray },
        { binding: ENVIRONMENT_BINDINGS.CSM_UNIFORMS, resource: { buffer: csmBuffer } },
      ],
    });
  }

  /**
   * Set the shadow map view
   * @param view Shadow map depth texture view (null to clear)
   */
  setShadowMap(view: GPUTextureView | null): void {
    if (this.currentShadowMapView !== view) {
      this.currentShadowMapView = view;
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Set IBL resources
   * @param ibl IBL resources (null to use placeholder/disable IBL)
   */
  setIBL(ibl: IBLResources | null): void {
    // Simple reference check - if IBL object changed, rebuild
    if (this.currentIBL !== ibl) {
      this.currentIBL = ibl;
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Set CSM resources for cascaded shadow mapping
   * @param csm CSM resources (null to disable CSM)
   */
  setCSM(csm: CSMResources | null): void {
    if (this.currentCSM !== csm) {
      this.currentCSM = csm;
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Update all environment resources in one call
   * More efficient than calling individual setters
   */
  update(
    shadowMapView: GPUTextureView | null, 
    ibl: IBLResources | null,
    csm?: CSMResources | null
  ): void {
    const shadowChanged = this.currentShadowMapView !== shadowMapView;
    const iblChanged = this.currentIBL !== ibl;
    const csmChanged = csm !== undefined && this.currentCSM !== csm;

    if (shadowChanged || iblChanged || csmChanged) {
      this.currentShadowMapView = shadowMapView;
      this.currentIBL = ibl;
      if (csm !== undefined) {
        this.currentCSM = csm;
      }
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Check if IBL is currently active (not placeholder)
   */
  hasIBL(): boolean {
    return this.currentIBL !== null;
  }

  /**
   * Check if shadow map is currently active (not placeholder)
   */
  hasShadow(): boolean {
    return this.currentShadowMapView !== null;
  }

  /**
   * Check if CSM is currently active
   */
  hasCSM(): boolean {
    return this.currentCSM !== null;
  }

  /**
   * Get the bind group layout for pipeline creation
   */
  get layout(): GPUBindGroupLayout {
    return this._layout;
  }

  /**
   * Get the current bind group
   * Automatically rebuilds if resources have changed
   */
  get bindGroup(): GPUBindGroup {
    if (this.needsRebuild) {
      this._bindGroup = this.createBindGroup(this.currentShadowMapView, this.currentIBL);
      this.needsRebuild = false;
    }
    return this._bindGroup;
  }

  /**
   * Force rebuild the bind group (call if IBL textures were updated in-place)
   */
  forceRebuild(): void {
    this._bindGroup = this.createBindGroup(this.currentShadowMapView, this.currentIBL);
    this.needsRebuild = false;
    this.invalidateMaskedBindGroups();
  }

  /**
   * Clear all resources back to placeholders
   */
  clear(): void {
    this.currentShadowMapView = null;
    this.currentIBL = null;
    this.currentCSM = null;
    this.needsRebuild = true;
    this.invalidateMaskedBindGroups();
  }

  static getDefaultBindGroupLayoutEntries(): Iterable<GPUBindGroupLayoutEntry> {
    return SceneEnvironment.getBindGroupLayoutEntriesForMask(ENV_BINDING_MASK.ALL);
  }
  
  /**
   * Get bind group layout entries for the specified mask
   * @param mask Bitmask of ENV_BINDING_MASK values
   * @returns Array of GPUBindGroupLayoutEntry for the requested bindings
   */
  static getBindGroupLayoutEntriesForMask(mask: EnvironmentBindingMask): GPUBindGroupLayoutEntry[] {
    const entries: GPUBindGroupLayoutEntry[] = [];
    
    // Shadow resources
    if (mask & ENV_BINDING_MASK.SHADOW_MAP) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SHADOW_MAP,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth' },
      });
    }
    if (mask & ENV_BINDING_MASK.SHADOW_SAMPLER) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      });
    }
    
    // IBL resources
    if (mask & ENV_BINDING_MASK.IBL_DIFFUSE) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.IBL_DIFFUSE,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      });
    }
    if (mask & ENV_BINDING_MASK.IBL_SPECULAR) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.IBL_SPECULAR,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      });
    }
    if (mask & ENV_BINDING_MASK.BRDF_LUT) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.BRDF_LUT,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      });
    }
    if (mask & ENV_BINDING_MASK.IBL_CUBE_SAMPLER) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      });
    }
    if (mask & ENV_BINDING_MASK.IBL_LUT_SAMPLER) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      });
    }
    
    // CSM resources
    if (mask & ENV_BINDING_MASK.CSM_SHADOW_ARRAY) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.CSM_SHADOW_ARRAY,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { 
          sampleType: 'depth',
          viewDimension: '2d-array',
        },
      });
    }
    if (mask & ENV_BINDING_MASK.CSM_UNIFORMS) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.CSM_UNIFORMS,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      });
    }
    
    return entries;
  }
  
  // Cache for masked layouts and bind groups
  private maskedLayouts: Map<EnvironmentBindingMask, GPUBindGroupLayout> = new Map();
  private maskedBindGroups: Map<EnvironmentBindingMask, GPUBindGroup> = new Map();
  private maskedBindGroupsNeedRebuild: Set<EnvironmentBindingMask> = new Set();
  
  /**
   * Get a bind group layout for the specified mask
   * Layouts are cached per mask value
   * @param mask Bitmask of ENV_BINDING_MASK values
   */
  getLayoutForMask(mask: EnvironmentBindingMask): GPUBindGroupLayout {
    let layout = this.maskedLayouts.get(mask);
    if (!layout) {
      layout = this.ctx.device.createBindGroupLayout({
        label: `environment-layout-mask-${mask.toString(16)}`,
        entries: SceneEnvironment.getBindGroupLayoutEntriesForMask(mask),
      });
      this.maskedLayouts.set(mask, layout);
    }
    return layout;
  }
  
  /**
   * Get a bind group for the specified mask
   * Automatically rebuilds if resources have changed
   * @param mask Bitmask of ENV_BINDING_MASK values
   */
  getBindGroupForMask(mask: EnvironmentBindingMask): GPUBindGroup {
    // Check if needs rebuild (either flagged or never created)
    if (this.maskedBindGroupsNeedRebuild.has(mask) || !this.maskedBindGroups.has(mask)) {
      const layout = this.getLayoutForMask(mask);
      const bindGroup = this.createBindGroupForMask(layout, mask);
      this.maskedBindGroups.set(mask, bindGroup);
      this.maskedBindGroupsNeedRebuild.delete(mask);
    }
    return this.maskedBindGroups.get(mask)!;
  }
  
  /**
   * Create a bind group for the specified mask
   */
  private createBindGroupForMask(layout: GPUBindGroupLayout, mask: EnvironmentBindingMask): GPUBindGroup {
    const shadow = this.currentShadowMapView ?? this.placeholders.shadowMapView;
    const ibl = this.currentIBL;
    const diffuse = ibl?.diffuseCubemap ?? this.placeholders.cubemapView;
    const specular = ibl?.specularCubemap ?? this.placeholders.cubemapView;
    const brdf = ibl?.brdfLut ?? this.placeholders.brdfLutView;
    const cubeSampler = ibl?.cubemapSampler ?? this.placeholders.cubemapSampler;
    const lutSampler = ibl?.lutSampler ?? this.placeholders.lutSampler;
    
    const entries: GPUBindGroupEntry[] = [];
    
    if (mask & ENV_BINDING_MASK.SHADOW_MAP) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SHADOW_MAP, resource: shadow });
    }
    if (mask & ENV_BINDING_MASK.SHADOW_SAMPLER) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER, resource: this.placeholders.shadowSampler });
    }
    if (mask & ENV_BINDING_MASK.IBL_DIFFUSE) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.IBL_DIFFUSE, resource: diffuse });
    }
    if (mask & ENV_BINDING_MASK.IBL_SPECULAR) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.IBL_SPECULAR, resource: specular });
    }
    if (mask & ENV_BINDING_MASK.BRDF_LUT) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.BRDF_LUT, resource: brdf });
    }
    if (mask & ENV_BINDING_MASK.IBL_CUBE_SAMPLER) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER, resource: cubeSampler });
    }
    if (mask & ENV_BINDING_MASK.IBL_LUT_SAMPLER) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER, resource: lutSampler });
    }
    
    // CSM resources
    if (mask & ENV_BINDING_MASK.CSM_SHADOW_ARRAY) {
      const csmArray = this.currentCSM?.shadowArrayView ?? this.placeholders.csmArrayView;
      entries.push({ binding: ENVIRONMENT_BINDINGS.CSM_SHADOW_ARRAY, resource: csmArray });
    }
    if (mask & ENV_BINDING_MASK.CSM_UNIFORMS) {
      if (this.currentCSM?.uniformBuffer) {
        entries.push({ 
          binding: ENVIRONMENT_BINDINGS.CSM_UNIFORMS, 
          resource: { buffer: this.currentCSM.uniformBuffer.buffer } 
        });
      } else {
        // Skip CSM uniforms if not available - shader should check csmEnabled flag
        // To prevent binding errors, we need a placeholder buffer
        entries.push({ 
          binding: ENVIRONMENT_BINDINGS.CSM_UNIFORMS, 
          resource: { buffer: this.placeholders.csmUniformBuffer } 
        });
      }
    }
    
    return this.ctx.device.createBindGroup({
      label: `environment-bindgroup-mask-${mask.toString(16)}`,
      layout,
      entries,
    });
  }
  
  /**
   * Mark all masked bind groups as needing rebuild
   * Called when shadow map or IBL resources change
   */
  private invalidateMaskedBindGroups(): void {
    for (const mask of this.maskedBindGroups.keys()) {
      this.maskedBindGroupsNeedRebuild.add(mask);
    }
  }
}
