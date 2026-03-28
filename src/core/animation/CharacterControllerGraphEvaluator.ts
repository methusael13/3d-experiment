/**
 * CharacterControllerGraphEvaluator — Compiles the visual node graph into
 * flat configuration on CharacterControllerComponent, and ensures the correct
 * ECS components exist on the entity.
 *
 * This runs at edit-time (not per-frame). When the user changes the graph
 * (adds a node, connects an edge, modifies a parameter), the evaluator:
 *
 * 1. Walks the connected graph from the Character Node outward
 * 2. Validates connections
 * 3. Compiles node data into the flat configuration sections
 * 4. Ensures the correct ECS components exist on the entity (adds/removes)
 * 5. Syncs compiled config → component field values
 */

import type { Entity } from '../ecs/Entity';
import {
  CharacterControllerComponent,
  type SerializedNodeGraph,
  type CompiledInputConfig,
  type CompiledMovementConfig,
  type CompiledCameraConfig,
  type CompiledAnimConfig,
} from '../ecs/components/CharacterControllerComponent';
import { PlayerComponent } from '../ecs/components/PlayerComponent';
import { CharacterPhysicsComponent } from '../ecs/components/CharacterPhysicsComponent';
import { CameraComponent } from '../ecs/components/CameraComponent';
import { CameraTargetComponent } from '../ecs/components/CameraTargetComponent';
import { CharacterVarsComponent } from '../ecs/components/CharacterVarsComponent';
import { ScriptComponent } from '../ecs/components/ScriptComponent';
import type { ScriptInstance } from '../scripting/types';
import type { AnimationComponent } from '../ecs/components/AnimationComponent';
import type { SkeletonComponent } from '../ecs/components/SkeletonComponent';
import type { AnimationSystem } from '../ecs/systems/AnimationSystem';
import { DEFAULT_BINDINGS, type InputBinding } from '../input/types';
import { loadAnimationClipsCached, isSkeletonCompatible } from './utils';
import { GLBSkeleton } from '@/loaders/types';

// ============================================================================
// Default values matching the plan
// ============================================================================

const DEFAULT_MOVEMENT: CompiledMovementConfig = {
  moveSpeed: 5.0,
  runSpeed: 10.0,
  sprintMultiplier: 2.0,
  jumpForce: 8.0,
  rotationSpeed: 720,
  gravity: -20.0,
  groundFriction: 10.0,
  airDrag: 0.5,
  playerHeight: 1.8,
  collisionRadius: 0.3,
};

const DEFAULT_CAMERA: CompiledCameraConfig = {
  mode: 'tps-orbit',
  fov: Math.PI / 3,
  near: 0.1,
  far: 1000,
  lookAtOffset: [0, 1.5, 0],
  orbitDistance: 5,
  orbitPitch: 20,
  minPitch: -10,
  maxPitch: 60,
  minDistance: 1.5,
  maxDistance: 15,
  yawSensitivity: 0.3,
  pitchSensitivity: 0.3,
  zoomSensitivity: 0.5,
  positionSmoothSpeed: 8.0,
  rotationSmoothSpeed: 12.0,
  collisionEnabled: true,
  collisionRadius: 0.2,
  swayEnabled: false,
  swayAmplitude: 0.02,
  swayFrequency: 2.0,
  bobIntensity: 0.03,
};

const DEFAULT_INPUT: CompiledInputConfig = {
  mode: 'tps',
  mouseSensitivity: 0.002,
  bindings: [...DEFAULT_BINDINGS],
  sprintMode: 'hold',
};

// ============================================================================
// Graph Evaluator
// ============================================================================

export class CharacterControllerGraphEvaluator {
  private animationSystem: AnimationSystem | null = null;

  /**
   * Set the AnimationSystem reference for syncing animation configs.
   */
  setAnimationSystem(animSystem: AnimationSystem): void {
    this.animationSystem = animSystem;
  }

