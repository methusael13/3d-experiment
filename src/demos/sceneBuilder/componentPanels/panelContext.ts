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
import type { WebGPUShadowSettings } from '../components/panels/RenderingPanel';

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
  windManager: WindManager;
  lightingManager: LightingManager;
  cameraController: CameraController | null;

  // Object wind settings accessors
  getObjectWindSettings(objectId: string): ObjectWindSettings;
  setObjectWindSettings(objectId: string, settings: ObjectWindSettings): void;

  // Callbacks
  onGizmoModeChange(mode: GizmoMode): void;
  onGizmoOrientationChange(orientation: GizmoOrientation): void;
  onTransformUpdate(): void;
  onObjectListUpdate(): void;
  onSelectionChanged(): void;
  setShadowResolution(resolution: number): void;
  setShadowEnabled(enabled: boolean): void;
  setShowShadowThumbnail(show: boolean): void;
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
  windManager: WindManager;
  lightingManager: LightingManager;
  cameraController: CameraController | null;

  // Per-object settings storage (Maps)
  objectWindSettings: Map<string, ObjectWindSettings>;

  // Callbacks (all optional)
  onGizmoModeChange?: (mode: GizmoMode) => void;
  onGizmoOrientationChange?: (orientation: GizmoOrientation) => void;
  onTransformUpdate?: () => void;
  onObjectListUpdate?: () => void;
  onSelectionChanged?: () => void;
  setShadowResolution?: (resolution: number) => void;
  setShadowEnabled?: (enabled: boolean) => void;
  setShowShadowThumbnail?: (show: boolean) => void;
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
    windManager,
    lightingManager,
    cameraController,
    objectWindSettings,
    onGizmoModeChange,
    onGizmoOrientationChange,
    onTransformUpdate,
    onObjectListUpdate,
    onSelectionChanged,
    setShadowResolution,
    setShadowEnabled,
    setShowShadowThumbnail,
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
    windManager,
    lightingManager,
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

    // Callbacks with no-op defaults
    onGizmoModeChange: onGizmoModeChange || (() => {}),
    onGizmoOrientationChange: onGizmoOrientationChange || (() => {}),
    onTransformUpdate: onTransformUpdate || (() => {}),
    onObjectListUpdate: onObjectListUpdate || (() => {}),
    onSelectionChanged: onSelectionChanged || (() => {}),
    setShadowResolution: setShadowResolution || (() => {}),
    setShadowEnabled: setShadowEnabled || (() => {}),
    setShowShadowThumbnail: setShowShadowThumbnail || (() => {}),
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
