/**
 * WebGPU Type Definitions
 * TypeScript interfaces for the GPU abstraction layer
 */

/**
 * Supported buffer usage types
 */
export type BufferUsage = 'vertex' | 'index' | 'uniform' | 'storage' | 'read' | 'copy-src' | 'copy-dst';

/**
 * Buffer creation descriptor
 */
export interface BufferDescriptor {
  size: number;
  usage: BufferUsage[];
  label?: string;
  mappedAtCreation?: boolean;
}

/**
 * Texture format aliases for common use cases
 */
export type TextureFormatAlias =
  | 'rgba8'
  | 'rgba8-srgb'
  | 'rgba16f'
  | 'rgba32f'
  | 'r32f'
  | 'rg32f'
  | 'depth24'
  | 'depth32f'
  | 'depth24-stencil8';

/**
 * Texture usage types
 */
export type TextureUsage = 'sampled' | 'storage' | 'render-attachment' | 'copy-src' | 'copy-dst';

/**
 * Texture creation descriptor
 */
export interface TextureDescriptor {
  width: number;
  height: number;
  format: TextureFormatAlias | GPUTextureFormat;
  usage: TextureUsage[];
  label?: string;
  mipLevelCount?: number;
  sampleCount?: number;
  dimension?: '1d' | '2d' | '3d';
  depth?: number;
}

/**
 * Sampler creation descriptor
 */
export interface SamplerDescriptor {
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
  addressModeW?: GPUAddressMode;
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUMipmapFilterMode;
  maxAnisotropy?: number;
  compare?: GPUCompareFunction;
  label?: string;
}

/**
 * Vertex attribute definition
 */
export interface VertexAttribute {
  location: number;
  format: GPUVertexFormat;
  offset: number;
}

/**
 * Vertex buffer layout
 */
export interface VertexBufferLayout {
  arrayStride: number;
  stepMode?: GPUVertexStepMode;
  attributes: VertexAttribute[];
}

/**
 * Shader stage definition
 */
export interface ShaderStage {
  code: string;
  entryPoint: string;
}

/**
 * Render pipeline descriptor
 */
export interface RenderPipelineDescriptor {
  label?: string;
  vertex: ShaderStage & {
    buffers?: VertexBufferLayout[];
  };
  fragment?: ShaderStage & {
    targets: GPUColorTargetState[];
  };
  primitive?: GPUPrimitiveState;
  depthStencil?: GPUDepthStencilState;
  multisample?: GPUMultisampleState;
  layout?: GPUPipelineLayout | 'auto';
}

/**
 * Compute pipeline descriptor
 */
export interface ComputePipelineDescriptor {
  label?: string;
  compute: ShaderStage;
  layout?: GPUPipelineLayout | 'auto';
}

/**
 * Bind group entry helper
 */
export interface BindGroupEntry {
  binding: number;
  resource: GPUBindingResource;
}

/**
 * Uniform buffer helper type
 */
export interface UniformBufferBinding {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
}

/**
 * GPU device limits we care about
 */
export interface GPULimits {
  maxTextureDimension2D: number;
  maxTextureArrayLayers: number;
  maxBindGroups: number;
  maxUniformBufferBindingSize: number;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupsPerDimension: number;
  maxComputeWorkgroupSizeX: number;
  maxComputeWorkgroupSizeY: number;
  maxComputeWorkgroupSizeZ: number;
}

/**
 * GPU adapter info
 */
export interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}
