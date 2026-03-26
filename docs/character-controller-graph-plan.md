# Character Controller Node Graph — Full Plan

> **Prerequisites:** Skeletal animation pipeline (see `docs/skeletal-animation-plan.md`) must
> be complete. GLB loading with skeleton/animation parsing, SkeletonComponent,
> AnimationComponent, AnimationSystem (clip evaluation, bone matrix computation,
> physics-driven state machine, crossfade blending), and GPU skinning are all implemented.
>
> **Depends on:** Player system (see `docs/player-system-plan.md`) — PlayerComponent,
> CharacterPhysicsComponent, CameraComponent, PlayerSystem, CharacterMovementSystem,
> TerrainCollisionSystem, and CameraSystem are all implemented.

---

## Overview

This plan adds a **visual node-graph workflow** for configuring playable third-person
characters entirely from the engine UI. The graph wires together input handling, character
physics, animation state machines, terrain interaction, and camera behavior — producing a
fully playable TPS character without writing code.

The graph is a **configuration tool**, not a visual scripting runtime. Nodes define which
ECS components exist on an entity and how they're parameterized. At runtime, the existing
ECS systems read these configured components — same execution model as today, with richer
configuration authored visually.

### What This Enables (End-to-End Workflow)

1. Import a skinned character GLB into the scene
2. Attach a `PlayerComponent` to the entity (via Object Panel → Add Component)
3. Click "Edit Controller" → opens the Character Controller Graph in a dockable window
4. The graph auto-creates a Character Node for the entity
5. Add an Input Node (TPS mode), connect to Character
6. Add a Camera Node (TPS orbit), connect to Character State output
7. Add a Terrain Node (picks up existing terrain), connect to Character
8. Add an Animation State Machine Node, define states (idle/walk/run/jump), assign clips
   from asset library via AssetPickerModal, define transition rules
9. Press Play — character walks on terrain with physics, TPS camera follows, animations
   blend seamlessly between states based on movement

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Input Node  │────▶│  Character Node   │────▶│ Animation State    │
│              │     │                   │     │ Machine Node       │
│ Mode: TPS    │     │ Speed: 5/10      │     │                    │
│ WASD + Space │     │ Jump: 8          │     │ idle → idle.glb    │
│ Sens: 0.002  │     │ Gravity: -20     │     │ walk → walk.glb    │
└──────────────┘     │ Height: 1.8      │     │ run  → run.glb     │
                     │                   │     │ jump → (sequence)  │
┌──────────────┐     │                   │     │                    │
│ Terrain Node │────▶│                   │     │ Blend: 0.2s        │
│              │     │                   │     │ Custom transitions  │
│ "Terrain"    │     └────────┬──────────┘     └────────────────────┘
│ 2048×2048    │              │
└──────────────┘              │ Character State
                              ▼
                     ┌──────────────────┐
                     │   Camera Node    │
                     │                  │
                     │ Mode: TPS Orbit  │
                     │ Distance: 5      │
                     │ Pitch: 20°       │
                     │ Smooth: 8.0      │
                     │ Collision: ✓     │
                     │ Sway: subtle     │
                     └──────────────────┘
```

---

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────────┐
│                    EDITOR UI LAYER                           │
│                                                              │
│  Dockable Window: Character Controller Graph                 │
│  (React Flow node editor — same library as Material Editor)  │
│                                                              │
│  Opened via: Object Panel → "Edit Controller" button         │
│  Or: double-click entity with PlayerComponent                │
│                                                              │
│  Source of truth: CharacterControllerComponent on entity      │
│  Debounced save on every user edit                           │
│                                                              │
│  Node types: Input, Character, Camera, AnimStateMachine,     │
│              Terrain, Script (future)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ Graph evaluator (on graph change)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    CONFIGURATION LAYER                        │
│                                                              │
│  CharacterControllerComponent (ECS component on entity)      │
│    - Serialized node graph (nodes + edges)                   │
│    - Compiled configuration cache:                           │
│      • inputConfig: { mode, bindings, sensitivity }          │
│      • movementConfig: { speeds, jump, gravity, friction }   │
│      • cameraConfig: { mode, orbit params, sway, collision } │
│      • animConfig: { states[], transitions[], clips }        │
│      • terrainRef: entity ID or null                         │
│      • scriptRefs: asset paths                               │
│                                                              │
│  Graph Evaluator: walks graph → produces compiled config     │
│  Also ensures correct ECS components exist on entity         │
└──────────────────────────┬──────────────────────────────────┘
                           │ Compiled config read by systems
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    ECS RUNTIME LAYER                          │
│                                                              │
│  PlayerSystem (pri 5)             — reads inputConfig        │
│  CharacterMovementSystem (pri 20) — reads movementConfig     │
│  TerrainCollisionSystem (pri 25)  — reads terrainRef         │
│  CameraSystem (pri 30)            — reads cameraConfig       │
│  AnimationSystem (pri 95)         — reads animConfig         │
│  ScriptSystem (pri 96)            — executes user scripts    │
│                                                              │
│  Systems adapt behavior based on compiled config             │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** The `CharacterControllerComponent` holds both the raw graph (for the
editor UI to visualize) AND a compiled/flattened configuration (for ECS systems to read
efficiently at runtime without parsing the graph every frame).

---

## Part 1: Node Types

### 1.1 Character Node (Central, Required)

The anchor node representing the entity. Always present in the graph — auto-created
when the graph is first opened. Has input ports for data streams and output ports
for character state.

**Input Ports:**
| Port | Data Type | Source |
|------|-----------|--------|
| `input` | `InputIntent` | Input Node |
| `terrain` | `TerrainData` | Terrain Node |

**Output Ports:**
| Port | Data Type | Consumer |
|------|-----------|----------|
| `characterState` | `CharacterState` | Camera Node, Animation State Machine Node |

**Configurable Properties:**
```typescript
interface CharacterNodeData {
  // Movement
  moveSpeed: number;        // Walk speed (units/s) — default 5.0
  runSpeed: number;         // Sprint speed (units/s) — default 10.0
  sprintMultiplier: number; // Sprint multiplier — default 2.0
  jumpForce: number;        // Upward impulse — default 8.0
  rotationSpeed: number;    // Character turn speed (deg/s) — default 720

  // Physics
  gravity: number;          // Downward acceleration — default -20.0
  groundFriction: number;   // Deceleration when grounded — default 10.0
  airDrag: number;          // Deceleration when airborne — default 0.5

  // Collision shape
  playerHeight: number;     // Feet to head — default 1.8
  collisionRadius: number;  // Horizontal radius — default 0.3
}
```

**Maps to:** `PlayerComponent` (speeds, jump force, rotation speed) + `CharacterPhysicsComponent`
(gravity, friction, drag, collision shape).

### 1.2 Input Node

Defines input mapping and mode. Outputs structured input intent.

**Output Ports:**
| Port | Data Type | Consumer |
|------|-----------|----------|
| `intent` | `InputIntent` | Character Node |

**Configurable Properties:**
```typescript
interface InputNodeData {
  // Input mode
  mode: 'fps' | 'tps';     // FPS: mouse-look yaw/pitch; TPS: camera-relative WASD

  // Mouse
  mouseSensitivity: number; // Radians per pixel — default 0.002

  // Key bindings (editable list)
  bindings: InputBinding[];

  // Sprint mode
  sprintMode: 'hold' | 'toggle'; // Hold Shift vs toggle
}

interface InputBinding {
  action: string;     // 'forward', 'backward', 'left', 'right', 'sprint', 'jump', 'attack', etc.
  key: string;        // 'KeyW', 'ShiftLeft', 'Space', 'Mouse0', etc.
  type: 'held' | 'pressed'; // Continuous vs one-shot
}
```

**Default bindings:**
```
forward:  KeyW (held)
backward: KeyS (held)
left:     KeyA (held)
right:    KeyD (held)
sprint:   ShiftLeft (held)
jump:     Space (pressed)
```

Users can add custom action bindings (e.g., `attack: Mouse0`, `dodge: KeyQ`) that the
Animation State Machine transition rules can reference.

**Maps to:** `PlayerComponent` configuration + `PlayerSystem` behavior mode. In TPS mode,
`PlayerSystem` writes mouse movement to `CameraTargetComponent.orbitYaw/orbitPitch` instead
of `PlayerComponent.yaw/pitch`, and `CharacterMovementSystem` computes movement relative
to the camera orbit yaw.

### 1.3 Camera Node

Defines camera behavior — FPS or TPS orbit.

**Input Ports:**
| Port | Data Type | Source |
|------|-----------|--------|
| `characterState` | `CharacterState` | Character Node |

**Output Ports:** (none — camera is a terminal node that writes to the engine view camera)

**Configurable Properties:**
```typescript
interface CameraNodeData {
  // Camera mode
  mode: 'fps' | 'tps-orbit';

  // Projection
  fov: number;              // Field of view (radians) — default π/3
  near: number;             // Near plane — default 0.1
  far: number;              // Far plane — default 1000

  // TPS Orbit parameters (only used when mode === 'tps-orbit')
  lookAtOffset: [number, number, number]; // Offset from entity origin — default [0, 1.5, 0]
  orbitDistance: number;     // Distance from look-at point — default 5
  orbitPitch: number;        // Initial vertical angle (degrees) — default 20
  minPitch: number;          // Min vertical angle — default -10
  maxPitch: number;          // Max vertical angle — default 60
  minDistance: number;       // Min zoom distance — default 1.5
  maxDistance: number;       // Max zoom distance — default 15
  yawSensitivity: number;   // Degrees per pixel — default 0.3
  pitchSensitivity: number; // Degrees per pixel — default 0.3
  zoomSensitivity: number;  // Distance per scroll tick — default 0.5

  // Smoothing
  positionSmoothSpeed: number;  // Camera position lerp factor — default 8.0
  rotationSmoothSpeed: number;  // Camera rotation lerp factor — default 12.0

  // Collision
  collisionEnabled: boolean;    // Prevent camera inside terrain — default true
  collisionRadius: number;      // Camera collision sphere — default 0.2

  // Camera sway (velocity-driven)
  swayEnabled: boolean;         // Enable head bob / sway — default false
  swayAmplitude: number;        // Sway displacement — default 0.02
  swayFrequency: number;        // Cycles per second — default 2.0
  bobIntensity: number;         // Vertical bob amount — default 0.03
}
```

**Maps to:** `CameraComponent` (FOV, near, far) + new `CameraTargetComponent` (orbit
parameters, smoothing, collision, sway). `CameraSystem` reads
`CameraTargetComponent.mode` to choose FPS vs TPS rendering.

### 1.4 Animation State Machine Node

The most complex node — defines states, clips, transitions, and sequences.

**Input Ports:**
| Port | Data Type | Source |
|------|-----------|--------|
| `characterState` | `CharacterState` | Character Node |

**Output Ports:** (none — terminal node that configures AnimationComponent)

**Configurable Properties:**
```typescript
interface AnimStateMachineNodeData {
  // Global settings
  defaultBlendDuration: number; // Default crossfade — default 0.2s

  // State definitions
  states: AnimationStateDefinition[];

  // Transition rules
  transitions: TransitionRule[];
}
```

**Maps to:** `AnimationComponent` (clips map, stateToClip map, thresholds, blend settings)
and the extended transition evaluation system.

See **Part 2** for the full animation state machine data model.

### 1.5 Terrain Node (Optional)

References a terrain entity in the scene. Provides height data and world bounds.

**Output Ports:**
| Port | Data Type | Consumer |
|------|-----------|----------|
| `terrain` | `TerrainData` | Character Node |

**Configurable Properties:**
```typescript
interface TerrainNodeData {
  // Which terrain entity to reference (auto-detected if only one exists)
  terrainEntityId: string | null;

