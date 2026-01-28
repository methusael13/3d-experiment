/**
 * TerrainPanel - UI controls for terrain generation parameters
 * Integrates with ObjectPanel when a TerrainObject is selected
 * Uses consistent styles from styles.ts
 */

import type { TerrainObject, TerrainProgressCallback } from '../../../core/sceneObjects';
import type { TerrainParams, TerrainNoiseParams, TerrainErosionParams, TerrainMaterialParams } from '../../../core/sceneObjects/types';
import { TERRAIN_PRESETS, getTerrainPreset, type TerrainPreset } from './terrainPresets';

// ==================== Styles (minimal, only terrain-specific) ====================

export const terrainPanelStyles = `
  .terrain-panel .compact-select {
    width: 100%;
    padding: 5px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #f0f0f0;
    font-size: 11px;
    cursor: pointer;
  }
  
  .terrain-panel .compact-select:hover {
    border-color: #666;
  }
  
  .terrain-panel .seed-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  
  .terrain-panel .seed-input {
    flex: 1;
    padding: 5px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #f0f0f0;
    font-family: monospace;
    font-size: 11px;
  }
  
  .terrain-panel .seed-btn {
    padding: 5px 10px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #ccc;
    cursor: pointer;
    font-size: 12px;
  }
  
  .terrain-panel .seed-btn:hover {
    background: #444;
    border-color: #666;
  }
  
  .terrain-panel .color-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  
  .terrain-panel .color-input-row label {
    font-size: 10px;
    color: #888;
    min-width: 80px;
  }
  
  .terrain-panel .color-input {
    width: 36px;
    height: 24px;
    border: 1px solid #555;
    border-radius: 3px;
    background: none;
    cursor: pointer;
    padding: 0;
  }
  
  .terrain-panel .progress-container {
    margin-top: 8px;
    display: none;
  }
  
  .terrain-panel .progress-container.active {
    display: block;
  }
  
  .terrain-panel .progress-bar {
    height: 4px;
    background: #333;
    border-radius: 2px;
    overflow: hidden;
  }
  
  .terrain-panel .progress-fill {
    height: 100%;
    background: #ff6666;
    transition: width 0.1s;
    width: 0%;
  }
  
  .terrain-panel .progress-text {
    font-size: 10px;
    color: #888;
    margin-top: 4px;
    text-align: center;
  }
  
  .terrain-panel .section-title {
    font-size: 10px;
    color: #888;
    margin: 12px 0 6px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .terrain-panel .section-title:first-child {
    margin-top: 0;
  }
  
  .terrain-panel .preset-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  
  .terrain-panel .preset-select {
    flex: 1;
    padding: 5px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #f0f0f0;
    font-size: 11px;
    cursor: pointer;
  }
  
  .terrain-panel .preset-select:hover {
    border-color: #666;
  }
  
  .terrain-panel .reset-btn {
    padding: 5px 10px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #ccc;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  
  .terrain-panel .reset-btn:hover {
    background: #444;
    border-color: #666;
  }
`;

// ==================== Template ====================

