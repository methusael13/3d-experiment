/**
 * Object Panel
 * Displays transform controls and modifiers (wind, terrain blend) for selected objects
 */

import type { PanelContext, Panel } from './panelContext';
import type { GizmoMode } from '../gizmos';
import type { GizmoOrientation } from '../gizmos/BaseGizmo';
import type { ObjectWindSettings } from '../wind';
import type { AnySceneObject } from '../../../core/sceneObjects';

// ==================== Constants ====================

const objectPanelStyles = `
  .object-panel .modifier-settings.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
`;

const objectPanelTemplate = `
  <h3>Object</h3>
  <div class="section-content">
    <div class="env-tabs">
      <button class="env-tab active" data-tab="transform">Transform</button>
      <button class="env-tab" data-tab="edit" id="edit-tab-btn" style="display: none;">Edit</button>
      <button class="env-tab" data-tab="modifiers">Modifiers</button>
    </div>
    
    <!-- Transform Tab Content -->
    <div id="obj-transform-tab" class="env-tab-content active">
      <div class="gizmo-mode-toggle">
        <button id="gizmo-translate" class="gizmo-btn active" title="Translate (T)">T</button>
        <button id="gizmo-rotate" class="gizmo-btn" title="Rotate (R)">R</button>
        <button id="gizmo-scale" class="gizmo-btn" title="Scale (S)">S</button>
        <span class="gizmo-separator">|</span>
        <button id="gizmo-world" class="gizmo-btn orientation-btn active" title="World Space">W</button>
        <button id="gizmo-local" class="gizmo-btn orientation-btn" title="Local Space">L</button>
      </div>
      <div class="transform-group">
        <label>Name</label>
        <input type="text" id="object-name" class="name-input" placeholder="Object name">
      </div>
      <div class="transform-group">
        <label>Position <button class="reset-btn" id="reset-position" title="Reset to origin">⟲</button></label>
        <div class="vector-inputs">
          <input type="number" id="pos-x" step="0.1" placeholder="X">
          <input type="number" id="pos-y" step="0.1" placeholder="Y">
          <input type="number" id="pos-z" step="0.1" placeholder="Z">
        </div>
      </div>
      <div class="transform-group">
        <label>Rotation (°) <button class="reset-btn" id="reset-rotation" title="Reset rotation">⟲</button></label>
        <div class="vector-inputs">
          <input type="number" id="rot-x" step="5" placeholder="X">
          <input type="number" id="rot-y" step="5" placeholder="Y">
          <input type="number" id="rot-z" step="5" placeholder="Z">
        </div>
      </div>
      <div class="transform-group">
        <label>Scale <button class="reset-btn" id="reset-scale" title="Reset to 1,1,1">⟲</button></label>
        <div class="vector-inputs">
          <input type="number" id="scale-x" step="0.1" placeholder="X" min="0.01">
          <input type="number" id="scale-y" step="0.1" placeholder="Y" min="0.01">
          <input type="number" id="scale-z" step="0.1" placeholder="Z" min="0.01">
        </div>
      </div>
      <button id="delete-object" class="danger-btn">Delete Object</button>
    </div>
    
    <!-- Edit Tab Content (for primitives) -->
    <div id="obj-edit-tab" class="env-tab-content">
      <div class="transform-group">
        <label>Primitive Type</label>
        <div id="primitive-type-display" style="font-size: 12px; color: #ccc; padding: 4px 0;">-</div>
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Size</label>
          <span id="primitive-size-value" class="slider-value">1.0</span>
        </div>
        <input type="range" id="primitive-size" min="0.1" max="10" step="0.1" value="1" class="slider-input">
      </div>
      <div class="transform-group compact-slider" id="primitive-subdivision-group">
        <div class="slider-header">
          <label>Subdivision</label>
          <span id="primitive-subdivision-value" class="slider-value">16</span>
        </div>
        <input type="range" id="primitive-subdivision" min="4" max="64" step="4" value="16" class="slider-input">
      </div>
      <div class="modifier-divider"></div>
      <div class="transform-group">
        <label style="font-size: 11px; color: #888;">Debug</label>
        <label class="checkbox-label">
          <input type="checkbox" id="primitive-show-normals">
          <span>Show Normals</span>
        </label>
      </div>
    </div>
    
    <!-- Modifiers Tab Content -->
    <div id="obj-modifiers-tab" class="env-tab-content">
      <div class="modifier-section" id="wind-modifier">
        <label class="checkbox-label">
          <input type="checkbox" id="object-wind-enabled">
          <span>Wind Affects This Object</span>
        </label>
        <div class="modifier-settings" id="wind-modifier-settings">
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Influence</label>
              <span id="object-wind-influence-value" class="slider-value">1.0</span>
            </div>
            <input type="range" id="object-wind-influence" min="0" max="2" step="0.1" value="1" class="slider-input">
          </div>
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Stiffness</label>
              <span id="object-wind-stiffness-value" class="slider-value">0.5</span>
            </div>
            <input type="range" id="object-wind-stiffness" min="0" max="1" step="0.1" value="0.5" class="slider-input">
          </div>
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Anchor Height</label>
              <span id="object-wind-anchor-value" class="slider-value">0.0</span>
            </div>
            <input type="range" id="object-wind-anchor" min="-2" max="5" step="0.1" value="0" class="slider-input">
          </div>
          <div class="transform-group">
            <label>Leaf Materials</label>
            <div id="leaf-material-list" class="material-list"></div>
          </div>
          <div class="transform-group">
            <label>Branch Materials</label>
            <div id="branch-material-list" class="material-list"></div>
          </div>
        </div>
      </div>
      <div class="modifier-divider"></div>
      <div class="modifier-section" id="terrain-blend-modifier">
        <label class="checkbox-label">
          <input type="checkbox" id="object-terrain-blend-enabled">
          <span>Terrain Blend</span>
        </label>
        <div class="modifier-settings" id="terrain-blend-settings">
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Blend Distance</label>
              <span id="terrain-blend-distance-value" class="slider-value">0.5</span>
            </div>
            <input type="range" id="terrain-blend-distance" min="0.1" max="2" step="0.1" value="0.5" class="slider-input">
          </div>
          <p style="font-size: 10px; color: #666; margin-top: 4px;">Fades object edges at intersections with other geometry</p>
        </div>
      </div>
    </div>
  </div>
`;

