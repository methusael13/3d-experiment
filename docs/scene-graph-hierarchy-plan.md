# Scene Graph Transform Hierarchy — Design Document

## 1. Overview

This document describes how to add parent-child entity hierarchy to the ECS, enabling transform inheritance (children move/rotate with their parents). This is separate from the existing flat grouping system in `World.ts`, which remains a selection/organizational convenience with no transform semantics.

### Motivating Use Cases

| Use Case | Parent | Child |
|----------|--------|-------|
| Player torch | FPS Camera entity | Spot light entity (offset lower-right) |
| Lantern on a building | House mesh entity | Point light entity |
| Weapon in hand | Player entity | Sword mesh entity |
| Particle emitter on vehicle | Vehicle entity | Particle system entity |
| Chandelier | Ceiling entity | Multiple point light entities |
| Camera rig | Empty pivot entity | Camera entity (orbiting) |

---

## 2. UI User Workflow

### 2.1 Objects Panel — Tree View

The Objects Panel (`ObjectsPanel.tsx`) currently shows a flat list of entities. With hierarchy it becomes a collapsible tree:

```
▼ 🏠 Mountain House
▼ 🎮 Player
    🔦 Torch Light                ← child: inherits player transform
▼ 🌲 Tree_01
    💡 Lantern                    ← child: attached to tree
  ☀️ Sun (Directional)            ← root-level, no parent
  🌊 Ocean                        ← root-level
```

- Root entities are at the top level (no indent)
- Child entities are indented under their parent with a tree connector line
- Collapse/expand arrows (▼/▶) for entities that have children
- Drag-and-drop to reparent (see 2.2)

### 2.2 Parenting Operations

**Drag-and-drop parenting:**
1. User drags "Torch Light" entity in the tree
2. Drops it onto "Player" entity
3. "Torch Light" becomes a child of "Player"
4. Its `TransformComponent` position/rotation are automatically converted from **world** to **local** (relative to parent) so the object doesn't visually jump

**Right-click context menu additions:**
- **"Create Child > Empty"** — creates an empty child entity with just a TransformComponent
- **"Create Child > Spot Light"** — creates a child entity with Transform + Light (spot)
- **"Create Child > Point Light"** — creates a child entity with Transform + Light (point)
- **"Unparent"** — detaches the entity from its parent (converts local transform back to world so it stays in place)
- **"Select Children"** — selects all direct children
- **"Select Hierarchy"** — selects entity + all descendants recursively

**Keyboard shortcuts:**
- `P` — parent selected entity to the last-selected entity (or a designated "parent target")
- `Alt+P` — unparent selected entity

### 2.3 Transform Inspector Behavior

When a **child entity** is selected, the Transform panel in the Object Panel shows:

```
Transform (Local)           [World ▾]
  Position:  0.30, -0.20, 0.50    ← relative to parent
  Rotation:  0.00,  0.00, 0.00    ← relative to parent
  Scale:     1.00,  1.00, 1.00

  Parent: Player [×]              ← click × to unparent
```

- A dropdown toggle lets the user switch between **Local** and **World** coordinate display
- In **Local** mode (default for children), editing position moves relative to the parent
- In **World** mode, editing position moves in world space (the system converts back to local)
- The "Parent" field shows the parent entity name with an unparent button

When a **root entity** is selected, the panel looks identical to today (no parent field, coordinates are world).

### 2.4 Gizmo Behavior

- When a child entity is selected, the translate/rotate gizmo operates in the **parent's local space** by default
- The gizmo space toggle (Local/World) already exists — Local now means "parent space" for children
- Moving a parent via gizmo moves all children with it (they maintain their local offsets)

### 2.5 Deletion Behavior

When deleting a parent entity, a confirmation dialog appears:

```
Delete "Player"?
This entity has 1 child(ren).

  ○ Delete children too        ← cascade delete
  ● Keep children (unparent)   ← children become root entities, keeping world position

  [Cancel]  [Delete]
```

Default behavior: **keep children** (safer). Children's transforms are converted from local back to world space so they don't jump.

---

## 3. Core ECS Changes

### 3.1 Entity — Add Hierarchy Fields

**File: `src/core/ecs/Entity.ts`**

