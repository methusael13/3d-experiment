/**
 * Canonical resource names for shader features.
 * Features MUST use these names to enable automatic deduplication.
 * If two features both declare a resource with the same name and group,
 * the ShaderComposer will emit only one binding.
 */
export const RES = {
  // ==================== Shadow (environment) ====================
  SHADOW_MAP: 'shadowMap',
  SHADOW_SAMPLER: 'shadowSampler',
  CSM_SHADOW_ARRAY: 'csmShadowArray',
  CSM_UNIFORMS: 'csmUniforms',

  // ==================== IBL (environment) ====================
  IBL_DIFFUSE: 'iblDiffuse',
  IBL_SPECULAR: 'iblSpecular',
  IBL_BRDF_LUT: 'iblBrdfLut',
  IBL_CUBEMAP_SAMPLER: 'iblCubemapSampler',
  IBL_LUT_SAMPLER: 'iblLutSampler',

  // ==================== PBR Textures (textures group) ====================
  BASE_COLOR_TEX: 'baseColorTexture',
  BASE_COLOR_SAMP: 'baseColorSampler',
  NORMAL_TEX: 'normalTexture',
  NORMAL_SAMP: 'normalSampler',
  METALLIC_ROUGHNESS_TEX: 'metallicRoughnessTexture',
  METALLIC_ROUGHNESS_SAMP: 'metallicRoughnessSampler',
  OCCLUSION_TEX: 'occlusionTexture',
  OCCLUSION_SAMP: 'occlusionSampler',
  EMISSIVE_TEX: 'emissiveTexture',
  EMISSIVE_SAMP: 'emissiveSampler',

  // ==================== Wind (per-object uniforms) ====================
  WIND_DISPLACEMENT_X: 'windDisplacementX',
  WIND_DISPLACEMENT_Z: 'windDisplacementZ',
  WIND_ANCHOR_HEIGHT: 'windAnchorHeight',
  WIND_STIFFNESS: 'windStiffness',
  WIND_TIME: 'windTime',
  WIND_TURBULENCE: 'windTurbulence',
  WIND_DEBUG_MODE: 'windDebugMode',
  WIND_DEBUG_MATERIAL_TYPE: 'windDebugMaterialType',

  // ==================== Wetness (per-object uniforms) ====================
  WETNESS_PARAMS: 'wetnessParams',

  // ==================== SSR (textures group) ====================
  SSR_PREV_FRAME_TEXTURE: 'ssrPrevFrameTexture',

  // ==================== Reflection Probe (environment group) ====================
  REFLECTION_PROBE_CUBEMAP: 'reflectionProbeCubemap',
  REFLECTION_PROBE_SAMPLER: 'reflectionProbeSampler',

  // ==================== Terrain (shared by terrain + shadow) ====================
  TERRAIN_HEIGHTMAP: 'terrainHeightmap',
  TERRAIN_NORMALMAP: 'terrainNormalMap',
  ISLAND_MASK_TEX: 'islandMaskTex',
  ISLAND_MASK_SAMP: 'islandMaskSamp',
  ISLAND_MASK_SCALE: 'islandMaskScale',
} as const;

export type ResourceName = (typeof RES)[keyof typeof RES];