const terrainPanelTemplate = `
  <div class="section-title">Preset</div>
  <div class="preset-row">
    <select id="terrain-preset" class="preset-select">
      <option value="default">Default</option>
      <option value="rolling-hills">Rolling Hills</option>
      <option value="alpine-mountains">Alpine Mountains</option>
      <option value="desert-dunes">Desert Dunes</option>
      <option value="rocky-badlands">Rocky Badlands</option>
      <option value="volcanic-island">Volcanic Island</option>
    </select>
    <button id="terrain-reset-preset" class="reset-btn" title="Reset to preset values">↺ Reset</button>
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Resolution</div>
  <div class="transform-group">
    <label>Resolution</label>
    <select id="terrain-resolution" class="compact-select">
      <option value="64">64×64 (Fast)</option>
      <option value="128">128×128</option>
      <option value="256" selected>256×256</option>
      <option value="512">512×512</option>
      <option value="1024">1024×1024 (Slow)</option>
    </select>
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>World Size</label>
      <span id="terrain-world-size-val" class="slider-value">10</span>
    </div>
    <input type="range" id="terrain-world-size" min="1" max="1000" step="10" value="10" class="slider-input">
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Rendering</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-clipmap-enabled">
    <span>Enable Clipmap (Camera-centered LOD)</span>
  </label>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Noise</div>
  <div class="transform-group seed-row">
    <label style="font-size: 10px; color: #888; min-width: 35px;">Seed</label>
    <input type="number" id="terrain-seed" value="12345" class="seed-input">
    <button id="terrain-randomize-seed" class="seed-btn" title="Randomize">🎲</button>
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Scale</label>
      <span id="terrain-scale-val" class="slider-value">3.0</span>
    </div>
    <input type="range" id="terrain-scale" min="0.5" max="10" step="0.1" value="3" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Octaves</label>
      <span id="terrain-octaves-val" class="slider-value">6</span>
    </div>
    <input type="range" id="terrain-octaves" min="1" max="10" step="1" value="6" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Lacunarity</label>
      <span id="terrain-lacunarity-val" class="slider-value">2.0</span>
    </div>
    <input type="range" id="terrain-lacunarity" min="1" max="4" step="0.1" value="2" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Persistence</label>
      <span id="terrain-persistence-val" class="slider-value">0.5</span>
    </div>
    <input type="range" id="terrain-persistence" min="0.1" max="1" step="0.05" value="0.5" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Height</label>
      <span id="terrain-height-scale-val" class="slider-value">2.0</span>
    </div>
    <input type="range" id="terrain-height-scale" min="0.1" max="5" step="0.1" value="2" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Ridge Amount</label>
      <span id="terrain-ridge-val" class="slider-value">0.5</span>
    </div>
    <input type="range" id="terrain-ridge" min="0" max="1" step="0.05" value="0.5" class="slider-input">
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Domain Warping</div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Warp Strength</label>
      <span id="terrain-warp-strength-val" class="slider-value">0.5</span>
    </div>
    <input type="range" id="terrain-warp-strength" min="0" max="2" step="0.05" value="0.5" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Warp Scale</label>
      <span id="terrain-warp-scale-val" class="slider-value">2.0</span>
    </div>
    <input type="range" id="terrain-warp-scale" min="0.5" max="5" step="0.1" value="2" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Warp Octaves</label>
      <span id="terrain-warp-octaves-val" class="slider-value">1</span>
    </div>
    <input type="range" id="terrain-warp-octaves" min="1" max="3" step="1" value="1" class="slider-input">
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Octave Rotation</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-rotate-octaves" checked>
    <span>Rotate Octaves (reduces patterns)</span>
  </label>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Rotation Angle</label>
      <span id="terrain-octave-rotation-val" class="slider-value">37°</span>
    </div>
    <input type="range" id="terrain-octave-rotation" min="10" max="60" step="1" value="37" class="slider-input">
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Hydraulic Erosion</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-erosion-enabled" checked>
    <span>Enable Hydraulic Erosion</span>
  </label>
  <div class="modifier-settings" id="terrain-erosion-settings">
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Iterations</label>
        <span id="terrain-erosion-iterations-val" class="slider-value">100k</span>
      </div>
      <input type="range" id="terrain-erosion-iterations" min="10000" max="500000" step="10000" value="100000" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Inertia</label>
        <span id="terrain-erosion-inertia-val" class="slider-value">0.05</span>
      </div>
      <input type="range" id="terrain-erosion-inertia" min="0" max="0.2" step="0.01" value="0.05" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Capacity</label>
        <span id="terrain-erosion-capacity-val" class="slider-value">4.0</span>
      </div>
      <input type="range" id="terrain-erosion-capacity" min="1" max="10" step="0.5" value="4" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Deposit Speed</label>
        <span id="terrain-erosion-deposit-val" class="slider-value">0.3</span>
      </div>
      <input type="range" id="terrain-erosion-deposit" min="0.1" max="1" step="0.05" value="0.3" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Erode Speed</label>
        <span id="terrain-erosion-erode-val" class="slider-value">0.3</span>
      </div>
      <input type="range" id="terrain-erosion-erode" min="0.1" max="1" step="0.05" value="0.3" class="slider-input">
    </div>
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Thermal Erosion</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-thermal-enabled" checked>
    <span>Enable Thermal Erosion</span>
  </label>
  <div class="modifier-settings" id="terrain-thermal-settings">
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Iterations</label>
        <span id="terrain-thermal-iterations-val" class="slider-value">100</span>
      </div>
      <input type="range" id="terrain-thermal-iterations" min="10" max="500" step="10" value="100" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Talus Angle</label>
        <span id="terrain-thermal-talus-val" class="slider-value">0.5</span>
      </div>
      <input type="range" id="terrain-thermal-talus" min="0.1" max="1" step="0.05" value="0.5" class="slider-input">
    </div>
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Material</div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Snow Line</label>
      <span id="terrain-snow-line-val" class="slider-value">0.8</span>
    </div>
    <input type="range" id="terrain-snow-line" min="0" max="1" step="0.05" value="0.8" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Rock Line</label>
      <span id="terrain-rock-line-val" class="slider-value">0.6</span>
    </div>
    <input type="range" id="terrain-rock-line" min="0" max="1" step="0.05" value="0.6" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Max Grass Slope</label>
      <span id="terrain-grass-slope-val" class="slider-value">0.6</span>
    </div>
    <input type="range" id="terrain-grass-slope" min="0" max="1" step="0.05" value="0.6" class="slider-input">
  </div>
  <div class="color-input-row">
    <label>Grass</label>
    <input type="color" id="terrain-grass-color" value="#4d8033" class="color-input">
  </div>
  <div class="color-input-row">
    <label>Rock</label>
    <input type="color" id="terrain-rock-color" value="#665a4d" class="color-input">
  </div>
  <div class="color-input-row">
    <label>Snow</label>
    <input type="color" id="terrain-snow-color" value="#f2f2f7" class="color-input">
  </div>
  <div class="color-input-row">
    <label>Dirt</label>
    <input type="color" id="terrain-dirt-color" value="#594033" class="color-input">
  </div>
  
  <button id="terrain-update-btn" class="primary-btn" style="width: 100%; margin-top: 12px;">🔄 Update Terrain</button>
  <div class="progress-container" id="terrain-progress">
    <div class="progress-bar">
      <div class="progress-fill" id="terrain-progress-fill"></div>
    </div>
    <div class="progress-text" id="terrain-progress-text">Initializing...</div>
  </div>
`;

