# Player System Plan — ECS Extension

> **Prerequisite:** ECS migration (see `docs/ecs-migration-plan.md`) must be complete.
> This plan builds on the Entity-Component-System architecture to add gameplay
> functionality: a third-person player character walking on terrain with WASD controls.

---

## Overview

A player character is just an entity with the right combination of components.
Rendering, shadow casting, and wind effects work automatically through the existing
ECS systems. Only movement, physics, camera, and animation require new player-specific
systems.

```
Entity "Player Character"
  ├── TransformComponent            ← position, rotation on terrain
  ├── MeshComponent                 ← character 3D model (GLB)
  ├── MaterialComponent             ← character materials
  ├── BoundsComponent               ← collision AABB
  ├── ShadowComponent               ← character casts shadow
  ├── PlayerControllerComponent     ← WASD input mapping, move/run speed, jump
  ├── CharacterPhysicsComponent     ← gravity, ground snapping, velocity
  ├── CameraTargetComponent         ← third-person camera follows this entity
  ├── AnimationComponent            ← idle/walk/run/jump animation state
  └── (optional) WindComponent      ← if you want a cloak/hair to sway
```

No existing systems or components are modified. The player entity is rendered by
`MeshRenderSystem`, casts shadows via `ShadowCasterSystem`, and can even have wind
effects via `WindSystem` — all without any player-specific rendering code.

---

## New Components

### PlayerControllerComponent

Maps keyboard input to movement intention. The component holds **processed input state**
(not raw key events), written by `InputSystem` and read by `CharacterMovementSystem`.

```typescript
class PlayerControllerComponent extends Component {
  readonly type = 'player-controller';

  // Movement parameters
  moveSpeed: number = 5.0;          // Walk speed (units/second)
  runSpeed: number = 10.0;          // Sprint speed (units/second, when Shift held)
  rotationSpeed: number = 720;      // Character turn speed (degrees/second)
  jumpForce: number = 8.0;          // Upward impulse on jump

  // Processed input state (written by InputSystem each frame)
  inputDirection: [number, number] = [0, 0];  // [forward/back, left/right], normalized
  isRunning: boolean = false;
  jumpRequested: boolean = false;
}
```

### CharacterPhysicsComponent

Simple character physics: gravity, velocity, ground detection. Not a full rigid body —
just enough for terrain-walking gameplay.

```typescript
class CharacterPhysicsComponent extends Component {
  readonly type = 'character-physics';

  velocity: [number, number, number] = [0, 0, 0];
  gravity: number = -20.0;          // Downward acceleration (units/s²)
  isGrounded: boolean = false;       // True when on terrain surface
  groundHeight: number = 0;         // Terrain height at character's XZ position
  groundNormal: [number, number, number] = [0, 1, 0]; // Terrain normal for slope handling

  // Collision shape (capsule approximation)
  radius: number = 0.3;             // Horizontal collision radius
  height: number = 1.8;             // Character height (feet to head)

  // Damping
  groundFriction: number = 10.0;    // Deceleration when no input on ground
  airDrag: number = 0.5;            // Horizontal deceleration in air
}
```

### CameraTargetComponent

Defines third-person camera behavior. The camera orbits around the entity this is
attached to, with mouse-controlled yaw/pitch.

```typescript
class CameraTargetComponent extends Component {
  readonly type = 'camera-target';

  // Look-at offset (from entity origin, typically head height)
  lookAtOffset: [number, number, number] = [0, 1.5, 0];

  // Orbit parameters
  orbitYaw: number = 0;              // Horizontal angle (degrees)
  orbitPitch: number = 20;           // Vertical angle above horizontal (degrees)
  orbitDistance: number = 5;         // Distance from look-at point

  // Orbit limits
  minPitch: number = -10;
  maxPitch: number = 60;
  minDistance: number = 1.5;
  maxDistance: number = 15;

  // Smoothing
  positionSmoothSpeed: number = 8.0;  // Camera position lerp factor
  rotationSmoothSpeed: number = 12.0; // Camera rotation lerp factor

  // Mouse sensitivity
  yawSensitivity: number = 0.3;     // Degrees per pixel of mouse movement
  pitchSensitivity: number = 0.3;
  zoomSensitivity: number = 0.5;    // Distance per scroll tick

  // Collision (prevent camera from going inside terrain/objects)
  collisionEnabled: boolean = true;
  collisionRadius: number = 0.2;     // Camera collision sphere radius
}
```

