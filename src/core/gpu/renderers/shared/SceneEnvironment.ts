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
import { IBLResources, ENVIRONMENT_BINDINGS } from './types';

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
      entries: [
        // Shadow resources
        {
          binding: ENVIRONMENT_BINDINGS.SHADOW_MAP,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'comparison' },
        },
        // IBL resources
        {
          binding: ENVIRONMENT_BINDINGS.IBL_DIFFUSE,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        {
          binding: ENVIRONMENT_BINDINGS.IBL_SPECULAR,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        {
          binding: ENVIRONMENT_BINDINGS.BRDF_LUT,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });
  }

  /**
   * Create a bind group with the given resources (or placeholders)
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
    }
  }

  /**
   * Update both shadow and IBL in one call
   * More efficient than calling setShadowMap + setIBL separately
   */
  update(shadowMapView: GPUTextureView | null, ibl: IBLResources | null): void {
    const shadowChanged = this.currentShadowMapView !== shadowMapView;
    const iblChanged = this.currentIBL !== ibl;

    if (shadowChanged || iblChanged) {
      this.currentShadowMapView = shadowMapView;
      this.currentIBL = ibl;
      this.needsRebuild = true;
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
  }

  /**
   * Clear all resources back to placeholders
   */
  clear(): void {
    this.currentShadowMapView = null;
    this.currentIBL = null;
    this.needsRebuild = true;
  }

  static getDefaultBindGroupLayoutEntries(): Iterable<GPUBindGroupLayoutEntry> {
    return [
      // Shadow resources
      {
        binding: ENVIRONMENT_BINDINGS.SHADOW_MAP,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth' },
      },
      {
        binding: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      },
      // IBL resources
      {
        binding: ENVIRONMENT_BINDINGS.IBL_DIFFUSE,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      },
      {
        binding: ENVIRONMENT_BINDINGS.IBL_SPECULAR,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: 'cube' },
      },
      {
        binding: ENVIRONMENT_BINDINGS.BRDF_LUT,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ];
  }
}