```ts
class Entity {
  // ...existing fields...

  /** Parent entity ID, or null if this is a root entity */
  parentId: string | null = null;

  /** Ordered list of child entity IDs */
  childIds: string[] = [];
}
```

These are plain data fields — no methods on Entity for hierarchy manipulation. All hierarchy operations go through `World` to maintain consistency.

### 3.2 World — Hierarchy API

**File: `src/core/ecs/World.ts`**

New methods to add:

```ts
class World {
  // ===================== Hierarchy =====================

  /**
   * Set an entity's parent. Pass null to unparent (make root).
   * 
   * When preserveWorldTransform is true (default), the child's local
   * transform is recalculated so it maintains its current world position.
   * When false, the child's existing transform values become local-space
   * values relative to the new parent (the entity may visually jump).
   */
  setParent(childId: string, parentId: string | null, preserveWorldTransform?: boolean): boolean;

  /**
   * Get the parent entity of a given entity, or null if it's a root.
   */
  getParent(entityId: string): Entity | null;

  /**
   * Get direct children of an entity.
   */
  getChildren(entityId: string): Entity[];

  /**
   * Get all descendants of an entity (recursive).
   */
  getDescendants(entityId: string): Entity[];

  /**
   * Get all root entities (entities with no parent).
   */
  getRootEntities(): Entity[];

  /**
   * Get entities in topological order (parents before children).
   * Used by TransformSystem for correct matrix propagation.
   * 
   * This is cached and only recomputed when hierarchy changes.
   */
  getHierarchyOrder(): Entity[];

  /**
   * Check if making parentId the parent of childId would create a cycle.
   */
  wouldCreateCycle(childId: string, parentId: string): boolean;
}
```

**`setParent` implementation details:**

1. Validate both entities exist
2. Check `wouldCreateCycle()` to prevent circular hierarchies
3. Remove child from old parent's `childIds` (if it had a parent)
4. Set `child.parentId = parentId`
5. Add child to new parent's `childIds` (if parentId is not null)
6. If `preserveWorldTransform`:
   - Get child's current world matrix
   - Compute `localMatrix = inverse(newParent.worldMatrix) × child.worldMatrix`
   - Decompose localMatrix back into position/rotation/scale and write to child's TransformComponent
7. Invalidate cached topological order
8. Mark child's TransformComponent as dirty

**`getHierarchyOrder` implementation:**

Uses a simple iterative BFS/DFS starting from roots:

```ts
private _hierarchyOrderCache: Entity[] | null = null;
private _hierarchyDirty = true;

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
      const child = this.getEntity(childId);
      if (child) queue.push(child);
    }
  }
  
  this._hierarchyOrderCache = result;
  this._hierarchyDirty = false;
  return result;
}
```

**`destroyEntity` modification:**

When destroying an entity that has children, the caller decides the policy. The `destroyEntity` method is extended:

```ts
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
    const parent = this.getEntity(entity.parentId);
    if (parent) {
      parent.childIds = parent.childIds.filter(c => c !== id);
    }
  }
  
  // ...existing cleanup (selection, sceneGraph, pendingDeletions)...
}
```

### 3.3 TransformComponent — Local vs World Matrix

**File: `src/core/ecs/components/TransformComponent.ts`**

Current state:
- `position`, `rotationQuat`, `scale` — these are the "source of truth"
- `modelMatrix` — the computed result
- All are effectively in world space (no parent concept)

New additions:

```ts
class TransformComponent {
  // ...existing fields (position, rotationQuat, scale remain as the LOCAL transform)...

  /** 
   * The local matrix (position × rotation × scale), computed from the component's
   * position/rotationQuat/scale. For root entities this equals modelMatrix.
   */
  localMatrix: mat4 = mat4.create();

  /**
   * The world matrix. For root entities: same as localMatrix.
   * For children: parentWorldMatrix × localMatrix.
   * This is what was previously called modelMatrix — the name stays for compatibility.
   */
  // modelMatrix already exists — semantics change slightly for children
}
```

The key semantic shift:
- **Before**: `position`/`rotationQuat`/`scale` are world-space, `modelMatrix` = TRS(position, rotation, scale)
- **After**: `position`/`rotationQuat`/`scale` are **local-space** (relative to parent), `localMatrix` = TRS(position, rotation, scale), `modelMatrix` = parent.modelMatrix × localMatrix. For root entities (no parent), local = world, so nothing changes.