// ==================== TerrainPanel Class ====================

export class TerrainPanel {
  private container: HTMLElement;
  private terrain: TerrainObject | null = null;
  private onUpdate: (() => void) | null = null;
  private onBoundsChanged: ((worldSize: number, heightScale: number) => void) | null = null;
  private currentPresetKey: string = 'default';
  
  // DOM references
  private presetSelect!: HTMLSelectElement;
  private resetPresetBtn!: HTMLButtonElement;
  private resolution!: HTMLSelectElement;
  private worldSize!: HTMLInputElement;
  private worldSizeVal!: HTMLSpanElement;
  private seed!: HTMLInputElement;
  private randomizeSeedBtn!: HTMLButtonElement;
  private scale!: HTMLInputElement;
  private scaleVal!: HTMLSpanElement;
  private octaves!: HTMLInputElement;
  private octavesVal!: HTMLSpanElement;
  private lacunarity!: HTMLInputElement;
  private lacunarityVal!: HTMLSpanElement;
  private persistence!: HTMLInputElement;
  private persistenceVal!: HTMLSpanElement;
  private heightScale!: HTMLInputElement;
  private heightScaleVal!: HTMLSpanElement;
  private ridge!: HTMLInputElement;
  private ridgeVal!: HTMLSpanElement;
  
  // Domain warping controls
  private warpStrength!: HTMLInputElement;
  private warpStrengthVal!: HTMLSpanElement;
  private warpScale!: HTMLInputElement;
  private warpScaleVal!: HTMLSpanElement;
  private warpOctaves!: HTMLInputElement;
  private warpOctavesVal!: HTMLSpanElement;
  
  // Octave rotation controls
  private rotateOctaves!: HTMLInputElement;
  private octaveRotation!: HTMLInputElement;
  private octaveRotationVal!: HTMLSpanElement;
  
  private erosionEnabled!: HTMLInputElement;
  private erosionSettings!: HTMLDivElement;
  private erosionIterations!: HTMLInputElement;
  private erosionIterationsVal!: HTMLSpanElement;
  private erosionInertia!: HTMLInputElement;
  private erosionInertiaVal!: HTMLSpanElement;
  private erosionCapacity!: HTMLInputElement;
  private erosionCapacityVal!: HTMLSpanElement;
  private erosionDeposit!: HTMLInputElement;
  private erosionDepositVal!: HTMLSpanElement;
  private erosionErode!: HTMLInputElement;
  private erosionErodeVal!: HTMLSpanElement;
  
  private thermalEnabled!: HTMLInputElement;
  private thermalSettings!: HTMLDivElement;
  private thermalIterations!: HTMLInputElement;
  private thermalIterationsVal!: HTMLSpanElement;
  private thermalTalus!: HTMLInputElement;
  private thermalTalusVal!: HTMLSpanElement;
  
  private snowLine!: HTMLInputElement;
  private snowLineVal!: HTMLSpanElement;
  private rockLine!: HTMLInputElement;
  private rockLineVal!: HTMLSpanElement;
  private grassSlope!: HTMLInputElement;
  private grassSlopeVal!: HTMLSpanElement;
  private grassColor!: HTMLInputElement;
  private rockColor!: HTMLInputElement;
  private snowColor!: HTMLInputElement;
  private dirtColor!: HTMLInputElement;
  