### AnimationComponent

Manages skeletal animation state. Determines which animation clip to play based on
character physics state.

```typescript
class AnimationComponent extends Component {
  readonly type = 'animation';

  // Current state
  currentState: 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'land' = 'idle';
  previousState: string = 'idle';
  animationTime: number = 0;

  // Blend
  blendFactor: number = 0;          // 0-1 transition between previous and current
  blendDuration: number = 0.2;      // Seconds to blend between states
  blendTimer: number = 0;

  // Skeletal data (future)
  skeleton: SkeletonData | null = null;
  clips: Map<string, AnimationClip> = new Map();
  boneMatrices: Float32Array | null = null;  // GPU bone buffer data
}
```

---

## New Systems

### InputSystem

**Priority:** 5 (before everything else — input must be read first)

**Required components:** `['player-controller']`

Reads raw keyboard/mouse state from the existing `InputManager` and writes structured
input to `PlayerControllerComponent`. The system does NOT directly modify position or
rotation — it only captures user intention.

```typescript
class InputSystem extends System {
  readonly name = 'input';
  readonly requiredComponents = ['player-controller'] as const;
  priority = 5;

  private inputManager: InputManager;

  constructor(inputManager: InputManager) {
    super();
    this.inputManager = inputManager;
  }

  update(entities: Entity[], dt: number): void {
    for (const entity of entities) {
      const pc = entity.getComponent<PlayerControllerComponent>('player-controller');
      if (!pc) continue;

      // Map WASD to normalized direction vector
      let forward = 0, right = 0;
      if (this.inputManager.isKeyDown('KeyW')) forward += 1;
      if (this.inputManager.isKeyDown('KeyS')) forward -= 1;
      if (this.inputManager.isKeyDown('KeyA')) right -= 1;
      if (this.inputManager.isKeyDown('KeyD')) right += 1;

      // Normalize diagonal movement
      const len = Math.sqrt(forward * forward + right * right);
      if (len > 0) {
        pc.inputDirection = [forward / len, right / len];
      } else {
        pc.inputDirection = [0, 0];
      }

      pc.isRunning = this.inputManager.isKeyDown('ShiftLeft');
      pc.jumpRequested = this.inputManager.wasKeyPressed('Space');
    }
  }
}
```

### CharacterMovementSystem

**Priority:** 20 (after input, before physics resolution)

**Required components:** `['transform', 'player-controller', 'character-physics']`

Converts input direction into world-space movement relative to the camera orientation,
applies speed, gravity, and jump impulse. Updates `TransformComponent.position`.

