/**
 * Shared renderer utilities
 * 
 * Provides common functionality for Object, Terrain, and Water renderers:
 * - SceneEnvironment: Manages shadow + IBL bind group (Group 3)
 * - PlaceholderTextures: Singleton for default 1x1 textures
 * - Types: Shared interfaces for IBL, shadows, and render params
 */

export { SceneEnvironment } from './SceneEnvironment';
export { PlaceholderTextures } from './PlaceholderTextures';
export {
  type IBLResources,
  type ShadowResources,
  type EnvironmentParams,
  type CommonRenderParams,
  type EnvironmentBindingMask,
  BIND_GROUP_SLOTS,
  ENVIRONMENT_BINDINGS,
  ENV_BINDING_MASK,
} from './types';
