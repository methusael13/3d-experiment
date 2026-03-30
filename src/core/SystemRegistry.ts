/**
 * SystemRegistry — Default ECS system registration
 *
 * Extracts the ~80-line system registration block from Viewport.ts into a
 * reusable function. Both the scene builder editor and a hypothetical game
 * runtime can call registerDefaultSystems() to get the standard system set.
 *
 * @see docs/engine-extraction-plan.md — Phase 1.4
 */

import { World } from './ecs/World';
import {
  TransformSystem,
  BoundsSystem,
  WindSystem,
  ShadowCasterSystem,
  MeshRenderSystem,
  LODSystem,
  WetnessSystem,
  SSRSystem,
  ReflectionProbeSystem,
  PlayerSystem,
  CharacterMovementSystem,
  TerrainCollisionSystem,
  CameraSystem,
  FrustumCullSystem,
  LightingSystem,
  AnimationSystem,
  VegetationInstanceSystem,
} from './ecs/systems';
import { FrustumCullComponent } from './ecs/components/FrustumCullComponent';
import { createDirectionalLightEntity } from './ecs/factories';
import { ActionInputManager, GenericGamepadProvider, KeyboardMouseProvider } from './input';

/**
 * Options for system registration.
 */
export interface SystemRegistryOptions {
  /**
   * Input manager for PlayerSystem. Required for player input handling.
   * If not provided, PlayerSystem will not have direct input — you can
   * still wire it up later via playerSystem.setInputManager().
   */
  inputManager?: any; // InputManager from demos — loosely typed to avoid demo import
}

/**
 * Register the default set of engine systems on a World in the correct
 * priority order. This is the canonical system registration that was
 * previously embedded in Viewport.ts constructor.
 *
 * Priority order:
 *   PlayerSystem(5) → TransformSystem(7) → BoundsSystem(10) →
 *   LODSystem(10) → CharacterMovementSystem(20) → TerrainCollisionSystem(25) →
 *   CameraSystem(30) → WindSystem(50) → WetnessSystem(55) →
 *   LightingSystem(80) → FrustumCullSystem(85) → ShadowCasterSystem(90) →
 *   AnimationSystem(95) → VegetationInstanceSystem(95) → SSRSystem(95) →
 *   ReflectionProbeSystem(96) → MeshRenderSystem(100)
 *
 * Also creates:
 *   - FrustumCull singleton entity (internal)
 *   - Default "__Sun" directional light entity (internal)
 *
 * @param world - The ECS World to register systems on
 * @param options - Optional configuration (input manager, etc.)
 */
export function registerDefaultSystems(world: World, options?: SystemRegistryOptions): void {
  // ── Player system (priority 5) ──
  // Persistent, no-ops until enter() is called.
  // Runs first to write position/rotation to TransformComponent before hierarchy propagation.
  const playerSystem = new PlayerSystem(options?.inputManager);
  playerSystem.initialize?.();
  world.addSystem(playerSystem);

  // Wire up ActionInputManager with keyboard + gamepad providers
  {
    const actionInput = new ActionInputManager();
    actionInput.addProvider(new KeyboardMouseProvider());
    actionInput.addProvider(new GenericGamepadProvider());
    playerSystem.setActionInputManager(actionInput);
  }

  // ── Character movement system (priority 20) ──
  // Converts input + physics into position changes.
  // Only runs on entities with CharacterPhysicsComponent.
  world.addSystem(new CharacterMovementSystem());

  // ── Terrain collision system (priority 25) ──
  // Samples heightmap, snaps to ground, detects grounding.
  world.addSystem(new TerrainCollisionSystem());

  // ── Camera system (priority 30) ──
  // Computes view/projection matrices from transform + player orientation.
  // Runs AFTER CharacterMovementSystem and TerrainCollisionSystem.
  world.addSystem(new CameraSystem());

  // ── Transform system (priority 7) ──
  // Propagates parent-child hierarchy AFTER player writes position.
  const transformSystem = new TransformSystem();
  transformSystem.world = world;
  transformSystem.priority = 7;
  world.addSystem(transformSystem);

  // ── Bounds system (priority 10) ──
  const boundsSystem = new BoundsSystem();
  boundsSystem.world = world;
  world.addSystem(boundsSystem);

  // ── LOD system (priority 10) ──
  world.addSystem(new LODSystem());

  // ── Wind system (priority 50) ──
  world.addSystem(new WindSystem());

  // ── Wetness system (priority 55) ──
  const wetnessSystem = new WetnessSystem();
  wetnessSystem.setWorld(world);
  world.addSystem(wetnessSystem);

  // ── Frustum cull system (priority 85) ──
  const frustumCullSystem = new FrustumCullSystem();
  world.addSystem(frustumCullSystem);

  // Create singleton entity for frustum cull data (internal = hidden from UI)
  const frustumCullEntity = world.createEntity('__FrustumCull');
  frustumCullEntity.internal = true;
  frustumCullEntity.addComponent(new FrustumCullComponent());

  // ── Lighting system (priority 80) ──
  world.addSystem(new LightingSystem());

  // ── Shadow caster system (priority 90) ──
  world.addSystem(new ShadowCasterSystem());

  // ── Animation system (priority 95) ──
  world.addSystem(new AnimationSystem());

  // ── Vegetation instance system (priority 95) ──
  world.addSystem(new VegetationInstanceSystem());

  // ── SSR system (priority 95) ──
  world.addSystem(new SSRSystem());

  // ── Reflection probe system (priority 96) ──
  world.addSystem(new ReflectionProbeSystem());

  // ── Mesh render system (priority 100) ──
  world.addSystem(new MeshRenderSystem());

  // ── Create default "Sun" directional light entity ──
  const sunEntity = createDirectionalLightEntity(world, {
    name: '__Sun',
    azimuth: 45,
    elevation: 45,
    castsShadow: true,
  });
  sunEntity.internal = true;
}