  /**
   * Evaluate the graph and update the entity's components.
   * Called on every graph change (debounced 300ms in the UI).
   */
  evaluate(entity: Entity, graph: SerializedNodeGraph): void {
    const cc = entity.getComponent<CharacterControllerComponent>('character-controller');
    if (!cc) return;

    // Store the raw graph
    cc.nodeGraph = graph;

    // Find nodes by type
    const characterNode = graph.nodes.find(n => n.type === 'character');
    const inputNode = graph.nodes.find(n => n.type === 'input');
    const cameraNode = graph.nodes.find(n => n.type === 'camera');
    const animNode = graph.nodes.find(n => n.type === 'animStateMachine');
    const terrainNode = graph.nodes.find(n => n.type === 'terrain');
    const scriptNodes = graph.nodes.filter(n => n.type === 'script');

    // Check connections
    const inputConnected = !!inputNode && graph.edges.some(e =>
      e.source === inputNode.id && e.target === characterNode?.id,
    );
    const terrainConnected = !!terrainNode && graph.edges.some(e =>
      e.source === terrainNode.id && e.target === characterNode?.id,
    );
    const cameraConnected = !!cameraNode && graph.edges.some(e =>
      e.source === characterNode?.id && e.target === cameraNode.id,
    );
    const animConnected = !!animNode && graph.edges.some(e =>
      e.source === characterNode?.id && e.target === animNode.id,
    );
    const connectedScripts = scriptNodes.filter(sn =>
      graph.edges.some(e => e.source === characterNode?.id && e.target === sn.id),
    );

    // Compile input config
    if (inputNode && inputConnected) {
      const d = inputNode.data;
      cc.inputConfig = {
        mode: d.mode ?? DEFAULT_INPUT.mode,
        mouseSensitivity: d.mouseSensitivity ?? DEFAULT_INPUT.mouseSensitivity,
        bindings: d.bindings ?? DEFAULT_INPUT.bindings,
        sprintMode: d.sprintMode ?? DEFAULT_INPUT.sprintMode,
      };
    } else {
      cc.inputConfig = null;
    }

    // Compile movement config from Character Node
    if (characterNode) {
      const d = characterNode.data;
      cc.movementConfig = {
        moveSpeed: d.moveSpeed ?? DEFAULT_MOVEMENT.moveSpeed,
        runSpeed: d.runSpeed ?? DEFAULT_MOVEMENT.runSpeed,
        sprintMultiplier: d.sprintMultiplier ?? DEFAULT_MOVEMENT.sprintMultiplier,
        jumpForce: d.jumpForce ?? DEFAULT_MOVEMENT.jumpForce,
        rotationSpeed: d.rotationSpeed ?? DEFAULT_MOVEMENT.rotationSpeed,
        gravity: d.gravity ?? DEFAULT_MOVEMENT.gravity,
        groundFriction: d.groundFriction ?? DEFAULT_MOVEMENT.groundFriction,
        airDrag: d.airDrag ?? DEFAULT_MOVEMENT.airDrag,
        playerHeight: d.playerHeight ?? DEFAULT_MOVEMENT.playerHeight,
        collisionRadius: d.collisionRadius ?? DEFAULT_MOVEMENT.collisionRadius,
      };
      this.syncMovementToComponents(entity, cc.movementConfig);
    } else {
      cc.movementConfig = null;
    }

    // Compile camera config
    if (cameraNode && cameraConnected) {
      const d = cameraNode.data;
      cc.cameraConfig = {
        mode: d.mode ?? DEFAULT_CAMERA.mode,
        fov: d.fov ?? DEFAULT_CAMERA.fov,
        near: d.near ?? DEFAULT_CAMERA.near,
        far: d.far ?? DEFAULT_CAMERA.far,
        lookAtOffset: d.lookAtOffset ?? [...DEFAULT_CAMERA.lookAtOffset],
        orbitDistance: d.orbitDistance ?? DEFAULT_CAMERA.orbitDistance,
        orbitPitch: d.orbitPitch ?? DEFAULT_CAMERA.orbitPitch,
        minPitch: d.minPitch ?? DEFAULT_CAMERA.minPitch,
        maxPitch: d.maxPitch ?? DEFAULT_CAMERA.maxPitch,
        minDistance: d.minDistance ?? DEFAULT_CAMERA.minDistance,
        maxDistance: d.maxDistance ?? DEFAULT_CAMERA.maxDistance,
        yawSensitivity: d.yawSensitivity ?? DEFAULT_CAMERA.yawSensitivity,
        pitchSensitivity: d.pitchSensitivity ?? DEFAULT_CAMERA.pitchSensitivity,
        zoomSensitivity: d.zoomSensitivity ?? DEFAULT_CAMERA.zoomSensitivity,
        positionSmoothSpeed: d.positionSmoothSpeed ?? DEFAULT_CAMERA.positionSmoothSpeed,
        rotationSmoothSpeed: d.rotationSmoothSpeed ?? DEFAULT_CAMERA.rotationSmoothSpeed,
        collisionEnabled: d.collisionEnabled ?? DEFAULT_CAMERA.collisionEnabled,
        collisionRadius: d.collisionRadius ?? DEFAULT_CAMERA.collisionRadius,
        swayEnabled: d.swayEnabled ?? DEFAULT_CAMERA.swayEnabled,
        swayAmplitude: d.swayAmplitude ?? DEFAULT_CAMERA.swayAmplitude,
        swayFrequency: d.swayFrequency ?? DEFAULT_CAMERA.swayFrequency,
        bobIntensity: d.bobIntensity ?? DEFAULT_CAMERA.bobIntensity,
      };
      this.syncCameraToComponents(entity, cc.cameraConfig);
    } else {
      cc.cameraConfig = null;
    }

    // Compile animation config
    if (animNode && animConnected) {
      const d = animNode.data;
      cc.animConfig = {
        states: d.states ?? [],
        transitions: d.transitions ?? [],
        defaultBlendDuration: d.defaultBlendDuration ?? 0.2,
      };
      this.syncAnimationConfig(entity, cc.animConfig);
    } else {
      cc.animConfig = null;
      // Remove animConfig from AnimationSystem if it was set
      if (this.animationSystem) {
        this.animationSystem.setAnimConfig(entity, null);
      }
    }

    // Terrain reference
    cc.terrainEntityId = terrainConnected
      ? terrainNode?.data?.terrainEntityId ?? null
      : null;

    // Script references + ScriptComponent sync
    cc.scriptRefs = connectedScripts.map(sn => sn.data.scriptPath).filter(Boolean);
    this.syncScriptsToComponent(entity, connectedScripts);

    // Ensure CharacterVarsComponent exists (needed for configurable animation mode)
    if (cc.animConfig || connectedScripts.length > 0) {
      if (!entity.hasComponent('character-vars')) {
        entity.addComponent(new CharacterVarsComponent());
      }
    }
  }

