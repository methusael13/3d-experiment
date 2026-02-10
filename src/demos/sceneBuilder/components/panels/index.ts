// Panel Components
export { EnvironmentPanel } from './EnvironmentPanel';
export type { EnvironmentPanelProps } from './EnvironmentPanel';

export { ObjectsPanel } from './ObjectsPanel';
export type { ObjectsPanelProps } from './ObjectsPanel';

export { ObjectPanel } from './ObjectPanel';
export type {
  ObjectPanelProps,
  TransformData,
  PrimitiveConfig,
  WindSettings,
  TerrainBlendSettings,
  MaterialInfo,
} from './ObjectPanel';

export { MaterialPanel } from './MaterialPanel';
export type { MaterialPanelProps } from './MaterialPanel';

export { RenderingPanel } from './RenderingPanel';
export type { RenderingPanelProps, WebGPUShadowSettings, SSAOSettings } from './RenderingPanel';

export { TerrainPanel, TERRAIN_PRESETS } from './TerrainPanel';
export type {
  TerrainPanelProps,
  TerrainPreset,
  NoiseParams,
  ErosionParams,
  MaterialParams,
  WaterParams,
  DetailParams,
  BiomeType,
  BiomeTextureConfig,
} from './TerrainPanel';
