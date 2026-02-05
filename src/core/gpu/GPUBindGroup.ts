/**
 * GPUBindGroup - Bind group and layout utilities for WebGPU
 * Simplifies resource binding for shaders
 */

import { GPUContext } from './GPUContext';
import { UnifiedGPUBuffer } from './GPUBuffer';
import { UnifiedGPUTexture } from './GPUTexture';

/** Binding visibility flags */
export type BindingVisibility = 'vertex' | 'fragment' | 'compute' | 'all';

/** Buffer binding type */
export type BufferBindingType = 'uniform' | 'storage' | 'read-only-storage';

/** Sampler binding type */
export type SamplerBindingType = 'filtering' | 'non-filtering' | 'comparison';

/** Texture sample type */
export type TextureSampleType = 'float' | 'unfilterable-float' | 'depth' | 'sint' | 'uint';

/** Storage texture access */
export type StorageTextureAccess = 'write-only' | 'read-only' | 'read-write';

/** Layout entry for a buffer */
export interface BufferLayoutEntry {
  type: 'buffer';
  bufferType?: BufferBindingType;
  hasDynamicOffset?: boolean;
  minBindingSize?: number;
}

/** Layout entry for a sampler */
export interface SamplerLayoutEntry {
  type: 'sampler';
  samplerType?: SamplerBindingType;
}

/** Layout entry for a texture */
export interface TextureLayoutEntry {
  type: 'texture';
  sampleType?: TextureSampleType;
  viewDimension?: GPUTextureViewDimension;
  multisampled?: boolean;
}

/** Layout entry for a storage texture */
export interface StorageTextureLayoutEntry {
  type: 'storageTexture';
  access?: StorageTextureAccess;
  format: GPUTextureFormat;
  viewDimension?: GPUTextureViewDimension;
}

/** Union type for all layout entry types */
export type LayoutEntry =
  | BufferLayoutEntry
  | SamplerLayoutEntry
  | TextureLayoutEntry
  | StorageTextureLayoutEntry;

/** Simplified layout descriptor */
export interface BindGroupLayoutDescriptor {
  label?: string;
  entries: Record<number, { visibility: BindingVisibility; entry: LayoutEntry }>;
}

/** Bind group entry with resource */
export interface BindGroupEntryResource {
  buffer?: GPUBuffer | UnifiedGPUBuffer;
  offset?: number;
  size?: number;
  sampler?: GPUSampler;
  textureView?: GPUTextureView | UnifiedGPUTexture;
}

/**
 * Convert visibility string to GPUShaderStageFlags
 */
function visibilityToFlags(visibility: BindingVisibility): GPUShaderStageFlags {
  switch (visibility) {
    case 'vertex':
      return GPUShaderStage.VERTEX;
    case 'fragment':
      return GPUShaderStage.FRAGMENT;
    case 'compute':
      return GPUShaderStage.COMPUTE;
    case 'all':
      return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    default:
      return GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  }
}

/**
 * Create a bind group layout entry from our simplified format
 */
function createLayoutEntry(
  binding: number,
  visibility: BindingVisibility,
  entry: LayoutEntry
): GPUBindGroupLayoutEntry {
  const base: GPUBindGroupLayoutEntry = {
    binding,
    visibility: visibilityToFlags(visibility),
  };

  switch (entry.type) {
    case 'buffer':
      return {
        ...base,
        buffer: {
          type: entry.bufferType || 'uniform',
          hasDynamicOffset: entry.hasDynamicOffset || false,
          minBindingSize: entry.minBindingSize || 0,
        },
      };
    case 'sampler':
      return {
        ...base,
        sampler: {
          type: entry.samplerType || 'filtering',
        },
      };
    case 'texture':
      return {
        ...base,
        texture: {
          sampleType: entry.sampleType || 'float',
          viewDimension: entry.viewDimension || '2d',
          multisampled: entry.multisampled || false,
        },
      };
    case 'storageTexture':
      return {
        ...base,
        storageTexture: {
          access: entry.access || 'write-only',
          format: entry.format,
          viewDimension: entry.viewDimension || '2d',
        },
      };
  }
}

/**
 * Bind group layout builder
 */
export class BindGroupLayoutBuilder {
  private entries: GPUBindGroupLayoutEntry[] = [];
  private label: string;

  constructor(label = 'bind-group-layout') {
    this.label = label;
  }

