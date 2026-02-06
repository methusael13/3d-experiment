/**
 * SceneBuilder - Main controller for the Scene Builder demo
 * Orchestrates Model (Scene), View (Viewport), and UI (Panels)
 */

import { quat } from 'gl-matrix';
import { createSceneGraph, type SceneGraph } from '../../core/sceneGraph';
import { sceneBuilderStyles, sceneBuilderTemplate } from './styles';
import { saveScene, parseCameraState, parseLightingState, clearImportedModels, type CameraState as SerializerCameraState } from '../../loaders';
import { ShaderDebugPanel } from './ShaderDebugPanel';
import { createLightingManager, type LightingManager } from './lightingManager';
import { createScene, type Scene } from '../../core/Scene';
import {
  WindManager,
  type ObjectWindSettings,
  serializeObjectWindSettings,
  deserializeObjectWindSettings,
} from './wind';
import {
  createPanelContext,
  ObjectPanel,
  EnvironmentPanel,
  MaterialPanel,
  RenderingPanel,
  type PanelContext,
  type TerrainBlendSettings,
  type ObjectPanelAPI,
  type EnvironmentPanelAPI,
  type RenderingPanelAPI,
} from './componentPanels';
import { createObjectsPanelBridge, type ObjectsPanelBridge } from './components/bridges';
import type { ContactShadowSettings } from '../../core/renderers';
import { Viewport, type ViewportOptions } from './Viewport';
import { FPSCameraController } from './FPSCameraController';
import type { GizmoMode, GizmoOrientation } from './gizmos';
import type { Vec3 } from '../../core/types';
import type { TerrainObject } from '../../core/sceneObjects';
import { GPUTerrainSceneObject } from '../../core/sceneObjects';
import { WaterParams } from './components';

// ==================== Types ====================

export interface SceneBuilderOptions {
  width?: number;
  height?: number;
  onFps?: (fps: number) => void;
}

interface SceneBuilderDemo {
  init(): Promise<void>;
  destroy(): void;
  name: string;
  description: string;
}

// ==================== SceneBuilder Class ====================

export class SceneBuilder implements SceneBuilderDemo {
  readonly name = 'Scene Builder';
  readonly description = 'Import and position 3D models to create composite scenes';
  
  // Configuration
  private container: HTMLElement;
  private options: SceneBuilderOptions;
  private canvasWidth: number;
  private canvasHeight: number;
  
  // Model Layer
  private sceneGraph: SceneGraph;
  private scene: Scene | null = null;
  private windManager: WindManager;
  private lightingManager: LightingManager;
  private objectWindSettings = new Map<string, ObjectWindSettings>();
  private objectTerrainBlendSettings = new Map<string, TerrainBlendSettings>();
  
  // View Layer
  private viewport: Viewport | null = null;
  private shaderDebugPanel: ShaderDebugPanel | null = null;
  
  // UI Layer
  private panelContext: PanelContext | null = null;
  private objectsPanel: ObjectsPanelBridge | null = null;
  private objectPanel: ObjectPanelAPI | null = null;
  private environmentPanel: EnvironmentPanelAPI | null = null;
  private materialPanel: MaterialPanel | null = null;
  private renderingPanel: RenderingPanelAPI | null = null;
  
  // State
  private currentSceneFilename: string | null = null;
  private gizmoMode: GizmoMode = 'translate';
  private viewportMode: 'solid' | 'wireframe' = 'solid';
  
  // FPS Camera Mode
  private fpsController: FPSCameraController | null = null;
  private fpsMode = false;
  private lastFrameTime = 0;
  
  // WebGPU terrain object (added to scene when WebGPU mode enabled)
  private gpuTerrainObject: GPUTerrainSceneObject | null = null;
  
  constructor(container: HTMLElement, options: SceneBuilderOptions = {}) {
    this.container = container;
    this.options = options;
    this.canvasWidth = options.width ?? 800;
    this.canvasHeight = options.height ?? 600;
    
    // Initialize core systems
    this.sceneGraph = createSceneGraph();
    this.windManager = new WindManager();
    this.lightingManager = createLightingManager();
  }
  
  // ==================== Viewport Callbacks ====================
  
  private handleGizmoTransform = (type: 'position' | 'rotation' | 'scale', value: Vec3 | quat): void => {
    // value is quat for rotation, Vec3 for position/scale
    this.scene?.applyTransform(type, value as any);
    this.objectPanel?.update();
  };
  