  private clipmapEnabled!: HTMLInputElement;
  
  private updateBtn!: HTMLButtonElement;
  private progressContainer!: HTMLDivElement;
  private progressFill!: HTMLDivElement;
  private progressText!: HTMLDivElement;
  
  constructor(container: HTMLElement) {
    this.container = container;
    container.classList.add('terrain-panel');
    container.innerHTML = terrainPanelTemplate;
    
    this.cacheDOM();
    this.setupEventListeners();
  }
  
  private cacheDOM(): void {
    const c = this.container;
    
    // Preset controls
    this.presetSelect = c.querySelector('#terrain-preset') as HTMLSelectElement;
    this.resetPresetBtn = c.querySelector('#terrain-reset-preset') as HTMLButtonElement;
    
    this.resolution = c.querySelector('#terrain-resolution') as HTMLSelectElement;
    this.worldSize = c.querySelector('#terrain-world-size') as HTMLInputElement;
    this.worldSizeVal = c.querySelector('#terrain-world-size-val') as HTMLSpanElement;
    this.seed = c.querySelector('#terrain-seed') as HTMLInputElement;
    this.randomizeSeedBtn = c.querySelector('#terrain-randomize-seed') as HTMLButtonElement;
    this.scale = c.querySelector('#terrain-scale') as HTMLInputElement;
    this.scaleVal = c.querySelector('#terrain-scale-val') as HTMLSpanElement;
    this.octaves = c.querySelector('#terrain-octaves') as HTMLInputElement;
    this.octavesVal = c.querySelector('#terrain-octaves-val') as HTMLSpanElement;
    this.lacunarity = c.querySelector('#terrain-lacunarity') as HTMLInputElement;
    this.lacunarityVal = c.querySelector('#terrain-lacunarity-val') as HTMLSpanElement;
    this.persistence = c.querySelector('#terrain-persistence') as HTMLInputElement;
    this.persistenceVal = c.querySelector('#terrain-persistence-val') as HTMLSpanElement;
    this.heightScale = c.querySelector('#terrain-height-scale') as HTMLInputElement;
    this.heightScaleVal = c.querySelector('#terrain-height-scale-val') as HTMLSpanElement;
    this.ridge = c.querySelector('#terrain-ridge') as HTMLInputElement;
    this.ridgeVal = c.querySelector('#terrain-ridge-val') as HTMLSpanElement;
    
    // Domain warping
    this.warpStrength = c.querySelector('#terrain-warp-strength') as HTMLInputElement;
    this.warpStrengthVal = c.querySelector('#terrain-warp-strength-val') as HTMLSpanElement;
    this.warpScale = c.querySelector('#terrain-warp-scale') as HTMLInputElement;
    this.warpScaleVal = c.querySelector('#terrain-warp-scale-val') as HTMLSpanElement;
    this.warpOctaves = c.querySelector('#terrain-warp-octaves') as HTMLInputElement;
    this.warpOctavesVal = c.querySelector('#terrain-warp-octaves-val') as HTMLSpanElement;
    
    // Octave rotation
    this.rotateOctaves = c.querySelector('#terrain-rotate-octaves') as HTMLInputElement;
    this.octaveRotation = c.querySelector('#terrain-octave-rotation') as HTMLInputElement;
    this.octaveRotationVal = c.querySelector('#terrain-octave-rotation-val') as HTMLSpanElement;
    
    this.erosionEnabled = c.querySelector('#terrain-erosion-enabled') as HTMLInputElement;
    this.erosionSettings = c.querySelector('#terrain-erosion-settings') as HTMLDivElement;
    this.erosionIterations = c.querySelector('#terrain-erosion-iterations') as HTMLInputElement;
    this.erosionIterationsVal = c.querySelector('#terrain-erosion-iterations-val') as HTMLSpanElement;
    this.erosionInertia = c.querySelector('#terrain-erosion-inertia') as HTMLInputElement;
    this.erosionInertiaVal = c.querySelector('#terrain-erosion-inertia-val') as HTMLSpanElement;
    this.erosionCapacity = c.querySelector('#terrain-erosion-capacity') as HTMLInputElement;
    this.erosionCapacityVal = c.querySelector('#terrain-erosion-capacity-val') as HTMLSpanElement;
    this.erosionDeposit = c.querySelector('#terrain-erosion-deposit') as HTMLInputElement;
    this.erosionDepositVal = c.querySelector('#terrain-erosion-deposit-val') as HTMLSpanElement;
    this.erosionErode = c.querySelector('#terrain-erosion-erode') as HTMLInputElement;
    this.erosionErodeVal = c.querySelector('#terrain-erosion-erode-val') as HTMLSpanElement;
    
    this.thermalEnabled = c.querySelector('#terrain-thermal-enabled') as HTMLInputElement;
    this.thermalSettings = c.querySelector('#terrain-thermal-settings') as HTMLDivElement;
    this.thermalIterations = c.querySelector('#terrain-thermal-iterations') as HTMLInputElement;
    this.thermalIterationsVal = c.querySelector('#terrain-thermal-iterations-val') as HTMLSpanElement;
    this.thermalTalus = c.querySelector('#terrain-thermal-talus') as HTMLInputElement;
    this.thermalTalusVal = c.querySelector('#terrain-thermal-talus-val') as HTMLSpanElement;
    
    this.snowLine = c.querySelector('#terrain-snow-line') as HTMLInputElement;
    this.snowLineVal = c.querySelector('#terrain-snow-line-val') as HTMLSpanElement;
    this.rockLine = c.querySelector('#terrain-rock-line') as HTMLInputElement;
    this.rockLineVal = c.querySelector('#terrain-rock-line-val') as HTMLSpanElement;
    this.grassSlope = c.querySelector('#terrain-grass-slope') as HTMLInputElement;
    this.grassSlopeVal = c.querySelector('#terrain-grass-slope-val') as HTMLSpanElement;
    this.grassColor = c.querySelector('#terrain-grass-color') as HTMLInputElement;
    this.rockColor = c.querySelector('#terrain-rock-color') as HTMLInputElement;
    this.snowColor = c.querySelector('#terrain-snow-color') as HTMLInputElement;
    this.dirtColor = c.querySelector('#terrain-dirt-color') as HTMLInputElement;
    
    this.clipmapEnabled = c.querySelector('#terrain-clipmap-enabled') as HTMLInputElement;
    
    this.updateBtn = c.querySelector('#terrain-update-btn') as HTMLButtonElement;
    this.progressContainer = c.querySelector('#terrain-progress') as HTMLDivElement;
    this.progressFill = c.querySelector('#terrain-progress-fill') as HTMLDivElement;
    this.progressText = c.querySelector('#terrain-progress-text') as HTMLDivElement;
  }
  
