/**
 * Material Panel - PBR material controls for primitives
 * Shows metallic/roughness sliders and albedo color picker
 */

import type { Panel } from './panelContext';
import type { PBRMaterial } from '../../../core/sceneObjects';
import { isPrimitiveObject, isModelObject } from '../../../core/sceneObjects';

// ==================== Types ====================

export interface MaterialPanelContext {
  getSelectedObjects(): Array<{ id: string; objectType?: string }>;
  getObjectMaterial(id: string): PBRMaterial | null;
  setObjectMaterial(id: string, material: Partial<PBRMaterial>): void;
  onMaterialChange?: () => void;
}

// ==================== Constants ====================

const materialPanelTemplate = `
  <div class="panel-header">Material</div>
  <div class="panel-content material-content">
    <div class="no-selection" style="display: none;">Select a primitive to edit material</div>
    <div class="material-controls" style="display: none;">
      <div class="control-group">
        <label>Albedo</label>
        <div class="color-row">
          <input type="color" class="albedo-color" value="#c0c0c0">
          <span class="color-hex">#c0c0c0</span>
        </div>
      </div>
      <div class="control-group">
        <label>Metallic <span class="value-display metallic-value">0.0</span></label>
        <input type="range" class="metallic-slider slider-input" min="0" max="1" step="0.01" value="0">
      </div>
      <div class="control-group">
        <label>Roughness <span class="value-display roughness-value">0.5</span></label>
        <input type="range" class="roughness-slider slider-input" min="0.04" max="1" step="0.01" value="0.5">
      </div>
      <div class="preset-buttons">
        <button class="preset-btn" data-preset="plastic">Plastic</button>
        <button class="preset-btn" data-preset="metal">Metal</button>
        <button class="preset-btn" data-preset="gold">Gold</button>
        <button class="preset-btn" data-preset="ceramic">Ceramic</button>
      </div>
    </div>
    <div class="glb-material-info" style="display: none;">
      <div class="glb-notice">GLB material (read-only)</div>
      <div class="glb-props"></div>
    </div>
  </div>
`;

// Material presets
const PRESETS: Record<string, PBRMaterial> = {
  plastic: { albedo: [0.8, 0.2, 0.2], metallic: 0.0, roughness: 0.4 },
  metal: { albedo: [0.9, 0.9, 0.9], metallic: 1.0, roughness: 0.3 },
  gold: { albedo: [1.0, 0.84, 0.0], metallic: 1.0, roughness: 0.2 },
  ceramic: { albedo: [0.95, 0.95, 0.92], metallic: 0.0, roughness: 0.1 },
};

// ==================== Helpers ====================

function rgbToHex(rgb: [number, number, number]): string {
  const r = Math.round(rgb[0] * 255);
  const g = Math.round(rgb[1] * 255);
  const b = Math.round(rgb[2] * 255);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [0.75, 0.75, 0.75];
  return [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255,
  ];
}

// ==================== MaterialPanel Class ====================

export class MaterialPanel implements Panel {
  private container: HTMLElement;
  private context: MaterialPanelContext;
  private panel: HTMLDivElement;
  
  // State
  private currentObjectId: string | null = null;
  private isPrimitive = false;
  
  // DOM references
  private noSelection!: HTMLDivElement;
  private materialControls!: HTMLDivElement;
  private glbMaterialInfo!: HTMLDivElement;
  private albedoInput!: HTMLInputElement;
  private colorHex!: HTMLSpanElement;
  private metallicSlider!: HTMLInputElement;
  private metallicValue!: HTMLSpanElement;
  private roughnessSlider!: HTMLInputElement;
  private roughnessValue!: HTMLSpanElement;
  private presetButtons!: NodeListOf<HTMLButtonElement>;
  private glbProps!: HTMLDivElement;
  
  constructor(container: HTMLElement, context: MaterialPanelContext) {
    this.container = container;
    this.context = context;
    
    // Create panel structure
    this.panel = document.createElement('div');
    this.panel.className = 'material-panel';
    this.panel.innerHTML = materialPanelTemplate;
    container.appendChild(this.panel);
    
    this.cacheDOM();
    this.setup();
  }
  
  private cacheDOM(): void {
    this.noSelection = this.panel.querySelector('.no-selection') as HTMLDivElement;
    this.materialControls = this.panel.querySelector('.material-controls') as HTMLDivElement;
    this.glbMaterialInfo = this.panel.querySelector('.glb-material-info') as HTMLDivElement;
    this.albedoInput = this.panel.querySelector('.albedo-color') as HTMLInputElement;
    this.colorHex = this.panel.querySelector('.color-hex') as HTMLSpanElement;
    this.metallicSlider = this.panel.querySelector('.metallic-slider') as HTMLInputElement;
    this.metallicValue = this.panel.querySelector('.metallic-value') as HTMLSpanElement;
    this.roughnessSlider = this.panel.querySelector('.roughness-slider') as HTMLInputElement;
    this.roughnessValue = this.panel.querySelector('.roughness-value') as HTMLSpanElement;
    this.presetButtons = this.panel.querySelectorAll('.preset-btn') as NodeListOf<HTMLButtonElement>;
    this.glbProps = this.panel.querySelector('.glb-props') as HTMLDivElement;
  }
  
