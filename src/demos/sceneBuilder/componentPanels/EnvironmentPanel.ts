/**
 * Environment Panel
 * Displays lighting and global wind controls
 */

import { HDRLoader } from '../../../loaders';
import { TONE_MAPPING, TONE_MAPPING_NAMES } from '../../../core/sceneObjects/lights';
import type { PanelContext, Panel } from './panelContext';
import type { WindManager } from '../wind';
import type { LightingManager } from '../lightingManager';

// ==================== Types ====================

interface HDRManifestEntry {
  name: string;
  displayName: string;
}

export interface EnvironmentPanelAPI extends Panel {
  updateLightModeDisplay(mode: 'directional' | 'hdr'): void;
  openHDRFilePicker(): void;
  setHDRFilename(filename: string): void;
}

// ==================== Constants ====================

const environmentPanelStyles = `
  .environment-panel .hdr-progress { margin-top: 8px; padding: 8px; background: #333; border-radius: 4px; }
  .environment-panel .hdr-progress-bar { height: 4px; background: #222; border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
  .environment-panel .hdr-progress-fill { height: 100%; background: #ff6666; width: 0%; transition: width 0.1s ease-out; }
  .environment-panel .hdr-progress-text { font-size: 10px; color: #888; }
  .environment-panel .wind-direction-indicator { width: 40px; height: 40px; border: 1px solid #555; border-radius: 50%; position: relative; margin: 4px auto; background: #222; }
  .environment-panel .wind-direction-arrow { position: absolute; top: 50%; left: 50%; width: 16px; height: 2px; background: #ff6666; transform-origin: left center; transform: translateY(-50%); border-radius: 1px; }
  .environment-panel .wind-direction-arrow::after { content: ''; position: absolute; right: -2px; top: -3px; border: 4px solid transparent; border-left: 6px solid #ff6666; }
  .environment-panel .wind-enabled-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #444; margin-left: 8px; }
  .environment-panel .wind-enabled-indicator.active { background: #4f4; box-shadow: 0 0 4px #4f4; }
  .environment-panel .hdr-gallery { margin-top: 8px; margin-bottom: 8px; }
  .environment-panel .hdr-gallery-label { font-size: 11px; color: #888; margin-bottom: 6px; }
  .environment-panel .hdr-gallery-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-height: 180px; overflow-y: auto; padding: 4px; background: #222; border-radius: 4px; }
  .environment-panel .hdr-gallery-item { position: relative; border-radius: 4px; overflow: hidden; cursor: pointer; border: 2px solid transparent; transition: border-color 0.15s, transform 0.15s; background: #333; }
  .environment-panel .hdr-gallery-item:hover { border-color: #666; transform: scale(1.02); }
  .environment-panel .hdr-gallery-item.selected { border-color: #ff6666; }
  .environment-panel .hdr-gallery-item.loading { opacity: 0.5; pointer-events: none; }
  .environment-panel .hdr-gallery-thumb { width: 100%; height: 100%; object-fit: cover; }
  .environment-panel .hdr-gallery-name { position: absolute; bottom: 0; left: 0; right: 0; padding: 2px 4px; background: rgba(0,0,0,0.7); font-size: 9px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .environment-panel .hdr-gallery-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: linear-gradient(135deg, #2a2a2a 0%, #3a3a3a 100%); color: #666; font-size: 16px; }
  .environment-panel .hdr-gallery-upload { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; background: #2a2a2a; color: #888; font-size: 10px; gap: 2px; }
  .environment-panel .hdr-gallery-upload-icon { font-size: 18px; }
  .environment-panel .hdr-load-btn { width: 100%; padding: 6px 12px; margin-top: 8px; background: #ff6666; color: #fff; border: none; border-radius: 4px; font-size: 11px; font-weight: 500; cursor: pointer; transition: background 0.15s; }
  .environment-panel .hdr-load-btn:hover { background: #ff8080; }
  .environment-panel .hdr-load-btn:disabled { background: #555; cursor: not-allowed; }
  .environment-panel .light-mode-toggle { display: flex; gap: 4px; margin-bottom: 12px; }
  .environment-panel .light-mode-btn { flex: 1; padding: 6px 12px; background: #333; color: #aaa; border: 1px solid #444; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all 0.15s; }
  .environment-panel .light-mode-btn:hover { background: #444; color: #fff; }
  .environment-panel .light-mode-btn.active { background: #ff6666; color: #fff; border-color: #ff6666; }
`;

