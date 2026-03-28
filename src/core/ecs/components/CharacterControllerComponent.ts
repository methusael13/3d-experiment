/**
 * CharacterControllerComponent — Stores the node graph and compiled configuration.
 *
 * This is the central data component for the character controller graph system.
 * It holds:
 * 1. The raw node graph (for the editor UI to visualize/edit)
 * 2. Compiled/flattened configuration sections (for ECS systems to read at runtime)
 *
 * The graph evaluator (CharacterControllerGraphEvaluator) compiles the graph
 * into the flat config sections whenever the graph changes. Systems read the
 * compiled config — they never parse the graph directly.
 *
 * Serialized as part of the entity's component data for save/load.
 */

import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { InputBinding } from '../../input/types';
import type {
  AnimationStateDefinition,
  TransitionRule,
} from '../../animation/types';

// ============================================================================
// Serialized Node Graph Types (same format as React Flow)
// ============================================================================

export interface SerializedNodeGraph {
  nodes: SerializedGraphNode[];
  edges: SerializedGraphEdge[];
}

export interface SerializedGraphNode {
  id: string;
  type: string; // 'character' | 'input' | 'camera' | 'animStateMachine' | 'terrain' | 'script'
  position: { x: number; y: number };
  data: Record<string, any>;
}

export interface SerializedGraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

// ============================================================================
// Compiled Config Sections
// ============================================================================

export interface CompiledInputConfig {
  mode: 'fps' | 'tps';
  mouseSensitivity: number;
  bindings: InputBinding[];
  sprintMode: 'hold' | 'toggle';
}

export interface CompiledMovementConfig {
  moveSpeed: number;
  runSpeed: number;
  sprintMultiplier: number;
  jumpForce: number;
  rotationSpeed: number;
  gravity: number;
  groundFriction: number;
  airDrag: number;
  playerHeight: number;
  collisionRadius: number;
}

export interface CompiledCameraConfig {
  mode: 'fps' | 'tps-orbit';
  fov: number;
  near: number;
  far: number;
  lookAtOffset: [number, number, number];
  orbitDistance: number;
  orbitPitch: number;
  minPitch: number;
  maxPitch: number;
  minDistance: number;
  maxDistance: number;
  yawSensitivity: number;
  pitchSensitivity: number;
  zoomSensitivity: number;
  positionSmoothSpeed: number;
  rotationSmoothSpeed: number;
  collisionEnabled: boolean;
  collisionRadius: number;
  swayEnabled: boolean;
  swayAmplitude: number;
  swayFrequency: number;
  bobIntensity: number;
}

export interface CompiledAnimConfig {
  states: AnimationStateDefinition[];
  transitions: TransitionRule[];
  defaultBlendDuration: number;
}

// ============================================================================
// CharacterControllerComponent
// ============================================================================

export class CharacterControllerComponent extends Component {
  readonly type: ComponentType = 'character-controller';

  // ==================== Node Graph (for editor UI) ====================

  /** Serialized React Flow node graph — same format as material editor */
  nodeGraph: SerializedNodeGraph | null = null;

  // ==================== Compiled Configuration (for runtime) ====================
  // Produced by the graph evaluator when the graph changes.
  // Systems read these at runtime instead of parsing the graph.

  inputConfig: CompiledInputConfig | null = null;

  movementConfig: CompiledMovementConfig | null = null;

  cameraConfig: CompiledCameraConfig | null = null;

  animConfig: CompiledAnimConfig | null = null;

  terrainEntityId: string | null = null;

  scriptRefs: string[] = [];
}