### 3.4 TransformSystem — Hierarchy-Aware Update

**File: `src/core/ecs/systems/TransformSystem.ts`**

Currently iterates all entities with `TransformComponent` and computes `modelMatrix` from position/rotation/scale directly. The update changes to:

```ts
update(entities: Entity[], deltaTime: number, context: SystemContext): void {
  const world = context.world;
  
  // Process in hierarchy order (parents before children)
  const ordered = world.getHierarchyOrder();
  
  for (const entity of ordered) {
    const transform = entity.getComponent<TransformComponent>('transform');
    if (!transform) continue;
    
    // Recompute local matrix from position/rotation/scale
    if (transform.dirty) {
      computeLocalMatrix(transform);  // TRS → localMatrix
    }
    
    // Compute world matrix
    const parent = world.getParent(entity.id);
    if (parent) {
      const parentTransform = parent.getComponent<TransformComponent>('transform');
      if (parentTransform) {
        // worldMatrix = parentWorldMatrix × localMatrix
        mat4.multiply(transform.modelMatrix, parentTransform.modelMatrix, transform.localMatrix);
      } else {
        mat4.copy(transform.modelMatrix, transform.localMatrix);
      }
    } else {
      // Root entity: world = local
      mat4.copy(transform.modelMatrix, transform.localMatrix);
    }
    
    transform.dirty = false;
    transform._updatedThisFrame = true;
  }
}
```

**Dirty propagation:** When a parent's transform changes, all descendants must also be updated. Two approaches:

- **Option A (simple):** Always process the full hierarchy each frame. At ~100s of entities this is cheap.
- **Option B (optimized):** When marking a transform dirty, also mark all descendants dirty. TransformSystem only recomputes dirty entities. Better for large scenes.

Recommend starting with **Option A** for simplicity.

---

## 4. Systems That Read Transform — Impact Assessment

These systems read `TransformComponent.modelMatrix` for world-space position. Since `modelMatrix` becomes the world matrix for both root and child entities, **most systems need no changes**:

| System | Reads modelMatrix? | Change Needed? |
|--------|-------------------|----------------|
| **TransformSystem** | Writes it | ✅ Major: hierarchy traversal |
| **MeshRenderSystem** | Yes (for GPU upload) | ❌ No change |
| **LightingSystem** | Yes (light world position/direction) | ❌ No change |
| **BoundsSystem** | Yes (world AABB from modelMatrix) | ❌ No change |
| **FrustumCullSystem** | Reads bounds | ❌ No change |
| **ShadowPass** | Reads light positions | ❌ No change |
| **FPSCameraSystem** | Currently bypasses TransformComponent | ⚠️ Refactor to use TransformComponent as source of truth (see Section 6) |
| **SelectionOutlinePass** | Reads modelMatrix | ❌ No change |

The key insight: **only TransformSystem changes**. Everything downstream reads `modelMatrix` which now correctly represents world space for all entities.

---

## 5. UI Changes

### 5.1 ObjectsPanel — Tree View

**File: `src/demos/sceneBuilder/components/panels/ObjectsPanel/ObjectsPanel.tsx`**

Currently renders a flat list of entities. Changes to a recursive tree:

```tsx
function EntityTreeNode({ entity, depth, world }: { entity: Entity; depth: number; world: World }) {
  const [expanded, setExpanded] = useState(true);
  const children = world.getChildren(entity.id);
  const hasChildren = children.length > 0;
  
  return (
    <>
      <div 
        style={{ paddingLeft: depth * 20 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('entityId', entity.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const childId = e.dataTransfer.getData('entityId');
          if (childId && childId !== entity.id) {
            world.setParent(childId, entity.id, true);
          }
        }}
      >
        {hasChildren && (
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? '▼' : '▶'}
          </button>
        )}
        <span>{getEntityIcon(entity)} {entity.name}</span>
      </div>
      {expanded && children.map(child => (
        <EntityTreeNode key={child.id} entity={child} depth={depth + 1} world={world} />
      ))}
    </>
  );
}

// Top-level render: only root entities
function ObjectsPanel({ world }: Props) {
  const roots = world.getRootEntities();
  return roots.map(entity => (
    <EntityTreeNode key={entity.id} entity={entity} depth={0} world={world} />
  ));
}
```

