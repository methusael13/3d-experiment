/**
 * Engine Configuration Types
 *
 * Canonical type definitions for engine-level settings that were previously
 * defined in the demo layer (RenderingPanel). Moving them here fixes the
 * boundary violation where core engine code (GPUForwardPipeline) imported
 * from src/demos/.
 *
 * @see docs/engine-extraction-plan.md — Phase 1.1
 */

import type { SSAOEffectConfig, AtmosphericFogConfig } from './gpu/postprocess';
import type { SSRQualityLevel } from './gpu/pipeline/SSRConfig';

// ==================== Shadow Settings ====================

/**
 * Shadow configuration for the rendering pipeline.
 * Previously: WebGPUShadowSettings in RenderingPanel.tsx
 */
export interface WebGPUShadowSettings {
  enabled: boolean;
  resolution: number;
  shadowRadius: number;
  softShadows: boolean;
  // CSM settings
  csmEnabled: boolean;
  cascadeCount: number;
  cascadeBlendFraction: number;
}

// ==================== SSAO Settings ====================

/**
 * SSAO Settings - extends SSAOConfig with enabled flag.
 * Uses SSAOConfig from postprocess module for consistency.
 * Previously: SSAOSettings in RenderingPanel.tsx
 */
export interface SSAOSettings extends Required<SSAOEffectConfig> {
  /** Whether SSAO effect is enabled */
  enabled: boolean;
}

// ==================== SSR Settings ====================

/**
 * SSR Settings for the rendering pipeline.
 * Previously: SSRSettings in RenderingPanel.tsx
 */
export interface SSRSettings {
  /** Whether SSR is enabled */
  enabled: boolean;
  /** Quality preset */
  quality: SSRQualityLevel;
}

// ==================== Atmospheric Fog Settings ====================

/**
 * Atmospheric fog settings.
 * Previously: AtmosphericFogSettings in RenderingPanel.tsx
 */
export interface AtmosphericFogSettings extends Required<AtmosphericFogConfig> {}

// ==================== God Ray Settings ====================

/**
 * God ray rendering mode.
 * Previously: GodRayMode in RenderingPanel.tsx
 */
export type GodRayMode = 'screen-space' | 'volumetric';

/**
 * God ray settings for the rendering pipeline.
 * Previously: GodRaySettings in RenderingPanel.tsx
 */
/**
 * Volumetric fog settings for the froxel-based fog system (Phase 6).
 * When enabled, replaces AtmosphericFogEffect with a full 3D froxel grid.
 */
export interface VolumetricFogSettings {
  enabled: boolean;
  fogHeight: number;
  fogHeightFalloff: number;
  fogBaseDensity: number;
  fogColor: [number, number, number];
  mieG: number;
  scatteringScale: number;
  ambientFogIntensity: number;
  noiseEnabled: boolean;
  noiseScale: number;
  noiseStrength: number;
  temporalEnabled: boolean;
  temporalBlend: number;
}

export interface GodRaySettings {
  enabled: boolean;
  mode: GodRayMode;
  intensity: number;
  samples: number;
  decay: number;
  weight: number;
  density: number;
}

// ==================== Debug View ====================

/**
 * Debug view mode type.
 * Re-exported from DebugViewPass for convenience.
 * Previously: exported from RenderingPanel.tsx via DebugViewPass import
 */
export type { DebugViewMode } from './gpu/pipeline/passes/DebugViewPass';

// ==================== Resolution Scale ====================

/**
 * Resolution scale presets for the viewport.
 * Previously: ResolutionScalePreset in RenderingPanel.tsx
 */
export type ResolutionScalePreset = '1.0' | '0.75' | '0.5' | '0.25';