  private setupEventListeners(): void {
    // World size slider with special handling to update height scale max
    this.worldSize.addEventListener('input', () => {
      const worldSizeValue = parseFloat(this.worldSize.value);
      this.worldSizeVal.textContent = String(worldSizeValue);
      this.updateHeightScaleMax(worldSizeValue);
      this.syncToTerrain();
    });
    
    // Regular slider value updates
    this.setupSlider(this.scale, this.scaleVal, v => v.toFixed(1));
    this.setupSlider(this.octaves, this.octavesVal, v => String(Math.round(v)));
    this.setupSlider(this.lacunarity, this.lacunarityVal, v => v.toFixed(1));
    this.setupSlider(this.persistence, this.persistenceVal, v => v.toFixed(2));
    // Height scale with separate listener since we need special handling
    this.heightScale.addEventListener('input', () => {
      this.heightScaleVal.textContent = parseFloat(this.heightScale.value).toFixed(1);
      this.syncToTerrain();
    });
    this.setupSlider(this.ridge, this.ridgeVal, v => v.toFixed(2));
    
    // Domain warping sliders
    this.setupSlider(this.warpStrength, this.warpStrengthVal, v => v.toFixed(2));
    this.setupSlider(this.warpScale, this.warpScaleVal, v => v.toFixed(1));
    this.setupSlider(this.warpOctaves, this.warpOctavesVal, v => String(Math.round(v)));
    
    // Octave rotation
    this.rotateOctaves.addEventListener('change', () => this.syncToTerrain());
    this.setupSlider(this.octaveRotation, this.octaveRotationVal, v => `${Math.round(v)}°`);
    
    this.setupSlider(this.erosionIterations, this.erosionIterationsVal, v => {
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
      if (v >= 1000) return `${Math.round(v / 1000)}k`;
      return String(v);
    });
    this.setupSlider(this.erosionInertia, this.erosionInertiaVal, v => v.toFixed(2));
    this.setupSlider(this.erosionCapacity, this.erosionCapacityVal, v => v.toFixed(1));
    this.setupSlider(this.erosionDeposit, this.erosionDepositVal, v => v.toFixed(2));
    this.setupSlider(this.erosionErode, this.erosionErodeVal, v => v.toFixed(2));
    
    this.setupSlider(this.thermalIterations, this.thermalIterationsVal, v => String(Math.round(v)));
    this.setupSlider(this.thermalTalus, this.thermalTalusVal, v => v.toFixed(2));
    
    this.setupSlider(this.snowLine, this.snowLineVal, v => v.toFixed(2));
    this.setupSlider(this.rockLine, this.rockLineVal, v => v.toFixed(2));
    this.setupSlider(this.grassSlope, this.grassSlopeVal, v => v.toFixed(2));
    
    // Checkbox toggles
    this.erosionEnabled.addEventListener('change', () => {
      this.erosionSettings.classList.toggle('disabled', !this.erosionEnabled.checked);
      this.syncToTerrain();
    });
    
    this.thermalEnabled.addEventListener('change', () => {
      this.thermalSettings.classList.toggle('disabled', !this.thermalEnabled.checked);
      this.syncToTerrain();
    });
    
    // Randomize seed
    this.randomizeSeedBtn.addEventListener('click', () => {
      this.seed.value = String(Math.floor(Math.random() * 100000));
      this.syncToTerrain();
    });
    
    // Resolution change
    this.resolution.addEventListener('change', () => this.syncToTerrain());
    
    // Seed change
    this.seed.addEventListener('input', () => this.syncToTerrain());
    
    // Color changes
    [this.grassColor, this.rockColor, this.snowColor, this.dirtColor].forEach(input => {
      input.addEventListener('input', () => this.syncToTerrain());
    });
    
    // Clipmap toggle
    this.clipmapEnabled.addEventListener('change', () => {
      if (this.terrain) {
        this.terrain.clipmapEnabled = this.clipmapEnabled.checked;
      }
    });
    
    // Update button
    this.updateBtn.addEventListener('click', () => this.handleUpdate());
    
    // Preset selection
    this.presetSelect.addEventListener('change', () => {
      this.currentPresetKey = this.presetSelect.value;
      this.applyPreset(this.currentPresetKey);
    });
    
    // Reset to preset
    this.resetPresetBtn.addEventListener('click', () => {
      this.applyPreset(this.currentPresetKey);
    });
  }
  
