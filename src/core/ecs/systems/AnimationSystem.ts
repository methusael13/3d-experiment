/**
 * AnimationSystem — CPU-side skeletal animation runtime.
 *
 * Evaluates animation clips, walks the bone hierarchy, computes bone matrices,
 * and drives animation state transitions based on physics velocity.
 *
 * Priority 95: runs after all gameplay/physics (5-25) and after ShadowCasterSystem (90),
 * but before MeshRenderSystem (100) which uploads bone matrices to GPU.
 */

import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import type { SkeletonComponent } from '../components/SkeletonComponent';
import type { AnimationComponent, AnimationState } from '../components/AnimationComponent';
import type { CharacterPhysicsComponent } from '../components/CharacterPhysicsComponent';
import type { GLBSkeleton, GLBAnimationClip, GLBAnimationChannel } from '../../../loaders/types';
import { mat4, vec3, quat } from 'gl-matrix';

// ============ Keyframe Interpolation ============

/**
 * Sample a single animation channel at time t.
 * Returns interpolated value in outVec (vec3 for translation/scale, vec4 for rotation).
 */
function sampleChannel(
  channel: GLBAnimationChannel,
  time: number,
  outVec: Float32Array, // length 3 or 4
): void {
  const times = channel.times;
  const values = channel.values;
  const compCount = channel.path === 'rotation' ? 4 : 3;

  // Clamp time to clip range
  if (time <= times[0]) {
    for (let i = 0; i < compCount; i++) outVec[i] = values[i];
    return;
  }
  if (time >= times[times.length - 1]) {
    const lastOffset = (times.length - 1) * compCount;
    for (let i = 0; i < compCount; i++) outVec[i] = values[lastOffset + i];
    return;
  }

  // Binary search for keyframe pair
  let lo = 0, hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid; else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const alpha = (t1 - t0) > 0 ? (time - t0) / (t1 - t0) : 0;

  const offset0 = lo * compCount;
  const offset1 = hi * compCount;

  if (channel.interpolation === 'STEP') {
    for (let i = 0; i < compCount; i++) outVec[i] = values[offset0 + i];
    return;
  }

  // LINEAR interpolation
  if (channel.path === 'rotation') {
    // Spherical linear interpolation for quaternions
    // Use gl-matrix's quat.slerp
    const q0 = _tempQ0;
    const q1 = _tempQ1;
    q0[0] = values[offset0]; q0[1] = values[offset0 + 1]; q0[2] = values[offset0 + 2]; q0[3] = values[offset0 + 3];
    q1[0] = values[offset1]; q1[1] = values[offset1 + 1]; q1[2] = values[offset1 + 2]; q1[3] = values[offset1 + 3];
    const result = _tempQResult;
    quat.slerp(result, q0, q1, alpha);
    outVec[0] = result[0]; outVec[1] = result[1]; outVec[2] = result[2]; outVec[3] = result[3];
  } else {
    // Linear interpolation for translation/scale
    for (let i = 0; i < compCount; i++) {
      outVec[i] = values[offset0 + i] * (1 - alpha) + values[offset1 + i] * alpha;
    }
  }
}

// ============ Bone Matrix Computation ============

/** Reusable temp mat4 for local transform computation */
const _tempLocal = mat4.create();

/**
 * Compute final bone matrices from per-joint local TRS poses.
 *
 * For each joint:
 *   globalTransform[i] = parent.globalTransform × localTransformFromPose(i)
 *   boneMatrix[i] = globalTransform[i] × inverseBindMatrix[i]
 */
