import { useMemo } from 'preact/hooks';
import { Panel, Tabs } from '../../ui';
import { TransformTab, type TransformData } from './TransformTab';
import { EditTab, type PrimitiveConfig } from './EditTab';
import { ModifiersTab, type WindSettings, type TerrainBlendSettings, type MaterialInfo } from './ModifiersTab';
import type { GizmoMode } from '../../../gizmos';
import type { GizmoOrientation } from '../../../gizmos/BaseGizmo';
import styles from './ObjectPanel.module.css';

// Import CSS variables
import '../../styles/variables.css';

export interface ObjectPanelProps {
  // Visibility
  visible: boolean;
  selectionCount: number;

  // Selected object info
  objectName: string;
  objectType: string | null;
  transform: TransformData;

  // Primitive edit (only for primitives)
  primitiveType?: 'cube' | 'plane' | 'sphere';
  primitiveConfig?: PrimitiveConfig;
  showNormals?: boolean;

  // Gizmo state
  gizmoMode: GizmoMode;
  gizmoOrientation: GizmoOrientation;

  // Modifier settings
  windSettings: WindSettings;
  terrainBlendSettings: TerrainBlendSettings;
  materials: MaterialInfo[];

  // Callbacks
  onNameChange: (name: string) => void;
  onPositionChange: (value: [number, number, number]) => void;
  onRotationChange: (value: [number, number, number]) => void;
  onScaleChange: (value: [number, number, number]) => void;
  onGizmoModeChange: (mode: GizmoMode) => void;
  onGizmoOrientationChange: (orientation: GizmoOrientation) => void;
  onDelete: () => void;

  // Primitive callbacks
  onPrimitiveConfigChange?: (config: Partial<PrimitiveConfig>) => void;
  onShowNormalsChange?: (show: boolean) => void;

  // Modifier callbacks
  onWindSettingsChange: (settings: Partial<WindSettings>) => void;
  onTerrainBlendChange: (settings: Partial<TerrainBlendSettings>) => void;
  onToggleLeafMaterial: (index: number) => void;
  onToggleBranchMaterial: (index: number) => void;
}

export function ObjectPanel({
  visible,
  selectionCount,
  objectName,
  objectType,
  transform,
  primitiveType,
  primitiveConfig,
  showNormals = false,
  gizmoMode,
  gizmoOrientation,
  windSettings,
  terrainBlendSettings,
  materials,
  onNameChange,
  onPositionChange,
  onRotationChange,
  onScaleChange,
  onGizmoModeChange,
  onGizmoOrientationChange,
  onDelete,
  onPrimitiveConfigChange,
  onShowNormalsChange,
  onWindSettingsChange,
  onTerrainBlendChange,
  onToggleLeafMaterial,
  onToggleBranchMaterial,
}: ObjectPanelProps) {
  const showEditTab = objectType === 'primitive' && selectionCount === 1;

  const tabs = useMemo(
    () => [
      {
        id: 'transform',
        label: 'Transform',
        content: (
          <TransformTab
            objectName={objectName}
            selectionCount={selectionCount}
            transform={transform}
            gizmoMode={gizmoMode}
            gizmoOrientation={gizmoOrientation}
            onNameChange={onNameChange}
            onPositionChange={onPositionChange}
            onRotationChange={onRotationChange}
            onScaleChange={onScaleChange}
            onGizmoModeChange={onGizmoModeChange}
            onGizmoOrientationChange={onGizmoOrientationChange}
            onDelete={onDelete}
          />
        ),
      },
      {
        id: 'edit',
        label: 'Edit',
        visible: showEditTab,
        content: showEditTab && primitiveType && primitiveConfig ? (
          <EditTab
            primitiveType={primitiveType}
            config={primitiveConfig}
            showNormals={showNormals}
            onConfigChange={onPrimitiveConfigChange!}
            onShowNormalsChange={onShowNormalsChange!}
          />
        ) : null,
      },
      {
        id: 'modifiers',
        label: 'Modifiers',
        content: (
          <ModifiersTab
            windSettings={windSettings}
            terrainBlendSettings={terrainBlendSettings}
            materials={materials}
            onWindSettingsChange={onWindSettingsChange}
            onTerrainBlendChange={onTerrainBlendChange}
            onToggleLeafMaterial={onToggleLeafMaterial}
            onToggleBranchMaterial={onToggleBranchMaterial}
          />
        ),
      },
    ],
    [
      objectName,
      selectionCount,
      transform,
      gizmoMode,
      gizmoOrientation,
      showEditTab,
      primitiveType,
      primitiveConfig,
      showNormals,
      windSettings,
      terrainBlendSettings,
      materials,
    ]
  );

  return (
    <Panel title="Object" visible={visible}>
      <Tabs tabs={tabs} defaultTab="transform" />
    </Panel>
  );
}