const environmentPanelTemplate = `
  <h3>Environment</h3>
  <div class="section-content">
    <div class="env-tabs">
      <button class="env-tab active" data-tab="lighting">Lighting</button>
      <button class="env-tab" data-tab="wind">Wind</button>
    </div>
    <div id="env-lighting-tab" class="env-tab-content active">
      <div class="light-mode-toggle">
        <button id="light-mode-sun" class="light-mode-btn active">☀️ Sun</button>
        <button id="light-mode-hdr" class="light-mode-btn">🌄 HDR</button>
      </div>
      <div id="sun-controls">
        <div class="transform-group compact-slider"><div class="slider-header"><label>Azimuth</label><span id="sun-azimuth-value" class="slider-value">45°</span></div><input type="range" id="sun-azimuth" min="0" max="360" value="45" class="slider-input"></div>
        <div class="transform-group compact-slider"><div class="slider-header"><label>Elevation</label><span id="sun-elevation-value" class="slider-value">45°</span></div><input type="range" id="sun-elevation" min="-90" max="90" value="45" class="slider-input"></div>
        <div class="transform-group compact-slider"><div class="slider-header"><label>Ambient</label><span id="sun-ambient-value" class="slider-value">0.15</span></div><input type="range" id="sun-ambient" min="0" max="1" step="0.05" value="0.15" class="slider-input"></div>
        <div class="shadow-controls">
          <label class="checkbox-label"><input type="checkbox" id="shadow-enabled" checked><span>Enable Shadows</span></label>
          <div class="transform-group"><label>Shadow Quality</label><div class="shadow-quality-btns"><button id="shadow-1024" class="quality-btn">1024</button><button id="shadow-2048" class="quality-btn active">2048</button><button id="shadow-4096" class="quality-btn">4096</button></div></div>
          <div class="transform-group"><label>Shadow Debug</label><select id="shadow-debug" style="width: 100%; padding: 4px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; font-size: 11px;"><option value="0">Off</option><option value="1">Depth Map</option><option value="2">UV Coords</option><option value="3">Shadow Value</option></select></div>
          <label class="checkbox-label"><input type="checkbox" id="shadow-thumbnail"><span>Show Depth Thumbnail</span></label>
        </div>
      </div>
      <div id="hdr-controls" style="display: none;">
        <div class="transform-group compact-slider"><div class="slider-header"><label>HDR Exposure</label><span id="hdr-exposure-value" class="slider-value">1.0</span></div><input type="range" id="hdr-exposure" min="0.1" max="5" step="0.1" value="1" class="slider-input"></div>
        <div id="hdr-filename" class="hdr-filename">No HDR loaded</div>
        <div class="hdr-gallery"><div class="hdr-gallery-label">Available HDRs</div><div id="hdr-gallery-grid" class="hdr-gallery-grid"></div><button id="hdr-load-btn" class="hdr-load-btn" disabled>Load Selected</button></div>
        <div id="hdr-progress" class="hdr-progress" style="display: none;"><div class="hdr-progress-bar"><div id="hdr-progress-fill" class="hdr-progress-fill"></div></div><span id="hdr-progress-text" class="hdr-progress-text">Processing...</span></div>
      </div>
      <input type="file" id="hdr-file" accept=".hdr" style="display: none;">
      <div class="transform-group" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #444;">
        <label>Tone Mapping</label>
        <select id="tone-mapping" style="width: 100%; padding: 4px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; font-size: 11px;"><option value="none">None (Linear)</option><option value="reinhard">Reinhard</option><option value="reinhardLum">Reinhard (Luminance)</option><option value="aces">ACES Filmic</option><option value="uncharted">Uncharted 2</option></select>
      </div>
    </div>
    <div id="env-wind-tab" class="env-tab-content">
      <label class="checkbox-label"><input type="checkbox" id="wind-enabled"><span>Enable Wind <span id="wind-enabled-indicator" class="wind-enabled-indicator"></span></span></label>
      <div class="transform-group"><div class="wind-direction-indicator"><div id="wind-direction-arrow" class="wind-direction-arrow"></div></div></div>
      <div class="transform-group compact-slider"><div class="slider-header"><label>Direction</label><span id="wind-direction-value" class="slider-value">45°</span></div><input type="range" id="wind-direction" min="0" max="360" value="45" class="slider-input"></div>
      <div class="transform-group compact-slider"><div class="slider-header"><label>Strength</label><span id="wind-strength-value" class="slider-value">0.5</span></div><input type="range" id="wind-strength" min="0" max="2" step="0.1" value="0.5" class="slider-input"></div>
      <div class="transform-group compact-slider"><div class="slider-header"><label>Turbulence</label><span id="wind-turbulence-value" class="slider-value">0.5</span></div><input type="range" id="wind-turbulence" min="0" max="1" step="0.1" value="0.5" class="slider-input"></div>
      <div class="transform-group compact-slider"><div class="slider-header"><label>Gust Strength</label><span id="wind-gust-strength-value" class="slider-value">0.3</span></div><input type="range" id="wind-gust-strength" min="0" max="1" step="0.1" value="0.3" class="slider-input"></div>
      <div class="transform-group compact-slider"><div class="slider-header"><label>Debug</label></div><select id="wind-debug" style="width: 100%; padding: 4px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; font-size: 11px;"><option value="0">Off</option><option value="1">Wind Type</option><option value="2">Height Factor</option><option value="3">Displacement</option></select></div>
    </div>
  </div>
`;