```typescript
class CharacterMovementSystem extends System {
  readonly name = 'character-movement';
  readonly requiredComponents = ['transform', 'player-controller', 'character-physics'] as const;
  priority = 20;

  update(entities: Entity[], dt: number): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const pc = entity.getComponent<PlayerControllerComponent>('player-controller');
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (!transform || !pc || !physics) continue;

      // 1. Get camera-relative movement direction
      const camera = entity.getComponent<CameraTargetComponent>('camera-target');
      const cameraYaw = camera ? camera.orbitYaw : 0;
      const moveDir = this.getWorldMoveDirection(pc.inputDirection, cameraYaw);

      // 2. Compute horizontal velocity
      const speed = pc.isRunning ? pc.runSpeed : pc.moveSpeed;
      const hasInput = moveDir[0] !== 0 || moveDir[1] !== 0;

      if (hasInput) {
        // Accelerate to target speed
        physics.velocity[0] = moveDir[0] * speed;
        physics.velocity[2] = moveDir[1] * speed;
      } else if (physics.isGrounded) {
        // Decelerate via friction when grounded with no input
        const friction = physics.groundFriction * dt;
        physics.velocity[0] *= Math.max(0, 1 - friction);
        physics.velocity[2] *= Math.max(0, 1 - friction);
      } else {
        // Air drag (slower deceleration)
        const drag = physics.airDrag * dt;
        physics.velocity[0] *= Math.max(0, 1 - drag);
        physics.velocity[2] *= Math.max(0, 1 - drag);
      }

      // 3. Gravity
      if (!physics.isGrounded) {
        physics.velocity[1] += physics.gravity * dt;
      }

      // 4. Jump
      if (pc.jumpRequested && physics.isGrounded) {
        physics.velocity[1] = pc.jumpForce;
        physics.isGrounded = false;
        pc.jumpRequested = false;
      }

      // 5. Integrate position
      transform.position[0] += physics.velocity[0] * dt;
      transform.position[1] += physics.velocity[1] * dt;
      transform.position[2] += physics.velocity[2] * dt;

      // 6. Rotate character to face movement direction
      if (hasInput) {
        const targetYaw = Math.atan2(moveDir[0], moveDir[1]) * (180 / Math.PI);
        const currentEuler = transform.rotation;
        const currentYaw = currentEuler[1];

        // Shortest-path rotation
        let deltaYaw = targetYaw - currentYaw;
        if (deltaYaw > 180) deltaYaw -= 360;
        if (deltaYaw < -180) deltaYaw += 360;

        const maxRotation = pc.rotationSpeed * dt;
        const clampedDelta = Math.max(-maxRotation, Math.min(maxRotation, deltaYaw));
        transform.rotation = [currentEuler[0], currentYaw + clampedDelta, currentEuler[2]];
      }

      transform.dirty = true;
    }
  }

  /**
   * Transform input direction (forward/right) into world-space XZ direction
   * relative to the camera's horizontal orientation.
   */
  private getWorldMoveDirection(
    input: [number, number],
    cameraYaw: number
  ): [number, number] {
    if (input[0] === 0 && input[1] === 0) return [0, 0];

    const rad = cameraYaw * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Camera-relative: forward = into screen, right = screen right
    const worldX = input[1] * cos + input[0] * sin;
    const worldZ = input[1] * -sin + input[0] * cos;

    const len = Math.sqrt(worldX * worldX + worldZ * worldZ);
    return len > 0 ? [worldX / len, worldZ / len] : [0, 0];
  }
}
```

### TerrainCollisionSystem

**Priority:** 25 (after movement, before transform recompute)

**Required components:** `['transform', 'character-physics']`

Samples the terrain heightmap at the character's XZ position and snaps the character
to the ground when falling. Also reads terrain normal for slope handling.

```typescript
class TerrainCollisionSystem extends System {
  readonly name = 'terrain-collision';
  readonly requiredComponents = ['transform', 'character-physics'] as const;
  priority = 25;

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    // Find the terrain entity to sample heightmap
    const terrainEntity = ctx.world.queryFirst('terrain');
    if (!terrainEntity) return;
    const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
    if (!terrain) return;

    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      if (!transform || !physics) continue;

      // Sample terrain height at character's XZ position
      const terrainHeight = terrain.manager.sampleHeight(
        transform.position[0],
        transform.position[2]
      );

      // Sample terrain normal for slope handling
      const terrainNormal = terrain.manager.sampleNormal(
        transform.position[0],
        transform.position[2]
      );

      physics.groundHeight = terrainHeight;
      physics.groundNormal = terrainNormal ?? [0, 1, 0];

      // Ground snapping
      if (transform.position[1] <= terrainHeight) {
        transform.position[1] = terrainHeight;
        physics.velocity[1] = 0;
        physics.isGrounded = true;
      } else {
        // Small tolerance for ground detection (prevent jitter)
        const groundThreshold = 0.05;
        physics.isGrounded = (transform.position[1] - terrainHeight) < groundThreshold;
      }

      transform.dirty = true;
    }
  }
}
```

