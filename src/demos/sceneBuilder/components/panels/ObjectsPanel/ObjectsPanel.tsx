import { useCallback } from 'preact/hooks';
import { Panel } from '../../ui';
import styles from './ObjectsPanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

interface SceneObject {
  id: string;
  name: string;
  groupId?: string | null;
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
}

export function ObjectsPanel({
  objects,
  groups,
  selectedIds,
  expandedGroupIds,
  onSelect,
  onSelectAll,
  onClearSelection,
  onToggleGroup
}: ObjectsPanelProps) {
  // Group objects
  const ungrouped = objects.filter((o) => !o.groupId);
  const groupedByGroupId = new Map<string, SceneObject[]>();

  for (const obj of objects) {
    if (obj.groupId) {
      if (!groupedByGroupId.has(obj.groupId)) {
        groupedByGroupId.set(obj.groupId, []);
      }
      groupedByGroupId.get(obj.groupId)!.push(obj);
    }
  }

  // Object item click
  const handleObjectClick = useCallback(
    (id: string, inExpandedGroup: boolean) => (e: MouseEvent) => {
      onSelect(id, e.shiftKey, inExpandedGroup);
    },
    [onSelect]
  );

  // Group header click
  const handleGroupClick = useCallback(
    (groupId: string, groupChildIds: string[]) => (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains(styles.groupToggle)) {
        onToggleGroup(groupId);
      } else {
        // Select all group members
        if (!e.shiftKey) onClearSelection();
        onSelectAll(groupChildIds);
      }
    },
    [onToggleGroup, onClearSelection, onSelectAll]
  );

  return (
    <Panel title="Scene Objects">
      {/* Object list */}
      <ul class={styles.objectList}>
        {/* Render groups first */}
        {Array.from(groupedByGroupId.entries()).map(([groupId, groupObjects]) => {
          const group = groups.get(groupId);
          if (!group) return null;

          const isExpanded = expandedGroupIds.has(groupId);
          const allSelected = groupObjects.every((o) => selectedIds.has(o.id));

          return (
            <li key={groupId}>
              <div
                class={`${styles.groupHeader} ${allSelected ? styles.selected : ''}`}
                onClick={handleGroupClick(groupId, group.childIds)}
              >
                <span class={styles.groupToggle}>{isExpanded ? '▼' : '▶'}</span>
                <span class={styles.groupName}>{group.name}</span>
                <span class={styles.groupCount}>({groupObjects.length})</span>
              </div>

              {isExpanded && (
                <ul class={styles.groupChildren}>
                  {groupObjects.map((obj) => (
                    <li
                      key={obj.id}
                      class={`${styles.groupChild} ${selectedIds.has(obj.id) ? styles.selected : ''}`}
                      onClick={handleObjectClick(obj.id, true)}
                    >
                      <span class={styles.childIndent}>└─</span>
                      <span>{obj.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}

        {/* Render ungrouped objects */}
        {ungrouped.map((obj) => (
          <li
            key={obj.id}
            class={`${styles.objectItem} ${selectedIds.has(obj.id) ? styles.selected : ''}`}
            onClick={handleObjectClick(obj.id, false)}
          >
            <span>{obj.name}</span>
          </li>
        ))}
      </ul>

      {/* Note: Use Asset Library panel to add assets to scene */}
    </Panel>
  );
}
