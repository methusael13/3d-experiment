// Core ECS primitives
export { Component } from './Component';
export { Entity } from './Entity';
export { System } from './System';
export { World } from './World';
export type { ComponentType, SystemContext } from './types';

// Components
export {
  TransformComponent,
  MeshComponent,
  MaterialComponent,
  BoundsComponent,
  ShadowComponent,
  VisibilityComponent,
  GroupComponent,
  PrimitiveGeometryComponent,
  LightComponent,
  TerrainComponent,
  OceanComponent,
  WindComponent,
  WindSourceComponent,
  LODComponent,
  WetnessComponent,
  PlayerComponent,
  CharacterPhysicsComponent,
  CameraComponent,
  FrustumCullComponent,
  SkeletonComponent,
  AnimationComponent,
  CameraTargetComponent,
  CharacterVarsComponent,
  CharacterControllerComponent,
  ScriptComponent,
} from './components';
export type { AnimationState } from './components';

// Systems
export {
  TransformSystem,
  BoundsSystem,
  LODSystem,
  WindSystem,
  WetnessSystem,
  MeshRenderSystem,
  ShadowCasterSystem,
  PlayerSystem,
  CharacterMovementSystem,
  TerrainCollisionSystem,
  CameraSystem,
  FrustumCullSystem,
  LightingSystem,
  AnimationSystem,
  ScriptSystem,
} from './systems';
export type { ShaderVariantGroup } from './systems';

// Entity factories
export {
  createModelEntity,
  createPrimitiveEntity,
  createTerrainEntity,
  createOceanEntity,
  createDirectionalLightEntity,
  createPointLightEntity,
  createSpotLightEntity,
  createPlayerEntity,
  createTPSPlayerEntity,
  createGlobalWindEntity,
  attachSkeletonAndAnimation,
} from './factories';
export type { ModelEntityMeta, PrimitiveEntityMeta } from './factories';

