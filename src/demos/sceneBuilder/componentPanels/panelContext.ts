/**
 * Panel Context Factory
 * Creates a context object that panels use to interact with scene state
 */

import type { Scene } from '../../../core/Scene';
import type { WindManager, ObjectWindSettings } from '../wind';
import { createObjectWindSettings } from '../wind';
import type { LightingManager } from '../lightingManager';
import type { CameraController } from '../CameraController';
import type { GizmoMode } from '../gizmos';
import type { GizmoOrientation } from '../gizmos/BaseGizmo';
import type { ShadowRenderer, ContactShadowSettings } from '../../../core/renderers';
import type { WebGPUShadowSettings } from './RenderingPanel';

// ==================== Types ====================

/**
 * Terrain blend settings per object
 */
export interface TerrainBlendSettings {
  enabled: boolean;
  blendDistance: number;
}

/**
 * Panel context - shared state and callbacks for all panels
 */
export interface PanelContext {
  // Core references
  container: HTMLElement;
  scene: Scene;
  gl: WebGL2RenderingContext;
  windManager: WindManager;
  lightingManager: LightingManager;
  shadowRenderer: ShadowRenderer | null;
  cameraController: CameraController | null;

  // Object wind settings accessors
  getObjectWindSettings(objectId: string): ObjectWindSettings;
  setObjectWindSettings(objectId: string, settings: ObjectWindSettings): void;

  // Object terrain blend settings accessors
  getObjectTerrainBlend(objectId: string): TerrainBlendSettings;
  setObjectTerrainBlend(objectId: string, settings: TerrainBlendSettings): void;

  // Callbacks
  onGizmoModeChange(mode: GizmoMode): void;
  onGizmoOrientationChange(orientation: GizmoOrientation): void;
  onTransformUpdate(): void;
  onObjectListUpdate(): void;
  onSelectionChanged(): void;
  setShadowResolution(resolution: number): void;
  setShadowEnabled(enabled: boolean): void;
  setShowShadowThumbnail(show: boolean): void;
  setContactShadowSettings(settings: ContactShadowSettings): void;
  setLightMode(mode: 'directional' | 'hdr'): void;
  loadHDRTexture(file: File): Promise<void>;
  setHDRTexture(texture: WebGLTexture | null): void;
  onWindChanged(): void;
  onLightingChanged(): void;
  onTerrainBoundsChanged(worldSize: number, heightScale: number): void;
  
  // WebGPU test mode
  enableWebGPUTest?(): Promise<boolean>;
  disableWebGPUTest?(): void;
  
  // WebGPU shadow settings
  setWebGPUShadowSettings?(settings: WebGPUShadowSettings): void;
  
  // WebGPU water config
  setWebGPUWaterConfig?(config: {
    enabled: boolean;
    waterLevel?: number;
    waveHeight?: number;
    waveSpeed?: number;
    shallowColor?: [number, number, number];
    deepColor?: [number, number, number];
    depthFalloff?: number;
    opacity?: number;
  }): void;
  
  /** Callback when dynamic IBL setting changes (WebGPU only) */
  onDynamicIBLChanged?(enabled: boolean): void;
}

/**
 * Configuration for creating a panel context
 */
export interface PanelContextConfig {
  container: HTMLElement;
  scene: Scene;
  gl: WebGL2RenderingContext;
  windManager: WindManager;
  lightingManager: LightingManager;
  shadowRenderer: ShadowRenderer | null;
  cameraController: CameraController | null;

  // Per-object settings storage (Maps)
  objectWindSettings: Map<string, ObjectWindSettings>;
  objectTerrainBlendSettings: Map<string, TerrainBlendSettings>;

  // Callbacks (all optional)
  onGizmoModeChange?: (mode: GizmoMode) => void;
  onGizmoOrientationChange?: (orientation: GizmoOrientation) => void;
  onTransformUpdate?: () => void;
  onObjectListUpdate?: () => void;
  onSelectionChanged?: () => void;
  setShadowResolution?: (resolution: number) => void;
  setShadowEnabled?: (enabled: boolean) => void;
  setShowShadowThumbnail?: (show: boolean) => void;
  setContactShadowSettings?: (settings: ContactShadowSettings) => void;
  setLightMode?: (mode: 'directional' | 'hdr') => void;
  loadHDRTexture?: (file: File) => Promise<void>;
  setHDRTexture?: (texture: WebGLTexture | null) => void;
  onWindChanged?: () => void;
  onLightingChanged?: () => void;
  onTerrainBoundsChanged?: (worldSize: number, heightScale: number) => void;
  