  /**
   * Add a uniform buffer binding
   */
  uniformBuffer(binding: number, visibility: BindingVisibility = 'all', minBindingSize = 0): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'buffer',
        bufferType: 'uniform',
        minBindingSize,
      })
    );
    return this;
  }

  /**
   * Add a storage buffer binding (read-only)
   */
  storageBuffer(binding: number, visibility: BindingVisibility = 'all', minBindingSize = 0): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'buffer',
        bufferType: 'read-only-storage',
        minBindingSize,
      })
    );
    return this;
  }

  /**
   * Add a storage buffer binding (read-write)
   */
  storageBufferRW(binding: number, visibility: BindingVisibility = 'compute', minBindingSize = 0): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'buffer',
        bufferType: 'storage',
        minBindingSize,
      })
    );
    return this;
  }

  /**
   * Add a texture binding
   */
  texture(
    binding: number,
    visibility: BindingVisibility = 'fragment',
    sampleType: TextureSampleType = 'float',
    viewDimension: GPUTextureViewDimension = '2d'
  ): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'texture',
        sampleType,
        viewDimension,
      })
    );
    return this;
  }

  /**
   * Add a depth texture binding
   */
  depthTexture(binding: number, visibility: BindingVisibility = 'fragment'): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'texture',
        sampleType: 'depth',
        viewDimension: '2d',
      })
    );
    return this;
  }

  /**
   * Add a storage texture binding
   */
  storageTexture(
    binding: number,
    format: GPUTextureFormat,
    visibility: BindingVisibility = 'compute',
    access: StorageTextureAccess = 'write-only'
  ): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'storageTexture',
        format,
        access,
      })
    );
    return this;
  }

  /**
   * Add a sampler binding
   */
  sampler(
    binding: number,
    visibility: BindingVisibility = 'fragment',
    samplerType: SamplerBindingType = 'filtering'
  ): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'sampler',
        samplerType,
      })
    );
    return this;
  }

  /**
   * Add a comparison sampler binding (for shadow mapping)
   */
  comparisonSampler(binding: number, visibility: BindingVisibility = 'fragment'): this {
    this.entries.push(
      createLayoutEntry(binding, visibility, {
        type: 'sampler',
        samplerType: 'comparison',
      })
    );
    return this;
  }

  /**
   * Build the bind group layout
   */
  build(ctx: GPUContext): GPUBindGroupLayout {
    return ctx.device.createBindGroupLayout({
      label: this.label,
      entries: this.entries,
    });
  }

  /**
   * Reset the builder
   */
  reset(): this {
    this.entries = [];
    return this;
  }
}

/**
 * Bind group builder
 */
export class BindGroupBuilder {
  private entries: GPUBindGroupEntry[] = [];
  private label: string;

  constructor(label = 'bind-group') {
    this.label = label;
  }

  /**
   * Add a buffer binding
   */
  buffer(
    binding: number,
    buffer: GPUBuffer | UnifiedGPUBuffer,
    offset = 0,
    size?: number
  ): this {
    const gpuBuffer = buffer instanceof UnifiedGPUBuffer ? buffer.buffer : buffer;
    const bufferSize = size ?? (buffer instanceof UnifiedGPUBuffer ? buffer.size : undefined);

    this.entries.push({
      binding,
      resource: {
        buffer: gpuBuffer,
        offset,
        size: bufferSize,
      },
    });
    return this;
  }

  /**
   * Add a texture view binding
   * Uses duck typing to check for UnifiedGPUTexture-like objects
   */
  texture(binding: number, textureOrView: GPUTextureView | UnifiedGPUTexture): this {
    // Use duck typing instead of instanceof - works with type assertions and plain objects
    const view = textureOrView && 'view' in textureOrView && 'texture' in textureOrView
      ? (textureOrView as UnifiedGPUTexture).view
      : textureOrView as GPUTextureView;
    this.entries.push({
      binding,
      resource: view,
    });
    return this;
  }

  /**
   * Add a sampler binding
   */
  sampler(binding: number, sampler: GPUSampler): this {
    this.entries.push({
      binding,
      resource: sampler,
    });
    return this;
  }

  /**
   * Build the bind group
   */
  build(ctx: GPUContext, layout: GPUBindGroupLayout): GPUBindGroup {
    return ctx.device.createBindGroup({
      label: this.label,
      layout,
      entries: this.entries,
    });
  }

  /**
   * Reset the builder
   */
  reset(): this {
    this.entries = [];
    return this;
  }
}

/**
 * Common bind group layouts for terrain rendering
 */
export const CommonLayouts = {
  /**
   * Camera uniforms layout (group 0)
   */
  createCameraLayout(ctx: GPUContext): GPUBindGroupLayout {
    return new BindGroupLayoutBuilder('camera-layout')
      .uniformBuffer(0, 'vertex') // Camera uniforms
      .build(ctx);
  },

  /**
   * Model uniforms layout (group 1)
   */
  createModelLayout(ctx: GPUContext): GPUBindGroupLayout {
    return new BindGroupLayoutBuilder('model-layout')
      .uniformBuffer(0, 'vertex') // Model matrix
      .build(ctx);
  },

  /**
   * Terrain layout with heightmap (group 2)
   */
  createTerrainLayout(ctx: GPUContext): GPUBindGroupLayout {
    return new BindGroupLayoutBuilder('terrain-layout')
      .uniformBuffer(0, 'vertex') // Terrain uniforms
      .texture(1, 'vertex', 'float') // Heightmap
      .sampler(2, 'vertex', 'filtering') // Heightmap sampler
      .build(ctx);
  },

  /**
   * Material layout (group 2 for non-terrain)
   */
  createMaterialLayout(ctx: GPUContext): GPUBindGroupLayout {
    return new BindGroupLayoutBuilder('material-layout')
      .uniformBuffer(0, 'fragment') // Material uniforms
      .texture(1, 'fragment', 'float') // Albedo
      .texture(2, 'fragment', 'float') // Normal
      .texture(3, 'fragment', 'float') // Roughness/Metallic
      .sampler(4, 'fragment', 'filtering') // Texture sampler
      .build(ctx);
  },

  /**
   * Heightmap compute layout
   */
  createHeightmapComputeLayout(ctx: GPUContext): GPUBindGroupLayout {
    return new BindGroupLayoutBuilder('heightmap-compute-layout')
      .uniformBuffer(0, 'compute') // Generation params
      .storageTexture(1, 'r32float', 'compute', 'write-only') // Output heightmap
      .build(ctx);
  },
};