**Note:** `TerrainManager.sampleHeight(x, z)` and `TerrainManager.sampleNormal(x, z)`
need to be implemented if not already present. These read from the CPU-side heightmap
data to return interpolated height/normal at arbitrary world positions.

### ThirdPersonCameraSystem

**Priority:** 30 (after character position is finalized)

**Required components:** `['transform', 'camera-target']`

Computes the camera position by orbiting around the character at the configured
yaw/pitch/distance, with smooth interpolation and terrain collision.

```typescript
class ThirdPersonCameraSystem extends System {
  readonly name = 'third-person-camera';
  readonly requiredComponents = ['transform', 'camera-target'] as const;
  priority = 30;

  private viewCamera: GPUCamera;
  private inputManager: InputManager;

  // Smoothed camera state
  private currentPosition: [number, number, number] = [0, 5, -5];
  private currentLookAt: [number, number, number] = [0, 0, 0];

  constructor(viewCamera: GPUCamera, inputManager: InputManager) {
    super();
    this.viewCamera = viewCamera;
    this.inputManager = inputManager;
  }

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const cam = entity.getComponent<CameraTargetComponent>('camera-target');
      if (!transform || !cam) continue;

      // 1. Update orbit from mouse input (right-click drag or always-on)
      if (this.inputManager.isMouseButtonDown(2)) { // Right mouse button
        const mouseDelta = this.inputManager.getMouseDelta();
        cam.orbitYaw -= mouseDelta[0] * cam.yawSensitivity;
        cam.orbitPitch += mouseDelta[1] * cam.pitchSensitivity;
        cam.orbitPitch = Math.max(cam.minPitch, Math.min(cam.maxPitch, cam.orbitPitch));
      }

      // 2. Update zoom from scroll wheel
      const scrollDelta = this.inputManager.getScrollDelta();
      if (scrollDelta !== 0) {
        cam.orbitDistance -= scrollDelta * cam.zoomSensitivity;
        cam.orbitDistance = Math.max(cam.minDistance, Math.min(cam.maxDistance, cam.orbitDistance));
      }

      // 3. Compute target look-at point (character position + offset)
      const targetLookAt: [number, number, number] = [
        transform.position[0] + cam.lookAtOffset[0],
        transform.position[1] + cam.lookAtOffset[1],
        transform.position[2] + cam.lookAtOffset[2],
      ];

      // 4. Compute target camera position (orbit around look-at)
      const yawRad = cam.orbitYaw * Math.PI / 180;
      const pitchRad = cam.orbitPitch * Math.PI / 180;

      let targetPosition: [number, number, number] = [
        targetLookAt[0] + Math.sin(yawRad) * Math.cos(pitchRad) * cam.orbitDistance,
        targetLookAt[1] + Math.sin(pitchRad) * cam.orbitDistance,
        targetLookAt[2] + Math.cos(yawRad) * Math.cos(pitchRad) * cam.orbitDistance,
      ];

      // 5. Terrain collision: prevent camera from going below terrain
      if (cam.collisionEnabled) {
        const terrainEntity = ctx.world.queryFirst('terrain');
        if (terrainEntity) {
          const terrain = terrainEntity.getComponent<TerrainComponent>('terrain');
          if (terrain) {
            const cameraTerrainHeight = terrain.manager.sampleHeight(
              targetPosition[0], targetPosition[2]
            );
            const minCameraY = cameraTerrainHeight + cam.collisionRadius;
            if (targetPosition[1] < minCameraY) {
              targetPosition[1] = minCameraY;
            }
          }
        }
      }

      // 6. Smooth interpolation
      const posLerp = 1 - Math.exp(-cam.positionSmoothSpeed * dt);
      const lookLerp = 1 - Math.exp(-cam.rotationSmoothSpeed * dt);

      this.currentPosition[0] += (targetPosition[0] - this.currentPosition[0]) * posLerp;
      this.currentPosition[1] += (targetPosition[1] - this.currentPosition[1]) * posLerp;
      this.currentPosition[2] += (targetPosition[2] - this.currentPosition[2]) * posLerp;

      this.currentLookAt[0] += (targetLookAt[0] - this.currentLookAt[0]) * lookLerp;
      this.currentLookAt[1] += (targetLookAt[1] - this.currentLookAt[1]) * lookLerp;
      this.currentLookAt[2] += (targetLookAt[2] - this.currentLookAt[2]) * lookLerp;

      // 7. Apply to engine camera
      this.viewCamera.setPosition(this.currentPosition);
      this.viewCamera.setLookAt(this.currentLookAt);
    }
  }
}
```

