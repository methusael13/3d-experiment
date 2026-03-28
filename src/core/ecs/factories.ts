import { vec3 } from 'gl-matrix';
import { World } from './World';
import { Entity } from './Entity';
import { TransformComponent } from './components/TransformComponent';
import { MeshComponent } from './components/MeshComponent';
import { MaterialComponent } from './components/MaterialComponent';
import { BoundsComponent } from './components/BoundsComponent';
import { ShadowComponent } from './components/ShadowComponent';
import { VisibilityComponent } from './components/VisibilityComponent';
import { GroupComponent } from './components/GroupComponent';
import { PrimitiveGeometryComponent } from './components/PrimitiveGeometryComponent';
import { LightComponent } from './components/LightComponent';
import { TerrainComponent } from './components/TerrainComponent';
import { OceanComponent } from './components/OceanComponent';
import { PlayerComponent } from './components/PlayerComponent';
import { CharacterPhysicsComponent } from './components/CharacterPhysicsComponent';
import { CameraComponent } from './components/CameraComponent';
import { CameraTargetComponent } from './components/CameraTargetComponent';
import { SkeletonComponent } from './components/SkeletonComponent';
import { AnimationComponent, type AnimationState } from './components/AnimationComponent';
import type { GLBModel } from '../../loaders/types';
import type { GPUContext } from '../gpu/GPUContext';
import type { TerrainManager, TerrainManagerConfig } from '../terrain';
import type { OceanManager, OceanManagerConfig } from '../ocean';
import type { AABB, PrimitiveType, PrimitiveConfig, PBRMaterial } from '../sceneObjects/types';

// ============================================================================
// Empty Entity Factory
// ============================================================================

/**
 * Create an empty entity with no components.
 * The user can attach components (Transform, FPS Camera, etc.) via the UI.
 */
