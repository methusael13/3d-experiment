import type { GPUContext } from '../gpu/GPUContext';
import type { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';
import type { World } from './World';

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
  | 'player'
  | 'lod'
  | 'wetness'
  | 'ssr'
  | 'reflection-probe'
  | 'frustum-cull'
  | 'character-physics'
  | 'skeleton'
  | 'animation'
  | 'vegetation-instance'
  | 'camera-target'
  | 'character-vars'
  | 'character-controller'
  | 'script'; // Extensible for future/external components

/**
 * Context provided to systems each frame.
 */
export interface SystemContext {
  ctx: GPUContext;
  world: World;
  time: number;
  deltaTime: number;
  sceneEnvironment: SceneEnvironment;
}