// ==================== Extended Panel Interface ====================

export interface ObjectPanelAPI extends Panel {
  setGizmoMode(mode: GizmoMode): void;
  getGizmoMode(): GizmoMode;
  setGizmoOrientation(orientation: GizmoOrientation): void;
  getGizmoOrientation(): GizmoOrientation;
}

// ==================== ObjectPanel Class ====================

export class ObjectPanel implements ObjectPanelAPI {
  private panelElement: HTMLElement;
  private context: PanelContext;
  private styleEl: HTMLStyleElement;
  
  // State
  private currentGizmoMode: GizmoMode = 'translate';
  private currentOrientation: GizmoOrientation = 'world';
  
  // DOM references - Transform tab
  private objectName!: HTMLInputElement;
  private posX!: HTMLInputElement;
  private posY!: HTMLInputElement;
  private posZ!: HTMLInputElement;
  private rotX!: HTMLInputElement;
  private rotY!: HTMLInputElement;
  private rotZ!: HTMLInputElement;
  private scaleX!: HTMLInputElement;
  private scaleY!: HTMLInputElement;
  private scaleZ!: HTMLInputElement;
  
  // DOM references - Edit tab
  private editTabBtn!: HTMLButtonElement;
  private primitiveTypeDisplay!: HTMLDivElement;
  private primitiveSize!: HTMLInputElement;
  private primitiveSizeValue!: HTMLSpanElement;
  private primitiveSubdivision!: HTMLInputElement;
  private primitiveSubdivisionValue!: HTMLSpanElement;
  private primitiveSubdivisionGroup!: HTMLDivElement;
  private showNormalsCheckbox!: HTMLInputElement;
  