**Drop-on-empty-space** at the root level = unparent the dragged entity.

### 5.2 Object Panel — Parent Display

**File: `src/demos/sceneBuilder/components/panels/ObjectPanel/ObjectPanel.tsx`**

Add a "Parent" row to the Transform sub-panel:

```tsx
// In the transform section:
{entity.parentId && (
  <div className="parent-field">
    <label>Parent:</label>
    <span>{world.getEntity(entity.parentId)?.name ?? 'Unknown'}</span>
    <button onClick={() => world.setParent(entity.id, null, true)}>
      Unparent
    </button>
  </div>
)}

// Coordinate space toggle:
<Select value={coordSpace} onChange={setCoordSpace}>
  <option value="local">Local</option>
  <option value="world">World</option>
</Select>
```

When "World" is selected, the displayed position/rotation are decomposed from `modelMatrix` (world). Edits in world mode are converted back to local by computing `inverse(parent.modelMatrix) × desiredWorldMatrix`.

### 5.3 Context Menu

**File: Right-click handler in ObjectsPanel or ObjectPanel**

Add menu items:
- "Create Child > Empty / Spot Light / Point Light / Mesh"
- "Unparent" (when entity has a parent)
- "Select Children" / "Select Hierarchy"

---

## 6. FPS Camera Refactor + Torch Light Integration

### 6.1 The Problem: FPSCameraComponent Bypasses TransformComponent

Currently `FPSCameraComponent` owns its own `position`, `yaw`, `pitch` and computes view matrices internally. This is the **only component** that bypasses `TransformComponent` as the source of truth. This creates a special-case sync problem for hierarchy.

### 6.2 The Solution: Make TransformComponent the Single Source of Truth

Refactor `FPSCameraComponent` to be a **lightweight config/state component** that does NOT own position or orientation. Instead, `FPSCameraSystem` reads and writes the entity's `TransformComponent` directly:

**FPSCameraComponent becomes (slimmed down):**
```ts
class FPSCameraComponent extends Component {
  readonly type: ComponentType = 'fps-camera';

  // ---- Camera-specific config (not position/orientation) ----
  playerHeight: number = 1.8;
  moveSpeed: number = 5.0;
  sprintMultiplier: number = 2.0;
  mouseSensitivity: number = 0.002;
  fov: number = Math.PI / 3;
  near: number = 0.1;
  far: number = 1000;
  aspect: number = 16 / 9;

  // ---- Movement key state (written by input handling) ----
  forward: boolean = false;
  backward: boolean = false;
  left: boolean = false;
  right: boolean = false;
  sprint: boolean = false;

  // ---- Derived from TransformComponent (for convenience/caching) ----
  yaw: number = 0;    // extracted from transform rotation
  pitch: number = 0;  // extracted from transform rotation

  // ---- Activation state ----
  active: boolean = false;
  needsSpawn: boolean = true;

  // ---- Cached matrices (computed from TransformComponent) ----
  viewMatrix: mat4 = mat4.create();
  projMatrix: mat4 = mat4.create();
  vpMatrix: mat4 = mat4.create();
}
```

**Key removals:** `position` is gone — it lives on `TransformComponent.position`.

**FPSCameraSystem update flow:**
```ts
update(entities: Entity[], deltaTime: number, context: SystemContext): void {
  for (const entity of entities) {
    const camera = entity.getComponent<FPSCameraComponent>('fps-camera');
    const transform = entity.getComponent<TransformComponent>('transform');
    if (!camera || !transform || !camera.active) continue;

    // 1. Apply mouse look → update yaw/pitch on camera, write rotation to transform
    camera.yaw += mouseDeltaX * camera.mouseSensitivity;
    camera.pitch = clamp(camera.pitch + mouseDeltaY * camera.mouseSensitivity, camera.minPitch, camera.maxPitch);
    transform.rotationQuat = quatFromYawPitch(camera.yaw, camera.pitch);

    // 2. Apply movement → update transform.position directly
    const speed = camera.moveSpeed * (camera.sprint ? camera.sprintMultiplier : 1.0) * deltaTime;
    const forward = vec3.fromValues(Math.sin(camera.yaw), 0, Math.cos(camera.yaw));
    const right = vec3.fromValues(forward[2], 0, -forward[0]);
    
    if (camera.forward)  vec3.scaleAndAdd(transform.position, transform.position, forward, speed);
    if (camera.backward) vec3.scaleAndAdd(transform.position, transform.position, forward, -speed);
    if (camera.right)    vec3.scaleAndAdd(transform.position, transform.position, right, speed);
    if (camera.left)     vec3.scaleAndAdd(transform.position, transform.position, right, -speed);
    
    // 3. Terrain height + bounds clamping on transform.position...
    
    // 4. Mark transform dirty so TransformSystem propagates to children
    transform.dirty = true;

    // 5. Compute view/VP matrices from transform.position + yaw/pitch
    computeViewMatrix(camera, transform.position);
  }
}
```