  private handleGizmoDragEnd = (): void => {
    this.scene?.resetTransformTracking();
    this.updateGizmoTargetAfterDrag();
  };
  
  private handleUniformScaleChange = (newScale: Vec3): void => {
    const obj = this.scene?.getFirstSelected();
    if (obj && this.scene?.getSelectionCount() === 1) {
      obj.scale = newScale;
      this.scene.updateObjectTransform(obj.id);
      this.objectPanel?.update();
      this.updateGizmoTarget();
    }
  };
  
  private handleUniformScaleCommit = (): void => {
    // Scale committed, nothing special needed
  };
  
  private handleUniformScaleCancel = (): void => {
    // Viewport already returned original scale via cancelUniformScale()
  };
  
  private handleObjectClicked = (objectId: string, shiftKey: boolean): void => {
    this.scene?.select(objectId, { additive: shiftKey });
  };
  
  private handleBackgroundClicked = (shiftKey: boolean): void => {
    if (!shiftKey) this.scene?.clearSelection();
  };
  
  // ==================== Model → View Sync ====================
  
  private updateGizmoTarget(): void {
    if (!this.scene || !this.viewport) return;
    const target = this.scene.getGizmoTarget();
    if (target.position && target.rotationQuat) {
      // Pass quat directly to avoid Euler→Quat conversion drift
      this.viewport.setGizmoTargetWithQuat(target.position, target.rotationQuat, target.scale ?? undefined);
    } else {
      this.viewport.setGizmoTarget(target.position ?? null, target.rotation ?? undefined, target.scale ?? undefined);
    }
    this.scene.resetTransformTracking();
  }
  
  private updateGizmoTargetAfterDrag(): void {
    if (!this.scene || !this.viewport) return;
    const target = this.scene.getGizmoTarget();
    this.viewport.setGizmoTargetPositionAndScale(target.position ?? null, target.scale ?? undefined);
  }
  
  private updateRenderData(): void {
    if (!this.scene || !this.viewport) return;
    this.viewport.setRenderData({
      objects: this.scene.getAllObjects() as any,
      objectWindSettings: this.objectWindSettings,
      objectTerrainBlendSettings: this.objectTerrainBlendSettings,
      selectedIds: this.scene.getSelectedIds(),
      getModelMatrix: (obj: any) => this.scene!.getModelMatrix(obj),
    });
  }
  
  private updateLightingState(): void {
    if (!this.viewport) return;
    
    const lightParams = this.lightingManager.getLightParams(null) as any;
    this.viewport.setLightParams(lightParams);
    this.viewport.setLightingState({
      shadowResolution: this.lightingManager.sunLight.shadowResolution,
    });
  }
  
  private updateWindParams(): void {
    if (!this.viewport) return;
    this.windManager.update(0);
    for (const [_, settings] of this.objectWindSettings) {
      this.windManager.updateObjectPhysics(settings, 0);
    }
    this.viewport.setWindParams(this.windManager.getShaderUniforms());
  }
  
  // ==================== Model Event Handlers ====================
  
  private setupModelEvents(): void {
    if (!this.scene) return;
    
    this.scene.onSelectionChanged = () => {
      this.objectsPanel?.update();
      this.objectPanel?.update();
      this.materialPanel?.update();
      this.updateGizmoTarget();
      this.updateRenderData();
      this.updateFPSMenuState();
    };
    
    this.scene.onObjectAdded = () => {
      this.objectsPanel?.update();
      this.updateRenderData();
    };
    
    this.scene.onObjectRemoved = () => {
      this.objectsPanel?.update();
      this.updateRenderData();
    };
    
    this.scene.onGroupChanged = () => {
      this.objectsPanel?.update();
      this.updateRenderData();
    };
  }
  
  // ==================== Gizmo Mode ====================
  
  private setGizmoMode = (mode: GizmoMode): void => {
    this.gizmoMode = mode;
    this.viewport?.setGizmoMode(mode);
    this.objectPanel?.setGizmoMode(mode);
  };
  
  private setGizmoOrientation = (orientation: GizmoOrientation): void => {
    this.viewport?.setGizmoOrientation(orientation);
    this.objectPanel?.setGizmoOrientation(orientation);
  };
  
  // ==================== Uniform Scale ====================
  
  private startUniformScale(): void {
    if (!this.scene || !this.viewport) return;
    if (this.scene.getSelectionCount() !== 1) return;
    
    const obj = this.scene.getFirstSelected();
    if (!obj) return;
    
    const objectScreenPos = this.viewport.projectObjectToScreen(obj.position as Vec3);
    const mousePos = this.viewport.getLastMousePos();
    this.viewport.startUniformScale([...obj.scale] as Vec3, objectScreenPos, mousePos);
  }
  
