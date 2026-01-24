/**
 * Light classes for scene illumination
 */

export { Light, type LightType, type BaseLightParams, type RGBColor } from './Light';
export { DirectionalLight, type SerializedDirectionalLight, type DirectionalLightParams } from './DirectionalLight';
export { PointLight, type SerializedPointLight, type PointLightParams } from './PointLight';
export { HDRLight, type SerializedHDRLight, type HDRLightParams } from './HDRLight';

export * from './types';

/**
 * Union of all light parameter types
 */
export type AnyLightParams = 
  | import('./DirectionalLight').DirectionalLightParams
  | import('./HDRLight').HDRLightParams
  | import('./PointLight').PointLightParams;