  // Read-only display info
  terrainSize: string;       // e.g., "2048×2048"
  heightmapResolution: string;
}
```

When connected, `TerrainCollisionSystem` samples height at the character's XZ position.
When disconnected, the character uses a flat ground plane at Y=0.

**Maps to:** Configuration for `TerrainCollisionSystem` — which terrain entity to query.

### 1.6 Script Node

The escape hatch for custom per-frame behavior that the predefined nodes can't express.
Script Nodes reference a TypeScript module that the engine hot-loads and executes each
frame during Play Mode. Multiple Script Nodes can be attached to a single graph, each
running independently.

**Input Ports:**
| Port | Data Type | Source |
|------|-----------|--------|
| `characterState` | `CharacterState` | Character Node |

**Output Ports:** (none — scripts modify components directly via the ECS API)

**Configurable Properties:**
```typescript
interface ScriptNodeData {
  /** Path to a .ts script file in the project (relative to public/scripts/) */
  scriptPath: string;

  /** User-editable parameters exposed by the script. The node UI renders
   *  a control for each entry (number → slider, boolean → checkbox, string → text).
   *  Values are passed to the script's update() function as `params`. */
  exposedParams: ScriptParam[];

  /** Human-readable label for the node */
  label: string;

  /** Whether this script runs in Play Mode only (default true)
   *  or also in Editor Mode (e.g., for visualization helpers) */
  playModeOnly: boolean;
}

interface ScriptParam {
  name: string;
  type: 'number' | 'boolean' | 'string';
  value: number | boolean | string;
  /** For numbers: min/max/step for the slider UI */
  min?: number;
  max?: number;
  step?: number;
}
```

**Node UI:**
```
┌─ Script: "Camera Sway" ──────────────────────┐
│                                                │
│  Script: [scripts/camera-sway.ts    📂]       │
│                                                │
│  Parameters:                                   │
│    swayScale:   [0.05  ] ───────●──── 0-1     │
│    bobScale:    [0.03  ] ────●─────── 0-1     │
│    damping:     [0.8   ] ─────────●── 0-1     │
│    enabled:     [✓]                            │
│                                                │
│  Play Mode Only: [✓]                           │
│                                                │
│  ○ Character State (in)                        │
└────────────────────────────────────────────────┘
```

#### Script Module API

Each script file exports a standard interface. The engine calls `setup()` once when
Play Mode starts and `update()` every frame:

```typescript
// public/scripts/camera-sway.ts

import type { ScriptContext } from '@/core/scripting/types';

/**
 * Called once when Play Mode starts (or when the script is hot-reloaded).
 * Use for initialization — caching component references, allocating state.
 */
export function setup(ctx: ScriptContext): void {
  // Optional. Most scripts don't need this.
}

/**
 * Called every frame during Play Mode.
 * Read/modify components on the entity or any entity in the world.
 */
export function update(ctx: ScriptContext): void {
  const cam = ctx.entity.getComponent('camera-target');
  const physics = ctx.entity.getComponent('character-physics');
  if (!cam || !physics) return;

  const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
  const t = ctx.time; // total elapsed time (seconds)

  // Modulate camera sway based on movement speed
  const swayScale = ctx.params.swayScale as number;
  const bobScale = ctx.params.bobScale as number;
  const damping = ctx.params.damping as number;

  cam.swayAmplitude = hSpeed * swayScale * damping;
  cam.bobIntensity = hSpeed * bobScale * damping;
  cam.swayFrequency = 1.5 + hSpeed * 0.1; // Faster sway at higher speeds
}

/**
 * Called when Play Mode exits or the script is about to be hot-reloaded.
 * Clean up any subscriptions, timers, or allocated resources.
 */
export function teardown(ctx: ScriptContext): void {
  // Optional. Reset any modified component values if needed.
}
```

#### ScriptContext Interface

```typescript
// src/core/scripting/types.ts

export interface ScriptContext {
  /** The entity this script is attached to */
  entity: Entity;

  /** Frame delta time in seconds */
  deltaTime: number;

  /** Total elapsed time since Play Mode started (seconds) */
  time: number;

  /** The ECS world — for querying other entities */
  world: World;

  /** User-configured parameters from the Script Node UI */
  params: Record<string, number | boolean | string>;

  /** Character runtime variables (read/write). Same object as CharacterVarsComponent. */
  vars: CharacterVarsComponent;

  /** Input state — check if actions are pressed/held */
  input: {
    isActionHeld(action: string): boolean;
    isActionPressed(action: string): boolean; // True for one frame
  };
}
```

#### ScriptComponent (ECS)

```typescript
class ScriptComponent extends Component {
  readonly type: ComponentType = 'script';

  /** Loaded script modules (multiple scripts can be attached) */
  scripts: ScriptInstance[] = [];
}

interface ScriptInstance {
  /** Asset path to the script file */
  path: string;

  /** User-configured parameter values */
  params: Record<string, number | boolean | string>;

  /** Whether to run only in Play Mode */
  playModeOnly: boolean;

  /** Loaded module reference (set by ScriptSystem at runtime) */
  _module: ScriptModule | null;

  /** Whether setup() has been called */
  _initialized: boolean;
}

interface ScriptModule {
  setup?: (ctx: ScriptContext) => void;
  update: (ctx: ScriptContext) => void;
  teardown?: (ctx: ScriptContext) => void;
}
```

#### ScriptSystem (ECS)

```typescript
class ScriptSystem extends System {
  readonly name = 'script';
  readonly requiredComponents: readonly ComponentType[] = ['script'];
  priority = 96; // After AnimationSystem (95), before MeshRenderSystem (100)

  private isPlayMode = false;
  private elapsedTime = 0;

  update(entities: Entity[], deltaTime: number, context: SystemContext): void {
    this.elapsedTime += deltaTime;

    for (const entity of entities) {
      const scriptComp = entity.getComponent<ScriptComponent>('script');
      if (!scriptComp) continue;

      const vars = entity.getComponent<CharacterVarsComponent>('character-vars');

      for (const instance of scriptComp.scripts) {
        // Skip play-mode-only scripts when not playing
        if (instance.playModeOnly && !this.isPlayMode) continue;

        // Lazy-load the module
        if (!instance._module) {
          instance._module = this.loadScriptModule(instance.path);
          instance._initialized = false;
        }
        if (!instance._module) continue;

        // Build context
        const ctx: ScriptContext = {
          entity,
          deltaTime,
          time: this.elapsedTime,
          world: context.world,
          params: instance.params,
          vars: vars ?? new CharacterVarsComponent(), // fallback empty
          input: this.buildInputAccessor(entity),
        };

        // Call setup() once
        if (!instance._initialized) {
          instance._module.setup?.(ctx);
          instance._initialized = true;
        }

        // Call update() every frame
        try {
          instance._module.update(ctx);
        } catch (err) {
          console.error(`[ScriptSystem] Error in ${instance.path}:`, err);
        }
      }
    }
  }

  enterPlayMode(): void {
    this.isPlayMode = true;
    this.elapsedTime = 0;
  }

  exitPlayMode(entities: Entity[]): void {
    // Call teardown() on all scripts
    for (const entity of entities) {
      const scriptComp = entity.getComponent<ScriptComponent>('script');
      if (!scriptComp) continue;
      for (const instance of scriptComp.scripts) {
        if (instance._module?.teardown && instance._initialized) {
          try { instance._module.teardown(/* ctx */); } catch {}
        }
        instance._initialized = false;
      }
    }
    this.isPlayMode = false;
  }

  private loadScriptModule(path: string): ScriptModule | null {
    // Dynamic import — Vite handles .ts files in public/ or src/
    // The actual loading strategy depends on build setup.
    // For development: dynamic import() with Vite's module resolution.
    // For production: scripts are bundled or loaded from a script registry.
    try {
      // Vite dynamic import pattern
      return null; // Placeholder — actual implementation uses import()
    } catch {
      console.warn(`[ScriptSystem] Failed to load script: ${path}`);
      return null;
    }
  }

  private buildInputAccessor(entity: Entity): ScriptContext['input'] {
    const vars = entity.getComponent<CharacterVarsComponent>('character-vars');
    return {
      isActionHeld: (action: string) => vars?.bools.get(`input_${action}_held`) === true,
      isActionPressed: (action: string) => vars?.bools.get(`input_${action}`) === true,
    };
  }
}
```

#### Script Loading Strategy

Scripts are `.ts` files stored under `public/scripts/` (or a configurable scripts
directory). During development, Vite's module system handles hot-reloading automatically.

```
public/scripts/
  camera-sway.ts           ← Camera sway/bob modulation
  footstep-sounds.ts       ← Trigger sounds based on ground contact
  health-effects.ts        ← Screen effects when health is low
  npc-patrol.ts            ← NPC patrol waypoint following
```

The `ScriptSystem` uses dynamic `import()` to load script modules:

```typescript
private async loadScriptModule(path: string): Promise<ScriptModule | null> {
  try {
    // Vite resolves public/ paths at dev time
    const mod = await import(/* @vite-ignore */ `/scripts/${path}`);
    return {
      setup: mod.setup,
      update: mod.update,
      teardown: mod.teardown,
    };
  } catch (err) {
    console.warn(`[ScriptSystem] Failed to load: ${path}`, err);
    return null;
  }
}
```

For the graph node UI, scripts are selected via a file picker (similar to the asset picker
but filtered to `.ts` files in the scripts directory). The script's `exposedParams` are
declared in the script file via a convention:

```typescript
// At the top of the script file — parsed by the editor for UI generation
export const params = {
  swayScale: { type: 'number' as const, default: 0.05, min: 0, max: 1, step: 0.01 },
  bobScale:  { type: 'number' as const, default: 0.03, min: 0, max: 1, step: 0.01 },
  damping:   { type: 'number' as const, default: 0.8,  min: 0, max: 1, step: 0.1 },
  enabled:   { type: 'boolean' as const, default: true },
};
```

The editor reads this `params` export to auto-generate the parameter UI in the Script Node.

#### Common Script Use Cases

**Camera sway/bob** (the example above): Modulate `CameraTargetComponent.swayAmplitude`
and `bobIntensity` based on movement speed. Simple and effective.

**Custom character variables** for transition conditions:
```typescript
// scripts/stamina.ts
export function update(ctx: ScriptContext) {
  const isSprinting = ctx.input.isActionHeld('sprint');
  let stamina = ctx.vars.floats.get('stamina') ?? 100;

  if (isSprinting && stamina > 0) {
    stamina -= 20 * ctx.deltaTime; // Drain
  } else {
    stamina = Math.min(100, stamina + 10 * ctx.deltaTime); // Regen
  }

  ctx.vars.floats.set('stamina', stamina);
  ctx.vars.bools.set('exhausted', stamina <= 0);
}
```

Then in the Animation State Machine, you can add a transition:
`run → walk | when: exhausted == true` — the character slows to a walk when stamina
runs out, purely configured through the graph + script.

**Footstep events:**
```typescript
export function update(ctx: ScriptContext) {
  const anim = ctx.entity.getComponent('animation');
  if (!anim) return;

  // Detect foot-strike frames in walk/run animations
  const t = anim.animationTime % 0.5; // ~2 steps per second
  if (t < ctx.deltaTime) {
    // Trigger footstep sound/particle
    console.log('Footstep!');
  }
}
```

**NPC patrol:**
```typescript
export const params = {
  patrolRadius: { type: 'number' as const, default: 10, min: 1, max: 50 },
  patrolSpeed:  { type: 'number' as const, default: 3, min: 0.5, max: 10 },
};

