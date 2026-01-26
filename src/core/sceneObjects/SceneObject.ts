import { mat4, vec3, quat } from 'gl-matrix';
import type { SerializedSceneObject } from './types';
import { eulerToQuat, quatToEuler } from '../utils/mathUtils';

/**
 * Base class for all objects in the scene.
 * Provides common transform properties (position, rotation, scale)
 * and identity/grouping functionality.
 */
export abstract class SceneObject {
  private static nextId = 1;
  
  /** Unique identifier */
  public readonly id: string;
  
  /** Display name */
  public name: string;
  
  /** Position in world space */
  public position: vec3;
  
  /** Rotation quaternion (primary internal representation) */
  public rotationQuat: quat;
  
  /** Scale factor */
  public scale: vec3;
  
  /** Visibility flag */
  public visible: boolean;
  
  /** Group this object belongs to (if any) */
  public groupId: string | null;
  
  constructor(name: string = 'Object') {
    this.id = `object-${SceneObject.nextId++}`;
    this.name = name;
    this.position = vec3.fromValues(0, 0, 0);
    this.rotationQuat = quat.create(); // Identity quaternion
    this.scale = vec3.fromValues(1, 1, 1);
    this.visible = true;
    this.groupId = null;
  }
  
  /**
   * Compute the model matrix from position, rotation quaternion, and scale.
   */
  getModelMatrix(): mat4 {
    const modelMatrix = mat4.create();
    
    // Translate
    mat4.translate(modelMatrix, modelMatrix, this.position);
    
    // Rotate using quaternion
    const rotMat = mat4.create();
    mat4.fromQuat(rotMat, this.rotationQuat);
    mat4.multiply(modelMatrix, modelMatrix, rotMat);
    
    // Scale
    mat4.scale(modelMatrix, modelMatrix, this.scale);
    
    return modelMatrix;
  }
  
  /**
   * Get rotation as Euler angles (degrees) for display purposes.
   * Note: This is a lossy conversion - internal state uses quaternion.
   */
  get rotation(): vec3 {
    return quatToEuler(this.rotationQuat);
  }
  
  /**
   * Set rotation from Euler angles (degrees).
   * Converts to quaternion internally.
   */
  set rotation(euler: vec3 | [number, number, number]) {
    this.rotationQuat = eulerToQuat(euler as [number, number, number]);
  }
  
  /**
   * Set position from array or vec3
   */
  setPosition(pos: vec3 | [number, number, number]): void {
    vec3.copy(this.position, pos as vec3);
  }
  
  /**
   * Set rotation from Euler angles (degrees)
   */
  setRotation(rot: vec3 | [number, number, number]): void {
    this.rotationQuat = eulerToQuat(rot as [number, number, number]);
  }
  
  /**
   * Set rotation from quaternion directly
   */
  setRotationQuat(q: quat | [number, number, number, number]): void {
    quat.copy(this.rotationQuat, q as quat);
  }
  
  /**
   * Get rotation quaternion
   */
  getRotationQuat(): quat {
    return quat.clone(this.rotationQuat);
  }
  
  /**
   * Set scale from array or vec3
   */
  setScale(scl: vec3 | [number, number, number]): void {
    vec3.copy(this.scale, scl as vec3);
  }
  
  /**
   * Set uniform scale on all axes
   */
  setUniformScale(s: number): void {
    vec3.set(this.scale, s, s, s);
  }
  
  /**
   * Get forward direction vector (local -Z in world space)
   */
  getForward(): vec3 {
    const modelMatrix = this.getModelMatrix();
    const forward = vec3.fromValues(
      -modelMatrix[8],
      -modelMatrix[9],
      -modelMatrix[10]
    );
    vec3.normalize(forward, forward);
    return forward;
  }
  
  /**
   * Get up direction vector (local +Y in world space)
   */
  getUp(): vec3 {
    const modelMatrix = this.getModelMatrix();
    const up = vec3.fromValues(
      modelMatrix[4],
      modelMatrix[5],
      modelMatrix[6]
    );
    vec3.normalize(up, up);
    return up;
  }
  
  /**
   * Get right direction vector (local +X in world space)
   */
  getRight(): vec3 {
    const modelMatrix = this.getModelMatrix();
    const right = vec3.fromValues(
      modelMatrix[0],
      modelMatrix[1],
      modelMatrix[2]
    );
    vec3.normalize(right, right);
    return right;
  }
  
  /**
   * Translate the object by a delta
   */
  translate(delta: vec3 | [number, number, number]): void {
    vec3.add(this.position, this.position, delta as vec3);
  }
  
  /**
   * Rotate the object by a delta quaternion
   */
  rotateByQuat(deltaQuat: quat): void {
    quat.multiply(this.rotationQuat, deltaQuat, this.rotationQuat);
    quat.normalize(this.rotationQuat, this.rotationQuat);
  }
  
  /**
   * Rotate the object by Euler delta (in degrees)
   * @deprecated Use rotateByQuat for precision
   */
  rotate(delta: vec3 | [number, number, number]): void {
    const deltaQuat = eulerToQuat(delta as [number, number, number]);
    this.rotateByQuat(deltaQuat);
  }
  
  /**
   * Serialize the object to a plain object for JSON storage
   */
  serialize(): SerializedSceneObject {
    const euler = quatToEuler(this.rotationQuat);
    return {
      id: this.id,
      name: this.name,
      position: [this.position[0], this.position[1], this.position[2]],
      rotation: [euler[0], euler[1], euler[2]], // Backward compatibility
      rotationQuat: [this.rotationQuat[0], this.rotationQuat[1], this.rotationQuat[2], this.rotationQuat[3]],
      scale: [this.scale[0], this.scale[1], this.scale[2]],
      visible: this.visible,
      groupId: this.groupId,
    };
  }
  
  /**
   * Restore state from serialized data
   */
  deserialize(data: Partial<SerializedSceneObject>): void {
    if (data.name !== undefined) this.name = data.name;
    if (data.position) this.setPosition(data.position);
    // Prefer quaternion if available, otherwise fall back to Euler
    if (data.rotationQuat) {
      this.setRotationQuat(data.rotationQuat);
    } else if (data.rotation) {
      this.setRotation(data.rotation);
    }
    if (data.scale) this.setScale(data.scale);
    if (data.visible !== undefined) this.visible = data.visible;
    if (data.groupId !== undefined) this.groupId = data.groupId;
  }
  
  /**
   * Clone transform values from another object
   */
  copyTransformFrom(other: SceneObject): void {
    vec3.copy(this.position, other.position);
    quat.copy(this.rotationQuat, other.rotationQuat);
    vec3.copy(this.scale, other.scale);
  }
  
  /**
   * Reset transform to identity
   */
  resetTransform(): void {
    vec3.set(this.position, 0, 0, 0);
    quat.identity(this.rotationQuat);
    vec3.set(this.scale, 1, 1, 1);
  }
  
  // Euler/Quat conversions are now in mathUtils.ts and imported above
  
  /**
   * Abstract method for subclasses to implement cleanup
   */
  abstract destroy(): void;
  
  /**
   * Get the type identifier for this object (for serialization)
   */
  abstract get objectType(): string;
}