function computeBoneMatrices(
  skeleton: GLBSkeleton,
  localT: Float32Array[], // per-joint vec3
  localR: Float32Array[], // per-joint quat
  localS: Float32Array[], // per-joint vec3
  globalTransforms: Float32Array, // joints.length * 16
  boneMatrices: Float32Array,     // joints.length * 16
): void {
  for (const joint of skeleton.joints) {
    const i = joint.index;
    const offset = i * 16;

    // Build local transform from animated TRS
    mat4.fromRotationTranslationScale(
      _tempLocal,
      localR[i] as unknown as quat,
      localT[i] as unknown as vec3,
      localS[i] as unknown as vec3,
    );

    // Compose global transform: parent's global × local
    if (joint.parentIndex >= 0) {
      const parentOffset = joint.parentIndex * 16;
      // globalTransforms[i] = globalTransforms[parent] * localMatrix
      const parentSlice = globalTransforms.subarray(parentOffset, parentOffset + 16);
      const destSlice = globalTransforms.subarray(offset, offset + 16);
      mat4.multiply(
        destSlice as unknown as mat4,
        parentSlice as unknown as mat4,
        _tempLocal,
      );
    } else {
      // Root joint: global = local
      globalTransforms.set(_tempLocal, offset);
    }

    // Final bone matrix = globalTransform × inverseBindMatrix
    const invBind = skeleton.inverseBindMatrices.subarray(offset, offset + 16);
    const boneDest = boneMatrices.subarray(offset, offset + 16);
    mat4.multiply(
      boneDest as unknown as mat4,
      globalTransforms.subarray(offset, offset + 16) as unknown as mat4,
      invBind as unknown as mat4,
    );
  }
}

// ============ Reusable Temporaries (avoid per-frame allocations) ============

const _tempVec = new Float32Array(4); // for sampleChannel output
const _tempQ0 = quat.create();
const _tempQ1 = quat.create();
const _tempQResult = quat.create();

// ============ Per-joint local pose type ============

interface JointPose {
  t: Float32Array; // vec3
  r: Float32Array; // quat (vec4)
  s: Float32Array; // vec3
}

// ============ AnimationSystem ============

export class AnimationSystem extends System {
  readonly name = 'animation';
  readonly requiredComponents: readonly ComponentType[] = ['skeleton', 'animation'];
  priority = 95;

  update(entities: Entity[], deltaTime: number, _context: SystemContext): void {
    for (const entity of entities) {
      const skel = entity.getComponent<SkeletonComponent>('skeleton');
      const anim = entity.getComponent<AnimationComponent>('animation');
      if (!skel?.skeleton || !skel.boneMatrices || !skel.globalTransforms || !anim || anim.paused) continue;

      // 1. Auto-determine animation state from physics
      this.updateStateFromPhysics(entity, anim);

      // 2. Advance animation time
      anim.animationTime += deltaTime * anim.playbackSpeed;
      if (anim.blendTimer < anim.blendDuration) {
        anim.blendTimer += deltaTime;
        anim.blendFactor = Math.min(1, anim.blendTimer / anim.blendDuration);
        anim.previousAnimationTime += deltaTime * anim.playbackSpeed;
      }

      // 3. Resolve clip from state name
      const clipKey = anim.stateToClip.get(anim.currentState) ?? anim.currentState;
      const currentClip = anim.clips.get(clipKey);
      if (!currentClip) continue;

      // Loop the animation
      if (anim.loop && currentClip.duration > 0) {
        anim.animationTime %= currentClip.duration;
      }

      const skeleton = skel.skeleton;
      const jointCount = skeleton.joints.length;

      // 4. Evaluate current clip → per-joint local poses
      const currentPoses = this.evaluateClip(currentClip, skeleton, anim.animationTime);

      // 5. If blending, evaluate previous clip and interpolate
      if (anim.blendFactor < 1) {
        const prevClipKey = anim.stateToClip.get(anim.previousState as AnimationState) ?? anim.previousState;
        const prevClip = anim.clips.get(prevClipKey);
        if (prevClip) {
          let prevTime = anim.previousAnimationTime;
          if (anim.loop && prevClip.duration > 0) prevTime %= prevClip.duration;
          const prevPoses = this.evaluateClip(prevClip, skeleton, prevTime);

          // Blend: lerp translations/scales, slerp rotations
          const bf = anim.blendFactor;
          for (let j = 0; j < jointCount; j++) {
            // Lerp translation
            vec3.lerp(
              currentPoses[j].t as unknown as vec3,
              prevPoses[j].t as unknown as vec3,
              currentPoses[j].t as unknown as vec3,
              bf,
            );
            // Slerp rotation
            quat.slerp(
              currentPoses[j].r as unknown as quat,
              prevPoses[j].r as unknown as quat,
              currentPoses[j].r as unknown as quat,
              bf,
            );
            // Normalize quaternion to prevent drift
            quat.normalize(
              currentPoses[j].r as unknown as quat,
              currentPoses[j].r as unknown as quat,
            );
            // Lerp scale
            vec3.lerp(
              currentPoses[j].s as unknown as vec3,
              prevPoses[j].s as unknown as vec3,
              currentPoses[j].s as unknown as vec3,
              bf,
            );
          }
        }
      }

      // 6. Compute bone matrices (hierarchy walk + inverse bind)
      const localT = currentPoses.map(p => p.t);
      const localR = currentPoses.map(p => p.r);
      const localS = currentPoses.map(p => p.s);
      computeBoneMatrices(skeleton, localT, localR, localS, skel.globalTransforms, skel.boneMatrices);
      skel.dirty = true;
    }
  }

