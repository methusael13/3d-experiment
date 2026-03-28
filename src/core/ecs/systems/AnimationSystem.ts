/**
 * AnimationSystem — CPU-side skeletal animation runtime.
 *
 * Evaluates animation clips, walks the bone hierarchy, computes bone matrices,
 * and drives animation state transitions.
 *
 * Supports two modes:
 * 1. **Legacy (hardcoded):** When no CharacterVarsComponent exists, uses the
 *    original velocity-threshold-based state machine (idle/walk/run/jump/fall).
 *    Fully backward compatible.
 *
 * 2. **Configurable:** When CharacterVarsComponent exists (added by the
 *    character controller graph), evaluates user-defined TransitionRule[]
 *    conditions against runtime variables. Supports sequence states with
 *    multi-phase clips and phase advance conditions.
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
import type { CharacterVarsComponent } from '../components/CharacterVarsComponent';
import type { GLBSkeleton, GLBAnimationClip, GLBAnimationChannel } from '../../../loaders/types';
import type {
  AnimationStateDefinition,
  TransitionRule,
  CompiledAnimConfig,
} from '../../animation/types';
import { evaluateCondition, readVariable } from '../../animation/TransitionEvaluator';
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
    const q0 = _tempQ0;
    const q1 = _tempQ1;
    q0[0] = values[offset0]; q0[1] = values[offset0 + 1]; q0[2] = values[offset0 + 2]; q0[3] = values[offset0 + 3];
    q1[0] = values[offset1]; q1[1] = values[offset1 + 1]; q1[2] = values[offset1 + 2]; q1[3] = values[offset1 + 3];
    const result = _tempQResult;
    quat.slerp(result, q0, q1, alpha);
    outVec[0] = result[0]; outVec[1] = result[1]; outVec[2] = result[2]; outVec[3] = result[3];
  } else {
    for (let i = 0; i < compCount; i++) {
      outVec[i] = values[offset0 + i] * (1 - alpha) + values[offset1 + i] * alpha;
    }
  }
}

// ============ Bone Matrix Computation ============

const _tempLocal = mat4.create();

/** Cache topological order per skeleton. */
const _topoOrderCache = new WeakMap<GLBSkeleton, number[]>();

function getTopologicalOrder(skeleton: GLBSkeleton): number[] {
  const cached = _topoOrderCache.get(skeleton);
  if (cached) return cached;

  const order: number[] = [];
  const visited = new Set<number>();

  function visit(idx: number): void {
    if (visited.has(idx)) return;
    const joint = skeleton.joints[idx];
    if (joint.parentIndex >= 0 && joint.parentIndex < skeleton.joints.length) {
      visit(joint.parentIndex);
    }
    visited.add(idx);
    order.push(idx);
  }

  for (let i = 0; i < skeleton.joints.length; i++) {
    visit(i);
  }

  _topoOrderCache.set(skeleton, order);
  return order;
}

function computeBoneMatrices(
  skeleton: GLBSkeleton,
  localT: Float32Array[],
  localR: Float32Array[],
  localS: Float32Array[],
  globalTransforms: Float32Array,
  boneMatrices: Float32Array,
): void {
  const order = getTopologicalOrder(skeleton);
  for (const i of order) {
    const joint = skeleton.joints[i];
    const offset = i * 16;

    mat4.fromRotationTranslationScale(
      _tempLocal,
      localR[i] as unknown as quat,
      localT[i] as unknown as vec3,
      localS[i] as unknown as vec3,
    );

    if (joint.parentIndex >= 0) {
      const parentOffset = joint.parentIndex * 16;
      const parentSlice = globalTransforms.subarray(parentOffset, parentOffset + 16);
      const destSlice = globalTransforms.subarray(offset, offset + 16);
      mat4.multiply(destSlice as unknown as mat4, parentSlice as unknown as mat4, _tempLocal);
    } else {
      const destSlice = globalTransforms.subarray(offset, offset + 16);
      mat4.multiply(destSlice as unknown as mat4, skeleton.armatureTransform as unknown as mat4, _tempLocal);
    }

    const invBind = skeleton.inverseBindMatrices.subarray(offset, offset + 16);
    const boneDest = boneMatrices.subarray(offset, offset + 16);
    mat4.multiply(
      boneDest as unknown as mat4,
      globalTransforms.subarray(offset, offset + 16) as unknown as mat4,
      invBind as unknown as mat4,
    );
  }
}

