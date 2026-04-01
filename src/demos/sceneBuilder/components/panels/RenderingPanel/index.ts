export { RenderingPanel } from './RenderingPanel';
export type {
  RenderingPanelProps,
  CloudSettings,
} from './RenderingPanel';

// Re-export engine config types from RenderingPanel (which imports from @/core/EngineConfig).
// This maintains backward compatibility for consumers that import from this barrel.
// @see docs/engine-extraction-plan.md — Phase 1.3
export type {
  WebGPUShadowSettings,
  SSAOSettings,
  SSRSettings,
  AtmosphericFogSettings,
  VolumetricFogSettings,
  GodRaySettings,
  GodRayMode,
  DebugViewMode,
  ResolutionScalePreset,
} from './RenderingPanel';
