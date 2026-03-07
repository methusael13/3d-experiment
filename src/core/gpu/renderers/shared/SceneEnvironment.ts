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
 * - Binding 7: CSM shadow map array
 * - Binding 8: CSM uniforms buffer
 * - Binding 9: SSR texture
 * - Binding 10: Light counts uniform
 * - Binding 11: Point lights storage
 * - Binding 12: Spot lights storage
 * - Binding 13: Spot shadow atlas (depth 2d-array)
 * - Binding 14: Spot shadow comparison sampler
 * - Binding 15: Cookie atlas (2d-array)
 * - Binding 16: Cookie sampler
 */

import { GPUContext } from '../../GPUContext';
import { PlaceholderTextures } from './PlaceholderTextures';
import type { UnifiedGPUBuffer } from '../../GPUBuffer';
import type { LightBufferManager } from '../LightBufferManager';
import type { ShadowRendererGPU } from '../ShadowRendererGPU';
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
  private currentSSRView: GPUTextureView | null = null;

  // Multi-light resources
  private currentLightBufferManager: LightBufferManager | null = null;
  private currentShadowRenderer: ShadowRendererGPU | null = null;

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
   * Includes all 10 bindings (0-9) including CSM for compatibility with ALL mask
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

    // Multi-light buffers
    const lightBuffers = this.currentLightBufferManager?.getBuffers();

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
        { binding: ENVIRONMENT_BINDINGS.SSR_TEXTURE, resource: this.currentSSRView ?? this.placeholders.ssrTextureView },
        // Multi-light bindings (10-12)
        { binding: ENVIRONMENT_BINDINGS.LIGHT_COUNTS, resource: { buffer: lightBuffers?.lightCountsBuffer ?? this.getPlaceholderUniformBuffer() } },
        { binding: ENVIRONMENT_BINDINGS.POINT_LIGHTS, resource: { buffer: lightBuffers?.pointLightsBuffer ?? this.getPlaceholderStorageBuffer() } },
        { binding: ENVIRONMENT_BINDINGS.SPOT_LIGHTS, resource: { buffer: lightBuffers?.spotLightsBuffer ?? this.getPlaceholderStorageBuffer() } },
        // Spot shadow atlas (13-14)
        { binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_ATLAS, resource: this.currentShadowRenderer?.getSpotShadowAtlasView() ?? this.placeholders.spotShadowAtlasView },
        { binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_SAMPLER, resource: this.placeholders.spotShadowSampler },
        // Cookie atlas (15-16)
        { binding: ENVIRONMENT_BINDINGS.COOKIE_ATLAS, resource: this.placeholders.cookieAtlasView },
        { binding: ENVIRONMENT_BINDINGS.COOKIE_SAMPLER, resource: this.placeholders.cookieSampler },
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
   * Set the LightBufferManager for multi-light bindings (10-12)
   * @param manager LightBufferManager (null to clear)
   */
  setLightBufferManager(manager: LightBufferManager | null): void {
    if (this.currentLightBufferManager !== manager) {
      this.currentLightBufferManager = manager;
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Set the ShadowRendererGPU for spot shadow atlas bindings (13-14)
   * @param renderer ShadowRendererGPU (null to clear)
   */
  setShadowRenderer(renderer: ShadowRendererGPU | null): void {
    if (this.currentShadowRenderer !== renderer) {
      this.currentShadowRenderer = renderer;
      this.needsRebuild = true;
      this.invalidateMaskedBindGroups();
    }
  }

  /**
   * Set SSR texture view (from SSRPass output)
   * @param view SSR texture view (null to clear/use placeholder)
   */
  setSSR(view: GPUTextureView | null): void {
    if (this.currentSSRView !== view) {
      this.currentSSRView = view;
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
    
    // Shadow resources (bindings 0-1)
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
    
    // IBL resources (bindings 2-6)
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
    
    // CSM resources (bindings 7-8)
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
    
    // SSR texture (binding 9)
    if (mask & ENV_BINDING_MASK.SSR_TEXTURE) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SSR_TEXTURE,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      });
    }
    
    // Multi-light buffers (bindings 10-12)
    if (mask & (1 << ENVIRONMENT_BINDINGS.LIGHT_COUNTS)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.LIGHT_COUNTS,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.POINT_LIGHTS)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.POINT_LIGHTS,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_LIGHTS)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SPOT_LIGHTS,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      });
    }
    
    // Spot shadow atlas (bindings 13-14)
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_SHADOW_ATLAS)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_ATLAS,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'depth',
          viewDimension: '2d-array',
        },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_SHADOW_SAMPLER)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      });
    }
    
    // Cookie atlas (bindings 15-16)
    if (mask & (1 << ENVIRONMENT_BINDINGS.COOKIE_ATLAS)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.COOKIE_ATLAS,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: 'float',
          viewDimension: '2d-array',
        },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.COOKIE_SAMPLER)) {
      entries.push({
        binding: ENVIRONMENT_BINDINGS.COOKIE_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
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
    
    // Shadow resources (bindings 0-1)
    if (mask & ENV_BINDING_MASK.SHADOW_MAP) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SHADOW_MAP, resource: shadow });
    }
    if (mask & ENV_BINDING_MASK.SHADOW_SAMPLER) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER, resource: this.placeholders.shadowSampler });
    }
    
    // IBL resources (bindings 2-6)
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
    
    // CSM resources (bindings 7-8)
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
        entries.push({ 
          binding: ENVIRONMENT_BINDINGS.CSM_UNIFORMS, 
          resource: { buffer: this.placeholders.csmUniformBuffer } 
        });
      }
    }
    
    // SSR texture (binding 9)
    if (mask & ENV_BINDING_MASK.SSR_TEXTURE) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SSR_TEXTURE, resource: this.currentSSRView ?? this.placeholders.ssrTextureView });
    }
    
    // Multi-light buffers (bindings 10-12)
    if (mask & (1 << ENVIRONMENT_BINDINGS.LIGHT_COUNTS)) {
      const buffers = this.currentLightBufferManager?.getBuffers();
      entries.push({
        binding: ENVIRONMENT_BINDINGS.LIGHT_COUNTS,
        resource: { buffer: buffers?.lightCountsBuffer ?? this.getPlaceholderUniformBuffer() },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.POINT_LIGHTS)) {
      const buffers = this.currentLightBufferManager?.getBuffers();
      entries.push({
        binding: ENVIRONMENT_BINDINGS.POINT_LIGHTS,
        resource: { buffer: buffers?.pointLightsBuffer ?? this.getPlaceholderStorageBuffer() },
      });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_LIGHTS)) {
      const buffers = this.currentLightBufferManager?.getBuffers();
      entries.push({
        binding: ENVIRONMENT_BINDINGS.SPOT_LIGHTS,
        resource: { buffer: buffers?.spotLightsBuffer ?? this.getPlaceholderStorageBuffer() },
      });
    }
    
    // Spot shadow atlas (bindings 13-14)
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_SHADOW_ATLAS)) {
      const atlasView = this.currentShadowRenderer?.getSpotShadowAtlasView() ?? this.placeholders.spotShadowAtlasView;
      entries.push({ binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_ATLAS, resource: atlasView });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.SPOT_SHADOW_SAMPLER)) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.SPOT_SHADOW_SAMPLER, resource: this.placeholders.spotShadowSampler });
    }
    
    // Cookie atlas (bindings 15-16)
    if (mask & (1 << ENVIRONMENT_BINDINGS.COOKIE_ATLAS)) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.COOKIE_ATLAS, resource: this.placeholders.cookieAtlasView });
    }
    if (mask & (1 << ENVIRONMENT_BINDINGS.COOKIE_SAMPLER)) {
      entries.push({ binding: ENVIRONMENT_BINDINGS.COOKIE_SAMPLER, resource: this.placeholders.cookieSampler });
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
  
  // ============ Placeholder buffer helpers for multi-light ============
  
  private _placeholderUniformBuffer: GPUBuffer | null = null;
  private _placeholderStorageBuffer: GPUBuffer | null = null;
  
  /** Get a placeholder 16-byte uniform buffer (for light counts when no LightBufferManager) */
  private getPlaceholderUniformBuffer(): GPUBuffer {
    if (!this._placeholderUniformBuffer) {
      this._placeholderUniformBuffer = this.ctx.device.createBuffer({
        label: 'placeholder-light-counts',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    return this._placeholderUniformBuffer;
  }
  
  /** Get a placeholder 64-byte storage buffer (for empty point/spot light arrays) */
  private getPlaceholderStorageBuffer(): GPUBuffer {
    if (!this._placeholderStorageBuffer) {
      this._placeholderStorageBuffer = this.ctx.device.createBuffer({
        label: 'placeholder-light-storage',
        size: 64, // min for storage buffer
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    return this._placeholderStorageBuffer;
  }
}