  // DOM references - Modifiers tab
  private windEnabled!: HTMLInputElement;
  private windModifierSettings!: HTMLDivElement;
  private windInfluence!: HTMLInputElement;
  private windInfluenceValue!: HTMLSpanElement;
  private windStiffness!: HTMLInputElement;
  private windStiffnessValue!: HTMLSpanElement;
  private windAnchor!: HTMLInputElement;
  private windAnchorValue!: HTMLSpanElement;
  private leafMaterialList!: HTMLDivElement;
  private branchMaterialList!: HTMLDivElement;
  private terrainBlendEnabled!: HTMLInputElement;
  private terrainBlendSettings!: HTMLDivElement;
  private terrainBlendDistance!: HTMLInputElement;
  private terrainBlendDistanceValue!: HTMLSpanElement;
  
  constructor(panelElement: HTMLElement, context: PanelContext) {
    this.panelElement = panelElement;
    this.context = context;
    
    // Set panel content
    panelElement.innerHTML = objectPanelTemplate;
    panelElement.classList.add('object-panel', 'sidebar-section');
    panelElement.id = 'object-panel';
    panelElement.style.display = 'none';
    
    // Add styles
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = objectPanelStyles;
    panelElement.appendChild(this.styleEl);
    
    this.cacheDOM();
    this.setup();
  }
  
  private cacheDOM(): void {
    const p = this.panelElement;
    
    // Transform tab
    this.objectName = p.querySelector('#object-name') as HTMLInputElement;
    this.posX = p.querySelector('#pos-x') as HTMLInputElement;
    this.posY = p.querySelector('#pos-y') as HTMLInputElement;
    this.posZ = p.querySelector('#pos-z') as HTMLInputElement;
    this.rotX = p.querySelector('#rot-x') as HTMLInputElement;
    this.rotY = p.querySelector('#rot-y') as HTMLInputElement;
    this.rotZ = p.querySelector('#rot-z') as HTMLInputElement;
    this.scaleX = p.querySelector('#scale-x') as HTMLInputElement;
    this.scaleY = p.querySelector('#scale-y') as HTMLInputElement;
    this.scaleZ = p.querySelector('#scale-z') as HTMLInputElement;
    
    // Edit tab
    this.editTabBtn = p.querySelector('#edit-tab-btn') as HTMLButtonElement;
    this.primitiveTypeDisplay = p.querySelector('#primitive-type-display') as HTMLDivElement;
    this.primitiveSize = p.querySelector('#primitive-size') as HTMLInputElement;
    this.primitiveSizeValue = p.querySelector('#primitive-size-value') as HTMLSpanElement;
    this.primitiveSubdivision = p.querySelector('#primitive-subdivision') as HTMLInputElement;
    this.primitiveSubdivisionValue = p.querySelector('#primitive-subdivision-value') as HTMLSpanElement;
    this.primitiveSubdivisionGroup = p.querySelector('#primitive-subdivision-group') as HTMLDivElement;
    this.showNormalsCheckbox = p.querySelector('#primitive-show-normals') as HTMLInputElement;
    
    // Modifiers tab
    this.windEnabled = p.querySelector('#object-wind-enabled') as HTMLInputElement;
    this.windModifierSettings = p.querySelector('#wind-modifier-settings') as HTMLDivElement;
    this.windInfluence = p.querySelector('#object-wind-influence') as HTMLInputElement;
    this.windInfluenceValue = p.querySelector('#object-wind-influence-value') as HTMLSpanElement;
    this.windStiffness = p.querySelector('#object-wind-stiffness') as HTMLInputElement;
    this.windStiffnessValue = p.querySelector('#object-wind-stiffness-value') as HTMLSpanElement;
    this.windAnchor = p.querySelector('#object-wind-anchor') as HTMLInputElement;
    this.windAnchorValue = p.querySelector('#object-wind-anchor-value') as HTMLSpanElement;
    this.leafMaterialList = p.querySelector('#leaf-material-list') as HTMLDivElement;
    this.branchMaterialList = p.querySelector('#branch-material-list') as HTMLDivElement;
    this.terrainBlendEnabled = p.querySelector('#object-terrain-blend-enabled') as HTMLInputElement;
    this.terrainBlendSettings = p.querySelector('#terrain-blend-settings') as HTMLDivElement;
    this.terrainBlendDistance = p.querySelector('#terrain-blend-distance') as HTMLInputElement;
    this.terrainBlendDistanceValue = p.querySelector('#terrain-blend-distance-value') as HTMLSpanElement;
  }
  
