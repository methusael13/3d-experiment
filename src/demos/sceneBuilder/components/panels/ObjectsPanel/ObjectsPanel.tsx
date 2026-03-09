import { useCallback, useState } from 'preact/hooks';
import { Panel } from '../../ui';
import styles from './ObjectsPanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

interface SceneObject {
  id: string;
  name: string;
  groupId?: string | null;
  /** Optional icon emoji displayed before the name (e.g. ☀️💡🔦🧊🌊⛰️) */
  icon?: string;
  /** Parent entity ID (null = root) */
  parentId?: string | null;
  /** Child entity IDs */
  childIds?: string[];
}

interface ObjectGroup {
  id: string;
  name: string;
  childIds: string[];
}

export interface ObjectsPanelProps {
  objects: SceneObject[];
  groups: Map<string, ObjectGroup>;
  selectedIds: Set<string>;
  expandedGroupIds: Set<string>;
  onSelect: (id: string, additive?: boolean, fromExpandedGroup?: boolean) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onToggleGroup: (groupId: string) => void;
  /** Called when a drag-and-drop reparent operation is performed */
  onSetParent?: (childId: string, parentId: string | null) => void;
}

/** Track which entity tree nodes are collapsed */
const collapsedNodes = new Set<string>();

function EntityTreeNode({
  obj,
  objects,
  depth,
  selectedIds,
  onSelect,
  onSetParent,
}: {
  obj: SceneObject;
  objects: SceneObject[];
  depth: number;
  selectedIds: Set<string>;
  onSelect: (id: string, additive?: boolean) => void;
  onSetParent?: (childId: string, parentId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(!collapsedNodes.has(obj.id));
  const [dragOver, setDragOver] = useState(false);
  const children = objects.filter((o) => o.parentId === obj.id);
  const hasChildren = children.length > 0;

  const handleToggle = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const next = !expanded;
      setExpanded(next);
      if (next) {
        collapsedNodes.delete(obj.id);
      } else {
        collapsedNodes.add(obj.id);
      }
    },
    [expanded, obj.id]
  );

  const handleClick = useCallback(
    (e: MouseEvent) => {
      onSelect(obj.id, e.shiftKey);
    },
    [obj.id, onSelect]
  );

  const handleDragStart = useCallback(
    (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', obj.id);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
      }
    },
    [obj.id]
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const childId = e.dataTransfer?.getData('text/plain');
      if (childId && childId !== obj.id && onSetParent) {
        onSetParent(childId, obj.id);
      }
    },
    [obj.id, onSetParent]
  );

  const isSelected = selectedIds.has(obj.id);

  return (
    <>
      <div
        class={`${styles.treeNode} ${isSelected ? styles.selected : ''} ${dragOver ? styles.dragOver : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span
          class={styles.expandToggle}
          onClick={hasChildren ? handleToggle : undefined}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? '▼' : '▶'}
        </span>
        {obj.icon && <span class={styles.objectIcon}>{obj.icon}</span>}
        <span class={styles.nodeName}>{obj.name}</span>
      </div>
      {expanded &&
        children.map((child) => (
          <EntityTreeNode
            key={child.id}
            obj={child}
            objects={objects}
            depth={depth + 1}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onSetParent={onSetParent}
          />
        ))}
    </>
  );
}

export function ObjectsPanel({
  objects,
  groups,
  selectedIds,
  expandedGroupIds,
  onSelect,
  onSelectAll,
  onClearSelection,
  onToggleGroup,
  onSetParent,
}: ObjectsPanelProps) {
  // Separate root entities (no parentId) from children
  const rootObjects = objects.filter((o) => !o.parentId);

  // Handle drop on the root area (unparent)
  const handleRootDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const handleRootDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const childId = e.dataTransfer?.getData('text/plain');
      if (childId && onSetParent) {
        // Drop on root = unparent (set parent to null)
        onSetParent(childId, null);
      }
    },
    [onSetParent]
  );

  // Legacy: group objects (flat grouping system, separate from hierarchy)
  const hasGroups = groups.size > 0;
  const groupedObjectIds = new Set<string>();
  if (hasGroups) {
    for (const group of groups.values()) {
      for (const id of group.childIds) {
        groupedObjectIds.add(id);
      }
    }
  }

  return (
    <Panel title="Scene Objects">
      <ul
        class={styles.objectList}
        onDragOver={handleRootDragOver}
        onDrop={handleRootDrop}
      >
        {/* Render hierarchy tree for root entities */}
        {rootObjects.map((obj) => (
          <EntityTreeNode
            key={obj.id}
            obj={obj}
            objects={objects}
            depth={0}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onSetParent={onSetParent}
          />
        ))}
      </ul>
    </Panel>
  );
}