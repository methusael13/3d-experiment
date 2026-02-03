// Bridge component exports - connect Preact components to the global store

// ObjectsPanel Bridge
export { createObjectsPanelBridge, type ObjectsPanelBridge } from './ObjectsPanelBridge';

// ObjectPanel Bridge
export { ConnectedObjectPanel } from './ObjectPanelBridge';

// EnvironmentPanel Bridge
export { ConnectedEnvironmentPanel, type ConnectedEnvironmentPanelProps } from './EnvironmentPanelBridge';

// RenderingPanel Bridge
export { ConnectedRenderingPanel, type ConnectedRenderingPanelProps } from './RenderingPanelBridge';

// MaterialPanel Bridge
export { ConnectedMaterialPanel } from './MaterialPanelBridge';

// TerrainPanel Bridge
export { ConnectedTerrainPanel, type ConnectedTerrainPanelProps } from './TerrainPanelBridge';

// MenuBar Bridge
export { ConnectedMenuBar } from './MenuBarBridge';

// ShaderDebugPanel Bridge
export { 
  ShaderDebugPanelContainer,
  useShaderDebugPanel,
  shaderPanelVisible,
  toggleShaderPanel,
  showShaderPanel,
  hideShaderPanel,
} from './ShaderDebugPanelBridge';