  private setup(): void {
    const { scene, onGizmoModeChange, onTransformUpdate, onObjectListUpdate, getObjectWindSettings, getObjectTerrainBlend } = this.context;
    const p = this.panelElement;
    
    // Tab switching
    const tabs = p.querySelectorAll('.env-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = (tab as HTMLElement).dataset.tab;
        p.querySelectorAll('.env-tab-content').forEach(content => content.classList.remove('active'));
        p.querySelector(`#obj-${tabName}-tab`)?.classList.add('active');
      });
    });
    
    // Gizmo mode buttons
    p.querySelector('#gizmo-translate')!.addEventListener('click', () => this.handleGizmoModeClick('translate'));
    p.querySelector('#gizmo-rotate')!.addEventListener('click', () => this.handleGizmoModeClick('rotate'));
    p.querySelector('#gizmo-scale')!.addEventListener('click', () => this.handleGizmoModeClick('scale'));
    
    // Gizmo orientation buttons
    p.querySelector('#gizmo-world')!.addEventListener('click', () => this.handleOrientationClick('world'));
    p.querySelector('#gizmo-local')!.addEventListener('click', () => this.handleOrientationClick('local'));
    
    // Object name
    this.objectName.addEventListener('input', () => {
      const obj = scene.getFirstSelected();
      if (obj && scene.getSelectionCount() === 1) {
        (obj as any).name = this.objectName.value || 'Unnamed';
        onObjectListUpdate();
      }
    });
    
    // Transform inputs
    ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-x', 'scale-y', 'scale-z'].forEach(inputId => {
      p.querySelector(`#${inputId}`)!.addEventListener('input', (e: Event) => {
        if (scene.getSelectionCount() !== 1) return;
        const obj = scene.getFirstSelected();
        if (!obj) return;
        
        const value = parseFloat((e.target as HTMLInputElement).value) || 0;
        const [type, axis] = inputId.split('-');
        const axisIndex = { x: 0, y: 1, z: 2 }[axis] as number;
        
        if (type === 'pos') obj.position[axisIndex] = value;
        else if (type === 'rot') obj.rotation[axisIndex] = value;
        else if (type === 'scale') obj.scale[axisIndex] = Math.max(0.01, value);
        
        scene.updateObjectTransform(obj.id);
        onTransformUpdate();
      });
    });
    
    // Reset buttons
    p.querySelector('#reset-position')!.addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.position = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      this.update();
      onTransformUpdate();
    });
    
    p.querySelector('#reset-rotation')!.addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.rotation = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      this.update();
      onTransformUpdate();
    });
    
    p.querySelector('#reset-scale')!.addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.scale = [1, 1, 1];
        scene.updateObjectTransform(obj.id);
      }
      this.update();
      onTransformUpdate();
    });
    
    // Delete button
    p.querySelector('#delete-object')!.addEventListener('click', () => {
      const ids = [...scene.getSelectedIds()];
      for (const id of ids) {
        scene.removeObject(id);
      }
      scene.clearSelection();
    });
    
    // Wind controls
    this.windEnabled.addEventListener('change', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.enabled = this.windEnabled.checked;
        this.windModifierSettings.classList.toggle('disabled', !settings.enabled);
      }
    });
    
    this.windInfluence.addEventListener('input', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.influence = parseFloat(this.windInfluence.value);
        this.windInfluenceValue.textContent = settings.influence.toFixed(1);
      }
    });
    
    this.windStiffness.addEventListener('input', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.stiffness = parseFloat(this.windStiffness.value);
        this.windStiffnessValue.textContent = settings.stiffness.toFixed(1);
      }
    });
    
    this.windAnchor.addEventListener('input', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.anchorHeight = parseFloat(this.windAnchor.value);
        this.windAnchorValue.textContent = settings.anchorHeight.toFixed(1);
      }
    });
    
    // Terrain blend controls
    this.terrainBlendEnabled.addEventListener('change', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectTerrainBlend(obj.id);
        settings.enabled = this.terrainBlendEnabled.checked;
        this.terrainBlendSettings.classList.toggle('disabled', !settings.enabled);
      }
    });
    
    this.terrainBlendDistance.addEventListener('input', () => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectTerrainBlend(obj.id);
        settings.blendDistance = parseFloat(this.terrainBlendDistance.value);
        this.terrainBlendDistanceValue.textContent = settings.blendDistance.toFixed(1);
      }
    });
    
    // Primitive controls
    this.primitiveSize.addEventListener('input', () => {
      const obj = scene.getFirstSelected() as any;
      if (obj && obj.objectType === 'primitive') {
        const newSize = parseFloat(this.primitiveSize.value);
        this.primitiveSizeValue.textContent = newSize.toFixed(1);
        scene.updatePrimitiveConfig(obj.id, { size: newSize });
      }
    });
    
    this.primitiveSubdivision.addEventListener('input', () => {
      const obj = scene.getFirstSelected() as any;
      if (obj && obj.objectType === 'primitive' && obj.primitiveType === 'sphere') {
        const newSubdiv = parseInt(this.primitiveSubdivision.value, 10);
        this.primitiveSubdivisionValue.textContent = String(newSubdiv);
        scene.updatePrimitiveConfig(obj.id, { subdivision: newSubdiv });
      }
    });
    
    this.showNormalsCheckbox.addEventListener('change', () => {
      const obj = scene.getFirstSelected() as any;
      if (obj && obj.objectType === 'primitive') {
        obj.showNormals = this.showNormalsCheckbox.checked;
      }
    });
  }
  
  private handleGizmoModeClick(mode: GizmoMode): void {
    this.setGizmoMode(mode);
    this.context.onGizmoModeChange(mode);
  }
  
  private handleOrientationClick(orientation: GizmoOrientation): void {
    this.setGizmoOrientation(orientation);
    this.context.onGizmoOrientationChange(orientation);
  }
  
  private updateTransformTab(): void {
    const { scene } = this.context;
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount === 1) {
      const obj = scene.getFirstSelected()!;
      this.objectName.value = obj.name;
      this.objectName.disabled = false;
      this.posX.value = obj.position[0].toFixed(2);
      this.posY.value = obj.position[1].toFixed(2);
      this.posZ.value = obj.position[2].toFixed(2);
      this.rotX.value = obj.rotation[0].toFixed(1);
      this.rotY.value = obj.rotation[1].toFixed(1);
      this.rotZ.value = obj.rotation[2].toFixed(1);
      this.scaleX.value = obj.scale[0].toFixed(2);
      this.scaleY.value = obj.scale[1].toFixed(2);
      this.scaleZ.value = obj.scale[2].toFixed(2);
    } else {
      const centroid = scene.getSelectionCentroid();
      this.objectName.value = `${selectionCount} objects`;
      this.objectName.disabled = true;
      this.posX.value = centroid[0].toFixed(2);
      this.posY.value = centroid[1].toFixed(2);
      this.posZ.value = centroid[2].toFixed(2);
      this.rotX.value = '-';
      this.rotY.value = '-';
      this.rotZ.value = '-';
      this.scaleX.value = '-';
      this.scaleY.value = '-';
      this.scaleZ.value = '-';
    }
  }
  
  private updateEditTab(): void {
    const { scene } = this.context;
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount !== 1) {
      this.editTabBtn.style.display = 'none';
      return;
    }
    
    const obj = scene.getFirstSelected() as any;
    if (!obj || obj.objectType !== 'primitive') {
      this.editTabBtn.style.display = 'none';
      return;
    }
    
    this.editTabBtn.style.display = '';
    
    const typeNames: Record<string, string> = { cube: 'Cube', plane: 'Plane', sphere: 'UV Sphere' };
    this.primitiveTypeDisplay.textContent = typeNames[obj.primitiveType] || obj.primitiveType;
    
    const config = obj.primitiveConfig || { size: 1, subdivision: 16 };
    this.primitiveSize.value = String(config.size);
    this.primitiveSizeValue.textContent = config.size.toFixed(1);
    
    if (obj.primitiveType === 'sphere') {
      this.primitiveSubdivisionGroup.style.display = '';
      this.primitiveSubdivision.value = String(config.subdivision || 16);
      this.primitiveSubdivisionValue.textContent = String(config.subdivision || 16);
    } else {
      this.primitiveSubdivisionGroup.style.display = 'none';
    }
    
    this.showNormalsCheckbox.checked = !!obj.showNormals;
  }
  
  private updateModifiersTab(): void {
    const { scene, getObjectWindSettings, getObjectTerrainBlend } = this.context;
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount !== 1) {
      this.windModifierSettings.classList.add('disabled');
      this.terrainBlendSettings.classList.add('disabled');
      return;
    }
    
    const obj = scene.getFirstSelected();
    if (!obj) {
      this.windModifierSettings.classList.add('disabled');
      this.terrainBlendSettings.classList.add('disabled');
      return;
    }
    
    // Wind settings
    const windSettings = getObjectWindSettings(obj.id);
    this.windEnabled.checked = windSettings.enabled;
    this.windInfluence.value = String(windSettings.influence);
    this.windInfluenceValue.textContent = windSettings.influence.toFixed(1);
    this.windStiffness.value = String(windSettings.stiffness);
    this.windStiffnessValue.textContent = windSettings.stiffness.toFixed(1);
    this.windAnchor.value = String(windSettings.anchorHeight);
    this.windAnchorValue.textContent = windSettings.anchorHeight.toFixed(1);
    this.windModifierSettings.classList.toggle('disabled', !windSettings.enabled);
    
    this.updateMaterialLists(obj, windSettings);
    
    // Terrain blend settings
    const terrainSettings = getObjectTerrainBlend(obj.id);
    this.terrainBlendEnabled.checked = terrainSettings.enabled;
    this.terrainBlendDistance.value = String(terrainSettings.blendDistance);
    this.terrainBlendDistanceValue.textContent = terrainSettings.blendDistance.toFixed(1);
    this.terrainBlendSettings.classList.toggle('disabled', !terrainSettings.enabled);
  }
  
  private updateMaterialLists(obj: AnySceneObject, settings: ObjectWindSettings): void {
    const model = (obj as any).model;
    if (!model || !model.materials) {
      this.leafMaterialList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      this.branchMaterialList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      return;
    }
    
    const materials = model.materials as Array<{ name?: string; baseColorFactor?: number[] }>;
    
    // Build leaf material list
    let leafHtml = '';
    materials.forEach((mat, idx) => {
      const isLeaf = settings.leafMaterialIndices.has(idx);
      const color = mat.baseColorFactor || [0.8, 0.8, 0.8, 1];
      const colorStr = `rgb(${Math.round(color[0]*255)}, ${Math.round(color[1]*255)}, ${Math.round(color[2]*255)})`;
      const name = mat.name || `Material ${idx}`;
      leafHtml += `
        <div class="material-item" data-material-idx="${idx}" data-type="leaf">
          <input type="checkbox" ${isLeaf ? 'checked' : ''}>
          <div class="material-color-swatch" style="background: ${colorStr}"></div>
          <span class="material-name">${name}</span>
          ${isLeaf ? '<span class="wind-type-badge leaf">Leaf</span>' : ''}
        </div>
      `;
    });
    this.leafMaterialList.innerHTML = leafHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
    // Build branch material list
    let branchHtml = '';
    materials.forEach((mat, idx) => {
      const isBranch = settings.branchMaterialIndices?.has(idx);
      const color = mat.baseColorFactor || [0.8, 0.8, 0.8, 1];
      const colorStr = `rgb(${Math.round(color[0]*255)}, ${Math.round(color[1]*255)}, ${Math.round(color[2]*255)})`;
      const name = mat.name || `Material ${idx}`;
      branchHtml += `
        <div class="material-item" data-material-idx="${idx}" data-type="branch">
          <input type="checkbox" ${isBranch ? 'checked' : ''}>
          <div class="material-color-swatch" style="background: ${colorStr}"></div>
          <span class="material-name">${name}</span>
          ${isBranch ? '<span class="wind-type-badge branch">Branch</span>' : ''}
        </div>
      `;
    });
    this.branchMaterialList.innerHTML = branchHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
    // Attach click handlers for leaf materials
    this.leafMaterialList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e: Event) => {
        const element = item as HTMLElement;
        const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(element.dataset.materialIdx!, 10);
        if (checkbox.checked) {
          settings.leafMaterialIndices.add(idx);
          settings.branchMaterialIndices?.delete(idx);
        } else {
          settings.leafMaterialIndices.delete(idx);
        }
        this.updateMaterialLists(obj, settings);
      });
    });
    
    // Attach click handlers for branch materials
    this.branchMaterialList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e: Event) => {
        const element = item as HTMLElement;
        const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(element.dataset.materialIdx!, 10);
        if (!settings.branchMaterialIndices) settings.branchMaterialIndices = new Set();
        
        if (checkbox.checked) {
          settings.branchMaterialIndices.add(idx);
          settings.leafMaterialIndices.delete(idx);
        } else {
          settings.branchMaterialIndices.delete(idx);
        }
        this.updateMaterialLists(obj, settings);
      });
    });
  }
  
  // ==================== Public API ====================
  
  setGizmoMode(mode: GizmoMode): void {
    this.currentGizmoMode = mode;
    this.panelElement.querySelectorAll('.gizmo-btn:not(.orientation-btn)').forEach(btn => btn.classList.remove('active'));
    this.panelElement.querySelector(`#gizmo-${mode}`)?.classList.add('active');
  }
  
  getGizmoMode(): GizmoMode {
    return this.currentGizmoMode;
  }
  
  setGizmoOrientation(orientation: GizmoOrientation): void {
    this.currentOrientation = orientation;
    this.panelElement.querySelectorAll('.orientation-btn').forEach(btn => btn.classList.remove('active'));
    this.panelElement.querySelector(`#gizmo-${orientation}`)?.classList.add('active');
  }
  
  getGizmoOrientation(): GizmoOrientation {
    return this.currentOrientation;
  }
  
  update(): void {
    const { scene } = this.context;
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount === 0) {
      this.panelElement.style.display = 'none';
      return;
    }
    
    this.panelElement.style.display = 'block';
    this.updateTransformTab();
    this.updateEditTab();
    this.updateModifiersTab();
  }
  
  destroy(): void {
    this.panelElement.innerHTML = '';
  }
}

// ==================== Factory Function ====================

/**
 * Creates the object panel
 * @deprecated Use `new ObjectPanel()` directly
 */
export function createObjectPanel(panelElement: HTMLElement, context: PanelContext): ObjectPanelAPI {
  return new ObjectPanel(panelElement, context);
}