  /**
   * Apply a preset to the terrain (excludes resolution and worldSize)
   */
  private applyPreset(presetKey: string): void {
    const preset = getTerrainPreset(presetKey);
    if (!preset || !this.terrain) return;
    
    const params = this.terrain.params;
    
    // Apply noise params (excluding offset which is derived)
    params.noise.seed = preset.noise.seed;
    params.noise.scale = preset.noise.scale;
    params.noise.octaves = preset.noise.octaves;
    params.noise.lacunarity = preset.noise.lacunarity;
    params.noise.persistence = preset.noise.persistence;
    params.noise.heightScale = preset.noise.heightScale;
    params.noise.ridgeWeight = preset.noise.ridgeWeight;
    params.noise.warpStrength = preset.noise.warpStrength;
    params.noise.warpScale = preset.noise.warpScale;
    params.noise.warpOctaves = preset.noise.warpOctaves;
    params.noise.rotateOctaves = preset.noise.rotateOctaves;
    params.noise.octaveRotation = preset.noise.octaveRotation;
    
    // Apply erosion params
    params.erosion = { ...preset.erosion };
    
    // Apply material params
    params.material = { 
      ...preset.material,
      // Deep copy colors
      waterColor: [...preset.material.waterColor] as [number, number, number],
      grassColor: [...preset.material.grassColor] as [number, number, number],
      rockColor: [...preset.material.rockColor] as [number, number, number],
      snowColor: [...preset.material.snowColor] as [number, number, number],
      dirtColor: [...preset.material.dirtColor] as [number, number, number],
    };
    
    // Update UI to reflect new values
    this.syncFromTerrain();
  }
  
