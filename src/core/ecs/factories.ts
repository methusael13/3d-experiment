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
import type { GPUContext } from '../gpu/GPUContext';
import type { TerrainManager, TerrainManagerConfig } from '../terrain';
import type { OceanManager, OceanManagerConfig } from '../ocean';
import type { AABB, PrimitiveType, PrimitiveConfig, PBRMaterial } from '../sceneObjects/types';

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

  const bounds = entity.addComponent(new BoundsComponent());
  if (options.localBounds) {
    bounds.localBounds = options.localBounds;
  }

  const shadow = entity.addComponent(new ShadowComponent());
  shadow.castsShadow = options.castsShadow ?? false;

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
 * Create a directional light entity.
 */
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