  private cancelUniformScale(): void {
    if (!this.scene || !this.viewport) return;
    
    const obj = this.scene.getFirstSelected();
    if (obj && this.scene.getSelectionCount() === 1) {
      const originalScale = this.viewport.cancelUniformScale();
      obj.scale = [...originalScale] as Vec3;
      this.scene.updateObjectTransform(obj.id);
      this.objectPanel?.update();
      this.updateGizmoTarget();
    } else {
      this.viewport.cancelUniformScale();
    }
  }
  
  // ==================== Viewport Mode ====================
  
  private setViewportMode(mode: 'solid' | 'wireframe'): void {
    this.viewportMode = mode;
    this.viewport?.setViewportMode(mode);
    this.container.querySelector('#viewport-solid-btn')?.classList.toggle('active', mode === 'solid');
    this.container.querySelector('#viewport-wireframe-btn')?.classList.toggle('active', mode === 'wireframe');
  }
  
  // ==================== Lighting ====================
  
  private setLightMode = (mode: 'directional' | 'hdr'): void => {
    this.lightingManager.setMode(mode);
    this.updateLightingState();
    this.environmentPanel?.updateLightModeDisplay(mode);
  };
  
  private getLightingState(): any {
    const state = this.lightingManager.serialize();
    state.hdr.filename = (this.container.querySelector('#hdr-filename') as HTMLElement)?.textContent || null;
    return state;
  }
  
  private setLightingStateFromLoad(state: any): void {
    if (!state) return;
    this.lightingManager.deserialize(state);
    this.updateLightingState();
    this.viewport?.setShadowResolution(this.lightingManager.sunLight.shadowResolution);
    this.setLightMode(this.lightingManager.activeMode);
    this.environmentPanel?.update();
    
    if (this.lightingManager.hdrLight.filename && this.lightingManager.hdrLight.filename !== 'No HDR loaded') {
      this.environmentPanel?.setHDRFilename(`${this.lightingManager.hdrLight.filename} (reload required)`);
    }
  }
  
  // ==================== Menu Bar ====================
  
