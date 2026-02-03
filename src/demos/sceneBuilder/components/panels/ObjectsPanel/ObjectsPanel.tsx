import { useCallback, useRef } from 'preact/hooks';
import { importModelFile, importGLTFDirectory } from '../../../../../loaders';
import { Panel, Select } from '../../ui';
import type { Scene } from '../../../../../core/Scene';
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
  scene: Scene;
  objects: SceneObject[];
  groups: Map<string, ObjectGroup>;
  selectedIds: Set<string>;
  expandedGroupIds: Set<string>;
  onSelect: (id: string, additive?: boolean, fromExpandedGroup?: boolean) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onToggleGroup: (groupId: string) => void;
}

const presetOptions = [
  { value: '', label: 'Add Preset...' },
  { value: 'duck.glb', label: 'Duck' },
];

export function ObjectsPanel({
  scene,
  objects,
  groups,
  selectedIds,
  expandedGroupIds,
  onSelect,
  onSelectAll,
  onClearSelection,
  onToggleGroup,
}: ObjectsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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

  // Import GLB file
  const handleImportFile = useCallback(
    async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) {
        const result = await importModelFile(file);
        if (result) {
          const { modelPath, displayName } = result;
          const obj = await scene.addObject(modelPath, displayName);
          if (obj) scene.select(obj.id);
        }
      }
      input.value = '';
    },
    [scene]
  );

  // Import glTF folder
  const handleImportFolder = useCallback(
    async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (files && files.length > 0) {
        const result = await importGLTFDirectory(files);
        if (result) {
          const { modelPath, displayName } = result;
          const obj = await scene.addObject(modelPath, displayName);
          if (obj) scene.select(obj.id);
        } else {
          console.error('Failed to import glTF folder - no .gltf file found');
        }
      }
      input.value = '';
    },
    [scene]
  );

  // Preset selection
  const handlePresetChange = useCallback(
    async (value: string) => {
      if (value) {
        const obj = await scene.addObject(`/models/${value}`);
        if (obj) scene.select(obj.id);
      }
    },
    [scene]
  );

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

      {/* Import controls */}
      <div class={styles.importControls}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
        <input
          ref={folderInputRef}
          type="file"
          // @ts-ignore - webkitdirectory is not in types
          webkitdirectory=""
          directory=""
          style={{ display: 'none' }}
          onChange={handleImportFolder}
        />

        <button
          class={styles.primaryBtn}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          Import GLB
        </button>
        <button
          class={styles.secondaryBtn}
          onClick={() => folderInputRef.current?.click()}
          type="button"
        >
          Import glTF Folder
        </button>
        <Select
          value=""
          options={presetOptions}
          onChange={handlePresetChange}
        />
      </div>
    </Panel>
  );
}