// ==================== EnvironmentPanel Class ====================

export class EnvironmentPanel implements EnvironmentPanelAPI {
  private panelElement: HTMLElement;
  private context: PanelContext;
  private gl: WebGL2RenderingContext;
  private windManager: WindManager;
  private lightingManager: LightingManager;
  private styleEl: HTMLStyleElement;
  
  // HDR Gallery state
  private hdrManifest: HDRManifestEntry[] = [];
  private selectedHdrName: string | null = null;
  private isLoadingHdr = false;
  
  // Cached DOM elements
  private lightModeSunBtn!: HTMLButtonElement;
  private lightModeHdrBtn!: HTMLButtonElement;
  private sunControls!: HTMLDivElement;
  private hdrControls!: HTMLDivElement;
  private sunAzimuth!: HTMLInputElement;
  private sunAzimuthValue!: HTMLSpanElement;
  private sunElevation!: HTMLInputElement;
  private sunElevationValue!: HTMLSpanElement;
  private sunAmbient!: HTMLInputElement;
  private sunAmbientValue!: HTMLSpanElement;
  private shadowEnabled!: HTMLInputElement;
  private shadowDebug!: HTMLSelectElement;
  private shadowThumbnail!: HTMLInputElement;
  private toneMapping!: HTMLSelectElement;
  private hdrExposure!: HTMLInputElement;
  private hdrExposureValue!: HTMLSpanElement;
  private hdrFilename!: HTMLDivElement;
  private hdrFile!: HTMLInputElement;
  private hdrProgress!: HTMLDivElement;
  private hdrProgressFill!: HTMLDivElement;
  private hdrProgressText!: HTMLSpanElement;
  private hdrGalleryGrid!: HTMLDivElement;
  private hdrLoadBtn!: HTMLButtonElement;
  
  // Wind elements
  private windEnabled!: HTMLInputElement;
  private windEnabledIndicator!: HTMLSpanElement;
  private windDirectionArrow!: HTMLDivElement;
  private windDirection!: HTMLInputElement;
  private windDirectionValue!: HTMLSpanElement;
  private windStrength!: HTMLInputElement;
  private windStrengthValue!: HTMLSpanElement;
  private windTurbulence!: HTMLInputElement;
  private windTurbulenceValue!: HTMLSpanElement;
  private windGustStrength!: HTMLInputElement;
  private windGustStrengthValue!: HTMLSpanElement;
  private windDebug!: HTMLSelectElement;
  