  private setupMenuBar(): void {
    const menuItems = this.container.querySelectorAll('.menu-item');
    
    menuItems.forEach(item => {
      const btn = item.querySelector(':scope > button');
      btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        menuItems.forEach(other => {
          if (other !== item) other.classList.remove('open');
        });
        item.classList.toggle('open');
      });
    });
    
    document.addEventListener('click', () => {
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-reset-origin')?.addEventListener('click', () => {
      this.viewport?.resetCameraOrigin();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-wireframe-view')?.addEventListener('click', () => {
      this.setViewportMode('wireframe');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-solid-view')?.addEventListener('click', () => {
      this.setViewportMode('solid');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Grid and axes toggle
    let showGrid = true;
    let showAxes = true;
    
    this.container.querySelector('#menu-toggle-grid')?.addEventListener('click', () => {
      showGrid = !showGrid;
      this.viewport?.setShowGrid(showGrid);
      const el = this.container.querySelector('#menu-toggle-grid');
      if (el) el.textContent = (showGrid ? '✓ ' : '  ') + 'Show Grid';
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-toggle-axes')?.addEventListener('click', () => {
      showAxes = !showAxes;
      this.viewport?.setShowAxes(showAxes);
      const el = this.container.querySelector('#menu-toggle-axes');
      if (el) el.textContent = (showAxes ? '✓ ' : '  ') + 'Show Axes';
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#viewport-solid-btn')?.addEventListener('click', () => this.setViewportMode('solid'));
    this.container.querySelector('#viewport-wireframe-btn')?.addEventListener('click', () => this.setViewportMode('wireframe'));
    
    this.container.querySelector('#menu-save-scene')?.addEventListener('click', () => {
      this.saveCurrentScene();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-load-scene')?.addEventListener('click', () => {
      (this.container.querySelector('#scene-file') as HTMLInputElement)?.click();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-sun-mode')?.addEventListener('click', () => {
      this.setLightMode('directional');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-hdr-mode')?.addEventListener('click', () => {
      this.setLightMode('hdr');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Scene > Add > Shapes menu
    this.container.querySelector('#menu-add-cube')?.addEventListener('click', () => {
      this.addPrimitive('cube');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-add-plane')?.addEventListener('click', () => {
      this.addPrimitive('plane');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-add-uvsphere')?.addEventListener('click', () => {
      this.addPrimitive('sphere');
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    this.container.querySelector('#menu-add-terrain')?.addEventListener('click', () => {
      this.addTerrain();
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Scene > Group Selection
    this.container.querySelector('#menu-group')?.addEventListener('click', () => {
      if (this.scene && this.scene.getSelectionCount() >= 2) {
        this.scene.createGroupFromSelection();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    // Scene > Ungroup
    this.container.querySelector('#menu-ungroup')?.addEventListener('click', () => {
      if (this.scene && this.scene.getSelectionCount() > 0) {
        this.scene.ungroupSelection();
      }
      menuItems.forEach(item => item.classList.remove('open'));
    });
    
    const shaderEditorBtn = this.container.querySelector('#menu-shader-editor');
    if (shaderEditorBtn) {
      shaderEditorBtn.addEventListener('click', () => {
        this.shaderDebugPanel?.toggle();
        menuItems.forEach(item => item.classList.remove('open'));
      });
    }
    
    // View > Expand/Shrink View
    let isExpanded = false;
    const expandViewBtn = this.container.querySelector('#menu-expand-view');
    if (expandViewBtn) {
      expandViewBtn.addEventListener('click', () => {
        isExpanded = !isExpanded;
        this.container.querySelector('.scene-builder-container')?.classList.toggle('expanded', isExpanded);
        expandViewBtn.textContent = isExpanded ? 'Shrink View' : 'Expand View';
        this.viewport?.resize();
        menuItems.forEach(item => item.classList.remove('open'));
      });
    }
    
    // View > Viewport > FPS Camera
    const fpsCameraBtn = this.container.querySelector('#menu-fps-camera') as HTMLButtonElement;
    if (fpsCameraBtn) {
      fpsCameraBtn.addEventListener('click', () => {
        this.enterFPSMode();
        menuItems.forEach(item => item.classList.remove('open'));
      });
    }
  }
  
  // ==================== FPS Camera Mode ====================
  
  /**
   * Update FPS camera menu item enabled state based on selection
   */
  private updateFPSMenuState(): void {
    const fpsCameraBtn = this.container.querySelector('#menu-fps-camera') as HTMLButtonElement;
    if (!fpsCameraBtn) return;
    
    // Enable only if exactly one terrain is selected
    const selectedTerrain = this.getSelectedTerrain();
    fpsCameraBtn.disabled = !selectedTerrain;
  }
  
  /**
   * Get selected terrain if exactly one terrain is selected
   */
  private getSelectedTerrain(): TerrainObject | null {
    if (!this.scene) return null;
    const selectedObjects = this.scene.getSelectedObjects();
    if (selectedObjects.length !== 1) return null;
    
    const obj = selectedObjects[0] as any;
    if (obj.objectType === 'terrain' && obj.hasGenerated?.()) {
      return obj as TerrainObject;
    }
    return null;
  }
  
  /**
   * Enter FPS camera mode on selected terrain
   */
  private enterFPSMode(): void {
    const terrain = this.getSelectedTerrain();
    if (!terrain || !this.viewport) return;
    
    const canvas = this.container.querySelector('#canvas') as HTMLCanvasElement;
    if (!canvas) return;
    
    // Create FPS controller if needed
    if (!this.fpsController) {
      this.fpsController = new FPSCameraController();
    }
    
    // Activate FPS mode
    const inputManager = this.viewport?.getInputManager();
    if (!inputManager) {
      console.error('[SceneBuilder] InputManager not available');
      return;
    }
    
    const success = this.fpsController.activate(canvas, terrain, inputManager, {
      onExit: () => this.exitFPSMode(),
    });
    
    if (!success) return;
    
    this.fpsMode = true;
    this.lastFrameTime = performance.now();
    
    // Update viewport to FPS mode
    this.viewport.setFPSMode(true, this.fpsController);
    
    // Hide UI elements
    this.setUIVisibility(false);
    
    console.log('[SceneBuilder] Entered FPS mode');
  }
  
  /**
   * Exit FPS camera mode
   */
  private exitFPSMode(): void {
    if (!this.fpsMode) return;
    
    this.fpsMode = false;
    
    // Restore viewport to editor mode
    this.viewport?.setFPSMode(false, null);
    
    // Show UI elements
    this.setUIVisibility(true);
    
    console.log('[SceneBuilder] Exited FPS mode');
  }
  
  /**
   * Show/hide editor UI during FPS mode
   */
  private setUIVisibility(visible: boolean): void {
    // Hide sidebars and menu bar in FPS mode
    const sidebars = this.container.querySelectorAll('.scene-builder-sidebar, .scene-builder-sidebar-right, .menu-bar, .viewport-toolbar, .viewport-controls');
    sidebars.forEach(el => {
      (el as HTMLElement).style.display = visible ? '' : 'none';
    });
  }
  
  private addPrimitive(type: 'cube' | 'plane' | 'sphere'): void {
    if (!this.scene) return;
    const obj = this.scene.addPrimitive(type);
    if (obj) {
      this.scene.select(obj.id);
      this.objectsPanel?.update();
      this.objectPanel?.update();
    }
  }
  
  private async addTerrain(): Promise<void> {
    if (!this.scene) return;
    const obj = await this.scene.addTerrain();
    if (obj) {
      this.scene.select(obj.id);
      this.objectsPanel?.update();
      this.objectPanel?.update();
      this.updateRenderData();
    }
  }
  
  private saveCurrentScene(): void {
    if (!this.scene || !this.viewport) return;
    
    const sceneData = this.scene.serialize() as any;
    sceneData.wind = this.windManager.serialize();
    sceneData.objectWindSettings = [];
    sceneData.objectTerrainBlendSettings = [];
    
    const allObjects = this.scene.getAllObjects();
    for (const obj of allObjects) {
      const windSettings = this.objectWindSettings.get(obj.id);
      sceneData.objectWindSettings.push(windSettings ? serializeObjectWindSettings(windSettings) : null);
      
      const terrainSettings = this.objectTerrainBlendSettings.get(obj.id);
      sceneData.objectTerrainBlendSettings.push(terrainSettings ? { ...terrainSettings } : null);
    }
    
    const savedFilename = saveScene(
      sceneData.objects,
      this.viewport.getCameraState() as SerializerCameraState,
      this.getLightingState(),
      this.currentSceneFilename,
      new Map(),
      sceneData.wind,
      sceneData.objectWindSettings,
      sceneData.groups,
      sceneData.objectTerrainBlendSettings
    );
    
    if (savedFilename) {
      this.currentSceneFilename = savedFilename;
    }
  }
  
  // ==================== Keyboard Shortcuts ====================
  
  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (!this.scene || !this.viewport) return;
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      
      // Skip all editor shortcuts when in FPS mode (FPS handles its own keys)
      if (this.fpsMode) return;
      
      if (e.key === 'Escape' && this.viewport.isUniformScaleActive()) {
        this.cancelUniformScale();
        return;
      }
      
      if (e.key === 'a' || e.key === 'A') {
        this.scene.toggleSelectAllObjects();
        return;
      }
      
      // Ctrl/Cmd+G - Group selection
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && !e.shiftKey && this.scene.getSelectionCount() >= 2) {
        e.preventDefault();
        this.scene.createGroupFromSelection();
        return;
      }
      
      // Ctrl/Cmd+Shift+G - Ungroup selection
      if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && e.shiftKey && this.scene.getSelectionCount() > 0) {
        e.preventDefault();
        this.scene.ungroupSelection();
        return;
      }
      
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.scene.getSelectionCount() > 0 && !this.viewport.isUniformScaleActive()) {
        e.preventDefault();
        this.deleteSelectedObjects();
        return;
      }
      
      if ((e.key === 's' || e.key === 'S') && this.scene.getSelectionCount() === 1 && !this.viewport.isGizmoDragging() && !this.viewport.isUniformScaleActive()) {
        this.startUniformScale();
        return;
      }
      
      if ((e.key === 'd' || e.key === 'D') && this.scene.getSelectionCount() > 0 && !this.viewport.isUniformScaleActive()) {
        this.duplicateSelectedObject();
        return;
      }
      
      if (!this.viewport.isUniformScaleActive()) {
        if (e.key === 't' || e.key === 'T') this.setGizmoMode('translate');
        if (e.key === 'r' || e.key === 'R') this.setGizmoMode('rotate');
        if (e.code === 'Numpad0' || e.key === '0') this.viewport.setCameraView('home');
        if (e.code === 'Numpad1' || e.key === '1') this.viewport.setCameraView('front');
        if (e.code === 'Numpad2' || e.key === '2') this.viewport.setCameraView('side');
        if (e.code === 'Numpad3' || e.key === '3') this.viewport.setCameraView('top');
      }
    });
  }
  
  // ==================== Scene File Handling ====================
  
  private setupSceneFileInput(): void {
    const sceneFile = this.container.querySelector('#scene-file') as HTMLInputElement;
    sceneFile?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        this.currentSceneFilename = file.name.replace(/\.json$/i, '');
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const sceneData = JSON.parse(event.target?.result as string);
            await this.loadSceneData(sceneData);
          } catch (err) {
            console.error('Failed to load scene:', err);
            this.currentSceneFilename = null;
          }
        };
        reader.readAsText(file);
      }
    });
  }
  
  private async loadSceneData(sceneData: any): Promise<void> {
    if (!this.scene || !this.viewport) return;
    
    this.viewport.setCameraState(parseCameraState(sceneData) as SerializerCameraState);
    
    const lightingState = parseLightingState(sceneData);
    if (lightingState) this.setLightingStateFromLoad(lightingState);
    
    if (sceneData.wind) {
      this.windManager.deserialize(sceneData.wind);
      this.viewport.setWindParams(this.windManager.getShaderUniforms());
    }
    
    await this.scene.deserialize({ objects: sceneData.objects, groups: sceneData.groups || [] });
    
    this.objectWindSettings.clear();
    if (sceneData.objectWindSettings && Array.isArray(sceneData.objectWindSettings)) {
      const allObjects = this.scene.getAllObjects();
      for (let i = 0; i < allObjects.length && i < sceneData.objectWindSettings.length; i++) {
        const settingsData = sceneData.objectWindSettings[i];
        if (settingsData) {
          const settings = deserializeObjectWindSettings(settingsData);
          if (settings) this.objectWindSettings.set(allObjects[i].id, settings);
        }
      }
    }
    
    this.objectTerrainBlendSettings.clear();
    if (sceneData.objectTerrainBlendSettings && Array.isArray(sceneData.objectTerrainBlendSettings)) {
      const allObjects = this.scene.getAllObjects();
      for (let i = 0; i < allObjects.length && i < sceneData.objectTerrainBlendSettings.length; i++) {
        const settingsData = sceneData.objectTerrainBlendSettings[i];
        if (settingsData) {
          this.objectTerrainBlendSettings.set(allObjects[i].id, { ...settingsData });
        }
      }
    }
    
    this.objectsPanel?.update();
    this.objectPanel?.update();
    this.environmentPanel?.update();
    this.updateRenderData();
    
    // Update camera bounds if terrain was loaded
    this.updateCameraBoundsForLoadedTerrain();
  }
  
  /**
   * Update camera limits based on loaded terrain
   */
  private updateCameraBoundsForLoadedTerrain(): void {
    if (!this.scene || !this.viewport) return;
    
    // Find first terrain object and update camera bounds
    const allObjects = this.scene.getAllObjects();
    for (const obj of allObjects) {
      if ((obj as any).objectType === 'terrain') {
        const terrain = obj as TerrainObject;
        const params = terrain.params;
        const worldSize = params.worldSize;
        const heightScale = params.noise.heightScale;
        
        // Same calculation as onTerrainBoundsChanged
        const diagonal = worldSize * Math.SQRT2 * 0.5;
        const maxHeight = worldSize * heightScale;
        const sceneRadius = Math.sqrt(diagonal * diagonal + maxHeight * maxHeight);
        
        this.viewport?.updateCameraForSceneBounds(sceneRadius);
        break; // Only need first terrain
      }
    }
  }
  
  // ==================== Object Operations ====================
  
  private deleteSelectedObjects(): void {
    if (!this.scene) return;
    
    const ids = [...this.scene.getSelectedIds()];
    for (const id of ids) {
      this.objectWindSettings.delete(id);
      this.objectTerrainBlendSettings.delete(id);
      this.scene.removeObject(id);
    }
    
    this.scene.clearSelection();
    this.updateRenderData();
  }
  
  private async duplicateSelectedObject(): Promise<void> {
    if (!this.scene) return;
    
    const obj = this.scene.getFirstSelected();
    if (!obj) return;
    
    const newObj = await this.scene.duplicateObject(obj.id);
    if (newObj) this.scene.select(newObj.id);
  }
  
  // ==================== Lifecycle ====================
  
  async init(): Promise<void> {
    // Create DOM structure
    this.container.innerHTML = sceneBuilderTemplate;
    
    const style = document.createElement('style');
    style.textContent = sceneBuilderStyles;
    this.container.appendChild(style);
    
    // DOM references
    const canvas = this.container.querySelector('#canvas') as HTMLCanvasElement;
    const viewportContainer = this.container.querySelector('.scene-builder-viewport') as HTMLElement;
    viewportContainer.style.position = 'relative';
    
    // Create viewport (View) with callbacks
    const viewportOptions: ViewportOptions = {
      width: this.canvasWidth,
      height: this.canvasHeight,
      onFps: this.options.onFps,
      onUpdate: (dt: number) => {
        this.windManager.update(dt);
        for (const [_, settings] of this.objectWindSettings) {
          this.windManager.updateObjectPhysics(settings, dt);
        }
        this.viewport?.setWindParams(this.windManager.getShaderUniforms());
      },
      onGizmoTransform: this.handleGizmoTransform,
      onGizmoDragEnd: this.handleGizmoDragEnd,
      onUniformScaleChange: this.handleUniformScaleChange,
      onUniformScaleCommit: this.handleUniformScaleCommit,
      onUniformScaleCancel: this.handleUniformScaleCancel,
      onObjectClicked: this.handleObjectClicked,
      onBackgroundClicked: this.handleBackgroundClicked,
    };
    
    this.viewport = new Viewport(canvas, viewportOptions);
    
    if (!this.viewport.init()) return;
    
    this.viewport.setOverlayContainer(viewportContainer);
    this.viewport.setSceneGraph(this.sceneGraph);
    
    // Create scene (Model)
    const gl = this.viewport.getGL()!;
    this.scene = createScene(gl, this.sceneGraph);
    this.setupModelEvents();
    
    // Setup UI (Controller)
    this.setupMenuBar();
    this.setupKeyboardShortcuts();
    this.setupSceneFileInput();
    
    // Create panel context
    this.panelContext = createPanelContext({
      container: this.container,
      scene: this.scene,
      gl: gl,
      windManager: this.windManager,
      lightingManager: this.lightingManager,
      shadowRenderer: null,
      cameraController: null,
      objectWindSettings: this.objectWindSettings,
      objectTerrainBlendSettings: this.objectTerrainBlendSettings,
      onGizmoModeChange: this.setGizmoMode,
      onGizmoOrientationChange: this.setGizmoOrientation,
      onTransformUpdate: () => this.updateGizmoTarget(),
      onObjectListUpdate: () => this.objectsPanel?.update(),
      onSelectionChanged: () => {
        this.objectsPanel?.update();
        this.objectPanel?.update();
        this.materialPanel?.update();
        this.updateGizmoTarget();
        this.updateRenderData();
      },
      setShadowResolution: (res: number) => {
        this.lightingManager.sunLight.shadowResolution = res;
        this.viewport?.setShadowResolution(res);
      },
      setShadowEnabled: (enabled: boolean) => {
        this.viewport?.setShadowEnabled(enabled);
      },
      setShowShadowThumbnail: (show: boolean) => this.viewport?.setShowShadowThumbnail(show),
      setContactShadowSettings: (settings: ContactShadowSettings) => {
        this.viewport?.setContactShadowSettings(settings);
      },
      setLightMode: this.setLightMode,
      setHDRTexture: (texture: WebGLTexture | null) => {
        this.lightingManager.hdrLight.setTexture(texture);
        this.viewport?.setHDRTexture(texture);
      },
      onWindChanged: () => {
        this.viewport?.setWindParams(this.windManager.getShaderUniforms());
      },
      onLightingChanged: () => {
        this.updateLightingState();
      },
      enableWebGPUTest: async () => {
        const success = await this.viewport?.enableWebGPUTest() ?? false;
        if (success && this.scene) {
          // Create GPUTerrainSceneObject and add to scene for selection
          this.gpuTerrainObject = new GPUTerrainSceneObject();
          const terrainManager = this.viewport?.getWebGPUTerrainManager() ?? null;
          this.gpuTerrainObject.setTerrainManager(terrainManager);
          
          // Add to scene so it appears in ObjectsPanel
          this.scene.addSceneObject(this.gpuTerrainObject);
          
          // Refresh panels
          this.objectsPanel?.update();
          this.updateRenderData();
          
          // Update camera bounds for WebGPU terrain
          if (terrainManager) {
            const config = terrainManager.getConfig();
            const diagonal = config.worldSize * Math.SQRT2 * 0.5;
            const maxHeight = config.heightScale;
            const sceneRadius = Math.sqrt(diagonal * diagonal + maxHeight * maxHeight);
            this.viewport?.updateCameraForSceneBounds(sceneRadius);
          }
        }
        return success;
      },
      disableWebGPUTest: () => {
        // Remove GPU terrain from scene
        if (this.gpuTerrainObject && this.scene) {
          this.scene.removeObject(this.gpuTerrainObject.id);
          this.gpuTerrainObject = null;
          this.objectsPanel?.update();
          this.updateRenderData();
        }
        this.viewport?.disableWebGPUTest();
      },
      onTerrainBoundsChanged: (worldSize: number, heightScale: number) => {
        // Calculate scene radius from terrain bounds: diagonal of XZ plane + max height
        const diagonal = worldSize * Math.SQRT2 * 0.5; // Half diagonal
        const maxHeight = worldSize * heightScale; // Height is scaled by worldSize
        const sceneRadius = Math.sqrt(diagonal * diagonal + maxHeight * maxHeight);
        this.viewport?.updateCameraForSceneBounds(sceneRadius);
      },
      setWebGPUShadowSettings: (settings) => {
        this.viewport?.setWebGPUShadowSettings(settings);
      },
      setWebGPUWaterConfig: (config) => {
        this.viewport?.setWebGPUWaterConfig(config as WaterParams);
      },
    });
    
    // Instantiate panels - ObjectsPanel is now a Preact bridge component
    this.objectsPanel = createObjectsPanelBridge({
      container: this.container.querySelector('#objects-panel-container') as HTMLElement,
      scene: this.scene,
      onSelectionChanged: () => {
        this.objectPanel?.update();
        this.materialPanel?.update();
        this.updateGizmoTarget();
        this.updateRenderData();
      },
    });
    
    this.objectPanel = new ObjectPanel(
      this.container.querySelector('#object-panel-container') as HTMLElement,
      this.panelContext
    );
    
    this.environmentPanel = new EnvironmentPanel(
      this.container.querySelector('#environment-panel-container') as HTMLElement,
      this.panelContext
    );
    
    // Create material panel context with required callbacks
    const materialPanelContext = {
      getSelectedObjects: () => this.scene?.getSelectedObjects() || [],
      getObjectMaterial: (objId: string) => {
        const obj = this.scene?.getObject(objId) as any;
        if (obj && obj.objectType === 'primitive') {
          return obj.getMaterial();
        }
        return null;
      },
      setObjectMaterial: (objId: string, material: any) => {
        const obj = this.scene?.getObject(objId) as any;
        if (obj && obj.objectType === 'primitive') {
          obj.setMaterial(material);
        }
      },
      onMaterialChange: () => {},
    };
    
    this.materialPanel = new MaterialPanel(
      this.container.querySelector('#material-panel-container') as HTMLElement,
      materialPanelContext
    );
    
    // Create rendering panel (using environment panel container for now, can be moved later)
    const renderingPanelContainer = this.container.querySelector('#rendering-panel-container');
    if (renderingPanelContainer) {
      this.renderingPanel = new RenderingPanel(
        renderingPanelContainer as HTMLElement,
        this.panelContext
      );
    }
    
    this.shaderDebugPanel = new ShaderDebugPanel(viewportContainer);
    
    // Initial sync
    this.updateLightingState();
    this.viewport.setWindParams(this.windManager.getShaderUniforms());
    this.updateRenderData();
  }
  
  destroy(): void {
    if (this.viewport) {
      this.viewport.destroy();
      this.viewport = null;
    }
    
    if (this.shaderDebugPanel) {
      this.shaderDebugPanel.destroy();
      this.shaderDebugPanel = null;
    }
    
    if (this.objectsPanel) {
      this.objectsPanel.destroy();
      this.objectsPanel = null;
    }
    
    if (this.objectPanel) {
      this.objectPanel.destroy();
      this.objectPanel = null;
    }
    
    if (this.environmentPanel) {
      this.environmentPanel.destroy();
      this.environmentPanel = null;
    }
    
    if (this.materialPanel) {
      this.materialPanel.destroy();
      this.materialPanel = null;
    }
    
    if (this.renderingPanel) {
      this.renderingPanel.destroy();
      this.renderingPanel = null;
    }
    
    this.panelContext = null;
    
    if (this.scene) {
      this.scene.destroy();
      this.scene = null;
    }
    
    this.sceneGraph.clear();
    clearImportedModels();
    this.container.innerHTML = '';
  }
}

// ==================== Factory Function ====================

/**
 * Creates a Scene Builder demo instance
 * @deprecated Use `new SceneBuilder()` directly
 */
export function createSceneBuilderDemo(
  container: HTMLElement,
  options?: SceneBuilderOptions
): SceneBuilderDemo {
  return new SceneBuilder(container, options);
}