// ============ Reusable Temporaries ============

const _tempVec = new Float32Array(4);
const _tempQ0 = quat.create();
const _tempQ1 = quat.create();
const _tempQResult = quat.create();

interface JointPose {
  t: Float32Array;
  r: Float32Array;
  s: Float32Array;
}

// ============ AnimationSystem ============

export class AnimationSystem extends System {
  readonly name = 'animation';
  readonly requiredComponents: readonly ComponentType[] = ['skeleton', 'animation'];
  priority = 95;

  /**
   * Optional compiled animation config. This is set when a
   * CharacterControllerComponent with animConfig exists on the entity.
   * For now, the system reads it from entity lookup each frame.
   */
  private animConfigs: WeakMap<Entity, CompiledAnimConfig> = new WeakMap();

  /**
   * Set a compiled animation config for an entity.
   * Called by CharacterControllerGraphEvaluator when the graph changes.
   */
  setAnimConfig(entity: Entity, config: CompiledAnimConfig | null): void {
    if (config) {
      this.animConfigs.set(entity, config);
    } else {
      this.animConfigs.delete(entity);
    }
  }

  update(entities: Entity[], deltaTime: number, _context: SystemContext): void {
    for (const entity of entities) {
      const skel = entity.getComponent<SkeletonComponent>('skeleton');
      const anim = entity.getComponent<AnimationComponent>('animation');
      if (!skel?.skeleton || !skel.boneMatrices || !skel.globalTransforms || !anim || anim.paused) continue;

      // Check for configurable state machine mode
      // Read animConfig from CharacterControllerComponent (compiled by graph evaluator)
      // or from the legacy setAnimConfig() WeakMap (for programmatic use)
      const vars = entity.getComponent<CharacterVarsComponent>('character-vars');
      const ccComp = entity.getComponent<any>('character-controller');
      const animConfig = ccComp?.animConfig ?? this.animConfigs.get(entity) ?? null;

      if (vars && animConfig) {
        // Configurable mode: user-defined transitions + sequences
        this.updateConfigurable(entity, anim, skel, vars, animConfig, deltaTime);
      } else {
        // Legacy mode: hardcoded velocity-threshold state machine
        this.updateLegacy(entity, anim, skel, deltaTime);
      }
    }
  }

  // ==================== Legacy Mode ====================

  /**
   * Original behavior: auto-determine state from physics velocity, simple clip playback.
   */
  private updateLegacy(
    entity: Entity,
    anim: AnimationComponent,
    skel: SkeletonComponent,
    deltaTime: number,
  ): void {
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
    if (!currentClip) return;

    // Loop the animation
    if (anim.loop && currentClip.duration > 0) {
      anim.animationTime %= currentClip.duration;
    }

    const skeleton = skel.skeleton!;
    const jointCount = skeleton.joints.length;

    // 4. Evaluate current clip
    const currentPoses = this.evaluateClip(currentClip, skeleton, anim.animationTime);

    // 5. If blending, evaluate previous clip and interpolate
    if (anim.blendFactor < 1) {
      const prevClipKey = anim.stateToClip.get(anim.previousState as AnimationState) ?? anim.previousState;
      const prevClip = anim.clips.get(prevClipKey);
      if (prevClip) {
        let prevTime = anim.previousAnimationTime;
        if (anim.loop && prevClip.duration > 0) prevTime %= prevClip.duration;
        const prevPoses = this.evaluateClip(prevClip, skeleton, prevTime);
        this.blendPoses(currentPoses, prevPoses, anim.blendFactor, jointCount);
      }
    }

    // 6. Compute bone matrices
    this.finalizePoses(currentPoses, skel);
  }

