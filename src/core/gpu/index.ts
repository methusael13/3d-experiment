/**
 * GPU Module - WebGPU abstraction layer
 * Provides a clean interface for WebGPU rendering
 */

// Core context
export { GPUContext } from './GPUContext';
export type { GPUContextOptions } from './GPUContext';

// Buffer abstractions
export { UnifiedGPUBuffer, UniformBuilder, alignTo256, alignTo4 } from './GPUBuffer';
export type { GPUBufferType, GPUBufferOptions } from './GPUBuffer';

// Texture abstractions
export { UnifiedGPUTexture, SamplerFactory } from './GPUTexture';
export type {
  TextureDimension,
  CommonTextureFormat,
  GPUTextureOptions,
  GPUSamplerOptions,
} from './GPUTexture';

// Shader module management
export { ShaderModuleManager, WGSLBuilder } from './GPUShaderModule';
export type { ShaderCompilationResult } from './GPUShaderModule';

// Shader loader (WGSL file imports)
export {
  ShaderSources,
  loadShader,
  loadShaderFromSource,
  combineShaderSources,
  clearShaderCache,
  getShaderSource,
  isShaderCached,
} from './ShaderLoader';
export type { ShaderName } from './ShaderLoader';

// Bind group utilities
export {
  BindGroupLayoutBuilder,
  BindGroupBuilder,
  CommonLayouts,
} from './GPUBindGroup';
export type {
  BindingVisibility,
  BufferBindingType,
  SamplerBindingType,
  TextureSampleType,
  StorageTextureAccess,
  BufferLayoutEntry,
  SamplerLayoutEntry,
  TextureLayoutEntry,
  StorageTextureLayoutEntry,
  LayoutEntry,
  BindGroupLayoutDescriptor,
  BindGroupEntryResource,
} from './GPUBindGroup';

// Render pipeline
export {
  RenderPipelineWrapper,
  CommonVertexLayouts,
  CommonBlendStates,
  getVertexFormatSize,
} from './GPURenderPipeline';
export type {
  PrimitiveTopology,
  CullMode,
  FrontFace,
  DepthCompareFunction,
  BlendFactor,
  BlendOperation,
  VertexFormat,
  VertexStepMode,
  VertexAttributeDesc,
  VertexBufferLayoutDesc,
  BlendStateDesc,
  RenderPipelineOptions,
} from './GPURenderPipeline';

// Compute pipeline
export {
  ComputePipelineWrapper,
  ComputePassHelper,
  calculateWorkgroupCount,
  calculateWorkgroupCount2D,
} from './GPUComputePipeline';
export type { ComputePipelineOptions } from './GPUComputePipeline';

// Re-export common types from types.ts
export type {
  BufferUsage,
  BufferDescriptor,
  TextureFormatAlias,
  TextureUsage,
  TextureDescriptor,
  SamplerDescriptor,
  VertexAttribute,
  VertexBufferLayout,
  ShaderStage,
  RenderPipelineDescriptor,
  ComputePipelineDescriptor,
  BindGroupEntry,
  UniformBufferBinding,
  GPULimits,
  GPUAdapterInfo,
} from './types';
