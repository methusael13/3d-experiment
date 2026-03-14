import { mat4, vec3, quat } from 'gl-matrix';
import type { ComponentType, SystemContext } from './types';
import { Entity } from './Entity';
import type { System } from './System';
import { SceneGraph } from '../sceneGraph';
import type { TransformComponent } from './components/TransformComponent';

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

  // ===================== Hierarchy Cache =====================

  /** Cached topological order (parents before children). Invalidated on hierarchy change. */
  private _hierarchyOrderCache: Entity[] | null = null;
  private _hierarchyDirty = true;

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
    this._hierarchyDirty = true;
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
   *
   * @param id - Entity ID to destroy
   * @param options - Optional: { cascade: true } to recursively destroy children.
   *                  Default behavior: unparent children (preserve world transform).
   */
  destroyEntity(id: string, options?: { cascade?: boolean }): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;

    if (options?.cascade) {
      // Recursively destroy all descendants first (depth-first)
      for (const childId of [...entity.childIds]) {
        this.destroyEntity(childId, { cascade: true });
      }
    } else {
      // Unparent children (they become roots, preserving world transform)
      for (const childId of [...entity.childIds]) {
        this.setParent(childId, null, true);
      }
    }

    // Remove from own parent
    if (entity.parentId) {
      const parent = this.entities.get(entity.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter((c) => c !== id);
      }
      entity.parentId = null;
    }

    this.selectedIds.delete(id);
    this._sceneGraph.remove(id);
    this.entities.delete(id);
    this._hierarchyDirty = true;
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

  // ===================== Entity Hierarchy =====================

  /**
   * Set an entity's parent. Pass null to unparent (make root).
   *
   * When preserveWorldTransform is true (default), the child's local
   * transform is recalculated so it maintains its current world position.
   * When false, the child's existing transform values become local-space
   * values relative to the new parent (the entity may visually jump).
   */
  setParent(childId: string, parentId: string | null, preserveWorldTransform: boolean = true): boolean {
    const child = this.entities.get(childId);
    if (!child) return false;

    // Can't parent to self
    if (parentId === childId) return false;

    // Validate parent exists
    if (parentId !== null) {
      const parent = this.entities.get(parentId);
      if (!parent) return false;

      // Cycle detection
      if (this.wouldCreateCycle(childId, parentId)) return false;
    }

    // Get child's current world matrix before reparenting (for preserveWorldTransform)
    let childWorldMatrix: mat4 | null = null;
    if (preserveWorldTransform) {
      const childTransform = child.getComponent<TransformComponent>('transform');
      if (childTransform) {
        childWorldMatrix = mat4.clone(childTransform.modelMatrix);
      }
    }

    // Remove from old parent
    if (child.parentId !== null) {
      const oldParent = this.entities.get(child.parentId);
      if (oldParent) {
        oldParent.childIds = oldParent.childIds.filter((c) => c !== childId);
      }
    }

    // Set new parent
    child.parentId = parentId;

    // Add to new parent's children
    if (parentId !== null) {
      const newParent = this.entities.get(parentId)!;
      if (!newParent.childIds.includes(childId)) {
        newParent.childIds.push(childId);
      }
    }

    // Preserve world transform: decompose inverse(newParent.worldMatrix) × child.worldMatrix
    if (preserveWorldTransform && childWorldMatrix) {
      const childTransform = child.getComponent<TransformComponent>('transform');
      if (childTransform) {
        if (parentId !== null) {
          const parentEntity = this.entities.get(parentId)!;
          const parentTransform = parentEntity.getComponent<TransformComponent>('transform');
          if (parentTransform) {
            const invParent = mat4.create();
            mat4.invert(invParent, parentTransform.modelMatrix);
            const localMatrix = mat4.create();
            mat4.multiply(localMatrix, invParent, childWorldMatrix);
            this._decomposeMatrix(localMatrix, childTransform);
          }
        } else {
          // Unparenting to root — decompose world matrix back to TRS
          this._decomposeMatrix(childWorldMatrix, childTransform);
        }
        childTransform.dirty = true;
      }
    } else {
      // Even without preserving, mark dirty so hierarchy is recomputed
      const childTransform = child.getComponent<TransformComponent>('transform');
      if (childTransform) {
        childTransform.dirty = true;
      }
    }

    this._hierarchyDirty = true;
    return true;
  }

  /**
   * Decompose a 4×4 matrix into position/rotation/scale and write to TransformComponent.
   */
  private _decomposeMatrix(m: mat4, transform: TransformComponent): void {
    // Extract translation
    vec3.set(transform.position, m[12], m[13], m[14]);

    // Extract scale from column vectors
    const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
    const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
    const sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
    vec3.set(transform.scale, sx, sy, sz);

    // Extract rotation by removing scale from the rotation matrix
    const rotMat = mat4.create();
    if (sx > 0) { rotMat[0] = m[0] / sx; rotMat[1] = m[1] / sx; rotMat[2] = m[2] / sx; }
    if (sy > 0) { rotMat[4] = m[4] / sy; rotMat[5] = m[5] / sy; rotMat[6] = m[6] / sy; }
    if (sz > 0) { rotMat[8] = m[8] / sz; rotMat[9] = m[9] / sz; rotMat[10] = m[10] / sz; }
    rotMat[15] = 1;

    mat4.getRotation(transform.rotationQuat, rotMat);
    quat.normalize(transform.rotationQuat, transform.rotationQuat);
  }

  /**
   * Get the parent entity of a given entity, or null if it's a root.
   */
  getParent(entityId: string): Entity | null {
    const entity = this.entities.get(entityId);
    if (!entity || !entity.parentId) return null;
    return this.entities.get(entity.parentId) ?? null;
  }

  /**
   * Get direct children of an entity.
   */
  getChildren(entityId: string): Entity[] {
    const entity = this.entities.get(entityId);
    if (!entity) return [];
    const result: Entity[] = [];
    for (const childId of entity.childIds) {
      const child = this.entities.get(childId);
      if (child) result.push(child);
    }
    return result;
  }

  /**
   * Get all descendants of an entity (recursive).
   */
  getDescendants(entityId: string): Entity[] {
    const result: Entity[] = [];
    const entity = this.entities.get(entityId);
    if (!entity) return result;

    const stack = [...entity.childIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const child = this.entities.get(id);
      if (child) {
        result.push(child);
        stack.push(...child.childIds);
      }
    }
    return result;
  }

  /**
   * Get all root entities (entities with no parent).
   */
  getRootEntities(): Entity[] {
    const result: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (entity.parentId === null) {
        result.push(entity);
      }
    }
    return result;
  }

  /**
   * Get entities in topological order (parents before children).
   * Used by TransformSystem for correct matrix propagation.
   * Cached and only recomputed when hierarchy changes.
   */
  getHierarchyOrder(): Entity[] {
    if (!this._hierarchyDirty && this._hierarchyOrderCache) {
      return this._hierarchyOrderCache;
    }

    const result: Entity[] = [];
    const roots = this.getRootEntities();

    // BFS: process parents before children
    const queue = [...roots];
    while (queue.length > 0) {
      const entity = queue.shift()!;
      result.push(entity);
      for (const childId of entity.childIds) {
        const child = this.entities.get(childId);
        if (child) queue.push(child);
      }
    }

    this._hierarchyOrderCache = result;
    this._hierarchyDirty = false;
    return result;
  }

  /**
   * Check if making parentId the parent of childId would create a cycle.
   * Walks ancestors of the proposed parent to see if childId is found.
   */
  wouldCreateCycle(childId: string, parentId: string): boolean {
    let current: string | null = parentId;
    while (current !== null) {
      if (current === childId) return true;
      const entity = this.entities.get(current);
      if (!entity) break;
      current = entity.parentId;
    }
    return false;
  }

  /**
   * Get the depth of an entity in the hierarchy (0 for root).
   */
  getDepth(entityId: string): number {
    let depth = 0;
    let current: string | null = this.entities.get(entityId)?.parentId ?? null;
    while (current !== null) {
      depth++;
      const entity = this.entities.get(current);
      if (!entity) break;
      current = entity.parentId;
    }
    return depth;
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

  // ===================== Spatial Queries =====================

  /**
   * Find all entities within a radius of a point.
   * BVH-accelerated via the scene graph, then resolves node IDs to entities.
   *
   * @param center - Query center point [x, y, z]
   * @param radius - Search radius in world units
   * @returns Entities whose world AABB intersects the query sphere
   */
  queryNearby(center: [number, number, number], radius: number): Entity[] {
    const nodes = this._sceneGraph.queryNearby(center, radius);
    const results: Entity[] = [];
    for (const node of nodes) {
      const entity = this.entities.get(node.id);
      if (entity) results.push(entity);
    }
    return results;
  }

  /**
   * Find all entities within a radius that have a specific component type.
   * Combines BVH spatial query with ECS component filtering.
   *
   * @param center - Query center point [x, y, z]
   * @param radius - Search radius in world units
   * @param componentType - Required component type for returned entities
   * @returns Entities within radius that have the specified component
   */
  queryNearbyWith(center: [number, number, number], radius: number, componentType: ComponentType): Entity[] {
    const nodes = this._sceneGraph.queryNearby(center, radius);
    const results: Entity[] = [];
    for (const node of nodes) {
      const entity = this.entities.get(node.id);
      if (entity && entity.hasComponent(componentType)) {
        results.push(entity);
      }
    }
    return results;
  }

  /**
   * Find all entities visible within a camera frustum.
   * BVH-accelerated: prunes branches whose bounding boxes are fully outside the frustum.
   *
   * @param vpMatrix - View-projection matrix (column-major Float32Array, from gl-matrix)
   * @returns Entities whose world AABB intersects or is inside the frustum
   */
  queryFrustum(vpMatrix: Float32Array | number[]): Entity[] {
    const nodes = this._sceneGraph.queryFrustum(vpMatrix);
    const results: Entity[] = [];
    for (const node of nodes) {
      const entity = this.entities.get(node.id);
      if (entity) results.push(entity);
    }
    return results;
  }

  /**
   * Cast a ray through the scene, return the closest hit entity.
   * BVH-accelerated via the scene graph.
   *
   * @param origin - Ray origin [x, y, z]
   * @param direction - Ray direction [x, y, z] (will be normalized)
   * @returns Object with entity, distance, and hitPoint — or null if no hit
   */
  raycast(origin: [number, number, number], direction: [number, number, number]): { entity: Entity; distance: number; hitPoint: [number, number, number] } | null {
    const hit = this._sceneGraph.castRay(origin as any, direction as any);
    if (!hit) return null;
    const entity = this.entities.get(hit.node.id);
    if (!entity) return null;
    return {
      entity,
      distance: hit.distance,
      hitPoint: [hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]],
    };
  }

  // ===================== Entity Cloning =====================

  /**
   * Clone an entity: creates a new entity with cloned copies of all clonable components.
   * Components that implement clone() are duplicated; components without clone() are skipped
   * (e.g., singleton managers like TerrainComponent, OceanComponent).
   *
   * The new entity's TransformComponent position is offset by +1 on X to avoid overlapping.
   * Returns the new entity, or null if cloning failed.
   */
  cloneEntity(sourceId: string): Entity | null {
    const source = this.entities.get(sourceId);
    if (!source) return null;

    // Create entity directly (bypassing createEntity) so we can add all
    // cloned components BEFORE firing onEntityAdded — the callback needs
    // to see mesh/primitive data to initialize GPU resources.
    const newEntity = new Entity(source.name + ' Copy');

    let skippedCount = 0;
    for (const component of source.getComponents()) {
      if (typeof component.clone === 'function') {
        const cloned = component.clone();
        if (cloned) {
          newEntity.addComponent(cloned);
        } else {
          skippedCount++;
        }
      } else {
        skippedCount++;
      }
    }

    if (skippedCount > 0) {
      console.log(`[World.cloneEntity] Skipped ${skippedCount} non-clonable component(s) on "${source.name}"`);
    }

    // Offset position so the clone doesn't overlap the original
    const transform = newEntity.getComponent<TransformComponent>('transform');
    if (transform) {
      transform.position[0] += 1;
      transform.dirty = true;
    }

    // Now register with the world and fire onEntityAdded (entity has all components)
    this.entities.set(newEntity.id, newEntity);
    this._sceneGraph.add(newEntity.id, {
      localBounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    });
    this._hierarchyDirty = true;
    this.onEntityAdded?.(newEntity);

    return newEntity;
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