  // WebGPU test mode
  enableWebGPUTest?: () => Promise<boolean>;
  disableWebGPUTest?: () => void;
  
  // WebGPU shadow settings
  setWebGPUShadowSettings?: (settings: WebGPUShadowSettings) => void;
  
  // WebGPU water config
  setWebGPUWaterConfig?: (config: {
    enabled: boolean;
    waterLevel?: number;
    waveHeight?: number;
    waveSpeed?: number;
    shallowColor?: [number, number, number];
    deepColor?: [number, number, number];
    depthFalloff?: number;
    opacity?: number;
  }) => void;
  
  /** Callback when dynamic IBL setting changes (WebGPU only) */
  onDynamicIBLChanged?: (enabled: boolean) => void;
}

/**
 * Common panel interface
 */
export interface Panel {
  update(): void;
  destroy(): void;
}

// ==================== Factory ====================

/**
 * Creates a panel context object
 */
export function createPanelContext(config: PanelContextConfig): PanelContext {
  const {
    container,
    scene,
    gl,
    windManager,
    lightingManager,
    shadowRenderer,
    cameraController,
    objectWindSettings,
    objectTerrainBlendSettings,
    onGizmoModeChange,
    onGizmoOrientationChange,
    onTransformUpdate,
    onObjectListUpdate,
    onSelectionChanged,
    setShadowResolution,
    setShadowEnabled,
    setShowShadowThumbnail,
    setContactShadowSettings,
    setLightMode,
    loadHDRTexture,
    setHDRTexture,
    onWindChanged,
    onLightingChanged,
  } = config;

  return {
    // Core references
    container,
    scene,
    gl,
    windManager,
    lightingManager,
    shadowRenderer,
    cameraController,

    // Object wind settings accessors
    getObjectWindSettings: (objectId: string) => {
      if (!objectWindSettings.has(objectId)) {
        objectWindSettings.set(objectId, createObjectWindSettings());
      }
      return objectWindSettings.get(objectId)!;
    },

    setObjectWindSettings: (objectId: string, settings: ObjectWindSettings) => {
      objectWindSettings.set(objectId, settings);
    },

    // Object terrain blend settings accessors
    getObjectTerrainBlend: (objectId: string) => {
      if (!objectTerrainBlendSettings.has(objectId)) {
        objectTerrainBlendSettings.set(objectId, { enabled: false, blendDistance: 0.5 });
      }
      return objectTerrainBlendSettings.get(objectId)!;
    },

    setObjectTerrainBlend: (objectId: string, settings: TerrainBlendSettings) => {
      objectTerrainBlendSettings.set(objectId, settings);
    },

    // Callbacks with no-op defaults
    onGizmoModeChange: onGizmoModeChange || (() => {}),
    onGizmoOrientationChange: onGizmoOrientationChange || (() => {}),
    onTransformUpdate: onTransformUpdate || (() => {}),
    onObjectListUpdate: onObjectListUpdate || (() => {}),
    onSelectionChanged: onSelectionChanged || (() => {}),
    setShadowResolution: setShadowResolution || (() => {}),
    setShadowEnabled: setShadowEnabled || (() => {}),
    setShowShadowThumbnail: setShowShadowThumbnail || (() => {}),
    setContactShadowSettings: setContactShadowSettings || (() => {}),
    setLightMode: setLightMode || (() => {}),
    loadHDRTexture: loadHDRTexture || (async () => {}),
    setHDRTexture: setHDRTexture || (() => {}),
    onWindChanged: onWindChanged || (() => {}),
    onLightingChanged: onLightingChanged || (() => {}),
    onTerrainBoundsChanged: config.onTerrainBoundsChanged || (() => {}),
    
    // WebGPU test mode
    enableWebGPUTest: config.enableWebGPUTest,
    disableWebGPUTest: config.disableWebGPUTest,
    
    // WebGPU shadow settings
    setWebGPUShadowSettings: config.setWebGPUShadowSettings,
    
    // WebGPU water config
    setWebGPUWaterConfig: config.setWebGPUWaterConfig,
    
    // Dynamic IBL
    onDynamicIBLChanged: config.onDynamicIBLChanged,
  };
}
