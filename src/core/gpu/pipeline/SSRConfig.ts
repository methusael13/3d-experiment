/**
 * SSRConfig - Screen Space Reflections configuration types and quality presets
 */

/**
 * SSR quality level
 */
export type SSRQualityLevel = 'low' | 'medium' | 'high' | 'ultra';

/**
 * SSR configuration parameters
 */
export interface SSRConfig {
  /** Whether SSR is enabled */
  enabled: boolean;
  /** Quality level preset */
  quality: SSRQualityLevel;
  /** Maximum ray march steps */
  maxSteps: number;
  /** Binary refinement steps after initial hit */
  refinementSteps: number;
  /** Maximum ray distance in view space */
  maxDistance: number;
  /** Ray step size (smaller = more precise, slower) */
  stepSize: number;
  /** Thickness threshold for hit detection */
  thickness: number;
  /** Fade at screen edges (0-1) */
  edgeFade: number;
  /** Enable jittered rays for noise-based anti-aliasing */
  jitter: boolean;
}

/**
 * Quality presets for SSR
 */
export const SSR_QUALITY_PRESETS: Record<SSRQualityLevel, Omit<SSRConfig, 'enabled' | 'quality'>> = {
  low: {
    maxSteps: 32,
    refinementSteps: 0,
    maxDistance: 100,
    stepSize: 0.5,
    thickness: 0.5,
    edgeFade: 0.1,
    jitter: false,
  },
  medium: {
    maxSteps: 64,
    refinementSteps: 4,
    maxDistance: 200,
    stepSize: 0.3,
    thickness: 0.3,
    edgeFade: 0.15,
    jitter: false,
  },
  high: {
    maxSteps: 128,
    refinementSteps: 8,
    maxDistance: 300,
    stepSize: 0.2,
    thickness: 0.2,
    edgeFade: 0.2,
    jitter: true,
  },
  ultra: {
    maxSteps: 256,
    refinementSteps: 16,
    maxDistance: 500,
    stepSize: 0.1,
    thickness: 0.15,
    edgeFade: 0.25,
    jitter: true,
  },
};

/**
 * Create default SSR config with a given quality level
 */
export function createSSRConfig(quality: SSRQualityLevel = 'medium', enabled: boolean = true): SSRConfig {
  return {
    enabled,
    quality,
    ...SSR_QUALITY_PRESETS[quality],
  };
}

/**
 * Apply quality preset to config, preserving enabled state
 */
export function applySSRQualityPreset(config: SSRConfig, quality: SSRQualityLevel): SSRConfig {
  return {
    ...config,
    quality,
    ...SSR_QUALITY_PRESETS[quality],
  };
}