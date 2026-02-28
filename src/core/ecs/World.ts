import type { ComponentType, SystemContext } from './types';
import { Entity } from './Entity';
import type { System } from './System';
import { SceneGraph } from '../sceneGraph';

/**
 * The World is the top-level container that manages entities and systems.
 * It replaces Scene as the central scene management class.
 */
export class World {
  private entities = new Map<string, Entity>();
  private systems: System[] = [];

  /** Entities marked for deletion — actual destroy() deferred to flushPendingDeletions() */
  private pendingDeletions: Entity[] = [];

  /** Spatial index for raycasting. Automatically synced with entity transforms. */
  private _sceneGraph: SceneGraph = new SceneGraph();

  // ===================== Selection State =====================

  private selectedIds = new Set<string>();

  // ===================== Lifecycle Callbacks =====================

  /** Called after an entity is created/added */
  onEntityAdded: ((entity: Entity) => void) | null = null;
  /** Called after an entity is removed/destroyed */
  onEntityRemoved: ((id: string) => void) | null = null;
  /** Called when selection changes */
  onSelectionChanged: (() => void) | null = null;

  // ===================== Entity Management =====================

  /**
   * Create a new entity and add it to the world.
   */
  createEntity(name?: string): Entity {
    const entity = new Entity(name);
    this.entities.set(entity.id, entity);
    // Add to spatial index with default bounds (will be updated by BoundsSystem)
    this._sceneGraph.add(entity.id, {
      localBounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    });
    this.onEntityAdded?.(entity);
    return entity;
  }