**Benefits:**
- **No sync needed** — TransformComponent IS the source of truth, FPSCameraSystem writes to it directly
- **Hierarchy works automatically** — TransformSystem sees the camera entity's transform is dirty, propagates `modelMatrix` to children (torch, weapons, etc.)
- **Consistent with all other systems** — the camera entity is no longer a special case
- **Position editable in UI** — the Transform inspector shows the camera's world position, which can be edited like any other entity

### 6.3 Torch Light Workflow

With the refactored camera + hierarchy:

1. User right-clicks "FPS Camera" in Objects Panel → "Create Child > Spot Light"
2. System creates child entity with `TransformComponent` + `LightComponent (spot)`
3. `setParent(childId, cameraEntityId)`
4. User adjusts child's local position to `[0.3, -0.2, 0.5]` (lower-right offset)
5. User configures spot light properties (warm color, 20m range, 35° cone, shadows)
6. Done — the torch follows the camera automatically. No custom code, no sync.

---

## 7. Serialization

**File: `src/loaders/SceneSerializer.ts`**

The scene file format needs to save hierarchy relationships:

```json
{
  "entities": [
    {
      "id": "player-1",
      "name": "Player",
      "parentId": null,
      "childIds": ["torch-1"],
      "components": { ... }
    },
    {
      "id": "torch-1", 
      "name": "Torch",
      "parentId": "player-1",
      "childIds": [],
      "components": {
        "transform": {
          "position": [0.3, -0.2, 0.5],
          "rotation": [0, 0, 0],
          "scale": [1, 1, 1]
        },
        "light": {
          "lightType": "spot",
          "color": [1.0, 0.85, 0.6],
          "intensity": 3.0,
          "range": 20,
          "innerConeAngle": 15,
          "outerConeAngle": 35,
          "castsShadow": true
        }
      }
    }
  ]
}
```

**Load order:** Entities must be created before `setParent` is called. Two-pass loading:
1. Create all entities with their components (transforms stored as local values)
2. Set parent relationships using saved `parentId` fields

---

## 8. Implementation Phases

### Phase 1: Core ECS Hierarchy + Camera TransformComponent Refactor (backend)
**Files:** `Entity.ts`, `World.ts`, `TransformComponent.ts`, `TransformSystem.ts`, `FPSCameraComponent.ts`, `FPSCameraSystem.ts`

**Already completed (prerequisites):**
- ✅ FPSCameraSystem is now a persistent system (registered at world startup in Viewport.ts, no longer created/destroyed per session)
- ✅ FPSCameraSystem has `enter(world)`/`exit()` methods and a `playing` flag (no-ops when not playing)
- ✅ MenuBarBridge decoupled: "Play Mode" calls `fpsSystem.enter()`/`exit()` instead of creating entities/systems
- ✅ Empty entities can be created via `Add > Empty Entity`
- ✅ FPS Camera and Transform are optional components in ComponentsTab with dependency auto-add
- ✅ FPSCameraSubPanel created for editing camera config

**Remaining work:**
- Add `parentId`/`childIds` to Entity
- Add `setParent()`/`getParent()`/`getChildren()`/`getRootEntities()`/`getHierarchyOrder()` to World
- Add `localMatrix` to TransformComponent
- Update TransformSystem for hierarchy-aware matrix computation
- Update `destroyEntity` for child handling
- Add cycle detection
- **FPSCameraComponent refactor:** Remove `position` from FPSCameraComponent (Section 6.2). FPSCameraSystem already operates as a persistent system; the remaining work is to make it write position/rotation to `TransformComponent` instead of FPSCameraComponent's own fields. This is the **only component that bypasses TransformComponent**. After refactoring, FPSCameraComponent becomes a lightweight config/state component (FOV, sensitivity, speed, key state, cached matrices) while TransformComponent owns the position/orientation.