  /**
   * Create a default graph for a new character controller.
   * Auto-creates Character Node + Input Node + Camera Node, connected.
   */
  createDefaultGraph(): SerializedNodeGraph {
    const characterId = 'character-1';
    const inputId = 'input-1';
    const cameraId = 'camera-1';

    return {
      nodes: [
        {
          id: characterId,
          type: 'character',
          position: { x: 300, y: 150 },
          data: { ...DEFAULT_MOVEMENT },
        },
        {
          id: inputId,
          type: 'input',
          position: { x: 0, y: 100 },
          data: {
            mode: 'tps',
            mouseSensitivity: 0.002,
            sprintMode: 'hold',
          },
        },
        {
          id: cameraId,
          type: 'camera',
          position: { x: 600, y: 50 },
          data: {
            ...DEFAULT_CAMERA,
          },
        },
      ],
      edges: [
        {
          id: `e-${inputId}-${characterId}`,
          source: inputId,
          sourceHandle: 'intent',
          target: characterId,
          targetHandle: 'input',
        },
        {
          id: `e-${characterId}-${cameraId}`,
          source: characterId,
          sourceHandle: 'characterState',
          target: cameraId,
          targetHandle: 'characterState',
        },
      ],
    };
  }

  // ==================== Component Sync ====================

