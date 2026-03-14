/**
 * sceneActions - Shared scene editing actions
 *
 * Single source of truth for edit operations (duplicate, delete, select all, group, ungroup).
 * Used by both MenuBarBridge (menu clicks) and useKeyboardShortcuts (keyboard).
 *
 * These are plain functions that read the store — no React/Preact hooks involved,
 * so they can be called from any context.
 */

import { getSceneBuilderStore } from './sceneBuilderStore';

/**
 * Duplicate all currently selected entities using World.cloneEntity().
 * Each entity's clonable components are copied; GPU resources are initialized
 * via the onEntityAdded callback. The new clones become the new selection.
 */
export function duplicateSelected(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world || store.selectionCount.value === 0) return;

  const selected = world.getSelectedEntities();
  const newIds: string[] = [];

  for (const entity of selected) {
    const cloned = world.cloneEntity(entity.id);
    if (cloned) {
      newIds.push(cloned.id);
    }
  }

  if (newIds.length > 0) {
    world.selectAll(newIds);
  }
}

/**
 * Delete all currently selected entities.
 */
export function deleteSelected(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world || store.selectionCount.value === 0) return;

  const selectedIds = new Set(world.getSelectedIds());
  for (const id of selectedIds) {
    world.destroyEntity(id);
  }
  // syncFromWorld is called automatically via world.onEntityRemoved callback
}

/**
 * Toggle select all: if everything is selected, clear; otherwise select all.
 */
export function toggleSelectAll(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world) return;

  const allEntities = world.getAllEntities();
  const allSelected = store.selectionCount.value === allEntities.length;

  if (allSelected) {
    world.clearSelection();
  } else {
    world.selectAll(allEntities.map(e => e.id));
  }
}

/**
 * Select all entities (always selects all, no toggle).
 */
export function selectAll(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world) return;

  const allEntities = world.getAllEntities();
  world.selectAll(allEntities.map(e => e.id));
}

/**
 * Group the current selection (requires 2+ selected entities).
 */
export function groupSelection(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world || store.selectionCount.value < 2) return;

  world.createGroupFromSelection();
  store.syncFromWorld();
}

/**
 * Ungroup the current selection.
 */
export function ungroupSelection(): void {
  const store = getSceneBuilderStore();
  const world = store.world;
  if (!world || store.selectionCount.value === 0) return;

  world.ungroupSelection();
  store.syncFromWorld();
}