  private setup(): void {
    this.albedoInput.addEventListener('input', this.handleAlbedoChange);
    this.metallicSlider.addEventListener('input', this.handleMetallicChange);
    this.roughnessSlider.addEventListener('input', this.handleRoughnessChange);
    this.presetButtons.forEach(btn => btn.addEventListener('click', this.handlePreset));
  }
  
  private handleAlbedoChange = (): void => {
    const hex = this.albedoInput.value;
    this.colorHex.textContent = hex;
    
    if (this.currentObjectId && this.isPrimitive) {
      const albedo = hexToRgb(hex);
      this.context.setObjectMaterial(this.currentObjectId, { albedo });
      this.context.onMaterialChange?.();
    }
  };
  
  private handleMetallicChange = (): void => {
    const value = parseFloat(this.metallicSlider.value);
    this.metallicValue.textContent = value.toFixed(2);
    
    if (this.currentObjectId && this.isPrimitive) {
      this.context.setObjectMaterial(this.currentObjectId, { metallic: value });
      this.context.onMaterialChange?.();
    }
  };
  
  private handleRoughnessChange = (): void => {
    const value = parseFloat(this.roughnessSlider.value);
    this.roughnessValue.textContent = value.toFixed(2);
    
    if (this.currentObjectId && this.isPrimitive) {
      this.context.setObjectMaterial(this.currentObjectId, { roughness: value });
      this.context.onMaterialChange?.();
    }
  };
  
  private handlePreset = (e: Event): void => {
    const target = e.target as HTMLButtonElement;
    const presetName = target.dataset.preset;
    if (!presetName) return;
    
    const preset = PRESETS[presetName];
    if (!preset || !this.currentObjectId || !this.isPrimitive) return;
    
    // Update UI
    this.albedoInput.value = rgbToHex(preset.albedo);
    this.colorHex.textContent = this.albedoInput.value;
    this.metallicSlider.value = String(preset.metallic);
    this.metallicValue.textContent = preset.metallic.toFixed(2);
    this.roughnessSlider.value = String(preset.roughness);
    this.roughnessValue.textContent = preset.roughness.toFixed(2);
    
    // Apply material
    this.context.setObjectMaterial(this.currentObjectId, preset);
    this.context.onMaterialChange?.();
  };
  
  update(): void {
    const selected = this.context.getSelectedObjects();
    
    if (selected.length === 0) {
      this.noSelection.style.display = 'block';
      this.materialControls.style.display = 'none';
      this.glbMaterialInfo.style.display = 'none';
      this.currentObjectId = null;
      this.isPrimitive = false;
      return;
    }
    
    // Use first selected object
    const obj = selected[0] as any;
    this.currentObjectId = obj.id;
    this.isPrimitive = obj.objectType === 'primitive';
    
    if (this.isPrimitive) {
      // Show editable controls
      this.noSelection.style.display = 'none';
      this.materialControls.style.display = 'block';
      this.glbMaterialInfo.style.display = 'none';
      
      // Get current material
      const material = this.context.getObjectMaterial(obj.id);
      if (material) {
        this.albedoInput.value = rgbToHex(material.albedo || [0.75, 0.75, 0.75]);
        this.colorHex.textContent = this.albedoInput.value;
        this.metallicSlider.value = String(material.metallic ?? 0);
        this.metallicValue.textContent = (material.metallic ?? 0).toFixed(2);
        this.roughnessSlider.value = String(material.roughness ?? 0.5);
        this.roughnessValue.textContent = (material.roughness ?? 0.5).toFixed(2);
      }
    } else {
      // GLB model - show read-only info
      this.noSelection.style.display = 'none';
      this.materialControls.style.display = 'none';
      this.glbMaterialInfo.style.display = 'block';
      
      const material = this.context.getObjectMaterial(obj.id);
      if (material) {
        this.glbProps.innerHTML = `
          <div class="glb-prop">Metallic: ${(material.metallic ?? 1).toFixed(2)}</div>
          <div class="glb-prop">Roughness: ${(material.roughness ?? 1).toFixed(2)}</div>
        `;
      } else {
        this.glbProps.innerHTML = '<div class="glb-prop">No PBR data</div>';
      }
    }
  }
  
  destroy(): void {
    this.albedoInput.removeEventListener('input', this.handleAlbedoChange);
    this.metallicSlider.removeEventListener('input', this.handleMetallicChange);
    this.roughnessSlider.removeEventListener('input', this.handleRoughnessChange);
    this.presetButtons.forEach(btn => btn.removeEventListener('click', this.handlePreset));
    this.panel.remove();
  }
}

// ==================== Factory Function ====================

/**
 * Creates the material panel
 * @deprecated Use `new MaterialPanel()` directly
 */
export function createMaterialPanel(container: HTMLElement, context: MaterialPanelContext): Panel {
  return new MaterialPanel(container, context);
}
