/**
 * GPU Renderers - WebGPU renderer components
 */

export { GridRendererGPU } from './GridRendererGPU';
export { SkyRendererGPU } from './SkyRendererGPU';
export { ObjectRendererGPU } from './ObjectRendererGPU';
export { GizmoRendererGPU, type GizmoColor, type GizmoDrawCommand } from './GizmoRendererGPU';
export { 
  ShadowRendererGPU, 
  type ShadowConfig, 
  type LightMatrixParams,
  createDefaultShadowConfig 
} from './ShadowRendererGPU';
export {
  WaterRendererGPU,
  type WaterConfig,
  type WaterRenderParams,
  createDefaultWaterConfig,
} from './WaterRendererGPU';

// Shadow receiver utilities
export { ShadowReceiverUtils, type ShadowReceiverResources } from './ShadowReceiverUtils';

// Types
export type { BoundingBox, ShadowCaster, ShadowReceiver } from './types';