export function update(ctx: ScriptContext) {
  const transform = ctx.entity.getComponent('transform');
  const physics = ctx.entity.getComponent('character-physics');
  if (!transform || !physics) return;

  const radius = ctx.params.patrolRadius as number;
  const speed = ctx.params.patrolSpeed as number;
  const angle = ctx.time * 0.5; // Slow circle

  // Set velocity toward next patrol point
  const targetX = Math.cos(angle) * radius;
  const targetZ = Math.sin(angle) * radius;
  const dx = targetX - transform.position[0];
  const dz = targetZ - transform.position[2];
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist > 0.5) {
    physics.velocity[0] = (dx / dist) * speed;
    physics.velocity[2] = (dz / dist) * speed;
  }
}
```

#### How Script Node Wires into the Graph

The Script Node's `characterState` input port is purely for graph topology — it ensures
the Script Node is "connected" to the character and gets included in the evaluator's
compilation. The actual data flow happens through the ECS component API, not through
port values.

When the graph evaluator encounters a connected Script Node:
1. Ensures `ScriptComponent` exists on the entity
2. Adds a `ScriptInstance` for this node's `scriptPath` + `params`
3. The `ScriptSystem` picks it up at runtime

Multiple Script Nodes can be connected to the same Character Node, each running
independently. Order of execution follows the order they appear in the graph
(top-to-bottom by node Y position).

---

## Part 2: Animation State Machine — Data Model

### State Types

Each state has a **type** that determines how it evaluates clips:

```typescript
type StateType = 'simple' | 'sequence' | 'blendTree';
```

### AnimationStateDefinition

```typescript
interface AnimationStateDefinition {
  /** Unique state name (e.g., 'idle', 'walk', 'jump', 'attack') */
  name: string;

  /** How this state evaluates clips */
  type: StateType;

  // ==================== Simple State ====================
  // One clip, optionally looped.

  /** Clip asset path (for 'simple' type) */
  clip?: string;

  /** Whether the clip loops (for 'simple' type) — default true */
  loop?: boolean;

  /** Playback speed multiplier — default 1.0 */
  playbackSpeed?: number;

  // ==================== Sequence State ====================
  // Ordered chain of sub-clips (phases) that play in order.
  // Each phase has its own clip and an advance condition.

  /** Ordered phases (for 'sequence' type) */
  phases?: AnimationPhase[];

  /** State to auto-transition to when the last phase completes */
  onSequenceComplete?: string;

  // ==================== Blend Tree State (future) ====================
  // Blends between multiple clips based on a continuous parameter.

  /** Parameter name to blend on (e.g., 'speed') */
  blendParameter?: string;

  /** Blend entries: each clip activates at a threshold */
  blendEntries?: { clip: string; threshold: number }[];
}
```

### AnimationPhase (for Sequence States)

```typescript
interface AnimationPhase {
  /** Phase name (for display, e.g., 'start', 'mid', 'end') */
  name: string;

  /** Clip asset path */
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

type PhaseAdvanceCondition =
  | { type: 'clipFinished' }
  | { type: 'condition'; condition: TransitionCondition }
  | { type: 'clipFinishedOrCondition'; condition: TransitionCondition };
```

### Transition Rules

```typescript
interface TransitionRule {
  /** Source state name, or 'any' for wildcard */
  from: string;

  /** Target state name */
  to: string;

  /** Condition that must be true to trigger this transition */
  condition: TransitionCondition;

  /** Override blend duration for this specific transition (optional) */
  blendDuration?: number;

  /** Priority (lower = higher priority). Used to resolve conflicts when
   *  multiple transitions are valid in the same frame. — default 0 */
  priority?: number;
}
```

### Transition Conditions

A composable boolean expression system. Structured (not string-parsed) for reliability
and easy UI construction.

```typescript
type TransitionCondition =
  | ComparisonCondition
  | InputActionCondition
  | ClipFinishedCondition
  | LogicalCondition;

interface ComparisonCondition {
  type: 'comparison';
  /** Runtime variable to read */
  variable: 'speed' | 'velY' | 'grounded' | 'horizontalSpeed' | string;
  /** Comparison operator */
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  /** Value to compare against */
  value: number | boolean;
}

interface InputActionCondition {
  type: 'input';
  /** Action name from InputNode bindings (e.g., 'attack', 'dodge', 'jump') */
  action: string;
}

interface ClipFinishedCondition {
  type: 'clipFinished';
}

interface LogicalCondition {
  type: 'and' | 'or' | 'not';
  children: TransitionCondition[];
}
```

**Built-in variables available for conditions:**

| Variable | Type | Description |
|----------|------|-------------|
| `speed` | number | Horizontal speed magnitude (sqrt(vx² + vz²)) |
| `horizontalSpeed` | number | Same as speed (alias) |
| `velY` | number | Vertical velocity |
| `grounded` | boolean | Whether character is on ground |
| `airTime` | number | Seconds since last grounded |
| `currentStateTime` | number | Seconds in current animation state |

Custom variables can be written by Script Nodes to a `CharacterVarsComponent` and
referenced in conditions by name.

### Example: Full Jump Configuration

```typescript
// States
{
  name: 'jump',
  type: 'sequence',
  phases: [
    {
      name: 'start',
      clip: 'animations/humanoid/jump_start.glb',
      loop: false,
      blendInDuration: 0.15,
      advance: { type: 'clipFinished' }
    },
    {
      name: 'mid',
      clip: 'animations/humanoid/jump_mid.glb',
      loop: true,
      blendInDuration: 0.1,
      speedFrom: 'horizontalSpeed',
      speedScale: 0.1,
      advance: {
        type: 'condition',
        condition: { type: 'comparison', variable: 'grounded', operator: '==', value: true }
      }
    },
    {
      name: 'end',
      clip: 'animations/humanoid/jump_end.glb',
      loop: false,
      blendInDuration: 0.1,
      advance: { type: 'clipFinished' }
    }
  ],
  onSequenceComplete: 'idle'
}

// Transition into jump
{
  from: 'any',
  to: 'jump',
  condition: {
    type: 'and',
    children: [
      { type: 'input', action: 'jump' },
      { type: 'comparison', variable: 'grounded', operator: '==', value: true },
    ]
  },
  priority: 0
}
```

### Example: Attack Combo

```typescript
{
  name: 'attack_combo',
  type: 'sequence',
  phases: [
    {
      name: 'slash_1',
      clip: 'animations/combat/slash_1.glb',
      loop: false,
      blendInDuration: 0.1,
      advance: {
        type: 'clipFinishedOrCondition',
        condition: { type: 'input', action: 'attack' }
      }
    },
    {
      name: 'slash_2',
      clip: 'animations/combat/slash_2.glb',
      loop: false,
      blendInDuration: 0.05,
      advance: {
        type: 'clipFinishedOrCondition',
        condition: { type: 'input', action: 'attack' }
      }
    },
    {
      name: 'slash_3',
      clip: 'animations/combat/slash_3.glb',
      loop: false,
      blendInDuration: 0.05,
      advance: { type: 'clipFinished' }
    }
  ],
  onSequenceComplete: 'idle'
}
```

---

## Part 3: New & Modified ECS Components

### 3.1 New: CameraTargetComponent

Defines third-person camera behavior. The camera orbits around the entity this is
attached to, with mouse-controlled yaw/pitch.

```typescript
class CameraTargetComponent extends Component {
  readonly type: ComponentType = 'camera-target';

  // Mode
  mode: 'fps' | 'tps-orbit' = 'fps';

  // TPS orbit state (written by PlayerSystem from mouse input)
  orbitYaw: number = 0;              // Horizontal angle (degrees)
  orbitPitch: number = 20;           // Vertical angle above horizontal (degrees)
  orbitDistance: number = 5;         // Distance from look-at point

  // Look-at offset (from entity origin, typically head height)
  lookAtOffset: [number, number, number] = [0, 1.5, 0];

  // Orbit limits
  minPitch: number = -10;
  maxPitch: number = 60;
  minDistance: number = 1.5;
  maxDistance: number = 15;

  // Mouse sensitivity (for TPS orbit control)
  yawSensitivity: number = 0.3;     // Degrees per pixel
  pitchSensitivity: number = 0.3;
  zoomSensitivity: number = 0.5;    // Distance per scroll tick

  // Smoothing
  positionSmoothSpeed: number = 8.0;  // Camera position lerp factor
  rotationSmoothSpeed: number = 12.0; // Camera rotation lerp factor

  // Collision
  collisionEnabled: boolean = true;
  collisionRadius: number = 0.2;

  // Camera sway (velocity-driven)
  swayEnabled: boolean = false;
  swayAmplitude: number = 0.02;
  swayFrequency: number = 2.0;
  bobIntensity: number = 0.03;

  // Internal smoothed state (written by CameraSystem)
  _currentPosition: [number, number, number] = [0, 5, -5];
  _currentLookAt: [number, number, number] = [0, 0, 0];
}
```

### 3.2 New: CharacterControllerComponent

Stores the node graph and compiled configuration.

```typescript
class CharacterControllerComponent extends Component {
  readonly type: ComponentType = 'character-controller';

  // ==================== Node Graph (for editor UI) ====================

  /** Serialized React Flow node graph — same format as material editor */
  nodeGraph: SerializedNodeGraph | null = null;

  // ==================== Compiled Configuration (for runtime) ====================
  // Produced by the graph evaluator when the graph changes.
  // Systems read these at runtime instead of parsing the graph.

  inputConfig: {
    mode: 'fps' | 'tps';
    mouseSensitivity: number;
    bindings: InputBinding[];
    sprintMode: 'hold' | 'toggle';
  } | null = null;

  movementConfig: {
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
  } | null = null;

  cameraConfig: {
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
    positionSmoothSpeed: number;
    rotationSmoothSpeed: number;
    collisionEnabled: boolean;
    collisionRadius: number;
    swayEnabled: boolean;
    swayAmplitude: number;
    swayFrequency: number;
    bobIntensity: number;
  } | null = null;

  animConfig: {
    states: AnimationStateDefinition[];
    transitions: TransitionRule[];
    defaultBlendDuration: number;
  } | null = null;

  terrainEntityId: string | null = null;

  scriptRefs: string[] = [];
}
```

### 3.3 New: CharacterVarsComponent

Runtime variables written by gameplay systems / scripts, readable by transition conditions.

```typescript
class CharacterVarsComponent extends Component {
  readonly type: ComponentType = 'character-vars';

  /** Float variables */
  floats: Map<string, number> = new Map();

  /** Boolean variables */
  bools: Map<string, boolean> = new Map();