  // ==================== Configurable Mode ====================

  /**
   * User-defined state machine with transition rules and sequence support.
   */
  private updateConfigurable(
    entity: Entity,
    anim: AnimationComponent,
    skel: SkeletonComponent,
    vars: CharacterVarsComponent,
    config: CompiledAnimConfig,
    deltaTime: number,
  ): void {
    const skeleton = skel.skeleton!;
    const jointCount = skeleton.joints.length;

    // 1. Update built-in variables from physics
    this.updateBuiltinVars(entity, vars, anim, deltaTime);

    // 2. Find the current state definition
    const stateDef = config.states.find(s => s.name === anim.currentState);

    // 3. Evaluate transitions (may change currentState)
    this.evaluateTransitions(anim, vars, config, stateDef);

    // 4. Evaluate current state clip(s) and advance time
    let currentPoses: JointPose[];

    if (stateDef?.type === 'sequence' && stateDef.phases && stateDef.phases.length > 0) {
      // Sequence state: multi-phase playback
      currentPoses = this.evaluateSequenceState(anim, skel, vars, stateDef, config, deltaTime);
    } else {
      // Simple state (or unknown): single clip playback
      currentPoses = this.evaluateSimpleState(anim, skel, stateDef, deltaTime);
    }

    // 5. Cross-fade blending with previous state
    if (anim.blendFactor < 1) {
      const prevClipKey = anim.stateToClip.get(anim.previousState as AnimationState) ?? anim.previousState;
      const prevClip = anim.clips.get(prevClipKey);
      if (prevClip) {
        let prevTime = anim.previousAnimationTime;
        if (prevClip.duration > 0) prevTime %= prevClip.duration;
        const prevPoses = this.evaluateClip(prevClip, skeleton, prevTime);
        this.blendPoses(currentPoses, prevPoses, anim.blendFactor, jointCount);
      }
      anim.blendTimer += deltaTime;
      anim.blendFactor = Math.min(1, anim.blendTimer / anim.blendDuration);
      anim.previousAnimationTime += deltaTime * anim.playbackSpeed;
    }

    // 6. Compute bone matrices
    this.finalizePoses(currentPoses, skel);
  }

  // ==================== Built-in Variables ====================

  /**
   * Write built-in runtime variables from physics state to CharacterVarsComponent.
   */
  private updateBuiltinVars(
    entity: Entity,
    vars: CharacterVarsComponent,
    anim: AnimationComponent,
    deltaTime: number,
  ): void {
    const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (physics) {
      const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
      vars.speed = hSpeed;
      vars.horizontalSpeed = hSpeed;
      vars.velY = physics.velocity[1];
      vars.grounded = physics.isGrounded;
      if (!physics.isGrounded) {
        vars.airTime += deltaTime;
      } else {
        vars.airTime = 0;
      }
    }
    vars.currentStateTime += deltaTime;
  }

  // ==================== Transition Evaluation ====================

  /**
   * Evaluate user-defined transition rules against runtime variables.
   * First matching rule (by priority) triggers a state change.
   */
  private evaluateTransitions(
    anim: AnimationComponent,
    vars: CharacterVarsComponent,
    config: CompiledAnimConfig,
    currentStateDef: AnimationStateDefinition | undefined,
  ): void {
    // Filter rules that apply to current state (or 'any')
    const applicableRules = config.transitions
      .filter(r => r.from === anim.currentState || r.from === 'any')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    // Check if current clip is finished (for clipFinished conditions)
    let clipFinished = false;
    if (currentStateDef?.type === 'simple') {
      const clipKey = currentStateDef.clip ?? anim.stateToClip.get(anim.currentState as AnimationState) ?? anim.currentState;
      const clip = anim.clips.get(clipKey);
      if (clip && !(currentStateDef.loop ?? true)) {
        clipFinished = anim.animationTime >= clip.duration;
      }
    } else if (currentStateDef?.type === 'sequence' && currentStateDef.phases) {
      // Sequence is "finished" when past the last phase
      clipFinished = anim.sequencePhaseIndex >= currentStateDef.phases.length;
    }

    for (const rule of applicableRules) {
      if (rule.to === anim.currentState) continue; // Skip self-transitions
      if (evaluateCondition(rule.condition, vars, clipFinished)) {
        this.triggerTransition(anim, rule.to as AnimationState, rule.blendDuration ?? config.defaultBlendDuration);
        break; // First matching rule wins
      }
    }
  }