### AnimationSystem

**Priority:** 95 (just before render — after all gameplay logic)

**Required components:** `['character-physics', 'animation']`

Determines which animation state to play based on physics state (velocity, grounded).
Handles state transitions and blend timing. In the future, evaluates skeletal poses
and writes bone matrices to GPU buffers.

```typescript
class AnimationSystem extends System {
  readonly name = 'animation';
  readonly requiredComponents = ['character-physics', 'animation'] as const;
  priority = 95;

  update(entities: Entity[], dt: number): void {
    for (const entity of entities) {
      const physics = entity.getComponent<CharacterPhysicsComponent>('character-physics');
      const anim = entity.getComponent<AnimationComponent>('animation');
      if (!physics || !anim) continue;

      // Determine target animation state from physics
      const horizontalSpeed = Math.sqrt(
        physics.velocity[0] ** 2 + physics.velocity[2] ** 2
      );

      let targetState: AnimationComponent['currentState'];

      if (!physics.isGrounded) {
        targetState = physics.velocity[1] > 0 ? 'jump' : 'fall';
      } else if (horizontalSpeed > 7) {
        targetState = 'run';
      } else if (horizontalSpeed > 0.5) {
        targetState = 'walk';
      } else {
        targetState = 'idle';
      }

      // Handle state transition
      if (targetState !== anim.currentState) {
        anim.previousState = anim.currentState;
        anim.currentState = targetState;
        anim.blendTimer = 0;
        anim.blendFactor = 0;
      }

      // Update blend
      if (anim.blendTimer < anim.blendDuration) {
        anim.blendTimer += dt;
        anim.blendFactor = Math.min(1, anim.blendTimer / anim.blendDuration);
      }

      // Advance animation time
      anim.animationTime += dt;

      // Future: evaluate skeleton pose
      // const currentPose = evaluateClip(anim.clips.get(anim.currentState), anim.animationTime);
      // const previousPose = evaluateClip(anim.clips.get(anim.previousState), anim.animationTime);
      // const blendedPose = blendPoses(previousPose, currentPose, anim.blendFactor);
      // writeBoneMatricesToGPU(anim.boneMatrices, blendedPose);
    }
  }
}
```

---

## System Execution Order

All existing ECS systems continue to run. Player systems slot in at the beginning of
the priority range (5-30) since they affect entity positions before transform/bounds
recomputation:

```
Priority 5   — InputSystem               reads keyboard → writes PlayerControllerComponent
Priority 20  — CharacterMovementSystem    reads input → updates velocity + position
Priority 25  — TerrainCollisionSystem     samples heightmap → snaps to ground
Priority 30  — ThirdPersonCameraSystem    reads character position → updates view camera

        ... existing systems continue unchanged ...

Priority 0   — TransformSystem            recomputes dirty model matrices
Priority 10  — BoundsSystem               updates world AABB
Priority 50  — WindSystem                 wind spring physics
Priority 60  — VegetationSystem           vegetation tile streaming
Priority 80  — LightingSystem             pack light data into GPU buffers
Priority 90  — ShadowCasterSystem         collect shadow casters (includes player!)
Priority 95  — AnimationSystem            determine animation state from physics
Priority 100 — MeshRenderSystem           shader variant selection + GPU upload
```

