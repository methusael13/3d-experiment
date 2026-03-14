import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { GLBAnimationClip } from '../../../loaders/types';

/**
 * Animation state labels.
 * Extensible — add states as needed for different character types.
 */
export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land';

/**
 * Holds animation playback state, clip registry, and blending state.
 * 
 * Works alongside SkeletonComponent. AnimationSystem reads this component
 * to determine which clips to evaluate and how to blend between them.
 */
export class AnimationComponent extends Component {
  readonly type: ComponentType = 'animation';

  // ==================== State Machine ====================

  /** Current animation state (determines which clip plays) */
  currentState: AnimationState = 'idle';

  /** Previous state (for blending transitions) */
  previousState: AnimationState = 'idle';

  /** Playback time within the current clip (seconds) */
  animationTime = 0;

  /** Playback time within the previous clip (for blend source) */
  previousAnimationTime = 0;

  // ==================== Blending ====================

  /** 0 = fully previous clip, 1 = fully current clip */
  blendFactor = 1;

  /** Duration of crossfade transition in seconds */
  blendDuration = 0.2;

  /** Timer tracking blend progress */
  blendTimer = 0;

  // ==================== Clip Registry ====================

  /**
   * Map of clip name → animation clip data.
   * Populated from GLBModel.animations on entity creation.
   *
   * Example:
   *   clips.set('idle', idleClip);
   *   clips.set('walk', walkClip);
   *   clips.set('run', runClip);
   */
  clips: Map<string, GLBAnimationClip> = new Map();

  /**
   * Mapping from animation state to clip name.
   * Allows remapping when clip names don't match state names.
   * If no entry, uses the state name as the clip key.
   *
   * Example:
   *   stateToClip.set('idle', 'Idle');
   *   stateToClip.set('walk', 'Walking');
   */
  stateToClip: Map<AnimationState, string> = new Map();

  // ==================== Playback Control ====================

  /** Whether to loop the current clip */
  loop = true;

  /** Playback speed multiplier (1.0 = normal) */
  playbackSpeed = 1.0;

  /** Whether animation is paused */
  paused = false;

  /**
   * Whether the animation state is automatically driven by physics.
   * When true, AnimationSystem reads CharacterPhysicsComponent velocity/isGrounded
   * to determine the animation state.
   * When false, the state must be set externally (e.g., for cutscenes).
   */
  autoStateFromPhysics = true;

  // ==================== Speed Thresholds ====================
  // Used by AnimationSystem to map horizontal speed → animation state

  /** Speed below which character plays 'idle' */
  idleThreshold = 0.5;

  /** Speed above which character plays 'run' (between idle and run = 'walk') */
  runThreshold = 7.0;
}
