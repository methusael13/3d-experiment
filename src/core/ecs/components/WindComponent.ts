import { Component } from '../Component';
import type { ComponentType } from '../types';

/**
 * Wind component — opt-in wind behavior for vegetation animation.
 *
 * Extracted from ModelObject.windSettings. Only entities with this component
 * are processed by WindSystem. Adding/removing this component toggles wind
 * on an entity without modifying any class.
 *
 * The WindSystem runs the spring physics simulation each frame,
 * updating displacement/velocity from the global WindManager forces.
 */
/** Wind debug visualization modes */
export type WindDebugMode = 'off' | 'wind-type' | 'height-factor' | 'displacement';

export class WindComponent extends Component {
  readonly type: ComponentType = 'wind';

  enabled: boolean = true;
  influence: number = 1.0;
  stiffness: number = 0.5;
  anchorHeight: number = 0;

  /** Debug visualization mode for viewport debugging */
  debugMode: WindDebugMode = 'off';

  /** Material indices that receive leaf flutter */
  leafMaterialIndices: Set<number> = new Set();

  /** Material indices that receive branch sway */
  branchMaterialIndices: Set<number> = new Set();

  /** Current spring displacement [x, z] — written by WindSystem */
  displacement: [number, number] = [0, 0];

  /** Current spring velocity [x, z] — written by WindSystem */
  velocity: [number, number] = [0, 0];

  serialize(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      influence: this.influence,
      stiffness: this.stiffness,
      anchorHeight: this.anchorHeight,
      leafMaterialIndices: [...this.leafMaterialIndices],
      branchMaterialIndices: [...this.branchMaterialIndices],
      debugMode: this.debugMode,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    if (data.influence !== undefined) this.influence = data.influence as number;
    if (data.stiffness !== undefined) this.stiffness = data.stiffness as number;
    if (data.anchorHeight !== undefined)
      this.anchorHeight = data.anchorHeight as number;
    if (data.leafMaterialIndices)
      this.leafMaterialIndices = new Set(data.leafMaterialIndices as number[]);
    if (data.branchMaterialIndices)
      this.branchMaterialIndices = new Set(
        data.branchMaterialIndices as number[],
      );
    if (data.debugMode !== undefined)
      this.debugMode = data.debugMode as WindDebugMode;
    // displacement and velocity are runtime state — not serialized
  }
}