/**
 * Animation State Machine Types — Data model for user-defined animation
 * states, transitions, sequences, and composable boolean conditions.
 *
 * These types define the configuration layer between the graph editor UI
 * and the ECS animation runtime. The graph evaluator compiles node data
 * into these structures; AnimationSystem reads them at runtime.
 */

// ============================================================================
// State Types
// ============================================================================

/** How a state evaluates its clips */
export type StateType = 'simple' | 'sequence' | 'blendTree';

// ============================================================================
// Animation State Definition
// ============================================================================

export interface AnimationStateDefinition {
  /** Unique state name (e.g., 'idle', 'walk', 'jump', 'attack') */
  name: string;

  /** How this state evaluates clips */
  type: StateType;

  // ==================== Simple State ====================
  // One clip, optionally looped.

  /** Clip asset path or clip name (for 'simple' type) */
  clip?: string;

  /** Whether the clip loops (for 'simple' type) — default true */
  loop?: boolean;

  /** Playback speed multiplier — default 1.0 */
  playbackSpeed?: number;

  // ==================== Sequence State ====================
  // Ordered chain of sub-clips (phases) that play in order.

  /** Ordered phases (for 'sequence' type) */
  phases?: AnimationPhase[];

  /** State to auto-transition to when the last phase completes */
  onSequenceComplete?: string;

  // ==================== Blend Tree State (future) ====================

  /** Parameter name to blend on (e.g., 'speed') */
  blendParameter?: string;

  /** Blend entries: each clip activates at a threshold */
  blendEntries?: { clip: string; threshold: number }[];
}

// ============================================================================
// Animation Phase (for Sequence States)
// ============================================================================

export interface AnimationPhase {
  /** Phase name (for display, e.g., 'start', 'mid', 'end') */
  name: string;

  /** Clip asset path or clip name */
  clip: string;

  /** Whether this phase's clip loops while held */
  loop: boolean;

  /** Playback speed — default 1.0 */
  playbackSpeed?: number;

  /**
   * Optional: modulate playback speed from a runtime variable.
   * e.g., speedFrom: 'horizontalSpeed', speedScale: 0.1
   * → actual speed = playbackSpeed + horizontalSpeed * speedScale
   */
  speedFrom?: string;
  speedScale?: number;

  /** Crossfade duration from previous phase (seconds) — default 0.1 */
  blendInDuration: number;

  /** Condition to advance to the next phase */
  advance: PhaseAdvanceCondition;
}

export type PhaseAdvanceCondition =
  | { type: 'clipFinished' }
  | { type: 'condition'; condition: TransitionCondition }
  | { type: 'clipFinishedOrCondition'; condition: TransitionCondition };

// ============================================================================
// Transition Rules
// ============================================================================

export interface TransitionRule {
  /** Source state name, or 'any' for wildcard */
  from: string;

  /** Target state name */
  to: string;

  /** Condition that must be true to trigger this transition */
  condition: TransitionCondition;

  /** Override blend duration for this specific transition (optional) */
  blendDuration?: number;

  /**
   * Priority (lower = higher priority). Used to resolve conflicts when
   * multiple transitions are valid in the same frame. — default 0
   */
  priority?: number;
}

// ============================================================================
// Transition Conditions — Composable boolean expressions
// ============================================================================

export type TransitionCondition =
  | ComparisonCondition
  | InputActionCondition
  | ClipFinishedCondition
  | LogicalCondition;

export interface ComparisonCondition {
  type: 'comparison';
  /** Runtime variable to read */
  variable: 'speed' | 'velY' | 'grounded' | 'horizontalSpeed' | string;
  /** Comparison operator */
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  /** Value to compare against */
  value: number | boolean;
}

export interface InputActionCondition {
  type: 'input';
  /** Action name from InputNode bindings (e.g., 'attack', 'dodge', 'jump') */
  action: string;
}

export interface ClipFinishedCondition {
  type: 'clipFinished';
}

export interface LogicalCondition {
  type: 'and' | 'or' | 'not';
  children: TransitionCondition[];
}

// ============================================================================
// Compiled Animation Config (stored on CharacterControllerComponent)
// ============================================================================

export interface CompiledAnimConfig {
  states: AnimationStateDefinition[];
  transitions: TransitionRule[];
  defaultBlendDuration: number;
}
