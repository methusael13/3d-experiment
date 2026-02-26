/**
 * ECS Utility Hooks for Preact UI components.
 *
 * These hooks provide a bridge between the ECS World and the Preact signal-based
 * UI layer. They allow bridge files and panels to read ECS component data
 * using familiar patterns.
 *
 * Phase 7 of the ECS migration plan. These are additive — existing hooks
 * continue to work alongside these new ones during incremental migration.
 */

import { computed, type ReadonlySignal } from '@preact/signals';
import type { Entity } from '../../../../core/ecs/Entity';
import type { Component } from '../../../../core/ecs/Component';
import type { ComponentType } from '../../../../core/ecs/types';
import type { World } from '../../../../core/ecs/World';
import { getSceneBuilderStore } from '../state';

/**
 * Get the ECS World from the store's WorldSceneAdapter (if available).
 * Returns null during the migration period before World is wired in.
 */
export function getWorld(): World | null {
  const store = getSceneBuilderStore();
  // During migration, world may be on viewport or adapter
  // This accessor will be updated when Viewport creates the World
  const viewport = store.viewport;
  return (viewport as any)?.world ?? null;
}

/**
 * Get an entity by ID from the World.
 *
 * @param id - Entity ID
 * @returns The entity, or undefined if not found or World not available
 */
export function useEntity(id: string | null | undefined): Entity | undefined {
  if (!id) return undefined;
  const world = getWorld();
  return world?.getEntity(id);
}

/**
 * Get a typed component from an entity.
 *
 * @param entityId - Entity ID
 * @param type - Component type to retrieve
 * @returns The component, or undefined if not present
 */
export function useComponent<T extends Component>(
  entityId: string | null | undefined,
  type: ComponentType,
): T | undefined {
  const entity = useEntity(entityId);
  return entity?.getComponent<T>(type);
}

/**
 * Query entities from the World by component types.
 *
 * @param types - Component types to query for (entities must have ALL)
 * @returns Array of matching entities, or empty array if World not available
 */
export function useQuery(...types: ComponentType[]): Entity[] {
  const world = getWorld();
  if (!world) return [];
  return world.query(...types);
}

/**
 * Query for the first entity matching the given component types.
 *
 * @param types - Component types to query for
 * @returns First matching entity, or undefined
 */
export function useQueryFirst(...types: ComponentType[]): Entity | undefined {
  const world = getWorld();
  return world?.queryFirst(...types);
}

/**
 * Check if an entity has a specific component.
 * Useful for type-guard style checks in bridge code.
 *
 * Replaces patterns like:
 *   isModelObject(obj) → hasComponent(entityId, 'mesh')
 *   isPrimitiveObject(obj) → hasComponent(entityId, 'primitive-geometry')
 *   obj instanceof OceanSceneObject → hasComponent(entityId, 'ocean')
 */
export function hasComponent(
  entityId: string | null | undefined,
  type: ComponentType,
): boolean {
  const entity = useEntity(entityId);
  return entity?.hasComponent(type) ?? false;
}