  /**
   * Ensure PlayerComponent + CharacterPhysicsComponent exist and are configured.
   */
  private syncMovementToComponents(entity: Entity, config: CompiledMovementConfig): void {
    let player = entity.getComponent<PlayerComponent>('player');
    if (!player) {
      player = entity.addComponent(new PlayerComponent());
    }
    player.moveSpeed = config.moveSpeed;
    player.runSpeed = config.runSpeed;
    player.sprintMultiplier = config.sprintMultiplier;
    player.jumpForce = config.jumpForce;
    player.rotationSpeed = config.rotationSpeed;
    player.playerHeight = config.playerHeight;

    let physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (!physics) {
      physics = entity.addComponent(new CharacterPhysicsComponent());
    }
    physics.gravity = config.gravity;
    physics.groundFriction = config.groundFriction;
    physics.airDrag = config.airDrag;
    physics.height = config.playerHeight;
    physics.radius = config.collisionRadius;
  }

  /**
   * Ensure CameraComponent + CameraTargetComponent exist and are configured.
   */
  private syncCameraToComponents(entity: Entity, config: CompiledCameraConfig): void {
    let cam = entity.getComponent<CameraComponent>('camera');
    if (!cam) {
      cam = entity.addComponent(new CameraComponent());
    }
    cam.fov = config.fov;
    cam.near = config.near;
    cam.far = config.far;

    let ct = entity.getComponent<CameraTargetComponent>('camera-target');
    if (!ct) {
      ct = entity.addComponent(new CameraTargetComponent());
    }
    ct.mode = config.mode;
    ct.lookAtOffset = [...config.lookAtOffset];
    ct.orbitDistance = config.orbitDistance;
    ct.orbitPitch = config.orbitPitch;
    ct.minPitch = config.minPitch;
    ct.maxPitch = config.maxPitch;
    ct.minDistance = config.minDistance;
    ct.maxDistance = config.maxDistance;
    ct.yawSensitivity = config.yawSensitivity;
    ct.pitchSensitivity = config.pitchSensitivity;
    ct.zoomSensitivity = config.zoomSensitivity;
    ct.positionSmoothSpeed = config.positionSmoothSpeed;
    ct.rotationSmoothSpeed = config.rotationSmoothSpeed;
    ct.collisionEnabled = config.collisionEnabled;
    ct.collisionRadius = config.collisionRadius;
    ct.swayEnabled = config.swayEnabled;
    ct.swayAmplitude = config.swayAmplitude;
    ct.swayFrequency = config.swayFrequency;
    ct.bobIntensity = config.bobIntensity;
  }

  /**
   * Sync animation states + transitions to entity, and load referenced clips.
   *
   * Each state's `clip` field is an asset path (e.g., "animations/humanoid/idle-loop.glb").
   * We load the GLB, extract the first animation clip, and register it on
   * AnimationComponent.clips keyed by the asset path — so evaluateSimpleState
   * can find it via `stateDef.clip`.
   *
   * Also sets up `stateToClip` mapping: state name → clip asset path.
   */
  private syncAnimationConfig(entity: Entity, config: CompiledAnimConfig): void {
    if (this.animationSystem) {
      this.animationSystem.setAnimConfig(entity, config);
    }

    const anim = entity.getComponent<AnimationComponent>('animation');
    if (!anim) return;

    const skel = entity.getComponent<SkeletonComponent>('skeleton');

    // Collect all clip asset paths referenced by states
    for (const state of config.states) {
      if (!state.clip) continue;
      const clipPath = state.clip;

      // Map state name → clip asset path for the AnimationSystem lookup
      anim.stateToClip.set(state.name as any, clipPath);

      // If this clip path is already loaded, skip
      if (anim.clips.has(clipPath)) continue;

      // Async load the clip from the GLB file
      this.loadAndRegisterClip(entity, clipPath, skel?.skeleton ?? null);
    }

    // If the current state is 'idle' but there's no state definition for it
    // and there IS a state definition, switch to the first defined state
    if (config.states.length > 0) {
      const currentStateDef = config.states.find(s => s.name === anim.currentState);
      if (!currentStateDef) {
        anim.currentState = config.states[0].name as any;
      }
    }
  }