  /**
   * Trigger a state transition with crossfade.
   */
  private triggerTransition(
    anim: AnimationComponent,
    targetState: AnimationState,
    blendDuration: number,
  ): void {
    anim.previousState = anim.currentState;
    anim.previousAnimationTime = anim.animationTime;
    anim.currentState = targetState;
    anim.animationTime = 0;
    anim.blendTimer = 0;
    anim.blendFactor = 0;
    anim.blendDuration = blendDuration;
    // Reset sequence tracking
    anim.sequencePhaseIndex = 0;
    anim.sequencePhaseTime = 0;
    anim.sequencePrevPhaseClip = null;
    anim.sequencePrevPhaseTime = 0;
  }

  // ==================== Simple State Evaluation ====================

  /**
   * Evaluate a simple (single-clip) state.
   */
  private evaluateSimpleState(
    anim: AnimationComponent,
    skel: SkeletonComponent,
    stateDef: AnimationStateDefinition | undefined,
    deltaTime: number,
  ): JointPose[] {
    const skeleton = skel.skeleton!;
    const speed = stateDef?.playbackSpeed ?? anim.playbackSpeed;
    const shouldLoop = stateDef?.loop ?? anim.loop;

    anim.animationTime += deltaTime * speed;

    // Resolve clip
    const clipKey = stateDef?.clip
      ?? anim.stateToClip.get(anim.currentState as AnimationState)
      ?? anim.currentState;
    const clip = anim.clips.get(clipKey);
    if (!clip) {
      return this.bindPoses(skeleton);
    }

    // Loop
    if (shouldLoop && clip.duration > 0) {
      anim.animationTime %= clip.duration;
    }

    return this.evaluateClip(clip, skeleton, anim.animationTime);
  }

  // ==================== Sequence State Evaluation ====================

