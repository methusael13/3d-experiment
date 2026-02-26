import { mat4, vec3, quat } from 'gl-matrix';
import { Component } from '../Component';
import type { ComponentType } from '../types';
import { eulerToQuat, quatToEuler } from '../../utils/mathUtils';

/**
 * Transform component — position, rotation, scale, and cached model matrix.
 *
 * Mirrors the transform logic from SceneObject but as a pure data component.
 * The TransformSystem recomputes the modelMatrix when dirty.
 */
export class TransformComponent extends Component {
  readonly type: ComponentType = 'transform';

  position: vec3 = vec3.fromValues(0, 0, 0);
  rotationQuat: quat = quat.create();
  scale: vec3 = vec3.fromValues(1, 1, 1);
  originPivot: 'top' | 'center' | 'bottom' = 'center';

  /** Cached model matrix — recomputed by TransformSystem when dirty */
  modelMatrix: mat4 = mat4.create();

  /** Set to true when position/rotation/scale change; cleared by TransformSystem */
  dirty: boolean = true;

  /** Set by TransformSystem when matrix was recomputed this frame; cleared by MeshRenderSystem after GPU upload */
  _updatedThisFrame: boolean = false;

  // ==================== Euler convenience ====================

  /** Get rotation as Euler angles (degrees) for UI compatibility */
  get rotation(): vec3 {
    return quatToEuler(this.rotationQuat);
  }

  /** Set rotation from Euler angles (degrees) */
  set rotation(euler: vec3 | [number, number, number]) {
    this.rotationQuat = eulerToQuat(euler as [number, number, number]);
    this.dirty = true;
  }

  // ==================== Setters that mark dirty ====================

  setPosition(pos: vec3 | [number, number, number]): void {
    vec3.copy(this.position, pos as vec3);
    this.dirty = true;
  }

  setRotation(rot: vec3 | [number, number, number]): void {
    this.rotationQuat = eulerToQuat(rot as [number, number, number]);
    this.dirty = true;
  }

  setRotationQuat(q: quat | [number, number, number, number]): void {
    quat.copy(this.rotationQuat, q as quat);
    this.dirty = true;
  }

  setScale(scl: vec3 | [number, number, number]): void {
    vec3.copy(this.scale, scl as vec3);
    this.dirty = true;
  }

  setUniformScale(s: number): void {
    vec3.set(this.scale, s, s, s);
    this.dirty = true;
  }

  // ==================== Serialization ====================

  serialize(): Record<string, unknown> {
    const euler = quatToEuler(this.rotationQuat);
    return {
      position: [this.position[0], this.position[1], this.position[2]],
      rotation: [euler[0], euler[1], euler[2]],
      rotationQuat: [
        this.rotationQuat[0],
        this.rotationQuat[1],
        this.rotationQuat[2],
        this.rotationQuat[3],
      ],
      scale: [this.scale[0], this.scale[1], this.scale[2]],
      originPivot: this.originPivot,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.position) {
      const p = data.position as number[];
      vec3.set(this.position, p[0], p[1], p[2]);
    }
    if (data.rotationQuat) {
      const q = data.rotationQuat as number[];
      quat.set(this.rotationQuat, q[0], q[1], q[2], q[3]);
    } else if (data.rotation) {
      const r = data.rotation as number[];
      this.rotationQuat = eulerToQuat([r[0], r[1], r[2]]);
    }
    if (data.scale) {
      const s = data.scale as number[];
      vec3.set(this.scale, s[0], s[1], s[2]);
    }
    if (data.originPivot) {
      this.originPivot = data.originPivot as 'top' | 'center' | 'bottom';
    }
    this.dirty = true;
  }
}