  constructor(panelElement: HTMLElement, context: PanelContext) {
    this.panelElement = panelElement;
    this.context = context;
    this.gl = context.gl;
    this.windManager = context.windManager;
    this.lightingManager = context.lightingManager;
    
    // Set panel content
    panelElement.innerHTML = environmentPanelTemplate;
    panelElement.classList.add('environment-panel', 'sidebar-section');
    panelElement.id = 'environment-panel';
    
    // Add styles
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = environmentPanelStyles;
    panelElement.appendChild(this.styleEl);
    
    this.cacheDOM();
    this.setup();
    this.update();
    this.loadHdrManifest();
  }
  
  private cacheDOM(): void {
    const p = this.panelElement;
    this.lightModeSunBtn = p.querySelector('#light-mode-sun')!;
    this.lightModeHdrBtn = p.querySelector('#light-mode-hdr')!;
    this.sunControls = p.querySelector('#sun-controls')!;
    this.hdrControls = p.querySelector('#hdr-controls')!;
    this.sunAzimuth = p.querySelector('#sun-azimuth')!;
    this.sunAzimuthValue = p.querySelector('#sun-azimuth-value')!;
    this.sunElevation = p.querySelector('#sun-elevation')!;
    this.sunElevationValue = p.querySelector('#sun-elevation-value')!;
    this.sunAmbient = p.querySelector('#sun-ambient')!;
    this.sunAmbientValue = p.querySelector('#sun-ambient-value')!;
    this.shadowEnabled = p.querySelector('#shadow-enabled')!;
    this.shadowDebug = p.querySelector('#shadow-debug')!;
    this.shadowThumbnail = p.querySelector('#shadow-thumbnail')!;
    this.toneMapping = p.querySelector('#tone-mapping')!;
    this.hdrExposure = p.querySelector('#hdr-exposure')!;
    this.hdrExposureValue = p.querySelector('#hdr-exposure-value')!;
    this.hdrFilename = p.querySelector('#hdr-filename')!;
    this.hdrFile = p.querySelector('#hdr-file')!;
    this.hdrProgress = p.querySelector('#hdr-progress')!;
    this.hdrProgressFill = p.querySelector('#hdr-progress-fill')!;
    this.hdrProgressText = p.querySelector('#hdr-progress-text')!;
    this.hdrGalleryGrid = p.querySelector('#hdr-gallery-grid')!;
    this.hdrLoadBtn = p.querySelector('#hdr-load-btn')!;
    
    this.windEnabled = p.querySelector('#wind-enabled')!;
    this.windEnabledIndicator = p.querySelector('#wind-enabled-indicator')!;
    this.windDirectionArrow = p.querySelector('#wind-direction-arrow')!;
    this.windDirection = p.querySelector('#wind-direction')!;
    this.windDirectionValue = p.querySelector('#wind-direction-value')!;
    this.windStrength = p.querySelector('#wind-strength')!;
    this.windStrengthValue = p.querySelector('#wind-strength-value')!;
    this.windTurbulence = p.querySelector('#wind-turbulence')!;
    this.windTurbulenceValue = p.querySelector('#wind-turbulence-value')!;
    this.windGustStrength = p.querySelector('#wind-gust-strength')!;
    this.windGustStrengthValue = p.querySelector('#wind-gust-strength-value')!;
    this.windDebug = p.querySelector('#wind-debug')!;
  }
  