Note: `TransformSystem` at priority 0 runs **after** gameplay systems at priorities 5-30,
which is correct because the gameplay systems modify `transform.position` and set
`transform.dirty = true`. TransformSystem then recomputes the model matrix from the
updated position/rotation/scale.

---

## What Existing Systems Handle Automatically

The player entity is rendered, shadows, and participates in all engine features without
any special player-specific rendering code:

| Feature | How It Works | Player-Specific Code? |
|---|---|---|
| 3D model rendering | Has `MeshComponent` → `MeshRenderSystem` renders it | ❌ No |
| PBR materials | Has `MaterialComponent` → standard PBR pipeline | ❌ No |
| Shadow casting | Has `ShadowComponent` → `ShadowCasterSystem` + shadow pass | ❌ No |
| Shadow receiving | Shader composition `shadow` feature | ❌ No |
| IBL ambient lighting | Shader composition `ibl` feature | ❌ No |
| Wind on cloak/hair | Add `WindComponent` → `WindSystem` processes it | ❌ No |
| Selection in editor | Entity selection via `World` | ❌ No |
| Serialization | Components serialize themselves | ❌ No |
| WASD movement | `InputSystem` + `CharacterMovementSystem` | ✅ Yes |
| Gravity + jumping | `CharacterPhysicsComponent` + `CharacterMovementSystem` | ✅ Yes |
| Terrain walking | `TerrainCollisionSystem` | ✅ Yes |
| Camera follow | `ThirdPersonCameraSystem` | ✅ Yes |
| Animations | `AnimationSystem` | ✅ Yes (generic for all animated entities) |

---

## Editor Mode vs. Play Mode

In the scene builder (editor mode), the player entity exists as a normal model in the
scene — it renders, casts shadows, can be selected and moved by gizmo. But it doesn't
respond to WASD because the gameplay systems are not registered.

Toggling between editor and play mode is just adding/removing systems:

```typescript
// Enter play mode
function enterPlayMode(world: World, viewCamera: GPUCamera, inputManager: InputManager): void {
  world.addSystem(new InputSystem(inputManager), 5);
  world.addSystem(new CharacterMovementSystem(), 20);
  world.addSystem(new TerrainCollisionSystem(), 25);
  world.addSystem(new ThirdPersonCameraSystem(viewCamera, inputManager), 30);
  world.addSystem(new AnimationSystem(), 95);

  // Optionally: disable editor gizmos, hide UI panels, lock cursor
}

// Exit play mode
function exitPlayMode(world: World): void {
  world.removeSystem('input');
  world.removeSystem('character-movement');
  world.removeSystem('terrain-collision');
  world.removeSystem('third-person-camera');
  world.removeSystem('animation');

  // Restore editor camera, re-enable gizmos, show UI panels
}
```

The entity doesn't change at all. The same `Transform`, `Mesh`, `Material` components
are present in both modes. Only the systems that interpret `PlayerControllerComponent`
are toggled.

---

## Entity Factory Function