  /**
   * Add an externally-created entity to the world.
   */
  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.onEntityAdded?.(entity);
  }

  /**
   * Mark an entity for deletion. The entity is immediately removed from
   * queries, selection, and the scene graph, but actual GPU resource
   * cleanup (entity.destroy()) is deferred until flushPendingDeletions()
   * is called — typically after the render frame submits GPU commands.
   * This prevents "destroyed texture used in a submit" crashes.
   */
  destroyEntity(id: string): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;
    this.selectedIds.delete(id);
    this._sceneGraph.remove(id);
    this.entities.delete(id);
    this.onEntityRemoved?.(id);
    // Defer actual GPU resource cleanup
    this.pendingDeletions.push(entity);
    return true;
  }

  /**
   * Flush pending entity deletions — call after GPU frame submission.
   * This runs entity.destroy() on all entities that were marked for
   * deletion since the last flush, safely releasing GPU resources
   * after the render commands referencing them have been submitted.
   */
  flushPendingDeletions(): void {
    if (this.pendingDeletions.length === 0) return;
    for (const entity of this.pendingDeletions) {
      entity.destroy();
    }
    this.pendingDeletions.length = 0;
  }

  /**
   * Get an entity by ID.
   */
  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Get all entities as an array.
   */
  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get entity count.
   */
  get entityCount(): number {
    return this.entities.size;
  }

  /**
   * Get the scene graph (spatial index for raycasting).
   */
  get sceneGraph(): SceneGraph {
    return this._sceneGraph;
  }

  /**
   * Set an entity's worldBounds in the scene graph (single source of truth from BoundsComponent).
   * Called by BoundsSystem after computing worldBounds.
   */
  setSceneGraphWorldBounds(entityId: string, worldBounds: { min: any; max: any }): void {
    this._sceneGraph.setWorldBounds(entityId, worldBounds);
  }

  // ===================== Selection =====================

  /**
   * Select an entity by ID.
   */
  select(id: string, options?: { additive?: boolean }): void {
    if (!this.entities.has(id)) return;
    if (!options?.additive) {
      this.selectedIds.clear();
    }
    this.selectedIds.add(id);
    this.onSelectionChanged?.();
  }

  /**
   * Select multiple entities.
   */
  selectAll(ids: string[]): void {
    this.selectedIds.clear();
    for (const id of ids) {
      if (this.entities.has(id)) {
        this.selectedIds.add(id);
      }
    }
    this.onSelectionChanged?.();
  }

  /**
   * Clear selection.
   */
  clearSelection(): void {
    if (this.selectedIds.size === 0) return;
    this.selectedIds.clear();
    this.onSelectionChanged?.();
  }

  /**
   * Get selected entity IDs.
   */
  getSelectedIds(): Set<string> {
    return this.selectedIds;
  }

  /**
   * Get selected entities.
   */
  getSelectedEntities(): Entity[] {
    const result: Entity[] = [];
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (entity) result.push(entity);
    }
    return result;
  }

  /**
   * Check if an entity is selected.
   */
  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  // ===================== Query =====================

  /**
   * Query entities that have ALL of the specified component types.
   * This is the primary ECS query operation.
   *
   * For our scale (~100s of entities), linear scan is fine.
   * Can be upgraded to archetype-based indexing if needed later.
   */
  query(...componentTypes: ComponentType[]): Entity[] {
    const results: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.hasAll(...componentTypes)) {
        results.push(entity);
      }
    }
    return results;
  }

  /**
   * Query and return the first matching entity, or undefined.
   */
  queryFirst(...componentTypes: ComponentType[]): Entity | undefined {
    for (const entity of this.entities.values()) {
      if (entity.hasAll(...componentTypes)) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * Query entities that have ANY of the specified component types.
   */
  queryAny(...componentTypes: ComponentType[]): Entity[] {
    const results: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.hasAny(...componentTypes)) {
        results.push(entity);
      }
    }
    return results;
  }

  // ===================== System Management =====================

  /**
   * Add a system to the world. Systems are sorted by priority (lower = earlier).
   */
  addSystem(system: System, priority?: number): void {
    if (priority !== undefined) {
      system.priority = priority;
    }
    this.systems.push(system);
    this.systems.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a system by name.
   */
  removeSystem(name: string): boolean {
    const index = this.systems.findIndex((s) => s.name === name);
    if (index === -1) return false;
    const system = this.systems[index];
    system.destroy?.();
    this.systems.splice(index, 1);
    return true;
  }

  /**
   * Get a system by name.
   */
  getSystem<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  /**
   * Get all registered systems.
   */
  getSystems(): readonly System[] {
    return this.systems;
  }

  // ===================== Update Loop =====================

  /**
   * Run all enabled systems for this frame.
   * Each system receives only the entities that match its required components.
   */
  update(deltaTime: number, context: SystemContext): void {
    for (const system of this.systems) {
      if (!system.enabled) continue;

      // Query matching entities for this system
      const matching = this.query(...system.requiredComponents);
      if (matching.length > 0 || system.requiredComponents.length === 0) {
        system.update(matching, deltaTime, context);
      }
    }
  }

  // ===================== Groups =====================

  private groups = new Map<string, { name: string; childIds: Set<string> }>();
  private nextGroupId = 1;

  /**
   * Create a group from entity IDs. Returns the group ID.
   */
  createGroup(entityIds: string[], name?: string): string {
    const groupId = `group-${this.nextGroupId++}`;
    const childIds = new Set<string>();
    for (const id of entityIds) {
      const entity = this.entities.get(id);
      if (entity) {
        childIds.add(id);
        // Set GroupComponent.groupId if entity has GroupComponent
        const groupComp = entity.getComponent<any>('group');
        if (groupComp) {
          groupComp.groupId = groupId;
        }
      }
    }
    this.groups.set(groupId, { name: name ?? `Group ${this.nextGroupId - 1}`, childIds });
    return groupId;
  }

  /**
   * Remove a group (ungroup). Clears GroupComponent.groupId on member entities.
   */
  removeGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const id of group.childIds) {
      const entity = this.entities.get(id);
      if (entity) {
        const groupComp = entity.getComponent<any>('group');
        if (groupComp) {
          groupComp.groupId = undefined;
        }
      }
    }
    this.groups.delete(groupId);
  }

  /**
   * Get all groups.
   */
  getAllGroups(): Map<string, { name: string; childIds: Set<string> }> {
    return this.groups;
  }

  /**
   * Create a group from currently selected entities.
   */
  createGroupFromSelection(): string | null {
    const ids = Array.from(this.selectedIds);
    if (ids.length < 2) return null;
    return this.createGroup(ids);
  }

  /**
   * Ungroup all selected entities (remove their groups).
   */
  ungroupSelection(): void {
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (entity) {
        const groupComp = entity.getComponent<any>('group');
        if (groupComp?.groupId) {
          this.removeGroup(groupComp.groupId);
        }
      }
    }
  }

  // ===================== Lifecycle =====================

  /**
   * Destroy all entities and systems.
   */
  destroy(): void {
    // Destroy systems first (they may reference entities)
    for (const system of this.systems) {
      system.destroy?.();
    }
    this.systems = [];

    // Destroy all entities
    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();
  }
}