import type { GPUContext } from '../gpu/GPUContext';
import type { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';

/**
 * Component type identifiers.
 * Using a string union for extensibility — new components just add a new string.
 */
export type ComponentType =
  | 'transform'
  | 'mesh'
  | 'material'
  | 'bounds'
  | 'shadow'
  | 'visibility'
  | 'group'
  | 'primitive-geometry'
  | 'wind'
  | 'vegetation'
  | 'biome-mask'
  | 'terrain'
  | 'ocean'
  | 'light'
  | 'camera'
  | 'lod'
  | 'wetness'
  | 'ssr'
  | 'reflection-probe'; // Extensible for future/external components

/**
 * Context provided to systems each frame.
 */
export interface SystemContext {
  ctx: GPUContext;
  time: number;
  deltaTime: number;
  sceneEnvironment: SceneEnvironment;
}