```typescript
// src/core/ecs/factories.ts

/**
 * Create a player character entity from a GLB model.
 *
 * @param world - The ECS world
 * @param modelPath - Path to the character GLB model
 * @param spawnPosition - Initial world position (will be snapped to terrain)
 */
async function createPlayerEntity(
  world: World,
  modelPath: string,
  spawnPosition: [number, number, number] = [0, 0, 0],
  getModelUrl?: (path: string) => string
): Promise<Entity> {
  const entity = world.createEntity('Player');

  // Standard renderable components
  entity.addComponent(new TransformComponent(spawnPosition));
  entity.addComponent(new BoundsComponent());
  entity.addComponent(new ShadowComponent({ castsShadow: true }));
  entity.addComponent(new VisibilityComponent());

  // Load character mesh
  const mesh = new MeshComponent({ modelPath });
  await mesh.loadGLB(modelPath, getModelUrl);
  entity.addComponent(mesh);
  entity.addComponent(new MaterialComponent(/* from GLB materials */));

  // Player-specific components
  entity.addComponent(new PlayerControllerComponent({
    moveSpeed: 5.0,
    runSpeed: 10.0,
    jumpForce: 8.0,
  }));

  entity.addComponent(new CharacterPhysicsComponent({
    gravity: -20.0,
    radius: 0.3,
    height: 1.8,
  }));

  entity.addComponent(new CameraTargetComponent({
    lookAtOffset: [0, 1.5, 0],
    orbitDistance: 5,
    orbitPitch: 20,
  }));

  entity.addComponent(new AnimationComponent());

  return entity;
}
```

---

## Future Extensions

These naturally extend the player system using additional components — no changes to
existing systems required:

### NPCs

Replace `PlayerControllerComponent` with `AIControllerComponent`:

```
Entity "NPC Guard"
  ├── TransformComponent
  ├── MeshComponent
  ├── MaterialComponent
  ├── BoundsComponent
  ├── ShadowComponent
  ├── AIControllerComponent         ← patrol waypoints, detection radius
  ├── CharacterPhysicsComponent     ← same physics as player
  ├── AnimationComponent            ← same animation system
  └── (no CameraTargetComponent — NPCs don't control the camera)
```

An `AIMovementSystem` reads `AIControllerComponent` and writes velocity — the same
`TerrainCollisionSystem` and `AnimationSystem` handle the rest.

### Inventory / Health

```
Entity "Player"
  ├── ... existing components ...
  ├── HealthComponent              ← hp, maxHp, invulnerability timer
  ├── InventoryComponent           ← item slots, equipped items
  └── InteractionComponent         ← interact radius, interaction target
```

New `HealthSystem`, `InventorySystem`, `InteractionSystem` process these without
touching movement or rendering.

### Multiplayer (Networked Characters)

```
Entity "Remote Player"
  ├── TransformComponent
  ├── MeshComponent, MaterialComponent
  ├── CharacterPhysicsComponent
  ├── AnimationComponent
  ├── NetworkSyncComponent          ← remote position/state updates
  └── (no PlayerControllerComponent — input comes from network)
```

A `NetworkSyncSystem` reads incoming state and writes to `TransformComponent` +
`CharacterPhysicsComponent`. The same rendering, shadow, and animation systems work.

### Vehicles

```
Entity "Car"
  ├── TransformComponent
  ├── MeshComponent
  ├── VehiclePhysicsComponent       ← wheels, suspension, engine
  ├── VehicleControllerComponent    ← WASD maps to throttle/steer
  ├── CameraTargetComponent         ← camera follows car
  └── SeatComponent                 ← player entity attaches here when entering
```

The player entity's `PlayerControllerComponent` is temporarily disabled, and
`VehicleControllerComponent` takes over WASD input. When exiting, swap back.

---

## Spatial Queries for Gameplay

The ECS `World` exposes BVH-accelerated spatial queries (see ECS migration plan,
Appendix B). These are essential for gameplay systems.

### Usage in CollisionSystem

Instead of testing against every collider in the world, use `queryNearbyWith` to find
only nearby collidable entities:

