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
  LODComponent,
  WetnessComponent,
} from './components';

// Systems
export {
  TransformSystem,
  BoundsSystem,
  LODSystem,
  WindSystem,
  WetnessSystem,
  MeshRenderSystem,
  ShadowCasterSystem,
} from './systems';
export type { ShaderVariantGroup } from './systems';

// Entity factories
export {
  createModelEntity,
  createPrimitiveEntity,
  createTerrainEntity,
  createOceanEntity,
  createDirectionalLightEntity,
} from './factories';
export type { ModelEntityMeta, PrimitiveEntityMeta } from './factories';