  private setupSlider(slider: HTMLInputElement, valueDisplay: HTMLSpanElement, format: (v: number) => string, syncOnInput = true): void {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = format(parseFloat(slider.value));
      if (syncOnInput) {
        this.syncToTerrain();
      }
    });
  }
  
  /**
   * Update heightScale slider max based on worldSize.
   * Allows height up to 1:10 ratio (worldSize / 10).
   */
  private updateHeightScaleMax(worldSize: number): void {
    const newMax = Math.max(1, worldSize / 10); // Min of 1 to avoid tiny maxes
    const currentValue = parseFloat(this.heightScale.value);
    
    // Update slider max attribute
    this.heightScale.max = String(newMax);
    
    // Update step for large ranges (keep ~50 steps)
    const step = Math.max(0.1, newMax / 50);
    this.heightScale.step = String(step);
    
    // Clamp current value if it exceeds new max
    if (currentValue > newMax) {
      this.heightScale.value = String(newMax);
      this.heightScaleVal.textContent = newMax.toFixed(1);
    }
  }
  
  private syncToTerrain(): void {
    if (!this.terrain) return;
    
    const params = this.terrain.params;
    
    // Resolution & world size
    params.resolution = parseInt(this.resolution.value, 10);
    params.worldSize = parseFloat(this.worldSize.value);
    
    // Noise params
    params.noise.seed = parseInt(this.seed.value, 10);
    params.noise.scale = parseFloat(this.scale.value);
    params.noise.octaves = parseInt(this.octaves.value, 10);
    params.noise.lacunarity = parseFloat(this.lacunarity.value);
    params.noise.persistence = parseFloat(this.persistence.value);
    params.noise.heightScale = parseFloat(this.heightScale.value);
    params.noise.ridgeWeight = parseFloat(this.ridge.value);
    
    // Domain warping
    params.noise.warpStrength = parseFloat(this.warpStrength.value);
    params.noise.warpScale = parseFloat(this.warpScale.value);
    params.noise.warpOctaves = parseInt(this.warpOctaves.value, 10);
    
    // Octave rotation
    params.noise.rotateOctaves = this.rotateOctaves.checked;
    params.noise.octaveRotation = parseFloat(this.octaveRotation.value);
    
    // Erosion params
    params.erosion.enabled = this.erosionEnabled.checked;
    params.erosion.iterations = parseInt(this.erosionIterations.value, 10);
    params.erosion.inertia = parseFloat(this.erosionInertia.value);
    params.erosion.sedimentCapacity = parseFloat(this.erosionCapacity.value);
    params.erosion.depositSpeed = parseFloat(this.erosionDeposit.value);
    params.erosion.erodeSpeed = parseFloat(this.erosionErode.value);
    
    // Thermal erosion
    params.erosion.thermalEnabled = this.thermalEnabled.checked;
    params.erosion.thermalIterations = parseInt(this.thermalIterations.value, 10);
    params.erosion.talusAngle = parseFloat(this.thermalTalus.value);
    
    // Material params
    params.material.snowLine = parseFloat(this.snowLine.value);
    params.material.rockLine = parseFloat(this.rockLine.value);
    params.material.maxGrassSlope = parseFloat(this.grassSlope.value);
    params.material.grassColor = this.hexToRgb(this.grassColor.value);
    params.material.rockColor = this.hexToRgb(this.rockColor.value);
    params.material.snowColor = this.hexToRgb(this.snowColor.value);
    params.material.dirtColor = this.hexToRgb(this.dirtColor.value);
  }
  
  private syncFromTerrain(): void {
    if (!this.terrain) return;
    
    const params = this.terrain.params;
    
    // Resolution & world size
    this.resolution.value = String(params.resolution);
    this.worldSize.value = String(params.worldSize);
    this.worldSizeVal.textContent = String(params.worldSize);
    
    // Update height scale max based on world size
    this.updateHeightScaleMax(params.worldSize);
    
    // Noise params
    this.seed.value = String(params.noise.seed);
    this.scale.value = String(params.noise.scale);
    this.scaleVal.textContent = params.noise.scale.toFixed(1);
    this.octaves.value = String(params.noise.octaves);
    this.octavesVal.textContent = String(params.noise.octaves);
    this.lacunarity.value = String(params.noise.lacunarity);
    this.lacunarityVal.textContent = params.noise.lacunarity.toFixed(1);
    this.persistence.value = String(params.noise.persistence);
    this.persistenceVal.textContent = params.noise.persistence.toFixed(2);
    this.heightScale.value = String(params.noise.heightScale);
    this.heightScaleVal.textContent = params.noise.heightScale.toFixed(1);
    this.ridge.value = String(params.noise.ridgeWeight);
    this.ridgeVal.textContent = params.noise.ridgeWeight.toFixed(2);
    
    // Domain warping
    this.warpStrength.value = String(params.noise.warpStrength);
    this.warpStrengthVal.textContent = params.noise.warpStrength.toFixed(2);
    this.warpScale.value = String(params.noise.warpScale);
    this.warpScaleVal.textContent = params.noise.warpScale.toFixed(1);
    this.warpOctaves.value = String(params.noise.warpOctaves);
    this.warpOctavesVal.textContent = String(params.noise.warpOctaves);
    
    // Octave rotation
    this.rotateOctaves.checked = params.noise.rotateOctaves;
    this.octaveRotation.value = String(params.noise.octaveRotation);
    this.octaveRotationVal.textContent = `${Math.round(params.noise.octaveRotation)}°`;
    
    // Erosion params
    this.erosionEnabled.checked = params.erosion.enabled;
    this.erosionSettings.classList.toggle('disabled', !params.erosion.enabled);
    this.erosionIterations.value = String(params.erosion.iterations);
    const iters = params.erosion.iterations;
    this.erosionIterationsVal.textContent = iters >= 1000 ? `${Math.round(iters / 1000)}k` : String(iters);
    this.erosionInertia.value = String(params.erosion.inertia);
    this.erosionInertiaVal.textContent = params.erosion.inertia.toFixed(2);
    this.erosionCapacity.value = String(params.erosion.sedimentCapacity);
    this.erosionCapacityVal.textContent = params.erosion.sedimentCapacity.toFixed(1);
    this.erosionDeposit.value = String(params.erosion.depositSpeed);
    this.erosionDepositVal.textContent = params.erosion.depositSpeed.toFixed(2);
    this.erosionErode.value = String(params.erosion.erodeSpeed);
    this.erosionErodeVal.textContent = params.erosion.erodeSpeed.toFixed(2);
    
    // Thermal erosion
    this.thermalEnabled.checked = params.erosion.thermalEnabled;
    this.thermalSettings.classList.toggle('disabled', !params.erosion.thermalEnabled);
    this.thermalIterations.value = String(params.erosion.thermalIterations);
    this.thermalIterationsVal.textContent = String(params.erosion.thermalIterations);
    this.thermalTalus.value = String(params.erosion.talusAngle);
    this.thermalTalusVal.textContent = params.erosion.talusAngle.toFixed(2);
    
    // Material params
    this.snowLine.value = String(params.material.snowLine);
    this.snowLineVal.textContent = params.material.snowLine.toFixed(2);
    this.rockLine.value = String(params.material.rockLine);
    this.rockLineVal.textContent = params.material.rockLine.toFixed(2);
    this.grassSlope.value = String(params.material.maxGrassSlope);
    this.grassSlopeVal.textContent = params.material.maxGrassSlope.toFixed(2);
    this.grassColor.value = this.rgbToHex(params.material.grassColor);
    this.rockColor.value = this.rgbToHex(params.material.rockColor);
    this.snowColor.value = this.rgbToHex(params.material.snowColor);
    this.dirtColor.value = this.rgbToHex(params.material.dirtColor);
    
    // Clipmap rendering
    this.clipmapEnabled.checked = this.terrain.clipmapEnabled;
  }
  
  private async handleUpdate(): Promise<void> {
    if (!this.terrain) return;
    
    this.syncToTerrain();
    
    // Show progress
    this.progressContainer.classList.add('active');
    this.progressFill.style.width = '0%';
    this.progressText.textContent = 'Initializing...';
    this.updateBtn.disabled = true;
    
    try {
      await this.terrain.regenerate((info) => {
        this.progressFill.style.width = `${Math.round(info.progress * 100)}%`;
        this.progressText.textContent = info.stage;
      });
    } finally {
      this.progressContainer.classList.remove('active');
      this.updateBtn.disabled = false;
    }
    
    if (this.onUpdate) this.onUpdate();
    
    // Notify of bounds change so camera limits can be updated
    if (this.onBoundsChanged && this.terrain) {
      const params = this.terrain.params;
      this.onBoundsChanged(params.worldSize, params.noise.heightScale);
    }
  }
  
  private hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
      ];
    }
    return [0.5, 0.5, 0.5];
  }
  
  private rgbToHex(rgb: [number, number, number]): string {
    const toHex = (n: number) => {
      const h = Math.round(n * 255).toString(16);
      return h.length === 1 ? '0' + h : h;
    };
    return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
  }
  
  // ==================== Public API ====================
  
  setTerrain(terrain: TerrainObject | null): void {
    this.terrain = terrain;
    if (terrain) {
      this.syncFromTerrain();
    }
  }
  
  setOnUpdate(callback: () => void): void {
    this.onUpdate = callback;
  }
  
  /**
   * Set callback for when terrain bounds change (worldSize or heightScale).
   * Used to update camera zoom limits.
   */
  setOnBoundsChanged(callback: (worldSize: number, heightScale: number) => void): void {
    this.onBoundsChanged = callback;
  }
  
  destroy(): void {
    this.container.innerHTML = '';
  }
}