  // Built-in derived variables (written by AnimationSystem each frame)
  speed: number = 0;
  horizontalSpeed: number = 0;
  velY: number = 0;
  grounded: boolean = false;
  airTime: number = 0;
  currentStateTime: number = 0;
}
```

### 3.4 ComponentType Additions

Add to `src/core/ecs/types.ts`:

```typescript
export type ComponentType =
  // ... existing types ...
  | 'camera-target'
  | 'character-controller'
  | 'character-vars';
```

---

## Part 4: System Changes

### 4.1 Extended: PlayerSystem — TPS Mouse Handling

Currently `PlayerSystem` only handles FPS mode (pointer-locked mouse controls yaw/pitch).

**Changes for TPS mode:**

When `CameraTargetComponent.mode === 'tps-orbit'`:
- Mouse movement (always-on in Play Mode, no pointer lock) writes to
  `CameraTargetComponent.orbitYaw` and `CameraTargetComponent.orbitPitch`
- Scroll wheel writes to `CameraTargetComponent.orbitDistance`
- `PlayerComponent.yaw/pitch` are NOT written by mouse — the character rotates
  independently based on movement direction
- Custom action bindings (from `InputNode`) are checked each frame and written
  to `CharacterVarsComponent` as boolean triggers (e.g., `input_attack = true` for one frame)

**Input channel for TPS:** A new `'tps'` channel on `InputManager` that receives
mouse events without pointer lock. In Play Mode with TPS, `InputManager.setActiveChannel('tps')`.

```typescript
// In PlayerSystem.update(), TPS mouse handling:
if (cameraTarget.mode === 'tps-orbit') {
  // Mouse always controls orbit (no pointer lock)
  const mouseDelta = inputManager.getMouseDelta(); // from 'tps' channel
  cameraTarget.orbitYaw -= mouseDelta.x * cameraTarget.yawSensitivity;
  cameraTarget.orbitPitch += mouseDelta.y * cameraTarget.pitchSensitivity;
  cameraTarget.orbitPitch = clamp(cameraTarget.orbitPitch, cameraTarget.minPitch, cameraTarget.maxPitch);

  // Scroll wheel → zoom
  const scroll = inputManager.getScrollDelta();
  if (scroll !== 0) {
    cameraTarget.orbitDistance -= scroll * cameraTarget.zoomSensitivity;
    cameraTarget.orbitDistance = clamp(cameraTarget.orbitDistance, cameraTarget.minDistance, cameraTarget.maxDistance);
  }
}
```

### 4.2 Extended: CharacterMovementSystem — Camera-Relative Movement for TPS

Currently movement is always relative to `player.yaw` (FPS). In TPS mode, movement
is relative to the camera's orbit yaw, and the character mesh smoothly rotates to
face the movement direction.

```typescript
// In CharacterMovementSystem.update():

const cameraTarget = entity.getComponent<CameraTargetComponent>('camera-target');

if (cameraTarget?.mode === 'tps-orbit') {
  // TPS: movement relative to camera orbit yaw
  const cameraYawRad = cameraTarget.orbitYaw * Math.PI / 180;

  if (hasInput) {
    const forwardX = Math.sin(cameraYawRad);
    const forwardZ = Math.cos(cameraYawRad);
    const rightX = -Math.cos(cameraYawRad);
    const rightZ = Math.sin(cameraYawRad);

    const moveX = input[0] * forwardX + input[1] * rightX;
    const moveZ = input[0] * forwardZ + input[1] * rightZ;

    // Normalize + apply speed
    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    const speed = player.isRunning ? player.runSpeed : player.moveSpeed;
    physics.velocity[0] = (moveX / len) * speed;
    physics.velocity[2] = (moveZ / len) * speed;

    // Smoothly rotate character to face movement direction
    const targetYaw = Math.atan2(moveX, moveZ);
    const currentYaw = player.yaw;
    let deltaYaw = targetYaw - currentYaw;
    // Shortest path
    if (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
    if (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
    const maxRotation = (player.rotationSpeed * Math.PI / 180) * deltaTime;
    player.yaw += Math.max(-maxRotation, Math.min(maxRotation, deltaYaw));
  }

  // Write character facing rotation to transform (for mesh orientation)
  const yawQuat = quat.create();
  quat.setAxisAngle(yawQuat, [0, 1, 0], player.yaw);
  quat.copy(transform.rotationQuat, yawQuat); // No pitch on character in TPS
} else {
  // FPS: existing behavior (movement relative to player.yaw)
  // ... unchanged ...
}
```

### 4.3 Extended: CameraSystem — TPS Orbit Mode

Currently `CameraSystem` only computes FPS view matrix (position + yaw/pitch lookAt).

**Changes:**

```typescript
// In CameraSystem.update():

const cameraTarget = entity.getComponent<CameraTargetComponent>('camera-target');

if (cameraTarget?.mode === 'tps-orbit') {
  // TPS: orbit camera around character
  this.updateTPSOrbitCamera(entity, cam, transform, cameraTarget, deltaTime, context);
} else {
  // FPS: existing behavior
  const player = entity.getComponent<PlayerComponent>('player');
  const yaw = player?.yaw ?? 0;
  const pitch = player?.pitch ?? 0;
  cam.updateMatrices(transform.position as [number, number, number], yaw, pitch);
}
```

**TPS orbit computation:**

```typescript
private updateTPSOrbitCamera(
  entity: Entity,
  cam: CameraComponent,
  transform: TransformComponent,
  ct: CameraTargetComponent,
  dt: number,
  context: SystemContext,
): void {
  // 1. Compute target look-at point (character position + offset)
  const targetLookAt: [number, number, number] = [
    transform.position[0] + ct.lookAtOffset[0],
    transform.position[1] + ct.lookAtOffset[1],
    transform.position[2] + ct.lookAtOffset[2],
  ];

  // 2. Compute target camera position (orbit around look-at)
  const yawRad = ct.orbitYaw * Math.PI / 180;
  const pitchRad = ct.orbitPitch * Math.PI / 180;

  let targetPos: [number, number, number] = [
    targetLookAt[0] + Math.sin(yawRad) * Math.cos(pitchRad) * ct.orbitDistance,
    targetLookAt[1] + Math.sin(pitchRad) * ct.orbitDistance,
    targetLookAt[2] + Math.cos(yawRad) * Math.cos(pitchRad) * ct.orbitDistance,
  ];

  // 3. Terrain collision: prevent camera below terrain
  if (ct.collisionEnabled) {
    const terrainEntity = context.world.queryFirst('terrain');
    if (terrainEntity) {
      const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
      if (terrain?.manager?.hasCPUHeightfield?.()) {
        const terrainHeight = terrain.manager.sampleHeightAt(targetPos[0], targetPos[2]);
        const minCamY = terrainHeight + ct.collisionRadius;
        if (targetPos[1] < minCamY) targetPos[1] = minCamY;
      }
    }
  }

  // 4. Camera sway (velocity-driven)
  if (ct.swayEnabled) {
    const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (physics) {
      const hSpeed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
      const swayTime = performance.now() * 0.001;
      const swayX = Math.sin(swayTime * ct.swayFrequency * Math.PI * 2) * ct.swayAmplitude * hSpeed;
      const swayY = Math.abs(Math.sin(swayTime * ct.swayFrequency * Math.PI * 2 * 2)) * ct.bobIntensity * hSpeed;
      targetLookAt[0] += swayX;
      targetLookAt[1] += swayY;
    }
  }

  // 5. Smooth interpolation
  const posLerp = 1 - Math.exp(-ct.positionSmoothSpeed * dt);
  const lookLerp = 1 - Math.exp(-ct.rotationSmoothSpeed * dt);

  ct._currentPosition[0] += (targetPos[0] - ct._currentPosition[0]) * posLerp;
  ct._currentPosition[1] += (targetPos[1] - ct._currentPosition[1]) * posLerp;
  ct._currentPosition[2] += (targetPos[2] - ct._currentPosition[2]) * posLerp;

  ct._currentLookAt[0] += (targetLookAt[0] - ct._currentLookAt[0]) * lookLerp;
  ct._currentLookAt[1] += (targetLookAt[1] - ct._currentLookAt[1]) * lookLerp;
  ct._currentLookAt[2] += (targetLookAt[2] - ct._currentLookAt[2]) * lookLerp;

  // 6. Compute view matrix from smoothed position + lookAt
  mat4.lookAt(cam.viewMatrix, ct._currentPosition, ct._currentLookAt, [0, 1, 0]);
  mat4.multiply(cam.vpMatrix, cam.projMatrix, cam.viewMatrix);
}
```

### 4.4 Extended: AnimationSystem — Custom State Machine & Sequences

The current `AnimationSystem` has hardcoded velocity→state mapping. This extends it
to evaluate user-defined transition rules and handle sequence states.

**Changes overview:**
1. Replace `updateStateFromPhysics()` with `evaluateTransitions()` that checks user-defined
   `TransitionRule[]` conditions against `CharacterVarsComponent`
2. Add sequence phase tracking and phase advance evaluation
3. Write built-in variables (`speed`, `grounded`, `velY`, `airTime`) to `CharacterVarsComponent`
   each frame before evaluating transitions

**Transition evaluation pseudocode:**

```typescript
private evaluateTransitions(entity: Entity, anim: AnimationComponent): void {
  const vars = entity.getComponent<CharacterVarsComponent>('character-vars');
  const controller = entity.getComponent<CharacterControllerComponent>('character-controller');
  if (!vars || !controller?.animConfig) return;

  // Update built-in variables
  const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
  if (physics) {
    vars.speed = Math.sqrt(physics.velocity[0] ** 2 + physics.velocity[2] ** 2);
    vars.horizontalSpeed = vars.speed;
    vars.velY = physics.velocity[1];
    vars.grounded = physics.isGrounded;
    if (!physics.isGrounded) vars.airTime += deltaTime;
    else vars.airTime = 0;
  }
  vars.currentStateTime = anim.animationTime;

  // Evaluate transition rules (sorted by priority)
  const rules = controller.animConfig.transitions
    .filter(r => r.from === anim.currentState || r.from === 'any')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  for (const rule of rules) {
    if (rule.to === anim.currentState) continue; // Skip self-transitions
    if (this.evaluateCondition(rule.condition, vars)) {
      // Trigger state transition
      anim.previousState = anim.currentState;
      anim.previousAnimationTime = anim.animationTime;
      anim.currentState = rule.to as AnimationState;
      anim.animationTime = 0;
      anim.blendTimer = 0;
      anim.blendFactor = 0;
      anim.blendDuration = rule.blendDuration ?? controller.animConfig.defaultBlendDuration;
      // Reset sequence tracking
      anim.sequencePhaseIndex = 0;
      anim.sequencePhaseTime = 0;
      break; // First matching rule wins
    }
  }
}

private evaluateCondition(cond: TransitionCondition, vars: CharacterVarsComponent): boolean {
  switch (cond.type) {
    case 'comparison': {
      const val = this.readVariable(cond.variable, vars);
      switch (cond.operator) {
        case '>':  return val > cond.value;
        case '<':  return val < cond.value;
        case '>=': return val >= cond.value;
        case '<=': return val <= cond.value;
        case '==': return val === cond.value;
        case '!=': return val !== cond.value;
      }
      return false;
    }
    case 'input':
      return vars.bools.get(`input_${cond.action}`) === true;
    case 'clipFinished':
      return /* check if current clip/phase has finished */;
    case 'and':
      return cond.children.every(c => this.evaluateCondition(c, vars));
    case 'or':
      return cond.children.some(c => this.evaluateCondition(c, vars));
    case 'not':
      return !this.evaluateCondition(cond.children[0], vars);
  }
}

private readVariable(name: string, vars: CharacterVarsComponent): number | boolean {
  // Check built-in variables first
  switch (name) {
    case 'speed':
    case 'horizontalSpeed': return vars.speed;
    case 'velY': return vars.velY;
    case 'grounded': return vars.grounded;
    case 'airTime': return vars.airTime;
    case 'currentStateTime': return vars.currentStateTime;
  }
  // Check custom variables
  return vars.floats.get(name) ?? vars.bools.get(name) ?? 0;
}
```

**Sequence phase evaluation:**

```typescript
// In AnimationSystem.update(), when current state is a sequence:

const stateDef = controller.animConfig.states.find(s => s.name === anim.currentState);
if (stateDef?.type === 'sequence' && stateDef.phases) {
  const phase = stateDef.phases[anim.sequencePhaseIndex];
  if (!phase) {
    // All phases complete → auto-transition
    if (stateDef.onSequenceComplete) {
      triggerTransition(anim, stateDef.onSequenceComplete);
    }
    continue;
  }

  // Advance phase time
  let phaseSpeed = phase.playbackSpeed ?? 1.0;
  if (phase.speedFrom) {
    const varVal = this.readVariable(phase.speedFrom, vars) as number;
    phaseSpeed += varVal * (phase.speedScale ?? 0);
  }
  anim.sequencePhaseTime += deltaTime * phaseSpeed;

  // Resolve clip for this phase
  const phaseClip = anim.clips.get(phase.clip);
  if (!phaseClip) continue;

  // Loop phase clip if configured
  if (phase.loop && phaseClip.duration > 0) {
    anim.sequencePhaseTime %= phaseClip.duration;
  }

  // Check advance condition
  let shouldAdvance = false;
  switch (phase.advance.type) {
    case 'clipFinished':
      shouldAdvance = !phase.loop && anim.sequencePhaseTime >= phaseClip.duration;
      break;
    case 'condition':
      shouldAdvance = this.evaluateCondition(phase.advance.condition, vars);
      break;
    case 'clipFinishedOrCondition':
      shouldAdvance = (!phase.loop && anim.sequencePhaseTime >= phaseClip.duration)
                   || this.evaluateCondition(phase.advance.condition, vars);
      break;
  }

  if (shouldAdvance) {
    // Advance to next phase with crossfade
    anim.sequencePhaseIndex++;
    const nextPhase = stateDef.phases[anim.sequencePhaseIndex];
    if (nextPhase) {
      // Start blending from current phase clip into next phase clip
      anim.previousAnimationTime = anim.sequencePhaseTime;
      anim.sequencePhaseTime = 0;
      anim.blendTimer = 0;
      anim.blendFactor = 0;
      anim.blendDuration = nextPhase.blendInDuration;
    }
    // If no next phase, onSequenceComplete triggers on next frame
  }

  // Evaluate phase clip (same evaluateClip() as today, but using phaseClip + sequencePhaseTime)
  // ... existing bone matrix computation ...
}
```

---

## Part 5: Graph Evaluator

The graph evaluator runs at edit-time (not per-frame). When the user changes the graph
(adds a node, connects an edge, modifies a parameter), the evaluator:

1. Walks the connected graph from the Character Node outward
2. Validates connections (e.g., can't connect Camera output to Terrain input)
3. Compiles node data into the flat configuration on `CharacterControllerComponent`
4. Ensures the correct ECS components exist on the entity (adds/removes as needed)

```typescript
class CharacterControllerGraphEvaluator {
  /**
   * Evaluate the graph and update the entity's components.
   * Called on every graph change (debounced 300ms).
   */
  evaluate(entity: Entity, graph: SerializedNodeGraph): void {
    const cc = entity.getComponent<CharacterControllerComponent>('character-controller');
    if (!cc) return;

    // Find nodes by type
    const characterNode = graph.nodes.find(n => n.type === 'character');
    const inputNode = graph.nodes.find(n => n.type === 'input');
    const cameraNode = graph.nodes.find(n => n.type === 'camera');
    const animNode = graph.nodes.find(n => n.type === 'animStateMachine');
    const terrainNode = graph.nodes.find(n => n.type === 'terrain');

    // Check connections (which nodes are wired to the character)
    const inputConnected = graph.edges.some(e =>
      e.source === inputNode?.id && e.target === characterNode?.id
    );
    const terrainConnected = graph.edges.some(e =>
      e.source === terrainNode?.id && e.target === characterNode?.id
    );
    const cameraConnected = graph.edges.some(e =>
      e.source === characterNode?.id && e.target === cameraNode?.id
    );
    const animConnected = graph.edges.some(e =>
      e.source === characterNode?.id && e.target === animNode?.id
    );

    // Compile input config
    if (inputNode && inputConnected) {
      cc.inputConfig = {
        mode: inputNode.data.mode ?? 'tps',
        mouseSensitivity: inputNode.data.mouseSensitivity ?? 0.002,
        bindings: inputNode.data.bindings ?? DEFAULT_BINDINGS,
        sprintMode: inputNode.data.sprintMode ?? 'hold',
      };
    } else {
      cc.inputConfig = null;
    }

    // Compile movement config from Character Node
    if (characterNode) {
      const d = characterNode.data;
      cc.movementConfig = {
        moveSpeed: d.moveSpeed ?? 5.0,
        runSpeed: d.runSpeed ?? 10.0,
        sprintMultiplier: d.sprintMultiplier ?? 2.0,
        jumpForce: d.jumpForce ?? 8.0,
        rotationSpeed: d.rotationSpeed ?? 720,
        gravity: d.gravity ?? -20.0,
        groundFriction: d.groundFriction ?? 10.0,
        airDrag: d.airDrag ?? 0.5,
        playerHeight: d.playerHeight ?? 1.8,
        collisionRadius: d.collisionRadius ?? 0.3,
      };

      // Sync to PlayerComponent + CharacterPhysicsComponent
      this.syncMovementToComponents(entity, cc.movementConfig);
    }

    // Compile camera config
    if (cameraNode && cameraConnected) {
      const d = cameraNode.data;
      cc.cameraConfig = { /* ... map all fields from cameraNode.data ... */ };
      this.syncCameraToComponents(entity, cc.cameraConfig);
    }

    // Compile animation config
    if (animNode && animConnected) {
      cc.animConfig = {
        states: animNode.data.states ?? [],
        transitions: animNode.data.transitions ?? [],
        defaultBlendDuration: animNode.data.defaultBlendDuration ?? 0.2,
      };
      this.syncAnimationToComponents(entity, cc.animConfig);
    }

    // Terrain reference
    cc.terrainEntityId = terrainConnected ? terrainNode?.data?.terrainEntityId ?? null : null;
  }

  /** Ensure PlayerComponent + CharacterPhysicsComponent exist and are configured */
  private syncMovementToComponents(entity: Entity, config: MovementConfig): void {
    let player = entity.getComponent<PlayerComponent>('player');
    if (!player) player = entity.addComponent(new PlayerComponent());
    player.moveSpeed = config.moveSpeed;
    player.runSpeed = config.runSpeed;
    player.sprintMultiplier = config.sprintMultiplier;
    player.jumpForce = config.jumpForce;
    player.rotationSpeed = config.rotationSpeed;
    player.playerHeight = config.playerHeight;

    let physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
    if (!physics) physics = entity.addComponent(new CharacterPhysicsComponent());
    physics.gravity = config.gravity;
    physics.groundFriction = config.groundFriction;
    physics.airDrag = config.airDrag;
    physics.height = config.playerHeight;
    physics.radius = config.collisionRadius;
  }

  /** Ensure CameraComponent + CameraTargetComponent exist and are configured */
  private syncCameraToComponents(entity: Entity, config: CameraConfig): void {
    let cam = entity.getComponent<CameraComponent>('camera');
    if (!cam) cam = entity.addComponent(new CameraComponent());
    cam.fov = config.fov;
    cam.near = config.near;
    cam.far = config.far;

    let ct = entity.getComponent<CameraTargetComponent>('camera-target');
    if (!ct) ct = entity.addComponent(new CameraTargetComponent());
    ct.mode = config.mode;
    ct.lookAtOffset = [...config.lookAtOffset];
    ct.orbitDistance = config.orbitDistance;
    ct.orbitPitch = config.orbitPitch;
    // ... sync all orbit + sway params ...
  }

  /** Sync animation states, transitions, and load clips */
  private syncAnimationToComponents(entity: Entity, config: AnimConfig): void {
    let anim = entity.getComponent<AnimationComponent>('animation');
    if (!anim) anim = entity.addComponent(new AnimationComponent());

    // Load clips for each state/phase that references an asset path
    // Uses the clip cache to avoid re-loading
    // ... async clip loading with skeleton compatibility check ...
  }
}
```

---

## Part 6: Editor UI

### 6.1 Dockable Window Architecture

The graph editor opens in a **dockable window** (using the existing `DockableWindow`
component). This scales to future use cases (e.g., shader graph, behavior tree) without
creating a new tab for each.

**Opening the graph:**
- Object Panel → Components Tab → when entity has `PlayerComponent`, show an
  "Edit Controller" button
- Clicking it opens a `DockableWindow` containing the `CharacterControllerNodeEditor`

**Graph state persistence:**
- **Source of truth:** `CharacterControllerComponent.nodeGraph` on the ECS entity
- **On open:** read graph from component → initialize React Flow
- **On edit:** debounced save (300ms) from React Flow → component. Skip saves during
  initial mount reconciliation using an `isInitialized` flag set after first `requestAnimationFrame`
- **On close:** do NOT save during unmount (avoids React Flow teardown edge-removal bug).
  All genuine edits have already been saved via debounced sync.
- **External changes:** If component data changes while the graph is open (e.g., clip
  assigned via AnimationSubPanel), a signal/event refreshes specific node data.

### 6.2 CharacterControllerNodeEditor

Mirrors the `MaterialNodeEditor` pattern:

```typescript
// src/demos/sceneBuilder/components/panels/CharacterControllerPanel/
//   CharacterControllerNodeEditor.tsx

const nodeTypes: NodeTypes = {
  character: CharacterNode,
  input: InputNode,
  camera: CameraNode,
  animStateMachine: AnimStateMachineNode,
  terrain: TerrainNode,
  script: ScriptNode,
};

const nodePortDefs: Record<string, NodePortDef> = {
  character: characterPortDef,
  input: inputPortDef,
  camera: cameraPortDef,
  animStateMachine: animStateMachinePortDef,
  terrain: terrainPortDef,
  script: scriptPortDef,
};
```

**Port data types for character controller domain:**

```typescript
type PortDataType =
  | 'inputIntent'      // Input Node → Character Node
  | 'characterState'   // Character Node → Camera Node / Anim Node
  | 'terrainData'      // Terrain Node → Character Node
  | 'animation'        // Anim Node (terminal)
  | 'camera'           // Camera Node (terminal)
  | 'any';
```

**Toolbar:**
```
Entity: "Player"    [+ Input] [+ Camera] [+ Terrain] [+ Animation States] [+ Script]
```

The Character Node is auto-created and cannot be deleted.

### 6.3 Animation State Machine Node — UI Details

The most complex node component. Contains:

**States section:**
```
┌─ States ──────────────────────────────────────────────────┐
│                                                            │
│  ▸ idle (simple)                                           │
│    Clip: [idle.glb               📂]  Loop ✓  Speed: 1.0  │
│                                                            │
│  ▸ walk (simple)                                           │
│    Clip: [walk.glb               📂]  Loop ✓  Speed: 1.0  │
│                                                            │
│  ▾ jump (sequence)  ← expanded to show phases              │
│    Phase 1: start                                          │
│      Clip: [jump_start.glb      📂]  Loop ✗  Speed: 1.0  │
│      Advance: when clip finishes                           │
│      Blend in: [0.15]s                                     │
│    Phase 2: mid                                            │
│      Clip: [jump_mid.glb        📂]  Loop ✓  Speed: 1.0  │
│      Advance: when grounded == true                        │
│      Blend in: [0.1]s                                      │
│    Phase 3: end                                            │
│      Clip: [jump_end.glb        📂]  Loop ✗  Speed: 1.0  │
│      Advance: when clip finishes → idle                    │
│      Blend in: [0.1]s                                      │
│    [+ Add Phase]                                           │
│                                                            │
│  [+ Add State]     Type: [simple ▾]                        │
└────────────────────────────────────────────────────────────┘
```

**Transitions section:**
```
┌─ Transitions ─────────────────────────────────────────────┐
│                                                            │
│  any → idle    │ when: grounded AND speed < 0.5           │
│  idle → walk   │ when: grounded AND speed ≥ 0.5           │
│  walk → run    │ when: grounded AND speed ≥ 7.0           │
│  run → walk    │ when: grounded AND speed < 7.0           │
│  any → jump    │ when: input(jump) AND grounded           │
│                                                            │
│  [+ Add Transition]                                        │
│                                                            │
│  Default Blend: [0.2]s                                     │
└────────────────────────────────────────────────────────────┘
```

**Condition builder UI:**

Each condition is a structured row, not a text field. The UI provides dropdowns:

```
[variable ▾] [operator ▾] [value    ]   [+ AND] [+ OR]
 speed         >=           0.5
```

For compound conditions (AND/OR), nested rows with indentation:

```
AND:
  ├── grounded == true
  └── speed < 0.5
```

**Clip assignment:** Every 📂 button opens `AssetPickerModal` with
`filterType="model"` and `filterCategory="animation"`. On selection:
1. Load GLB via `loadAnimationClipsCached(url)`
2. Validate skeleton compatibility via `isSkeletonCompatible()`
3. Register clip on `AnimationComponent.clips`
4. Store asset path in the node data

---

## Part 7: Clip Assignment & Animation Library

### Clip Loading Pipeline

```
📂 click → AssetPickerModal (filterCategory='animation')
         → User selects 'jump_start.glb'
         → loadAnimationClipsCached(url)
         → isSkeletonCompatible(entitySkeleton, clipSkeleton)
         → If compatible: anim.clips.set(assetPath, clip)
         → Update node data with asset path + display name
         → Graph evaluator syncs to AnimationComponent
```

### Clip Cache

Shared URL-keyed cache. Multiple characters sharing the same clip → one copy in memory:

```typescript
const animationClipCache = new Map<string, {
  clips: GLBAnimationClip[];
  skeleton: GLBSkeleton | null;
}>();

async function loadAnimationClipsCached(url: string): Promise<{
  clips: GLBAnimationClip[];
  skeleton: GLBSkeleton | null;
}> {
  if (animationClipCache.has(url)) return animationClipCache.get(url)!;
  const result = await loadAnimationClips(url);
  animationClipCache.set(url, result);
  return result;
}
```

### Asset Indexer: Animation Category

GLBs under `animations/`, `animation/`, or `anims/` directories are automatically
classified as `category: 'animation'` by the `AssetIndexer`.

```typescript
// server/services/AssetIndexer.ts — DIR_TYPE_HINTS additions:
'animations': { type: 'model', category: 'animation' },
'animation':  { type: 'model', category: 'animation' },
'anims':      { type: 'model', category: 'animation' },
```

---

## Part 8: Play Mode Integration

### Enter Play Mode (TPS)

```typescript
function enterPlayMode(world: World, inputManager: InputManager): void {
  const playerEntity = world.queryFirst('player');
  if (!playerEntity) return;

  const player = playerEntity.getComponent<PlayerComponent>('player');
  const cameraTarget = playerEntity.getComponent<CameraTargetComponent>('camera-target');

  player.active = true;
  player.needsSpawn = true;

  if (cameraTarget?.mode === 'tps-orbit') {
    // TPS: hide cursor, always-on orbit (no pointer lock)
    inputManager.setActiveChannel('tps');
    document.body.style.cursor = 'none'; // Hide cursor in play mode
  } else {
    // FPS: pointer lock as before
    inputManager.setActiveChannel('fps');
    inputManager.requestPointerLock();
  }
}
```

### Exit Play Mode

```typescript
function exitPlayMode(world: World, inputManager: InputManager): void {
  const playerEntity = world.queryFirst('player');
  if (!playerEntity) return;

  const player = playerEntity.getComponent<PlayerComponent>('player');
  player.active = false;
  player.resetKeys();

  inputManager.setActiveChannel('editor');
  inputManager.exitPointerLock();
  document.body.style.cursor = '';
}
```

---

## Part 9: Multi-Device Input Abstraction

The input system is designed around **abstract actions**, not raw hardware events. The
entire character controller pipeline (PlayerSystem, CharacterMovementSystem, transition
conditions) never sees key codes or button IDs — only action names and analog values.
This enables seamless keyboard + controller support from a single Input Node configuration.

### Core Principle: Actions, Not Devices

Each action binding maps to **multiple input sources** across different devices. At runtime,
`InputManager` polls all connected providers, merges their outputs per action, and exposes
unified `ActionState` objects with analog values.

```
┌─────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
│ KeyboardMouse   │──▶│                  │   │                      │
│ Provider        │   │  InputManager    │──▶│ PlayerSystem         │
│ (DOM events)    │   │                  │   │ (reads ActionStates) │
├─────────────────┤   │  Polls providers │   │                      │
│ DualSense       │──▶│  each frame,    │   │ CharacterMovement    │
│ Provider        │   │  merges into     │   │ (reads analog values)│
│ (dualsense-ts)  │   │  ActionStates    │   │                      │
├─────────────────┤   │                  │   │ CameraSystem         │
│ Generic Gamepad │──▶│                  │   │ (reads camera axes)  │
│ Provider        │   │                  │   │                      │
│ (Gamepad API)   │   └──────────────────┘   └──────────────────────┘
└─────────────────┘
```

### InputBinding — Multi-Source

```typescript
interface InputBinding {
  /** Abstract action name (e.g., 'forward', 'jump', 'attack') */
  action: string;

  /** Whether this action is continuous (held) or one-shot (pressed) */
  type: 'held' | 'pressed';

  /** Multiple hardware sources can trigger the same action */
  sources: InputSource[];
}

type InputSource =
  | KeyboardSource
  | MouseButtonSource
  | GamepadAxisSource
  | GamepadButtonSource;

interface KeyboardSource {
  device: 'keyboard';
  key: string;              // DOM key code: 'KeyW', 'ShiftLeft', 'Space'
}

interface MouseButtonSource {
  device: 'mouse';
  button: number;           // 0 = left, 1 = middle, 2 = right
}

interface GamepadAxisSource {
  device: 'gamepad';
  kind: 'axis';
  axis: 'leftStickX' | 'leftStickY' | 'rightStickX' | 'rightStickY' | 'L2' | 'R2';
  direction: 'positive' | 'negative';  // e.g., leftStickY negative = forward
  deadzone?: number;         // Default 0.15
}

interface GamepadButtonSource {
  device: 'gamepad';
  kind: 'button';
  button: 'cross' | 'circle' | 'square' | 'triangle'
        | 'L1' | 'R1' | 'L2' | 'R2' | 'L3' | 'R3'
        | 'dpadUp' | 'dpadDown' | 'dpadLeft' | 'dpadRight'
        | 'options' | 'share' | 'ps' | 'touchpad';
}
```

### ActionState — Analog-Aware

```typescript
interface ActionState {
  /** Whether the action is active (pressed/held) — binary threshold */
  active: boolean;

  /** Analog value 0.0–1.0 (keyboard = 0 or 1, stick = continuous) */
  value: number;

  /** True for exactly one frame when action activates */
  justPressed: boolean;

  /** True for exactly one frame when action deactivates */
  justReleased: boolean;
}
```

Controller sticks produce continuous 0.0–1.0 values. `CharacterMovementSystem` uses
this for proportional speed: light tilt = slow walk, full tilt = run. Keyboard input
produces binary 0/1.

### Camera Axes — Merged Mouse + Right Stick

```typescript
interface CameraAxesConfig {
  sources: CameraAxisSource[];
}

type CameraAxisSource =
  | { device: 'mouse'; sensitivity: number }
  | { device: 'gamepad'; stick: 'rightStick'; sensitivity: number; deadzone: number };
```

Both mouse delta and right stick feed into `CameraTargetComponent.orbitYaw/Pitch`. The
`InputManager` merges them additively — whichever source has nonzero input contributes.

### InputProvider Interface

```typescript
// src/core/input/InputProvider.ts

interface InputProvider {
  /** Unique device identifier (e.g., 'keyboard-mouse', 'dualsense', 'gamepad-0') */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether this provider is currently connected */
  isConnected(): boolean;

  /** Called each frame to poll hardware state */
  poll(): void;

  /** Read the current value of a source. Returns 0 if not applicable. */
  readSource(source: InputSource): number;  // 0.0 to 1.0

  /** Read camera axis deltas (mouse movement / right stick) */
  readCameraAxis(): { deltaX: number; deltaY: number };

  /** Cleanup resources */
  destroy(): void;
}
```

### Built-in Providers

#### KeyboardMouseProvider

Wraps existing DOM event listeners. Always connected.

```typescript
class KeyboardMouseProvider implements InputProvider {
  readonly id = 'keyboard-mouse';
  readonly name = 'Keyboard & Mouse';

  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;

  isConnected() { return true; }

  poll() {
    // Mouse deltas accumulated from DOM mousemove events
    // Reset after reading in readCameraAxis()
  }

  readSource(source: InputSource): number {
    if (source.device === 'keyboard') return this.keys.has(source.key) ? 1.0 : 0.0;
    if (source.device === 'mouse') return this.mouseButtons.has(source.button) ? 1.0 : 0.0;
    return 0;
  }

  readCameraAxis() {
    const dx = this.mouseDeltaX;
    const dy = this.mouseDeltaY;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { deltaX: dx, deltaY: dy };
  }
}
```

#### DualSenseProvider (via dualsense-ts)

```typescript
import { Dualsense } from 'dualsense-ts';

class DualSenseProvider implements InputProvider {
  readonly id = 'dualsense';
  readonly name = 'PS5 DualSense';

  private controller: Dualsense;

  constructor() { this.controller = new Dualsense(); }

  isConnected() { return this.controller.connected; }
  poll() { /* dualsense-ts updates state via HID automatically */ }

  readSource(source: InputSource): number {
    if (source.device !== 'gamepad') return 0;

    if (source.kind === 'button') {
      return this.readButton(source.button) ? 1.0 : 0.0;
    }
    if (source.kind === 'axis') {
      const raw = this.readAxis(source.axis);
      const deadzone = source.deadzone ?? 0.15;
      const clamped = Math.abs(raw) < deadzone ? 0 : raw;
      if (source.direction === 'positive') return Math.max(0, clamped);
      if (source.direction === 'negative') return Math.max(0, -clamped);
    }
    return 0;
  }

  readCameraAxis() {
    const rx = this.controller.right.analog.x.value;
    const ry = this.controller.right.analog.y.value;
    const deadzone = 0.1;
    return {
      deltaX: Math.abs(rx) > deadzone ? rx * 3.0 : 0,
      deltaY: Math.abs(ry) > deadzone ? ry * 3.0 : 0,
    };
  }

  private readButton(name: string): boolean {
    switch (name) {
      case 'cross': return this.controller.cross.state;
      case 'circle': return this.controller.circle.state;
      case 'square': return this.controller.square.state;
      case 'triangle': return this.controller.triangle.state;
      case 'L1': return this.controller.left.bumper.state;
      case 'R1': return this.controller.right.bumper.state;
      case 'L3': return this.controller.left.analog.button.state;
      case 'R3': return this.controller.right.analog.button.state;
      default: return false;
    }
  }

  private readAxis(name: string): number {
    switch (name) {
      case 'leftStickX': return this.controller.left.analog.x.value;
      case 'leftStickY': return this.controller.left.analog.y.value;
      case 'rightStickX': return this.controller.right.analog.x.value;
      case 'rightStickY': return this.controller.right.analog.y.value;
      case 'L2': return this.controller.left.trigger.value;
      case 'R2': return this.controller.right.trigger.value;
      default: return 0;
    }
  }
}
```

### InputManager: Provider Merging

The `InputManager` polls all providers each frame and merges their outputs:

```typescript
class InputManager {
  private providers: InputProvider[] = [];
  private actionStates: Map<string, ActionState> = new Map();
  private bindings: InputBinding[] = [];

  addProvider(provider: InputProvider): void {
    this.providers.push(provider);
  }

  getProvider(id: string): InputProvider | undefined {
    return this.providers.find(p => p.id === id);
  }

  /** Called once per frame, before PlayerSystem */
  pollAll(): void {
    for (const p of this.providers) p.poll();

    for (const binding of this.bindings) {
      const prev = this.actionStates.get(binding.action);
      const wasActive = prev?.active ?? false;

      // Find max value across all sources and all providers
      let maxValue = 0;
      for (const source of binding.sources) {
        for (const provider of this.providers) {
          maxValue = Math.max(maxValue, provider.readSource(source));
        }
      }

      const active = maxValue > 0;
      this.actionStates.set(binding.action, {
        active,
        value: maxValue,
        justPressed: active && !wasActive,
        justReleased: !active && wasActive,
      });
    }
  }

  /** Read merged action state */
  getAction(action: string): ActionState {
    return this.actionStates.get(action)
      ?? { active: false, value: 0, justPressed: false, justReleased: false };
  }

  /** Read merged camera axes from all providers */
  getCameraAxes(): { deltaX: number; deltaY: number } {
    let dx = 0, dy = 0;
    for (const p of this.providers) {
      const axes = p.readCameraAxis();
      dx += axes.deltaX;
      dy += axes.deltaY;
    }
    return { deltaX: dx, deltaY: dy };
  }
}
```

### Default Bindings (Keyboard + DualSense)

```typescript
const DEFAULT_BINDINGS: InputBinding[] = [
  {
    action: 'forward', type: 'held',
    sources: [
      { device: 'keyboard', key: 'KeyW' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickY', direction: 'negative', deadzone: 0.15 },
    ]
  },
  {
    action: 'backward', type: 'held',
    sources: [
      { device: 'keyboard', key: 'KeyS' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickY', direction: 'positive', deadzone: 0.15 },
    ]
  },
  {
    action: 'left', type: 'held',
    sources: [
      { device: 'keyboard', key: 'KeyA' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickX', direction: 'negative', deadzone: 0.15 },
    ]
  },
  {
    action: 'right', type: 'held',
    sources: [
      { device: 'keyboard', key: 'KeyD' },
      { device: 'gamepad', kind: 'axis', axis: 'leftStickX', direction: 'positive', deadzone: 0.15 },
    ]
  },
  {
    action: 'jump', type: 'pressed',
    sources: [
      { device: 'keyboard', key: 'Space' },
      { device: 'gamepad', kind: 'button', button: 'cross' },
    ]
  },
  {
    action: 'sprint', type: 'held',
    sources: [
      { device: 'keyboard', key: 'ShiftLeft' },
      { device: 'gamepad', kind: 'button', button: 'L3' },
    ]
  },
  {
    action: 'attack', type: 'pressed',
    sources: [
      { device: 'mouse', button: 0 },
      { device: 'gamepad', kind: 'button', button: 'R1' },
    ]
  },
];
```

### How PlayerSystem Uses Actions

`PlayerSystem` reads `ActionState` instead of raw key booleans:

```typescript
// In PlayerSystem.update():
const forward = inputManager.getAction('forward');
const backward = inputManager.getAction('backward');
const left = inputManager.getAction('left');
const right = inputManager.getAction('right');
const jump = inputManager.getAction('jump');
const sprint = inputManager.getAction('sprint');

// Analog-aware movement direction (smooth for controller, binary for keyboard)
player.inputDirection[0] = forward.value - backward.value;
player.inputDirection[1] = right.value - left.value;

// Normalize diagonal
const len = Math.sqrt(player.inputDirection[0] ** 2 + player.inputDirection[1] ** 2);
if (len > 1) {
  player.inputDirection[0] /= len;
  player.inputDirection[1] /= len;
}

player.isRunning = sprint.active;
player.jumpRequested = jump.justPressed;

// Camera orbit from merged mouse + right stick
const camAxes = inputManager.getCameraAxes();
cameraTarget.orbitYaw -= camAxes.deltaX * cameraTarget.yawSensitivity;
cameraTarget.orbitPitch += camAxes.deltaY * cameraTarget.pitchSensitivity;
```

### Analog Speed Modulation

With controller sticks providing 0.0–1.0 values, `CharacterMovementSystem` can
use the analog value for proportional speed instead of binary walk/sprint:

```typescript
// Light stick tilt = slow walk, full tilt = run
const moveIntensity = Math.sqrt(player.inputDirection[0] ** 2 + player.inputDirection[1] ** 2);
const speed = player.moveSpeed + (player.runSpeed - player.moveSpeed) * moveIntensity;
```

Keyboard users still get binary (0 or 1) values, so they use walk/sprint toggle as before.

### Input Node UI — Multi-Device Bindings

The Input Node in the character controller graph shows both keyboard and gamepad bindings:

```
┌─ Input ─────────────────────────────────────────────────┐
│  Mode: TPS                                               │
│                                                          │
│  Actions:                                                │
│  ┌────────────────────────────────────────────────────┐ │
│  │ forward    │ 🔤 W           │ 🎮 Left Stick ↑    │ │
│  │ backward   │ 🔤 S           │ 🎮 Left Stick ↓    │ │
│  │ left       │ 🔤 A           │ 🎮 Left Stick ←    │ │
│  │ right      │ 🔤 D           │ 🎮 Left Stick →    │ │
│  │ sprint     │ 🔤 Shift       │ 🎮 L3              │ │
│  │ jump       │ 🔤 Space       │ 🎮 ✕ (Cross)       │ │
│  │ attack     │ 🖱️ LMB         │ 🎮 R1              │ │
│  │ dodge      │ 🔤 Q           │ 🎮 ○ (Circle)      │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Camera: 🖱️ Mouse (sens: 0.3)  🎮 Right Stick (sens: 3)│
│  Deadzone: [0.15]                                        │
│                                                          │
│  [+ Add Action]                                          │
│                                                          │
│  ○ Intent (out)                                          │
└──────────────────────────────────────────────────────────┘
```

Clicking on a binding cell opens a "press any key/button" capture dialog that detects
which device the user pressed and records the appropriate `InputSource`.

### DualSense-Specific Features via Script Node

Advanced controller features (haptics, adaptive triggers, touchpad, gyroscope) are
accessed through the Script Node, not the Input Node:

```typescript
// scripts/dualsense-haptics.ts
export function update(ctx: ScriptContext) {
  const ds = ctx.input.getProvider?.('dualsense') as DualSenseProvider | null;
  if (!ds?.isConnected()) return;

  // Haptic feedback on landing
  if (ctx.vars.bools.get('justLanded')) {
    ds.controller.left.haptic.intensity = 0.5;
    ds.controller.right.haptic.intensity = 0.5;
    setTimeout(() => {
      ds.controller.left.haptic.intensity = 0;
      ds.controller.right.haptic.intensity = 0;
    }, 100);
  }

  // Adaptive trigger resistance when aiming
  if (ctx.input.isActionHeld('aim')) {
    ds.controller.right.trigger.resistance = [0, 150];
  } else {
    ds.controller.right.trigger.resistance = [0, 0];
  }
}
```

### File Additions

```
src/core/input/
  types.ts                    ← InputSource, InputBinding, ActionState, CameraAxesConfig
  InputProvider.ts            ← InputProvider interface
  KeyboardMouseProvider.ts    ← DOM event-based keyboard + mouse provider
  DualSenseProvider.ts        ← dualsense-ts wrapper (optional, loaded if available)
  GenericGamepadProvider.ts   ← Web Gamepad API fallback (navigator.getGamepads())
```

---

## File Structure

```
src/core/ecs/
  components/
    CameraTargetComponent.ts              ← NEW: TPS orbit camera state
    CharacterControllerComponent.ts       ← NEW: graph + compiled config
    CharacterVarsComponent.ts             ← NEW: runtime variables for conditions
    ScriptComponent.ts                    ← NEW: script instance registry
  systems/
    PlayerSystem.ts                       ← MODIFIED: TPS mouse handling
    CharacterMovementSystem.ts            ← MODIFIED: camera-relative TPS movement
    CameraSystem.ts                       ← MODIFIED: TPS orbit camera computation
    AnimationSystem.ts                    ← MODIFIED: custom transitions + sequences
    ScriptSystem.ts                       ← NEW: per-frame script execution
  types.ts                                ← MODIFIED: new ComponentTypes

src/core/animation/
  types.ts                                ← NEW: state/transition/condition types
  TransitionEvaluator.ts                  ← NEW: condition evaluation logic
  SequencePlayer.ts                       ← NEW: sequence phase tracking
  CharacterControllerGraphEvaluator.ts    ← NEW: graph → component compiler

src/core/input/
  types.ts                                ← NEW: InputSource, InputBinding, ActionState
  InputProvider.ts                        ← NEW: InputProvider interface
  KeyboardMouseProvider.ts                ← NEW: DOM event-based keyboard + mouse
  DualSenseProvider.ts                    ← NEW: dualsense-ts wrapper (optional)
  GenericGamepadProvider.ts               ← NEW: Web Gamepad API fallback

src/core/scripting/
  types.ts                                ← NEW: ScriptContext, ScriptModule interfaces

src/demos/sceneBuilder/
  components/
    panels/
      CharacterControllerPanel/
        CharacterControllerNodeEditor.tsx  ← NEW: React Flow graph editor
        CharacterControllerNodeEditor.module.css
        nodes/
          CharacterNode.tsx               ← NEW
          InputNode.tsx                   ← NEW
          CameraNode.tsx                  ← NEW
          AnimStateMachineNode.tsx        ← NEW
          TerrainNode.tsx                 ← NEW
          ScriptNode.tsx                  ← NEW
          portTypes.ts                    ← NEW: character controller port types
          nodeStyles.module.css           ← NEW
    bridges/
      CharacterControllerBridge.tsx       ← NEW: ECS ↔ graph UI bridge
    panels/ObjectPanel/
      subpanels/
        PlayerSubPanel.tsx                ← MODIFIED: add "Edit Controller" button

  InputManager.ts                         ← MODIFIED: add 'tps' channel

public/scripts/                           ← NEW: user script directory
  camera-sway.ts                          ← EXAMPLE: camera sway/bob script
```

---

## Implementation Phases

### Phase 1: TPS Camera + Input Abstraction + Decoupled Movement (~4-5 days)

Core engine work, no UI changes. Refactors the input system into an action-based
multi-device architecture (Part 9) and makes TPS playable programmatically.

**Files to create:**
- `src/core/ecs/components/CameraTargetComponent.ts`
- `src/core/input/types.ts` — InputSource, InputBinding, ActionState, CameraAxesConfig
- `src/core/input/InputProvider.ts` — InputProvider interface
- `src/core/input/KeyboardMouseProvider.ts` — DOM event-based keyboard + mouse provider
- `src/core/input/DualSenseProvider.ts` — dualsense-ts wrapper (optional)
- `src/core/input/GenericGamepadProvider.ts` — Web Gamepad API fallback

**Files to modify:**
- `src/core/ecs/types.ts` — add `'camera-target'`
- `src/demos/sceneBuilder/InputManager.ts` — refactor to use InputProvider abstraction,
  add `pollAll()`, `getAction()`, `getCameraAxes()`, provider registry
- `src/core/ecs/systems/PlayerSystem.ts` — read ActionState instead of raw keys, TPS orbit
- `src/core/ecs/systems/CharacterMovementSystem.ts` — camera-relative movement, analog
  speed modulation from ActionState.value, smooth character rotation
- `src/core/ecs/systems/CameraSystem.ts` — TPS orbit computation, merged camera axes
  from mouse + right stick, smoothing, terrain collision, sway

**Steps:**
1. Define `InputSource`, `InputBinding`, `ActionState`, `InputProvider` types
2. Create `KeyboardMouseProvider` — wraps existing DOM event listeners from InputManager
   into the provider interface. Always connected.
3. Create `GenericGamepadProvider` — wraps Web Gamepad API (`navigator.getGamepads()`)
   as a fallback for any standard controller.
4. Create `DualSenseProvider` — wraps `dualsense-ts` library (optional, loaded if
   available). Reads buttons, sticks, and triggers via HID.
5. Refactor `InputManager` — add provider registry (`addProvider()`), per-frame
   `pollAll()` that merges all providers into `ActionState` per binding, `getAction()`
   and `getCameraAxes()` APIs. Existing channel-based event routing preserved for
   editor mode; action-based polling used in play mode.
6. Create `CameraTargetComponent` with FPS/TPS mode, orbit params, smoothing, collision, sway
7. Refactor `PlayerSystem`: read `ActionState` instead of raw key booleans. In TPS mode,
   merged camera axes (mouse + right stick) write to `CameraTargetComponent.orbitYaw/Pitch`.
   No pointer lock — always-on orbit.
8. Refactor `CharacterMovementSystem`: use analog `ActionState.value` for proportional
   speed (light stick tilt = slow walk, full tilt = run). Camera-relative movement in TPS.
   Smoothly rotate character model to face movement direction.
9. Extend `CameraSystem`: add TPS orbit path — compute target position from orbit params,
   terrain-collide the camera, apply smoothing, compute sway from velocity, write view matrix.
10. Update `createPlayerEntity` factory to optionally add `CameraTargetComponent`.
11. Default bindings: configure keyboard + gamepad sources for all standard actions.

**Deliverable:** Action-based input system with pluggable providers. Keyboard + controller
both work simultaneously with no code changes. TPS player entity playable programmatically.
WASD/left stick moves relative to camera, character mesh rotates to face movement, camera
orbits via mouse/right stick smoothly, terrain collision works, sway works.

---

### Phase 2: Custom Animation State Machine + Sequences (~3-4 days)

Extend the animation runtime with user-defined states, transition rules, sequence phases.

**Files to create:**
- `src/core/animation/types.ts` — `AnimationStateDefinition`, `TransitionRule`, `TransitionCondition`, `AnimationPhase`
- `src/core/animation/TransitionEvaluator.ts` — condition evaluation logic
- `src/core/ecs/components/CharacterVarsComponent.ts` — runtime variables

**Files to modify:**
- `src/core/ecs/types.ts` — add `'character-vars'`
- `src/core/ecs/components/AnimationComponent.ts` — add `sequencePhaseIndex`, `sequencePhaseTime`
- `src/core/ecs/systems/AnimationSystem.ts` — replace hardcoded state machine with
  configurable transitions + sequence evaluation

**Steps:**
1. Define all type interfaces for states, transitions, conditions, phases
2. Create `CharacterVarsComponent` — holds built-in + custom variables
3. Build `TransitionEvaluator` — evaluates `TransitionCondition` trees against vars
4. Extend `AnimationComponent` with sequence tracking fields
5. Extend `AnimationSystem`:
   a. Write built-in variables to `CharacterVarsComponent` each frame
   b. Replace `updateStateFromPhysics()` with `evaluateTransitions()` using user-defined rules
   c. Add sequence phase evaluation: track current phase, evaluate phase clips, check
      advance conditions, crossfade between phases
   d. Backward compat: if no `CharacterControllerComponent` exists, fall back to the
      existing hardcoded velocity-threshold behavior

**Deliverable:** Can define custom states (including sequences), transition rules with
compound conditions, and input-triggered transitions. Jump with `start→mid→end` phases
works. Backward compatible — entities without controller component use old behavior.

---

### Phase 3: CharacterControllerComponent + Graph Evaluator (~2-3 days)

Data model and the compile-from-graph-to-components pipeline.

**Files to create:**
- `src/core/ecs/components/CharacterControllerComponent.ts`
- `src/core/animation/CharacterControllerGraphEvaluator.ts`

**Files to modify:**
- `src/core/ecs/types.ts` — add `'character-controller'`
- `src/loaders/SceneSerializer.ts` — serialize/deserialize the graph

**Steps:**
1. Create `CharacterControllerComponent` with node graph + compiled config fields
2. Build `CharacterControllerGraphEvaluator`:
   a. Parse the graph nodes and edges
   b. Compile each node's data into the flat config sections
   c. Ensure correct components exist on entity (add/remove)
   d. Sync compiled config → component fields (movement, camera, animation)
   e. Async clip loading during animation sync (with cache + skeleton validation)
3. Add serialization support — the graph serializes as part of the entity's components

**Deliverable:** Can create a `CharacterControllerComponent`, set a graph programmatically,
call `evaluator.evaluate(entity, graph)`, and see all components configured correctly.

---

### Phase 4: Node Graph UI (Dockable Window) (~3-4 days)

React Flow node components, dockable window, persistence.

**Files to create:**
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/CharacterControllerNodeEditor.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/CharacterControllerNodeEditor.module.css`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/CharacterNode.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/InputNode.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/CameraNode.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/AnimStateMachineNode.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/TerrainNode.tsx`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/portTypes.ts`
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/nodeStyles.module.css`
- `src/demos/sceneBuilder/components/bridges/CharacterControllerBridge.tsx`

**Files to modify:**
- `src/demos/sceneBuilder/components/panels/ObjectPanel/subpanels/PlayerSubPanel.tsx` — add "Edit Controller" button
- `src/demos/sceneBuilder/components/app/SceneBuilderApp.tsx` — register dockable window

**Steps:**
1. Create port type definitions for character controller domain
2. Create `CharacterNode` — displays movement/physics params as number inputs
3. Create `InputNode` — mode selector, key binding list, sensitivity slider
4. Create `CameraNode` — mode selector, orbit params, smoothing, sway toggles
5. Create `TerrainNode` — auto-detects terrain entity, shows info
6. Create `AnimStateMachineNode` — states list, transitions list, condition builder,
   clip assignment via AssetPickerModal (the most complex node)
7. Create `CharacterControllerNodeEditor` — React Flow wrapper with toolbar, propagation,
   persistence (debounced save to component, no save on unmount)
8. Create `CharacterControllerBridge` — connects graph UI to ECS via evaluator
9. Wire into PlayerSubPanel — "Edit Controller" opens dockable window
10. Default graph: auto-create Character Node + Input Node + Camera Node connected

**Deliverable:** Full visual node graph editor. Can add nodes, connect ports, configure
parameters, assign clips. Graph persists on the entity component. Evaluator compiles
graph → runtime configuration.

---

### Phase 5: Animation Clip Library + Script System + Integration (~3 days)

Loading clips from separate GLBs, caching, scripting runtime, end-to-end testing.

**Files to create:**
- `src/core/scripting/types.ts` — ScriptContext, ScriptModule, ScriptParam interfaces
- `src/core/ecs/components/ScriptComponent.ts` — ScriptInstance registry
- `src/core/ecs/systems/ScriptSystem.ts` — per-frame script execution with setup/update/teardown lifecycle
- `src/demos/sceneBuilder/components/panels/CharacterControllerPanel/nodes/ScriptNode.tsx` — Script Node UI
- `public/scripts/camera-sway.ts` — example camera sway script

**Files to modify:**
- `server/types/index.ts` — add `'animation'` to `AssetCategory`
- `server/services/AssetIndexer.ts` — add animation DIR_TYPE_HINTS
- `src/core/animation/utils.ts` — add clip caching functions
- `src/core/ecs/types.ts` — add `'script'` to ComponentType
- `src/core/animation/CharacterControllerGraphEvaluator.ts` — handle Script Node compilation
  (ensure ScriptComponent exists, sync script instances from graph)

**Steps:**
1. Add `'animation'` asset category to indexer
2. Implement `loadAnimationClipsCached()` with URL-keyed cache
3. Wire AssetPickerModal in AnimStateMachineNode to load + validate + register clips
4. Create `ScriptContext` / `ScriptModule` type interfaces
5. Create `ScriptComponent` with `ScriptInstance[]` for multiple attached scripts
6. Create `ScriptSystem` at priority 96 — lazy-loads script modules via dynamic `import()`,
   calls `setup()` once on Play Mode enter, `update()` each frame, `teardown()` on exit.
   Builds `ScriptContext` with entity, world, deltaTime, params, vars, input accessor.
7. Create `ScriptNode` UI component — file picker for `.ts` scripts, auto-generated
   parameter controls from script's exported `params` declaration, play-mode-only toggle
8. Extend graph evaluator to compile Script Nodes → ScriptComponent instances
9. Write `camera-sway.ts` example script demonstrating velocity-driven camera modulation
10. End-to-end test: import character → open controller graph → add states → assign clips
    → add Script Node with camera sway → press Play → verify TPS movement + animation
    blending + camera sway driven by script

---

### Phase 6: Polish (~1-2 days)

Play mode integration, UI polish, editor/play toggle.

**Steps:**
1. Play mode: enter/exit with TPS support (hidden cursor, always-on orbit, ESC to exit)
2. Camera sway/bob visualization and tuning
3. Transition rule validation (warn if no path from any state to idle, etc.)
4. Default graph preset for common TPS character setup
5. Documentation in-editor tooltips

---

### Phase Summary

| Phase | What | Effort | Dependencies |
|-------|------|--------|--------------|
| 1 | Input Abstraction + TPS Camera + Decoupled Movement | 4-5 days | Existing player/physics systems |
| 2 | Custom Animation State Machine + Sequences | 3-4 days | Phase 1 (for TPS testing) |
| 3 | CharacterControllerComponent + Graph Evaluator | 2-3 days | Phases 1, 2 |
| 4 | Node Graph UI (Dockable Window) | 3-4 days | Phase 3 |
| 5 | Animation Clip Library + Script System + Integration | 3 days | Phases 3, 4 |
| 6 | Polish | 1-2 days | Phases 1-5 |

**Total: ~16-21 days**

Phases 1-2 are core engine work (can be tested programmatically without UI).
Phase 3 bridges engine ↔ UI.
Phases 4-5 are pure UI/integration.
Phase 6 is polish and testing.