```typescript
class CollisionSystem extends System {
  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const charEntity of entities) {
      const transform = charEntity.getComponent<TransformComponent>('transform');
      const physics = charEntity.getComponent<CharacterPhysicsComponent>('character-physics');

      // BVH-accelerated: only colliders within 10 units
      const nearbyColliders = ctx.world.queryNearbyWith(
        transform.position, 10, 'collider'
      );

      let highestGround = -Infinity;
      for (const colliderEntity of nearbyColliders) {
        const result = this.testCollision(transform.position, colliderEntity);
        if (result && result.height > highestGround) {
          highestGround = result.height;
        }
      }
      // ... snap to ground ...
    }
  }
}
```

### Usage in AI Detection

NPCs can detect the player using radius queries:

```typescript
class AIDetectionSystem extends System {
  readonly name = 'ai-detection';
  readonly requiredComponents = ['transform', 'ai-controller'] as const;
  priority = 15;

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const npcEntity of entities) {
      const ai = npcEntity.getComponent<AIControllerComponent>('ai-controller');
      const npcPos = npcEntity.getComponent<TransformComponent>('transform').position;

      // Find player within detection radius (BVH-accelerated)
      const nearbyPlayers = ctx.world.queryNearbyWith(
        npcPos, ai.detectionRadius, 'player-controller'
      );

      ai.detectedPlayer = nearbyPlayers.length > 0;
      if (ai.detectedPlayer) {
        const playerPos = nearbyPlayers[0].getComponent<TransformComponent>('transform').position;
        ai.playerLastPosition = [playerPos[0], playerPos[1], playerPos[2]];
      }
    }
  }
}
```

### Usage in Interaction System

Find interactive objects near the player (doors, items, NPCs to talk to):

```typescript
class InteractionSystem extends System {
  readonly name = 'interaction';
  readonly requiredComponents = ['transform', 'interaction'] as const;

  update(entities: Entity[], dt: number, ctx: SystemContext): void {
    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const interaction = entity.getComponent<InteractionComponent>('interaction');

      // Find all interactable entities within reach
      const nearbyInteractables = ctx.world.queryNearbyWith(
        transform.position, interaction.reachDistance, 'interactable'
      );

      interaction.closestTarget = nearbyInteractables.length > 0
        ? nearbyInteractables[0].id
        : null;
    }
  }
}
```

### Available Spatial Queries

| Query | Method | Use Case |
|---|---|---|
| Radius | `world.queryNearby(pos, radius)` | Find all entities nearby |
| Radius + type | `world.queryNearbyWith(pos, radius, 'collider')` | Find nearby colliders only |
| AABB | `world.queryInBounds(aabb)` | Area triggers, frustum culling |
| Raycast | `world.raycast(origin, dir)` | Line-of-sight, projectiles |

All spatial queries use the existing BVH tree in `SceneGraph` — O(log n) not O(n).

---

## File Structure

```
src/core/ecs/
  components/
    PlayerControllerComponent.ts
    CharacterPhysicsComponent.ts
    CameraTargetComponent.ts
    AnimationComponent.ts
  systems/
    InputSystem.ts
    CharacterMovementSystem.ts
    TerrainCollisionSystem.ts
    ThirdPersonCameraSystem.ts
    AnimationSystem.ts
```

---

## Implementation Order

| Step | Effort | Dependencies |
|---|---|---|
| 1. `PlayerControllerComponent` + `InputSystem` | 0.5 day | ECS foundation |
| 2. `CharacterPhysicsComponent` + `CharacterMovementSystem` | 1 day | Step 1 |
| 3. `TerrainCollisionSystem` + `TerrainManager.sampleHeight()` | 1 day | Step 2, terrain entity |
| 4. `CameraTargetComponent` + `ThirdPersonCameraSystem` | 1 day | Step 3 |
| 5. `AnimationComponent` + `AnimationSystem` (state machine only) | 0.5 day | Step 2 |
| 6. Editor/Play mode toggle | 0.5 day | Steps 1-4 |
| 7. Skeletal animation GPU pipeline (future) | 3-5 days | Step 5, shader composition |

**Total (steps 1-6): ~4.5 days** (skeletal animation is a separate future effort)
