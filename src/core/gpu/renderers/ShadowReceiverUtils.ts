/**
 * ShadowReceiverUtils - Shared utilities for shadow map receiving
 * 
 * Provides reusable GPU resources for any renderer that needs to receive shadows:
 * - Bind group layout for shadow map (depth texture + comparison sampler)
 * - Bind group creation from shadow map view
 * - Comparison sampler for shadow testing
 * - Placeholder shadow map for when shadows are disabled
 * 
 * Usage pattern:
 * 1. Create shadow bind group layout once per renderer
 * 2. Create sampler and placeholder once
 * 3. Call createShadowBindGroup() to bind actual shadow map before render
 */

/**
 * Interface for shadow receiver resources
 */
export interface ShadowReceiverResources {
  bindGroupLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  placeholderTexture: GPUTexture;
  placeholderView: GPUTextureView;
  currentBindGroup: GPUBindGroup;
}

/**
 * Utility class for shadow map receiving across different renderers
 */
export class ShadowReceiverUtils {
  /**
   * Create a bind group layout for shadow map receiving.
   * Standard layout: binding 0 = depth texture, binding 1 = comparison sampler
   * 
   * @param device - GPU device
   * @param label - Optional label for debugging
   * @returns GPUBindGroupLayout for shadow map
   */
  static createShadowBindGroupLayout(
    device: GPUDevice,
    label = 'shadow-receiver-layout'
  ): GPUBindGroupLayout {
    return device.createBindGroupLayout({
      label,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'comparison' },
        },
      ],
    });
  }

  /**
   * Create a comparison sampler for shadow testing.
   * Uses 'less' comparison with linear filtering for PCF-like softness.
   * 
   * @param device - GPU device
   * @param label - Optional label for debugging
   * @returns GPUSampler configured for shadow comparison
   */
  static createShadowSampler(
    device: GPUDevice,
    label = 'shadow-comparison-sampler'
  ): GPUSampler {
    return device.createSampler({
      label,
      compare: 'less',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  /**
   * Create a placeholder 1x1 depth texture for when shadows are disabled.
   * The texture is at max depth (1.0), so all samples will pass = no shadow.
   * 
   * @param device - GPU device
   * @param label - Optional label for debugging
   * @returns Object with texture and view
   */
  static createPlaceholderShadowMap(
    device: GPUDevice,
    label = 'placeholder-shadow-map'
  ): { texture: GPUTexture; view: GPUTextureView } {
    const texture = device.createTexture({
      label,
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    
    const view = texture.createView({ label: `${label}-view` });
    
    return { texture, view };
  }

  /**
   * Create a bind group for shadow map receiving.
   * 
   * @param device - GPU device
   * @param layout - Bind group layout from createShadowBindGroupLayout()
   * @param shadowMapView - The shadow map depth texture view
   * @param sampler - Comparison sampler from createShadowSampler()
   * @param label - Optional label for debugging
   * @returns GPUBindGroup ready for use
   */
  static createShadowBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    shadowMapView: GPUTextureView,
    sampler: GPUSampler,
    label = 'shadow-receiver-bindgroup'
  ): GPUBindGroup {
    return device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: shadowMapView },
        { binding: 1, resource: sampler },
      ],
    });
  }

  /**
   * Create all shadow receiver resources at once.
   * Convenience method that creates layout, sampler, placeholder, and initial bind group.
   * 
   * @param device - GPU device
   * @param labelPrefix - Prefix for all resource labels
   * @returns ShadowReceiverResources object with all resources
   */
  static createResources(
    device: GPUDevice,
    labelPrefix = 'shadow-receiver'
  ): ShadowReceiverResources {
    const bindGroupLayout = ShadowReceiverUtils.createShadowBindGroupLayout(
      device,
      `${labelPrefix}-layout`
    );
    
    const sampler = ShadowReceiverUtils.createShadowSampler(
      device,
      `${labelPrefix}-sampler`
    );
    
    const { texture: placeholderTexture, view: placeholderView } =
      ShadowReceiverUtils.createPlaceholderShadowMap(
        device,
        `${labelPrefix}-placeholder`
      );
    
    // Create initial bind group with placeholder
    const currentBindGroup = ShadowReceiverUtils.createShadowBindGroup(
      device,
      bindGroupLayout,
      placeholderView,
      sampler,
      `${labelPrefix}-bindgroup`
    );
    
    return {
      bindGroupLayout,
      sampler,
      placeholderTexture,
      placeholderView,
      currentBindGroup,
    };
  }

  /**
   * Update the shadow bind group with a new shadow map.
   * Returns a new bind group (bind groups are immutable).
   * 
   * @param device - GPU device
   * @param resources - Existing shadow receiver resources
   * @param shadowMapView - New shadow map view (or null to use placeholder)
   * @param label - Optional label for the new bind group
   * @returns New GPUBindGroup
   */
  static updateBindGroup(
    device: GPUDevice,
    resources: ShadowReceiverResources,
    shadowMapView: GPUTextureView | null,
    label = 'shadow-receiver-bindgroup'
  ): GPUBindGroup {
    const view = shadowMapView ?? resources.placeholderView;
    
    return ShadowReceiverUtils.createShadowBindGroup(
      device,
      resources.bindGroupLayout,
      view,
      resources.sampler,
      label
    );
  }

  /**
   * Destroy shadow receiver resources to free GPU memory.
   * 
   * @param resources - Resources to destroy
   */
  static destroyResources(resources: ShadowReceiverResources): void {
    resources.placeholderTexture.destroy();
    // Note: GPUBindGroup, GPUBindGroupLayout, and GPUSampler don't have destroy()
  }
}
