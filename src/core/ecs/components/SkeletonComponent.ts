import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GLBSkeleton } from '../../../loaders/types';

/**
 * Holds skeleton hierarchy, bind-pose data, and per-frame bone matrices.
 * 
 * The skeleton is parsed from a glTF skin node by the GLBLoader.
 * At runtime, AnimationSystem evaluates animation clips and writes
 * bone matrices here. MeshRenderSystem reads them and uploads to GPU.
 */
export class SkeletonComponent extends Component {
  readonly type: ComponentType = 'skeleton';

  /** Parsed skeleton hierarchy and bind-pose data (from GLBModel.skeleton) */
  skeleton: GLBSkeleton | null = null;

  /**
   * Current-frame bone matrices.
   * Length = joints.length × 16 (one mat4 per joint, column-major).
   *
   * Each matrix = globalJointTransform × inverseBindMatrix.
   * Written by AnimationSystem each frame.
   * Uploaded to GPU storage buffer by MeshRenderSystem when dirty.
   */
  boneMatrices: Float32Array | null = null;

  /**
   * Workspace for computing global joint transforms.
   * Same layout as boneMatrices (joints.length × 16).
   * Used internally by AnimationSystem — not uploaded to GPU.
   */
  globalTransforms: Float32Array | null = null;

  /** GPU storage buffer for bone matrices (created/managed by MeshRenderSystem) */
  boneBuffer: GPUBuffer | null = null;

  /** Whether bone matrices have been updated this frame and need GPU re-upload */
  dirty = true;

  /**
   * Initialize bone matrix arrays based on skeleton joint count.
   * Call this after setting `skeleton`.
   */
  initBuffers(): void {
    if (!this.skeleton) return;
    const count = this.skeleton.joints.length;
    this.boneMatrices = new Float32Array(count * 16);
    this.globalTransforms = new Float32Array(count * 16);

    // Initialize all to identity
    for (let i = 0; i < count; i++) {
      const offset = i * 16;
      this.boneMatrices[offset + 0] = 1;
      this.boneMatrices[offset + 5] = 1;
      this.boneMatrices[offset + 10] = 1;
      this.boneMatrices[offset + 15] = 1;
      this.globalTransforms[offset + 0] = 1;
      this.globalTransforms[offset + 5] = 1;
      this.globalTransforms[offset + 10] = 1;
      this.globalTransforms[offset + 15] = 1;
    }
  }

  destroy(): void {
    this.boneBuffer?.destroy();
    this.boneBuffer = null;
    this.boneMatrices = null;
    this.globalTransforms = null;
  }
}
