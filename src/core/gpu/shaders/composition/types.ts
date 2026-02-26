// ============ WGSL Type Unions ============

/**
 * WGSL scalar and vector types used in uniform declarations.
 */
export type WGSLUniformType =
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2f'
  | 'vec2i'
  | 'vec2u'
  | 'vec3f'
  | 'vec3i'
  | 'vec3u'
  | 'vec4f'
  | 'vec4i'
  | 'vec4u'
  | 'mat2x2f'
  | 'mat3x3f'
  | 'mat4x4f';

/**
 * WGSL texture types for texture binding declarations.
 */
export type WGSLTextureType =
  | 'texture_2d<f32>'
  | 'texture_2d<i32>'
  | 'texture_2d<u32>'
  | 'texture_2d_array<f32>'
  | 'texture_cube<f32>'
  | 'texture_depth_2d'
  | 'texture_depth_2d_array'
  | 'texture_storage_2d<rgba8unorm, write>'
  | 'texture_storage_2d<rgba16float, write>'
  | 'texture_storage_2d<r32float, write>';

/**
 * WGSL sampler types for sampler binding declarations.
 */
export type WGSLSamplerType = 'sampler' | 'sampler_comparison';

// ============ Resource & Feature Types ============

/**
 * A GPU resource declared by a shader feature.
 * Resources with the same (name, group) are deduplicated during composition.
 */
export interface ShaderResource {
  /** Canonical resource name (from resourceNames.ts). Used for dedup. */
  name: string;

  /** Resource kind */
  kind: 'uniform' | 'texture' | 'sampler' | 'storage';

  /** For uniforms: the WGSL type */
  wgslType?: WGSLUniformType;

  /** For textures: the WGSL texture type */
  textureType?: WGSLTextureType;

  /** For samplers: the WGSL sampler type */
  samplerType?: WGSLSamplerType;

  /** Which bind group this resource belongs to */
  group: 'perObject' | 'environment' | 'textures';

  /** The component type that provides this resource at runtime */
  provider: string;
}

/**
 * A composable shader feature module.
 * Features declare their resource needs and provide WGSL code snippets
 * that get injected into the base template.
 */
export interface ShaderFeature {
  /** Unique feature identifier */
  id: string;

  /** Which shader stage(s) this feature affects */
  stage: 'vertex' | 'fragment' | 'both';

  /** GPU resources this feature requires */
  resources: ShaderResource[];

  /** WGSL function definitions (injected before main functions) */
  functions: string;

  /** WGSL code injected into the vertex shader main body */
  vertexInject?: string;

  /** WGSL code injected into the fragment shader main body (ambient section) */
  fragmentInject?: string;

  /** WGSL code injected before PBR lighting (modify albedo/roughness for wetness, etc.) */
  fragmentPreLightingInject?: string;

  /** WGSL code injected after final color computation (post-effects like snow) */
  fragmentPostInject?: string;

  /** Additional VertexOutput fields needed for passing data to fragment */
  varyings?: string;

  /** Other feature IDs that must be composed before this one */
  dependencies?: string[];
}

/**
 * Result of shader composition — contains the WGSL code and layout metadata.
 */
export interface ComposedShader {
  /** The final assembled WGSL source code */
  wgsl: string;

  /** Deduplicated per-object uniform fields (for buffer layout) */
  uniformLayout: Map<string, ShaderResource>;

  /** Deduplicated texture/sampler bindings with assigned indices */
  bindingLayout: Map<string, ShaderResource & { bindingIndex: number }>;

  /** The cache key that produced this shader */
  featureKey: string;

  /** Ordered list of feature IDs that were composed */
  features: string[];
}