  /**
   * Evaluate a sequence state — multi-phase clips with advance conditions.
   */
  private evaluateSequenceState(
    anim: AnimationComponent,
    skel: SkeletonComponent,
    vars: CharacterVarsComponent,
    stateDef: AnimationStateDefinition,
    config: CompiledAnimConfig,
    deltaTime: number,
  ): JointPose[] {
    const skeleton = skel.skeleton!;
    const phases = stateDef.phases!;

    // Check if all phases are complete
    if (anim.sequencePhaseIndex >= phases.length) {
      // All phases complete → auto-transition if configured
      if (stateDef.onSequenceComplete) {
        this.triggerTransition(
          anim,
          stateDef.onSequenceComplete as AnimationState,
          config.defaultBlendDuration,
        );
      }
      // Return bind pose as fallback (transition will take over next frame)
      return this.bindPoses(skeleton);
    }

    const phase = phases[anim.sequencePhaseIndex];

    // Advance phase time with speed modulation
    let phaseSpeed = phase.playbackSpeed ?? 1.0;
    if (phase.speedFrom) {
      const varVal = readVariable(phase.speedFrom, vars);
      phaseSpeed += (varVal as number) * (phase.speedScale ?? 0);
    }
    anim.sequencePhaseTime += deltaTime * phaseSpeed;

    // Resolve phase clip
    const phaseClip = anim.clips.get(phase.clip);
    if (!phaseClip) {
      return this.bindPoses(skeleton);
    }

    // Loop phase clip if configured
    let phaseTime = anim.sequencePhaseTime;
    if (phase.loop && phaseClip.duration > 0) {
      phaseTime %= phaseClip.duration;
    }

    // Check advance condition
    let shouldAdvance = false;
    const phaseClipFinished = !phase.loop && phaseClip.duration > 0 && anim.sequencePhaseTime >= phaseClip.duration;

    switch (phase.advance.type) {
      case 'clipFinished':
        shouldAdvance = phaseClipFinished;
        break;
      case 'condition':
        shouldAdvance = evaluateCondition(phase.advance.condition, vars, phaseClipFinished);
        break;
      case 'clipFinishedOrCondition':
        shouldAdvance = phaseClipFinished || evaluateCondition(phase.advance.condition, vars, phaseClipFinished);
        break;
    }

    if (shouldAdvance) {
      // Save current phase for blending
      anim.sequencePrevPhaseClip = phase.clip;
      anim.sequencePrevPhaseTime = phaseTime;

      // Advance to next phase
      anim.sequencePhaseIndex++;
      anim.sequencePhaseTime = 0;

      const nextPhase = phases[anim.sequencePhaseIndex];
      if (nextPhase) {
        // Start phase blend
        anim.blendTimer = 0;
        anim.blendFactor = 0;
        anim.blendDuration = nextPhase.blendInDuration;
      }
    }

    // Evaluate the current phase clip
    const currentPoses = this.evaluateClip(phaseClip, skeleton, phaseTime);

    // Blend with previous phase if transitioning between phases
    if (anim.sequencePrevPhaseClip && anim.blendFactor < 1) {
      const prevPhaseClip = anim.clips.get(anim.sequencePrevPhaseClip);
      if (prevPhaseClip) {
        const prevPoses = this.evaluateClip(prevPhaseClip, skeleton, anim.sequencePrevPhaseTime);
        this.blendPoses(currentPoses, prevPoses, anim.blendFactor, skeleton.joints.length);
      }
    }

    return currentPoses;
  }

  // ==================== Legacy State Machine ====================

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

  // ==================== Clip Evaluation ====================

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

  /**
   * Return bind-pose JointPoses for a skeleton (fallback when no clip found).
   */
  private bindPoses(skeleton: GLBSkeleton): JointPose[] {
    return skeleton.joints.map(j => ({
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
  }

  // ==================== Pose Blending ====================

  /**
   * Blend currentPoses toward prevPoses by blendFactor.
   * Modifies currentPoses in place.
   */
  private blendPoses(
    currentPoses: JointPose[],
    prevPoses: JointPose[],
    blendFactor: number,
    jointCount: number,
  ): void {
    const bf = blendFactor;
    for (let j = 0; j < jointCount; j++) {
      vec3.lerp(
        currentPoses[j].t as unknown as vec3,
        prevPoses[j].t as unknown as vec3,
        currentPoses[j].t as unknown as vec3,
        bf,
      );
      quat.slerp(
        currentPoses[j].r as unknown as quat,
        prevPoses[j].r as unknown as quat,
        currentPoses[j].r as unknown as quat,
        bf,
      );
      quat.normalize(
        currentPoses[j].r as unknown as quat,
        currentPoses[j].r as unknown as quat,
      );
      vec3.lerp(
        currentPoses[j].s as unknown as vec3,
        prevPoses[j].s as unknown as vec3,
        currentPoses[j].s as unknown as vec3,
        bf,
      );
    }
  }

  // ==================== Bone Matrix Finalization ====================

  /**
   * Compute bone matrices from poses and mark skeleton dirty.
   */
  private finalizePoses(poses: JointPose[], skel: SkeletonComponent): void {
    const localT = poses.map(p => p.t);
    const localR = poses.map(p => p.r);
    const localS = poses.map(p => p.s);
    computeBoneMatrices(skel.skeleton!, localT, localR, localS, skel.globalTransforms!, skel.boneMatrices!);
    skel.dirty = true;
  }
}
