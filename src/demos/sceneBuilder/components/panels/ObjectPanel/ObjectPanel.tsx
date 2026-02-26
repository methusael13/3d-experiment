import { useMemo } from 'preact/hooks';
import { Panel, SidebarTabs } from '../../ui';
import { TransformTab, type TransformData } from './TransformTab';
import { EditTab, type PrimitiveConfig } from './EditTab';
import { ComponentsTab, type ComponentsTabProps } from './ComponentsTab';
import type { GizmoMode } from '../../../gizmos';
import type { GizmoOrientation } from '../../../gizmos/BaseGizmo';
import { OriginPivot } from '@/core/sceneObjects/SceneObject';
import type { Entity } from '@/core/ecs/Entity';
import type { ComponentType } from '@/core/ecs/types';
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

  // Callbacks
  onNameChange: (name: string) => void;
  onPositionChange: (value: [number, number, number]) => void;
  onRotationChange: (value: [number, number, number]) => void;
  onScaleChange: (value: [number, number, number]) => void;
  onGizmoModeChange: (mode: GizmoMode) => void;
  onGizmoOrientationChange: (orientation: GizmoOrientation) => void;
  originPivot?: OriginPivot;
  onOriginPivotChange?: (pivot: OriginPivot) => void;
  onDelete: () => void;

  // Primitive callbacks
  onPrimitiveConfigChange?: (config: Partial<PrimitiveConfig>) => void;
  onShowNormalsChange?: (show: boolean) => void;

  // Components tab
  entity: Entity | null;
  activeComponents: ComponentType[];
  onComponentsChanged: () => void;
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
  onNameChange,
  onPositionChange,
  onRotationChange,
  onScaleChange,
  onGizmoModeChange,
  onGizmoOrientationChange,
  originPivot,
  onOriginPivotChange,
  onDelete,
  onPrimitiveConfigChange,
  onShowNormalsChange,
  entity,
  activeComponents,
  onComponentsChanged,
}: ObjectPanelProps) {
  const showEditTab = objectType === 'primitive' && selectionCount === 1;

  const tabs = useMemo(
    () => [
      {
        id: 'transform',
        icon: '⊞',
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
            originPivot={originPivot}
            onOriginPivotChange={onOriginPivotChange}
            onDelete={onDelete}
          />
        ),
      },
      {
        id: 'edit',
        icon: '✎',
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
        id: 'components',
        icon: '⧉',
        label: 'Components',
        visible: selectionCount === 1,
        content: selectionCount === 1 ? (
          <ComponentsTab
            entity={entity}
            activeComponents={activeComponents}
            onChanged={onComponentsChanged}
          />
        ) : null,
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
      entity,
      activeComponents,
    ]
  );

  return (
    <Panel title="Object" visible={visible}>
      <SidebarTabs tabs={tabs} defaultTab="transform" />
    </Panel>
  );
}