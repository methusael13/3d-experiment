/**
 * SDF (Signed Distance Field) Module
 * 
 * Provides a Global Distance Field for water contact foam, volumetric fog,
 * and ambient occlusion.
 */

export { GlobalDistanceField } from './GlobalDistanceField';
export { SDFTerrainStamper } from './SDFTerrainStamper';
export { SDFPrimitiveStamper } from './SDFPrimitiveStamper';
export { createDefaultSDFConfig } from './types';
export type { SDFConfig, SDFCascade, SDFTerrainStampParams, SDFShaderParams, SDFPrimitive, SDFPrimitiveType } from './types';
