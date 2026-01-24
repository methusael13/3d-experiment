import { mat4, vec3 } from 'gl-matrix';
import type { SerializedSceneObject } from './types';

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
  
  /** Rotation in degrees (Euler XYZ) */
  public rotation: vec3;
  
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
    this.rotation = vec3.fromValues(0, 0, 0);
    this.scale = vec3.fromValues(1, 1, 1);
    this.visible = true;
    this.groupId = null;
  }
  
  /**
   * Compute the model matrix from position, rotation, and scale.
   * Rotation order is X -> Y -> Z (Euler angles in degrees).
   */
  getModelMatrix(): mat4 {
    const modelMatrix = mat4.create();
    
    // Translate
    mat4.translate(modelMatrix, modelMatrix, this.position);
    
    // Rotate (convert degrees to radians)
    const degToRad = Math.PI / 180;
    mat4.rotateX(modelMatrix, modelMatrix, this.rotation[0] * degToRad);
    mat4.rotateY(modelMatrix, modelMatrix, this.rotation[1] * degToRad);
    mat4.rotateZ(modelMatrix, modelMatrix, this.rotation[2] * degToRad);
    
    // Scale
    mat4.scale(modelMatrix, modelMatrix, this.scale);
    
    return modelMatrix;
  }
  
  /**
   * Set position from array or vec3
   */
  setPosition(pos: vec3 | [number, number, number]): void {
    vec3.copy(this.position, pos as vec3);
  }
  
  /**
   * Set rotation from array or vec3 (in degrees)
   */
  setRotation(rot: vec3 | [number, number, number]): void {
    vec3.copy(this.rotation, rot as vec3);
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
   * Rotate the object by a delta (in degrees)
   */
  rotate(delta: vec3 | [number, number, number]): void {
    vec3.add(this.rotation, this.rotation, delta as vec3);
  }
  
  /**
   * Serialize the object to a plain object for JSON storage
   */
  serialize(): SerializedSceneObject {
    return {
      id: this.id,
      name: this.name,
      position: [this.position[0], this.position[1], this.position[2]],
      rotation: [this.rotation[0], this.rotation[1], this.rotation[2]],
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
    if (data.rotation) this.setRotation(data.rotation);
    if (data.scale) this.setScale(data.scale);
    if (data.visible !== undefined) this.visible = data.visible;
    if (data.groupId !== undefined) this.groupId = data.groupId;
  }
  
  /**
   * Clone transform values from another object
   */
  copyTransformFrom(other: SceneObject): void {
    vec3.copy(this.position, other.position);
    vec3.copy(this.rotation, other.rotation);
    vec3.copy(this.scale, other.scale);
  }
  
  /**
   * Reset transform to identity
   */
  resetTransform(): void {
    vec3.set(this.position, 0, 0, 0);
    vec3.set(this.rotation, 0, 0, 0);
    vec3.set(this.scale, 1, 1, 1);
  }
  
  /**
   * Abstract method for subclasses to implement cleanup
   */
  abstract destroy(): void;
  
  /**
   * Get the type identifier for this object (for serialization)
   */
  abstract get objectType(): string;
}
