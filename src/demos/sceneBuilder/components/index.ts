// Main entry point for all React/Preact components

// Layout Components
export { MenuBar } from './layout';
export type { MenuBarProps, MenuDefinition, MenuAction } from './layout';

// UI Primitives
export {
  Slider,
  Checkbox,
  ColorPicker,
  Select,
  Section,
  VectorInput,
  Panel,
  Tabs,
} from './ui';

// UI Component Types
export type {
  SliderProps,
  CheckboxProps,
  ColorPickerProps,
  SelectProps,
  SelectOption,
  SectionProps,
  VectorInputProps,
  PanelProps,
  TabsProps,
} from './ui';

// Panel Components
export {
  EnvironmentPanel,
  ObjectsPanel,
  ObjectPanel,
  MaterialPanel,
  RenderingPanel,
  TerrainPanel,
  TERRAIN_PRESETS,
} from './panels';

// Panel Types
export type {
  EnvironmentPanelProps,
  ObjectsPanelProps,
  ObjectPanelProps,
  TransformData,
  PrimitiveConfig,
  WindSettings,
  TerrainBlendSettings,
  MaterialInfo,
  MaterialPanelProps,
  RenderingPanelProps,
  WebGPUShadowSettings,
  TerrainPanelProps,
  TerrainPreset,
  NoiseParams,
  ErosionParams,
  MaterialParams as TerrainMaterialParams,
  WaterParams,
  DetailParams,
} from './panels';

// App Components
export { SceneBuilderApp, mountSceneBuilderApp } from './app';
export type { SceneBuilderAppProps } from './app';

// State Management
export { getSceneBuilderStore, resetSceneBuilderStore, createSceneBuilderStore } from './state';
export type {
  SceneBuilderStore,
  ObjectGroupData,
  CameraState,
  ViewportState,
} from './state';

// Viewport Components
export { ViewportContainer } from './viewport';
export type { ViewportContainerProps, ViewportContainerHandle } from './viewport';