  /**
   * Load a clip from a GLB asset path and register it on the AnimationComponent.
   * Uses the shared clip cache to avoid redundant loads.
   */
  private async loadAndRegisterClip(
    entity: Entity,
    clipPath: string,
    entitySkeleton: GLBSkeleton | null,
  ): Promise<void> {
    try {
      // Construct URL — asset paths are relative to public/ root
      const url = clipPath.startsWith('/') ? clipPath : `/${clipPath}`;
      const result = await loadAnimationClipsCached(url);
      if (!result.clips.length) {
        console.warn(`[GraphEvaluator] No animation clips found in: ${clipPath}`);
        return;
      }

      // Optional: validate skeleton compatibility
      if (entitySkeleton && result.skeleton) {
        if (!isSkeletonCompatible(entitySkeleton, result.skeleton)) {
          console.warn(`[GraphEvaluator] Skeleton mismatch for clip: ${clipPath}`);
          // Still register — the clip may work with partial bone matching
        }
      }

      // Register the first clip keyed by asset path
      const anim = entity.getComponent<AnimationComponent>('animation');
      if (anim) {
        anim.clips.set(clipPath, result.clips[0]);
        console.log(`[GraphEvaluator] Loaded clip "${result.clips[0].name}" from ${clipPath}`);
      }
    } catch (err) {
      console.warn(`[GraphEvaluator] Failed to load clip: ${clipPath}`, err);
    }
  }

  /**
   * Ensure ScriptComponent exists and sync script instances from connected Script Nodes.
   * Each connected Script Node becomes a ScriptInstance on the entity.
   * Scripts with empty paths are skipped.
   */
  private syncScriptsToComponent(
    entity: Entity,
    connectedScriptNodes: { id: string; data: Record<string, any> }[],
  ): void {
    // Filter to script nodes that have a valid path
    const validScripts = connectedScriptNodes.filter(sn => {
      const path = sn.data?.scriptPath;
      return typeof path === 'string' && path.trim().length > 0;
    });

    if (validScripts.length === 0) {
      // No scripts — remove ScriptComponent if present
      if (entity.hasComponent('script')) {
        entity.removeComponent('script');
      }
      return;
    }

    // Ensure ScriptComponent exists
    let scriptComp = entity.getComponent<ScriptComponent>('script');
    if (!scriptComp) {
      scriptComp = entity.addComponent(new ScriptComponent());
    }

    // Build desired script instances from graph nodes
    // Sort by Y position (top-to-bottom) for deterministic execution order
    const sortedScripts = [...validScripts].sort((a, b) => {
      const ay = (a as any).position?.y ?? 0;
      const by = (b as any).position?.y ?? 0;
      return ay - by;
    });

    const desiredPaths = new Set<string>();

    for (const sn of sortedScripts) {
      const d = sn.data;
      const scriptPath = d.scriptPath.trim();
      desiredPaths.add(scriptPath);

      // Build params map from exposedParams array
      const params: Record<string, number | boolean | string> = {};
      if (Array.isArray(d.exposedParams)) {
        for (const p of d.exposedParams) {
          if (p.name) params[p.name] = p.value ?? p.default ?? 0;
        }
      }

      const instance: ScriptInstance = {
        path: scriptPath,
        params,
        playModeOnly: d.playModeOnly !== false, // Default true
        label: d.label || 'Script',
        _module: null,
        _initialized: false,
        _loadFailed: false,
      };

      scriptComp.addScript(instance);
    }

    // Remove scripts that are no longer in the graph
    scriptComp.scripts = scriptComp.scripts.filter(s => desiredPaths.has(s.path));
  }
}