export function createEmptyEntity(
  world: World,
  options?: {
    name?: string;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Empty');
  entity.addComponent(new TransformComponent());
  return entity;
}

// ============================================================================
// Model Entity Factory
// ============================================================================

/**
 * Metadata stored on a model entity for identification and resource management.
 * Stored as a plain object on the entity (via a tag or user data approach).
 */
export interface ModelEntityMeta {
  modelPath: string;
  objectType: 'model';
}

/**
 * Create a model entity with standard components.
 * Note: GPU resources (mesh upload, texture upload) are NOT handled here —
 * that happens during the MeshComponent integration in Phase 5+.
 * This factory just sets up the ECS entity with correct component data.
 */
export function createModelEntity(
  world: World,
  options: {
    name?: string;
    modelPath: string;
    localBounds?: AABB | null;
    position?: [number, number, number];
    castsShadow?: boolean;
  },
): Entity {
  const entity = world.createEntity(options.name ?? 'Model');

  const transform = entity.addComponent(new TransformComponent());
  if (options.position) {
    vec3.set(transform.position, options.position[0], options.position[1], options.position[2]);
  }

  // MeshComponent holds GPU mesh data for rendering
  const mesh = entity.addComponent(new MeshComponent());
  mesh.modelPath = options.modelPath;

  const material = entity.addComponent(new MaterialComponent());
  // Indicate that the material comp has textures from the model
  material.hasIntrinsicTextures = true;

  const bounds = entity.addComponent(new BoundsComponent());
  if (options.localBounds) {
    bounds.localBounds = options.localBounds;
  }

  const shadow = entity.addComponent(new ShadowComponent());
  shadow.castsShadow = options.castsShadow ?? true;

  entity.addComponent(new VisibilityComponent());
  entity.addComponent(new GroupComponent());

  return entity;
}

// ============================================================================
// Primitive Entity Factory
// ============================================================================

/**
 * Metadata stored on a primitive entity.
 */
export interface PrimitiveEntityMeta {
  primitiveType: PrimitiveType;
  primitiveConfig: PrimitiveConfig;
  objectType: 'primitive';
}

/**
 * Create a primitive entity (cube, plane, sphere) with standard components.
 */
export function createPrimitiveEntity(
  world: World,
  options: {
    primitiveType: PrimitiveType;
    name?: string;
    config?: PrimitiveConfig;
    material?: Partial<PBRMaterial>;
    localBounds?: AABB | null;
  },
): Entity {
  const typeNames: Record<string, string> = {
    cube: 'Cube',
    plane: 'Plane',
    sphere: 'UV Sphere',
  };
  const entity = world.createEntity(options.name ?? typeNames[options.primitiveType] ?? 'Primitive');

  entity.addComponent(new TransformComponent());

  // PrimitiveGeometryComponent holds geometry data for rendering
  entity.addComponent(new PrimitiveGeometryComponent(options.primitiveType, options.config));

  const material = entity.addComponent(new MaterialComponent());
  if (options.material) {
    if (options.material.albedo) material.albedo = options.material.albedo;
    if (options.material.metallic !== undefined) material.metallic = options.material.metallic;
    if (options.material.roughness !== undefined) material.roughness = options.material.roughness;
  }

  const bounds = entity.addComponent(new BoundsComponent());
  if (options.localBounds) {
    bounds.localBounds = options.localBounds;
  }

  entity.addComponent(new ShadowComponent());
  entity.addComponent(new VisibilityComponent());
  entity.addComponent(new GroupComponent());

  return entity;
}

// ============================================================================
// Terrain Entity Factory
// ============================================================================

/**
 * Create a terrain entity that wraps a TerrainManager.
 */
export function createTerrainEntity(
  world: World,
  manager: TerrainManager,
  options?: {
    name?: string;
    canCastShadows?: boolean;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Terrain');

  entity.addComponent(new TransformComponent());

  const terrain = entity.addComponent(new TerrainComponent(manager));
  terrain.canCastShadows = options?.canCastShadows ?? true;

  entity.addComponent(new BoundsComponent());

  const shadow = entity.addComponent(new ShadowComponent());
  shadow.castsShadow = options?.canCastShadows ?? true;

  entity.addComponent(new VisibilityComponent());

  return entity;
}

// ============================================================================
// Ocean Entity Factory
// ============================================================================

/**
 * Create an ocean entity that wraps an OceanManager.
 */
export function createOceanEntity(
  world: World,
  manager: OceanManager,
  options?: {
    name?: string;
    waterLevel?: number;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Ocean');

  entity.addComponent(new TransformComponent());

  const ocean = entity.addComponent(new OceanComponent(manager));
  if (options?.waterLevel !== undefined) {
    ocean.waterLevel = options.waterLevel;
  }

  entity.addComponent(new BoundsComponent());
  entity.addComponent(new VisibilityComponent());

  return entity;
}

// ============================================================================
// Light Entity Factory
// ============================================================================

/**
 * Create a point light entity.
 */
export function createPointLightEntity(
  world: World,
  options?: {
    name?: string;
    position?: [number, number, number];
    color?: [number, number, number];
    intensity?: number;
    range?: number;
    castsShadow?: boolean;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Point Light');

  const transform = entity.addComponent(new TransformComponent());
  if (options?.position) {
    vec3.set(transform.position, options.position[0], options.position[1], options.position[2]);
  }

  const light = entity.addComponent(new LightComponent());
  light.lightType = 'point';
  if (options?.color) light.color = options.color;
  if (options?.intensity !== undefined) light.intensity = options.intensity;
  if (options?.range !== undefined) light.range = options.range;
  light.castsShadow = options?.castsShadow ?? false;

  entity.addComponent(new VisibilityComponent());

  return entity;
}

/**
 * Create a spot light entity.
 */
export function createSpotLightEntity(
  world: World,
  options?: {
    name?: string;
    position?: [number, number, number];
    direction?: [number, number, number];
    color?: [number, number, number];
    intensity?: number;
    range?: number;
    innerConeAngle?: number;
    outerConeAngle?: number;
    castsShadow?: boolean;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Spot Light');

  const transform = entity.addComponent(new TransformComponent());
  if (options?.position) {
    vec3.set(transform.position, options.position[0], options.position[1], options.position[2]);
  }

  const light = entity.addComponent(new LightComponent());
  light.lightType = 'spot';
  if (options?.color) light.color = options.color;
  if (options?.intensity !== undefined) light.intensity = options.intensity;
  if (options?.range !== undefined) light.range = options.range;
  if (options?.innerConeAngle !== undefined) light.innerConeAngle = options.innerConeAngle;
  if (options?.outerConeAngle !== undefined) light.outerConeAngle = options.outerConeAngle;
  if (options?.direction) light.direction = options.direction;
  light.castsShadow = options?.castsShadow ?? false;

  entity.addComponent(new VisibilityComponent());

  return entity;
}

/**
 * Create a directional light entity.
 */
// ============================================================================
// Player Entity Factory
// ============================================================================

/**
 * Create a player entity with the full physics-based movement pipeline.
 *
 * Assembles: TransformComponent, PlayerComponent, CharacterPhysicsComponent,
 * CameraComponent, BoundsComponent, VisibilityComponent.
 *
 * When this entity has a CharacterPhysicsComponent, PlayerSystem (input) delegates
 * movement to CharacterMovementSystem and TerrainCollisionSystem automatically.
 *
 * For FPS mode: the camera is on the same entity, using yaw/pitch from PlayerComponent.
 * The entity position represents the eye position (ground + playerHeight).
 */
export function createPlayerEntity(
  world: World,
  options?: {
    name?: string;
    position?: [number, number, number];
    moveSpeed?: number;
    runSpeed?: number;
    sprintMultiplier?: number;
    jumpForce?: number;
    playerHeight?: number;
    mouseSensitivity?: number;
    gravity?: number;
    groundFriction?: number;
    airDrag?: number;
    fov?: number;
    near?: number;
    far?: number;
    active?: boolean;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Player');

  // Transform: position (eye position = ground + playerHeight)
  const transform = entity.addComponent(new TransformComponent());
  if (options?.position) {
    vec3.set(transform.position, options.position[0], options.position[1], options.position[2]);
  }

  // Player controller: input state, orientation, movement config
  const player = entity.addComponent(new PlayerComponent({
    moveSpeed: options?.moveSpeed,
    runSpeed: options?.runSpeed,
    sprintMultiplier: options?.sprintMultiplier,
    jumpForce: options?.jumpForce,
    playerHeight: options?.playerHeight,
    mouseSensitivity: options?.mouseSensitivity,
  }));
  player.active = options?.active ?? false;

  // Character physics: velocity, gravity, ground detection, collision shape
  entity.addComponent(new CharacterPhysicsComponent({
    gravity: options?.gravity,
    height: options?.playerHeight ?? 1.8,
    groundFriction: options?.groundFriction,
    airDrag: options?.airDrag,
  }));

  // Camera: projection & view matrices for FPS rendering
  entity.addComponent(new CameraComponent({
    fov: options?.fov,
    near: options?.near,
    far: options?.far,
  }));

  // Bounds + Visibility for engine integration
  entity.addComponent(new BoundsComponent());
  entity.addComponent(new VisibilityComponent());

  return entity;
}

/**
 * Create a TPS (third-person) player entity with orbit camera support.
 *
 * Same as createPlayerEntity but also adds a CameraTargetComponent in TPS orbit mode.
 * The camera orbits around the character with smooth interpolation, terrain collision,
 * and optional velocity-driven sway.
 *
 * For TPS mode: the character mesh rotates to face movement direction independently
 * of the camera. WASD/left stick moves relative to the camera orbit yaw.
 */
export function createTPSPlayerEntity(
  world: World,
  options?: {
    name?: string;
    position?: [number, number, number];
    moveSpeed?: number;
    runSpeed?: number;
    sprintMultiplier?: number;
    jumpForce?: number;
    playerHeight?: number;
    gravity?: number;
    groundFriction?: number;
    airDrag?: number;
    fov?: number;
    near?: number;
    far?: number;
    active?: boolean;
    // TPS orbit options
    orbitDistance?: number;
    orbitPitch?: number;
    lookAtOffset?: [number, number, number];
    positionSmoothSpeed?: number;
    rotationSmoothSpeed?: number;
    collisionEnabled?: boolean;
    swayEnabled?: boolean;
  },
): Entity {
  // Create base player entity (includes Transform, Player, Physics, Camera, Bounds, Visibility)
  const entity = createPlayerEntity(world, {
    ...options,
    // Don't pass mouseSensitivity — TPS uses CameraTargetComponent sensitivity instead
  });

  // Override name if not set
  if (!options?.name) {
    entity.name = 'Player (TPS)';
  }

  // Add CameraTargetComponent for TPS orbit
  entity.addComponent(new CameraTargetComponent({
    mode: 'tps-orbit',
    orbitDistance: options?.orbitDistance,
    orbitPitch: options?.orbitPitch,
    lookAtOffset: options?.lookAtOffset,
    positionSmoothSpeed: options?.positionSmoothSpeed,
    rotationSmoothSpeed: options?.rotationSmoothSpeed,
    collisionEnabled: options?.collisionEnabled,
    swayEnabled: options?.swayEnabled,
  }));

  return entity;
}

// ============================================================================
// Light Entity Factories
// ============================================================================

export function createDirectionalLightEntity(
  world: World,
  options?: {
    name?: string;
    color?: [number, number, number];
    intensity?: number;
    azimuth?: number;
    elevation?: number;
    castsShadow?: boolean;
  },
): Entity {
  const entity = world.createEntity(options?.name ?? 'Directional Light');

  entity.addComponent(new TransformComponent());

  const light = entity.addComponent(new LightComponent());
  light.lightType = 'directional';
  if (options?.color) light.color = options.color;
  if (options?.intensity !== undefined) light.intensity = options.intensity;
  if (options?.azimuth !== undefined) light.azimuth = options.azimuth;
  if (options?.elevation !== undefined) light.elevation = options.elevation;
  light.castsShadow = options?.castsShadow ?? true;

  entity.addComponent(new VisibilityComponent());

  return entity;
}

// ============================================================================
// Skeleton & Animation Attachment
// ============================================================================

/**
 * Known clip name patterns mapped to animation states.
 * Case-insensitive matching. First match wins.
 */
const CLIP_NAME_TO_STATE: Array<{ patterns: string[]; state: AnimationState }> = [
  { patterns: ['idle', 'breathing idle', 'standing'],           state: 'idle' },
  { patterns: ['walk', 'walking', 'walk forward'],              state: 'walk' },
  { patterns: ['run', 'running', 'run forward', 'jog', 'jogging'], state: 'run' },
  { patterns: ['jump', 'jumping', 'jump up'],                   state: 'jump' },
  { patterns: ['fall', 'falling', 'fall idle', 'in air'],       state: 'fall' },
  { patterns: ['land', 'landing', 'hard landing'],              state: 'land' },
];

/**
 * Try to auto-map a clip name to an animation state using known patterns.
 * Returns the matched AnimationState or null if no match.
 */
function autoMapClipToState(clipName: string): AnimationState | null {
  const lower = clipName.toLowerCase().trim();
  for (const { patterns, state } of CLIP_NAME_TO_STATE) {
    for (const pattern of patterns) {
      if (lower === pattern || lower === `mixamo.com|${pattern}`) {
        return state;
      }
    }
  }
  return null;
}

/**
 * Attach SkeletonComponent and AnimationComponent to an entity based on
 * a loaded GLBModel's skeleton and animation data.
 *
 * Call this after setting mesh.model on the entity. If the model has no
 * skeleton, this is a no-op — safe to call on any model.
 *
 * Handles:
 * - Creating SkeletonComponent with bone matrices initialized
 * - Creating AnimationComponent with all embedded clips registered
 * - Auto-mapping clip names to animation states (idle/walk/run/jump/fall/land)
 *
 * @param entity - The entity to attach skeleton/animation to
 * @param model - The loaded GLBModel (from loadGLB)
 * @returns true if skeleton was attached, false if model has no skeleton
 */
export function attachSkeletonAndAnimation(entity: Entity, model: GLBModel): boolean {
  if (!model.skeleton) return false;

  // --- SkeletonComponent ---
  const skel = entity.addComponent(new SkeletonComponent());
  skel.skeleton = model.skeleton;
  skel.initBuffers();

  // --- AnimationComponent ---
  if (model.animations && model.animations.length > 0) {
    const anim = entity.addComponent(new AnimationComponent());

    // Register all embedded clips
    for (const clip of model.animations) {
      anim.clips.set(clip.name, clip);
    }

    // Auto-map clip names to animation states
    const mappedStates = new Set<AnimationState>();
    for (const clip of model.animations) {
      const state = autoMapClipToState(clip.name);
      if (state && !mappedStates.has(state)) {
        anim.stateToClip.set(state, clip.name);
        mappedStates.add(state);
      }
    }

    // If only one clip and no state was auto-mapped, default it to 'idle'
    if (model.animations.length === 1 && mappedStates.size === 0) {
      anim.stateToClip.set('idle', model.animations[0].name);
    }

    // When not used as a player character (no CharacterPhysicsComponent),
    // disable auto-state-from-physics so the animation just plays idle in a loop
    anim.autoStateFromPhysics = entity.hasComponent('character-physics');

    console.log(
      `[attachSkeletonAndAnimation] ${entity.name}: ${model.skeleton.joints.length} joints, ` +
      `${model.animations.length} clips, ${mappedStates.size} auto-mapped states` +
      (mappedStates.size > 0 ? ` (${[...mappedStates].join(', ')})` : ''),
    );
  }

  return true;
}