**Estimated effort:** 1 day (reduced from 1.5 — FPS system persistence already done)

### Phase 2: Objects Panel Tree View (UI)
**Files:** `ObjectsPanel.tsx`, `ObjectsPanel.module.css`

- Replace flat list with recursive tree component
- Drag-and-drop parenting (drag entity onto another → `setParent`)
- Collapse/expand arrows for entities with children
- Drop-on-empty-space to unparent
- Visual indent with tree connector lines

**Estimated effort:** 1 day

### Phase 3: Object Panel — Parent Controls + "Create Child" Menu
**Files:** `ObjectPanel.tsx`, transform sub-panel, context menu

- Parent display row with unparent button
- Local/World coordinate toggle for transform inspector
- Right-click context menu: "Create Child > Empty / Spot Light / Point Light"
- "Unparent", "Select Children", "Select Hierarchy" menu items

This is what enables the **torch workflow from UI only:**
1. User enters FPS mode (camera entity already exists with TransformComponent)
2. User right-clicks the camera entity in Objects Panel → "Create Child > Spot Light"
3. System creates a child entity with `TransformComponent` + `LightComponent (spot, default torch preset)`
4. User adjusts the child's local position in the Transform inspector (e.g., `[0.3, -0.2, 0.5]`)
5. Done — the spot light follows the camera automatically via hierarchy. No code needed.

**Estimated effort:** 1 day

### Phase 4: Serialization
**Files:** `SceneSerializer.ts`

- Save parentId/childIds
- Two-pass loading (create entities, then link parents)

**Estimated effort:** 0.5 day

### Phase 5: Gizmo Integration
**Files:** `TransformGizmoManager.ts`, `TranslateGizmo.ts`

- Gizmo operates in parent space for child entities
- Moving a parent via gizmo correctly updates children (this should work automatically via TransformSystem, but needs visual verification)

**Estimated effort:** 0.5 day

**Total estimated effort: ~4 days** (reduced from 4.5 — FPS system persistence + Play Mode + empty entities + component UI already done)

### Torch Light — Pure UI Workflow (No Custom Code)

After Phases 1–3 are complete, creating a player torch is entirely UI-driven:

```
1. Objects Panel shows:
     🎮 FPS Camera

2. Right-click "FPS Camera" → "Create Child" → "Spot Light"
   Objects Panel now shows:
     ▼ 🎮 FPS Camera
         🔦 Spot Light

3. Select "Spot Light" → Object Panel shows:
     Transform (Local)
       Position: 0.3, -0.2, 0.5      ← adjust offset
       Rotation: 0, 0, 0              ← faces forward (same as parent)
     
     Light
       Type: Spot
       Color: [1.0, 0.85, 0.6]       ← warm torch color
       Intensity: 3.0
       Range: 20
       Inner Cone: 15°
       Outer Cone: 35°
       Cast Shadow: ☑

4. Enter FPS mode → torch follows camera automatically
```

No factory functions, no custom system code, no hardcoded entity creation. The hierarchy system + UI "Create Child" menu + TransformSystem propagation handles everything.

---

## 9. Edge Cases & Rules

1. **Maximum depth:** No hard limit, but warn at depth > 10 (performance + usability)
2. **Cycle prevention:** `setParent` rejects if the proposed parent is a descendant of the child
3. **Root entity deletion:** Children become roots (default) or cascade-delete (opt-in)
4. **Transform scale inheritance:** Children inherit parent scale. This can cause non-uniform scale issues with rotated children (shearing). Accept this for now; add a "freeze transforms" option later if needed.
5. **Components on parent vs child:** A parent doesn't need a mesh — empty "pivot" entities are valid and useful (e.g., a rotation pivot point)
6. **Existing groups:** Groups remain independent of hierarchy. A child entity can also be in a group.
7. **Scene graph (BVH):** Remains flat. Every entity (parent or child) has its own entry in the BVH with world-space bounds. No change needed.
8. **System query ordering:** `world.query('transform')` returns ALL entities (parents and children). Systems that need hierarchy order use `world.getHierarchyOrder()` instead (only TransformSystem currently).