  /**
   * Auto-determine animation state from CharacterPhysicsComponent.
   * Maps horizontal speed to idle/walk/run, airborne to jump/fall.
   */
  private updateStateFromPhysics(entity: Entity, anim: AnimationComponent): void {
    if (!anim.autoStateFromPhysics) return;

    const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (!physics) return;

    const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);

    let targetState: AnimationState;
    if (!physics.isGrounded) {
      targetState = physics.velocity[1] > 0 ? 'jump' : 'fall';
    } else if (hSpeed > anim.runThreshold) {
      targetState = 'run';
    } else if (hSpeed > anim.idleThreshold) {
      targetState = 'walk';
    } else {
      targetState = 'idle';
    }

    // Trigger state transition if changed
    if (targetState !== anim.currentState) {
      anim.previousState = anim.currentState;
      anim.previousAnimationTime = anim.animationTime;
      anim.currentState = targetState;
      anim.animationTime = 0;
      anim.blendTimer = 0;
      anim.blendFactor = 0;
    }
  }

  /**
   * Evaluate all channels of a clip to produce per-joint local TRS poses.
   * Joints not animated by the clip use their bind-pose defaults.
   */
  private evaluateClip(
    clip: GLBAnimationClip,
    skeleton: GLBSkeleton,
    time: number,
  ): JointPose[] {
    // Start from bind pose
    const poses: JointPose[] = skeleton.joints.map(j => ({
      t: new Float32Array([
        j.localBindTransform.translation[0],
        j.localBindTransform.translation[1],
        j.localBindTransform.translation[2],
      ]),
      r: new Float32Array([
        j.localBindTransform.rotation[0],
        j.localBindTransform.rotation[1],
        j.localBindTransform.rotation[2],
        j.localBindTransform.rotation[3],
      ]),
      s: new Float32Array([
        j.localBindTransform.scale[0],
        j.localBindTransform.scale[1],
        j.localBindTransform.scale[2],
      ]),
    }));

    // Apply animated channels on top
    for (const ch of clip.channels) {
      if (ch.jointIndex < 0 || ch.jointIndex >= poses.length) continue;
      sampleChannel(ch, time, _tempVec);
      const pose = poses[ch.jointIndex];
      switch (ch.path) {
        case 'translation':
          pose.t[0] = _tempVec[0]; pose.t[1] = _tempVec[1]; pose.t[2] = _tempVec[2];
          break;
        case 'rotation':
          pose.r[0] = _tempVec[0]; pose.r[1] = _tempVec[1]; pose.r[2] = _tempVec[2]; pose.r[3] = _tempVec[3];
          break;
        case 'scale':
          pose.s[0] = _tempVec[0]; pose.s[1] = _tempVec[1]; pose.s[2] = _tempVec[2];
          break;
      }
    }

    return poses;
  }
}