  private setup(): void {
    const { setLightMode, setShadowResolution, setShowShadowThumbnail, setHDRTexture, onWindChanged, onLightingChanged } = this.context;
    const p = this.panelElement;
    
    // Tab switching
    const tabs = p.querySelectorAll('.env-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = (tab as HTMLElement).dataset.tab;
        p.querySelectorAll('.env-tab-content').forEach(c => c.classList.remove('active'));
        p.querySelector(`#env-${tabName}-tab`)?.classList.add('active');
      });
    });
    
    // Sun controls
    this.sunAzimuth.addEventListener('input', () => {
      this.lightingManager.sunLight.azimuth = parseFloat(this.sunAzimuth.value);
      this.sunAzimuthValue.textContent = `${this.lightingManager.sunLight.azimuth}°`;
      onLightingChanged();
    });
    
    this.sunElevation.addEventListener('input', () => {
      this.lightingManager.sunLight.elevation = parseFloat(this.sunElevation.value);
      this.sunElevationValue.textContent = `${this.lightingManager.sunLight.elevation}°`;
      onLightingChanged();
    });
    
    this.sunAmbient.addEventListener('input', () => {
      this.lightingManager.sunLight.ambientIntensity = parseFloat(this.sunAmbient.value);
      this.sunAmbientValue.textContent = this.lightingManager.sunLight.ambientIntensity.toFixed(2);
      onLightingChanged();
    });
    
    this.shadowEnabled.addEventListener('change', () => {
      this.lightingManager.shadowEnabled = this.shadowEnabled.checked;
      onLightingChanged();
    });
    
    [1024, 2048, 4096].forEach(res => {
      p.querySelector(`#shadow-${res}`)!.addEventListener('click', () => {
        this.lightingManager.sunLight.shadowResolution = res;
        setShadowResolution(res);
        p.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
        p.querySelector(`#shadow-${res}`)?.classList.add('active');
      });
    });
    
    this.shadowDebug.addEventListener('change', () => {
      this.lightingManager.shadowDebug = parseInt(this.shadowDebug.value, 10);
      onLightingChanged();
    });
    
    this.shadowThumbnail.addEventListener('change', () => {
      setShowShadowThumbnail(this.shadowThumbnail.checked);
    });
    
    this.toneMapping.addEventListener('change', () => {
      this.lightingManager.toneMapping = (TONE_MAPPING_NAMES as any)[this.toneMapping.value] ?? TONE_MAPPING.ACES;
      onLightingChanged();
    });
    
    this.hdrExposure.addEventListener('input', () => {
      this.lightingManager.hdrLight.exposure = parseFloat(this.hdrExposure.value);
      this.hdrExposureValue.textContent = this.lightingManager.hdrLight.exposure.toFixed(1);
      onLightingChanged();
    });
    
    this.hdrLoadBtn.addEventListener('click', () => this.loadSelectedHdr());
    
    this.hdrFile.addEventListener('change', async () => {
      const file = (this.hdrFile as HTMLInputElement).files?.[0];
      if (file) await this.loadHdrFromFile(file);
    });
    
    // Light mode toggle buttons
    this.lightModeSunBtn.addEventListener('click', () => {
      setLightMode('directional');
      this.updateLightModeDisplay('directional');
    });
    
    this.lightModeHdrBtn.addEventListener('click', () => {
      setLightMode('hdr');
      this.updateLightModeDisplay('hdr');
    });
    
    // Wind controls
    this.windEnabled.addEventListener('change', () => {
      this.windManager.enabled = this.windEnabled.checked;
      this.updateWindEnabledIndicator();
      onWindChanged();
    });
    
    this.windDirection.addEventListener('input', () => {
      this.windManager.direction = parseFloat(this.windDirection.value);
      this.windDirectionValue.textContent = `${this.windManager.direction}°`;
      this.updateWindDirectionArrow();
      onWindChanged();
    });
    
    this.windStrength.addEventListener('input', () => {
      this.windManager.strength = parseFloat(this.windStrength.value);
      this.windStrengthValue.textContent = this.windManager.strength.toFixed(1);
      onWindChanged();
    });
    
    this.windTurbulence.addEventListener('input', () => {
      this.windManager.turbulence = parseFloat(this.windTurbulence.value);
      this.windTurbulenceValue.textContent = this.windManager.turbulence.toFixed(1);
      onWindChanged();
    });
    
    this.windGustStrength.addEventListener('input', () => {
      this.windManager.gustStrength = parseFloat(this.windGustStrength.value);
      this.windGustStrengthValue.textContent = this.windManager.gustStrength.toFixed(1);
      onWindChanged();
    });
    
    this.windDebug.addEventListener('change', () => {
      this.windManager.debug = parseInt(this.windDebug.value, 10);
      onWindChanged();
    });
  }
  
  private async loadHdrManifest(): Promise<void> {
    try {
      const response = await fetch('/ibl/manifest.json');
      const data = await response.json();
      this.hdrManifest = data.hdrs || [];
      this.renderHdrGallery();
    } catch {
      this.hdrManifest = [];
      this.renderHdrGallery();
    }
  }
  
  private renderHdrGallery(): void {
    let html = '';
    for (const hdr of this.hdrManifest) {
      const isSelected = this.selectedHdrName === hdr.name;
      html += `<div class="hdr-gallery-item ${isSelected ? 'selected' : ''}" data-hdr-name="${hdr.name}">
        <img class="hdr-gallery-thumb" src="/ibl/${hdr.name}.jpg" alt="${hdr.displayName}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="hdr-gallery-placeholder" style="display: none;">🌄</div>
        <div class="hdr-gallery-name">${hdr.displayName}</div>
      </div>`;
    }
    html += `<div class="hdr-gallery-item" data-hdr-upload="true"><div class="hdr-gallery-upload"><span class="hdr-gallery-upload-icon">+</span><span>Upload</span></div></div>`;
    
    this.hdrGalleryGrid.innerHTML = html;
    
    this.hdrGalleryGrid.querySelectorAll('.hdr-gallery-item').forEach(item => {
      item.addEventListener('click', () => {
        if (this.isLoadingHdr) return;
        const el = item as HTMLElement;
        if (el.dataset.hdrUpload) {
          this.hdrFile.click();
        } else if (el.dataset.hdrName) {
          this.selectHdr(el.dataset.hdrName);
        }
      });
    });
    
    this.updateLoadButton();
  }
  
  private selectHdr(name: string): void {
    this.selectedHdrName = name;
    this.hdrGalleryGrid.querySelectorAll('.hdr-gallery-item').forEach(item => {
      item.classList.toggle('selected', (item as HTMLElement).dataset.hdrName === name);
    });
    this.updateLoadButton();
  }
  
  private updateLoadButton(): void {
    this.hdrLoadBtn.disabled = !this.selectedHdrName || this.isLoadingHdr;
    this.hdrLoadBtn.textContent = this.isLoadingHdr ? 'Loading...' : 'Load Selected';
  }
  
  private async loadSelectedHdr(): Promise<void> {
    if (!this.selectedHdrName || this.isLoadingHdr) return;
    
    this.isLoadingHdr = true;
    this.updateLoadButton();
    
    try {
      const hdrPath = `/ibl/${this.selectedHdrName}.hdr`;
      this.hdrFilename.textContent = 'Loading...';
      this.hdrProgress.style.display = 'block';
      this.hdrProgressFill.style.width = '0%';
      
      const response = await fetch(hdrPath);
      if (!response.ok) throw new Error(`Failed to fetch ${hdrPath}`);
      
      const buffer = await response.arrayBuffer();
      const hdrData = HDRLoader.parse(buffer);
      
      const result = HDRLoader.createPrefilteredTextureWithMIS(this.gl, hdrData, (progress) => {
        this.hdrProgressFill.style.width = `${Math.round(10 + progress * 90)}%`;
      });
      
      const hdrInfo = this.hdrManifest.find(h => h.name === this.selectedHdrName);
      this.lightingManager.hdrLight.setTexture(result.texture, `${this.selectedHdrName}.hdr`);
      this.hdrFilename.textContent = hdrInfo?.displayName || this.selectedHdrName;
      
      setTimeout(() => { this.hdrProgress.style.display = 'none'; }, 500);
      
      this.context.setHDRTexture(result.texture);
      this.context.setLightMode('hdr');
      this.updateLightModeDisplay('hdr');
    } catch (err) {
      console.error('Failed to load HDR:', err);
      this.hdrFilename.textContent = 'Error loading HDR';
      this.hdrProgress.style.display = 'none';
    } finally {
      this.isLoadingHdr = false;
      this.updateLoadButton();
    }
  }
  
  private async loadHdrFromFile(file: File): Promise<void> {
    try {
      this.selectedHdrName = null;
      this.renderHdrGallery();
      
      this.hdrFilename.textContent = 'Loading...';
      this.hdrProgress.style.display = 'block';
      this.hdrProgressFill.style.width = '0%';
      
      const buffer = await file.arrayBuffer();
      const hdrData = HDRLoader.parse(buffer);
      
      const result = HDRLoader.createPrefilteredTextureWithMIS(this.gl, hdrData, (progress) => {
        this.hdrProgressFill.style.width = `${Math.round(progress * 100)}%`;
      });
      
      this.lightingManager.hdrLight.setTexture(result.texture, file.name);
      this.hdrFilename.textContent = file.name;
      
      setTimeout(() => { this.hdrProgress.style.display = 'none'; }, 500);
      
      this.context.setHDRTexture(result.texture);
      this.context.setLightMode('hdr');
      this.updateLightModeDisplay('hdr');
    } catch (err) {
      console.error('Failed to load HDR:', err);
      this.hdrFilename.textContent = 'Error loading HDR';
      this.hdrProgress.style.display = 'none';
    }
  }
  
  private updateWindDirectionArrow(): void {
    this.windDirectionArrow.style.transform = `translateY(-50%) rotate(${this.windManager.direction}deg)`;
  }
  
  private updateWindEnabledIndicator(): void {
    this.windEnabledIndicator.classList.toggle('active', this.windManager.enabled);
  }
  
  // ==================== Public API ====================
  
  updateLightModeDisplay(mode: 'directional' | 'hdr'): void {
    // Update button states
    this.lightModeSunBtn.classList.toggle('active', mode === 'directional');
    this.lightModeHdrBtn.classList.toggle('active', mode === 'hdr');
    
    // Show/hide relevant controls
    this.sunControls.style.display = mode === 'directional' ? 'block' : 'none';
    this.hdrControls.style.display = mode === 'hdr' ? 'block' : 'none';
  }
  
  openHDRFilePicker(): void {
    this.hdrFile.click();
  }
  
  setHDRFilename(filename: string): void {
    this.hdrFilename.textContent = filename;
  }
  
  update(): void {
    // Update lighting UI
    this.updateLightModeDisplay(this.lightingManager.activeMode);
    this.sunAzimuth.value = String(this.lightingManager.sunLight.azimuth);
    this.sunAzimuthValue.textContent = `${this.lightingManager.sunLight.azimuth}°`;
    this.sunElevation.value = String(this.lightingManager.sunLight.elevation);
    this.sunElevationValue.textContent = `${this.lightingManager.sunLight.elevation}°`;
    this.sunAmbient.value = String(this.lightingManager.sunLight.ambientIntensity);
    this.sunAmbientValue.textContent = this.lightingManager.sunLight.ambientIntensity.toFixed(2);
    this.shadowEnabled.checked = this.lightingManager.shadowEnabled;
    this.hdrExposure.value = String(this.lightingManager.hdrLight.exposure);
    this.hdrExposureValue.textContent = this.lightingManager.hdrLight.exposure.toFixed(1);
    
    // Update shadow quality buttons
    this.panelElement.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
    this.panelElement.querySelector(`#shadow-${this.lightingManager.sunLight.shadowResolution}`)?.classList.add('active');
    
    // Update tone mapping dropdown
    const tmValue = Object.entries(TONE_MAPPING_NAMES).find(([_, v]) => v === this.lightingManager.toneMapping)?.[0] || 'aces';
    this.toneMapping.value = tmValue;
    
    // Update wind UI
    this.windEnabled.checked = this.windManager.enabled;
    this.windDirection.value = String(this.windManager.direction);
    this.windDirectionValue.textContent = `${this.windManager.direction}°`;
    this.windStrength.value = String(this.windManager.strength);
    this.windStrengthValue.textContent = this.windManager.strength.toFixed(1);
    this.windTurbulence.value = String(this.windManager.turbulence);
    this.windTurbulenceValue.textContent = this.windManager.turbulence.toFixed(1);
    this.windGustStrength.value = String(this.windManager.gustStrength);
    this.windGustStrengthValue.textContent = this.windManager.gustStrength.toFixed(1);
    
    this.updateWindDirectionArrow();
    this.updateWindEnabledIndicator();
  }
  
  destroy(): void {
    this.panelElement.innerHTML = '';
  }
}

// ==================== Factory Function ====================

/**
 * Creates the environment panel
 * @deprecated Use `new EnvironmentPanel()` directly
 */
export function createEnvironmentPanel(panelElement: HTMLElement, context: PanelContext): EnvironmentPanelAPI {
  return new EnvironmentPanel(panelElement, context);
}
