import { mat4 } from 'gl-matrix';

import { DirectionalLightParams } from './DirectionalLight';
import { HDRLightParams } from './HDRLight';
import { PointLightParams } from './PointLight'

// Tone mapping mode constants
export const TONE_MAPPING = {
  NONE: 0,
  REINHARD: 1,
  REINHARD_LUMINANCE: 2,
  ACES: 3,
  UNCHARTED2: 4,
} as const;

export type ToneMappingMode = typeof TONE_MAPPING[keyof typeof TONE_MAPPING];

// String to mode mapping for UI
export const TONE_MAPPING_NAMES: Record<string, ToneMappingMode> = {
  'none': TONE_MAPPING.NONE,
  'reinhard': TONE_MAPPING.REINHARD,
  'reinhardLum': TONE_MAPPING.REINHARD_LUMINANCE,
  'aces': TONE_MAPPING.ACES,
  'uncharted': TONE_MAPPING.UNCHARTED2,
};

/**
 * Scene-level shadow parameters
 */
export interface ShadowParams {
  shadowEnabled: boolean;
  shadowDebug: number;
  shadowMap?: WebGLTexture | null;
  lightSpaceMatrix?: mat4;
  shadowBias?: number;
}

/**
 * Combined scene lighting parameters for shader uniforms.
 * Extends the active light params with scene-level shadow and tone mapping settings.
 */
export type SceneLightingParams = (DirectionalLightParams | HDRLightParams) & ShadowParams & {
  toneMapping: ToneMappingMode;
  pointLights: PointLightParams[];
};

/** @deprecated Use SceneLightingParams instead */
export type LightParams = SceneLightingParams;
