/**
 * TerrainPanel - UI controls for terrain generation parameters
 * Supports both:
 * - TerrainObject (WebGL mode)
 * - TerrainManager (WebGPU mode)
 */

import type { TerrainObject, TerrainProgressCallback } from '../../../core/sceneObjects';
import type { TerrainParams, TerrainNoiseParams, TerrainErosionParams, TerrainMaterialParams } from '../../../core/sceneObjects/types';
import { TERRAIN_PRESETS, getTerrainPreset, type TerrainPreset } from './terrainPresets';
import type { TerrainManager, TerrainGenerationConfig } from '../../../core/terrain/TerrainManager';
import { debounce } from '../../../core/utils';

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
      <option value="1024">1024×1024</option>
      <option value="2048">2048×2048 (High)</option>
      <option value="4096">4096×4096 (Ultra)</option>
    </select>
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>World Size</label>
      <span id="terrain-world-size-val" class="slider-value">10</span>
    </div>
    <input type="range" id="terrain-world-size" min="10" max="1000" step="10" value="10" class="slider-input">
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Rendering Mode</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-cdlod-enabled">
    <span>Enable CDLOD (Quadtree LOD)</span>
  </label>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-clipmap-enabled">
    <span>Enable Clipmap (Geometric LOD)</span>
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
      <label>Offset X</label>
      <span id="terrain-offset-x-val" class="slider-value">0</span>
    </div>
    <input type="range" id="terrain-offset-x" min="0" max="1000" step="1" value="0" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Offset Z</label>
      <span id="terrain-offset-z-val" class="slider-value">0</span>
    </div>
    <input type="range" id="terrain-offset-z" min="0" max="1000" step="1" value="0" class="slider-input">
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
      <input type="range" id="terrain-erosion-iterations" min="1000" max="500000" step="1000" value="100000" class="slider-input">
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
  
  <div class="modifier-divider"></div>
  <div class="section-title">Water</div>
  <label class="checkbox-label">
    <input type="checkbox" id="terrain-water-enabled">
    <span>Enable Water</span>
  </label>
  <div class="modifier-settings" id="terrain-water-settings">
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Water Level</label>
        <span id="terrain-water-level-val" class="slider-value">0.0</span>
      </div>
      <input type="range" id="terrain-water-level" min="-0.5" max="0.5" step="0.01" value="0" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Wave Height</label>
        <span id="terrain-water-wave-height-val" class="slider-value">1.0</span>
      </div>
      <input type="range" id="terrain-water-wave-height" min="0" max="3" step="0.1" value="1" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Wave Speed</label>
        <span id="terrain-water-wave-speed-val" class="slider-value">1.0</span>
      </div>
      <input type="range" id="terrain-water-wave-speed" min="0.1" max="3" step="0.1" value="1" class="slider-input">
    </div>
    <div class="color-input-row">
      <label>Shallow</label>
      <input type="color" id="terrain-water-shallow-color" value="#40a0c0" class="color-input">
    </div>
    <div class="color-input-row">
      <label>Deep</label>
      <input type="color" id="terrain-water-deep-color" value="#102030" class="color-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Depth Falloff</label>
        <span id="terrain-water-depth-falloff-val" class="slider-value">0.1</span>
      </div>
      <input type="range" id="terrain-water-depth-falloff" min="0.01" max="0.5" step="0.01" value="0.1" class="slider-input">
    </div>
    <div class="transform-group compact-slider">
      <div class="slider-header">
        <label>Opacity</label>
        <span id="terrain-water-opacity-val" class="slider-value">0.85</span>
      </div>
      <input type="range" id="terrain-water-opacity" min="0.1" max="1" step="0.05" value="0.85" class="slider-input">
    </div>
  </div>
  
  <div class="modifier-divider"></div>
  <div class="section-title">Procedural Detail (Close-up)</div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Detail Frequency</label>
      <span id="terrain-detail-freq-val" class="slider-value">0.5</span>
    </div>
    <input type="range" id="terrain-detail-freq" min="0.1" max="2" step="0.1" value="0.5" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Detail Amplitude</label>
      <span id="terrain-detail-amp-val" class="slider-value">0.3</span>
    </div>
    <input type="range" id="terrain-detail-amp" min="0" max="2" step="0.1" value="0.3" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Detail Octaves</label>
      <span id="terrain-detail-octaves-val" class="slider-value">3</span>
    </div>
    <input type="range" id="terrain-detail-octaves" min="1" max="5" step="1" value="3" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Fade Start (m)</label>
      <span id="terrain-detail-fade-start-val" class="slider-value">50</span>
    </div>
    <input type="range" id="terrain-detail-fade-start" min="10" max="200" step="10" value="50" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Fade End (m)</label>
      <span id="terrain-detail-fade-end-val" class="slider-value">150</span>
    </div>
    <input type="range" id="terrain-detail-fade-end" min="50" max="500" step="10" value="150" class="slider-input">
  </div>
  <div class="transform-group compact-slider">
    <div class="slider-header">
      <label>Slope Influence</label>
      <span id="terrain-detail-slope-val" class="slider-value">0.5</span>
    </div>
    <input type="range" id="terrain-detail-slope" min="0" max="1" step="0.1" value="0.5" class="slider-input">
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
  private terrainManager: TerrainManager | null = null; // WebGPU mode
  private onUpdate: (() => void) | null = null;
  private onBoundsChanged: ((worldSize: number, heightScale: number) => void) | null = null;
  private currentPresetKey: string = 'default';
  
  // Debounced erosion handler for offset changes
  private debouncedErosion = debounce(() => this.handleUpdate(), 500);
  
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
  
  // Offset controls
  private offsetX!: HTMLInputElement;
  private offsetXVal!: HTMLSpanElement;
  private offsetZ!: HTMLInputElement;
  private offsetZVal!: HTMLSpanElement;
  
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
  private cdlodEnabled!: HTMLInputElement;
  
  // Procedural detail controls (WebGPU close-up rendering)
  private detailFreq!: HTMLInputElement;
  private detailFreqVal!: HTMLSpanElement;
  private detailAmp!: HTMLInputElement;
  private detailAmpVal!: HTMLSpanElement;
  private detailOctaves!: HTMLInputElement;
  private detailOctavesVal!: HTMLSpanElement;
  private detailFadeStart!: HTMLInputElement;
  private detailFadeStartVal!: HTMLSpanElement;
  private detailFadeEnd!: HTMLInputElement;
  private detailFadeEndVal!: HTMLSpanElement;
  private detailSlope!: HTMLInputElement;
  private detailSlopeVal!: HTMLSpanElement;
  
  // Water controls (WebGPU only)
  private waterEnabled!: HTMLInputElement;
  private waterSettings!: HTMLDivElement;
  private waterLevel!: HTMLInputElement;
  private waterLevelVal!: HTMLSpanElement;
  private waterWaveHeight!: HTMLInputElement;
  private waterWaveHeightVal!: HTMLSpanElement;
  private waterWaveSpeed!: HTMLInputElement;
  private waterWaveSpeedVal!: HTMLSpanElement;
  private waterShallowColor!: HTMLInputElement;
  private waterDeepColor!: HTMLInputElement;
  private waterDepthFalloff!: HTMLInputElement;
  private waterDepthFalloffVal!: HTMLSpanElement;
  private waterOpacity!: HTMLInputElement;
  private waterOpacityVal!: HTMLSpanElement;
  
  // Water config callback (WebGPU mode)
  private onWaterConfigChange: ((config: {
    enabled: boolean;
    waterLevel?: number;
    waveHeight?: number;
    waveSpeed?: number;
    shallowColor?: [number, number, number];
    deepColor?: [number, number, number];
    depthFalloff?: number;
    opacity?: number;
  }) => void) | null = null;
  
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
    
    // Offset controls
    this.offsetX = c.querySelector('#terrain-offset-x') as HTMLInputElement;
    this.offsetXVal = c.querySelector('#terrain-offset-x-val') as HTMLSpanElement;
    this.offsetZ = c.querySelector('#terrain-offset-z') as HTMLInputElement;
    this.offsetZVal = c.querySelector('#terrain-offset-z-val') as HTMLSpanElement;
    
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
    this.cdlodEnabled = c.querySelector('#terrain-cdlod-enabled') as HTMLInputElement;
    
    // Procedural detail controls
    this.detailFreq = c.querySelector('#terrain-detail-freq') as HTMLInputElement;
    this.detailFreqVal = c.querySelector('#terrain-detail-freq-val') as HTMLSpanElement;
    this.detailAmp = c.querySelector('#terrain-detail-amp') as HTMLInputElement;
    this.detailAmpVal = c.querySelector('#terrain-detail-amp-val') as HTMLSpanElement;
    this.detailOctaves = c.querySelector('#terrain-detail-octaves') as HTMLInputElement;
    this.detailOctavesVal = c.querySelector('#terrain-detail-octaves-val') as HTMLSpanElement;
    this.detailFadeStart = c.querySelector('#terrain-detail-fade-start') as HTMLInputElement;
    this.detailFadeStartVal = c.querySelector('#terrain-detail-fade-start-val') as HTMLSpanElement;
    this.detailFadeEnd = c.querySelector('#terrain-detail-fade-end') as HTMLInputElement;
    this.detailFadeEndVal = c.querySelector('#terrain-detail-fade-end-val') as HTMLSpanElement;
    this.detailSlope = c.querySelector('#terrain-detail-slope') as HTMLInputElement;
    this.detailSlopeVal = c.querySelector('#terrain-detail-slope-val') as HTMLSpanElement;
    
    // Water controls
    this.waterEnabled = c.querySelector('#terrain-water-enabled') as HTMLInputElement;
    this.waterSettings = c.querySelector('#terrain-water-settings') as HTMLDivElement;
    this.waterLevel = c.querySelector('#terrain-water-level') as HTMLInputElement;
    this.waterLevelVal = c.querySelector('#terrain-water-level-val') as HTMLSpanElement;
    this.waterWaveHeight = c.querySelector('#terrain-water-wave-height') as HTMLInputElement;
    this.waterWaveHeightVal = c.querySelector('#terrain-water-wave-height-val') as HTMLSpanElement;
    this.waterWaveSpeed = c.querySelector('#terrain-water-wave-speed') as HTMLInputElement;
    this.waterWaveSpeedVal = c.querySelector('#terrain-water-wave-speed-val') as HTMLSpanElement;
    this.waterShallowColor = c.querySelector('#terrain-water-shallow-color') as HTMLInputElement;
    this.waterDeepColor = c.querySelector('#terrain-water-deep-color') as HTMLInputElement;
    this.waterDepthFalloff = c.querySelector('#terrain-water-depth-falloff') as HTMLInputElement;
    this.waterDepthFalloffVal = c.querySelector('#terrain-water-depth-falloff-val') as HTMLSpanElement;
    this.waterOpacity = c.querySelector('#terrain-water-opacity') as HTMLInputElement;
    this.waterOpacityVal = c.querySelector('#terrain-water-opacity-val') as HTMLSpanElement;
    
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
    
    // Offset sliders with immediate preview + debounced erosion
    this.setupOffsetSlider(this.offsetX, this.offsetXVal);
    this.setupOffsetSlider(this.offsetZ, this.offsetZVal);
    
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
    
    // Material sliders with live update (separate from normal sync)
    this.setupMaterialSlider(this.snowLine, this.snowLineVal, v => v.toFixed(2));
    this.setupMaterialSlider(this.rockLine, this.rockLineVal, v => v.toFixed(2));
    this.setupMaterialSlider(this.grassSlope, this.grassSlopeVal, v => v.toFixed(2));
    
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
    
    // Color changes with live update
    [this.grassColor, this.rockColor, this.snowColor, this.dirtColor].forEach(input => {
      input.addEventListener('input', () => {
        this.syncToTerrain();
        this.pushMaterialLive();
      });
    });
    
    // Clipmap toggle
    this.clipmapEnabled.addEventListener('change', () => {
      if (this.terrain) {
        this.terrain.clipmapEnabled = this.clipmapEnabled.checked;
        // Disable CDLOD when clipmap is enabled (mutually exclusive)
        if (this.clipmapEnabled.checked && this.cdlodEnabled.checked) {
          this.cdlodEnabled.checked = false;
          this.terrain.cdlodEnabled = false;
        }
      }
    });
    
    // CDLOD toggle
    this.cdlodEnabled.addEventListener('change', () => {
      if (this.terrain) {
        this.terrain.cdlodEnabled = this.cdlodEnabled.checked;
        // Disable Clipmap when CDLOD is enabled (mutually exclusive)
        if (this.cdlodEnabled.checked && this.clipmapEnabled.checked) {
          this.clipmapEnabled.checked = false;
          this.terrain.clipmapEnabled = false;
        }
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
    
    // Procedural detail sliders with live update (WebGPU mode only)
    this.setupDetailSlider(this.detailFreq, this.detailFreqVal, v => v.toFixed(1));
    this.setupDetailSlider(this.detailAmp, this.detailAmpVal, v => v.toFixed(1));
    this.setupDetailSlider(this.detailOctaves, this.detailOctavesVal, v => String(Math.round(v)));
    this.setupDetailSlider(this.detailFadeStart, this.detailFadeStartVal, v => String(Math.round(v)));
    this.setupDetailSlider(this.detailFadeEnd, this.detailFadeEndVal, v => String(Math.round(v)));
    this.setupDetailSlider(this.detailSlope, this.detailSlopeVal, v => v.toFixed(1));
    
    // Water controls with live update (WebGPU mode only)
    this.waterEnabled.addEventListener('change', () => {
      this.waterSettings.classList.toggle('disabled', !this.waterEnabled.checked);
      this.pushWaterConfigLive();
    });
    this.setupWaterSlider(this.waterLevel, this.waterLevelVal, v => v.toFixed(2));
    this.setupWaterSlider(this.waterWaveHeight, this.waterWaveHeightVal, v => v.toFixed(1));
    this.setupWaterSlider(this.waterWaveSpeed, this.waterWaveSpeedVal, v => v.toFixed(1));
    this.setupWaterSlider(this.waterDepthFalloff, this.waterDepthFalloffVal, v => v.toFixed(2));
    this.setupWaterSlider(this.waterOpacity, this.waterOpacityVal, v => v.toFixed(2));
    [this.waterShallowColor, this.waterDeepColor].forEach(input => {
      input.addEventListener('input', () => this.pushWaterConfigLive());
    });
  }
  
  /**
   * Apply a preset to the terrain (excludes resolution and worldSize)
   * HeightScale is scaled proportionally: preset.heightScale * (currentWorldSize / referenceWorldSize)
   */
  private applyPreset(presetKey: string): void {
    const preset = getTerrainPreset(presetKey);
    if (!preset || !this.terrain) return;
    
    const params = this.terrain.params;
    const currentWorldSize = params.worldSize;
    
    // Scale heightScale proportionally to maintain visual proportions
    const scaleFactor = currentWorldSize / preset.referenceWorldSize;
    const scaledHeightScale = preset.noise.heightScale * scaleFactor;
    
    // Apply noise params (excluding offset which is derived)
    params.noise.seed = preset.noise.seed;
    params.noise.scale = preset.noise.scale;
    params.noise.octaves = preset.noise.octaves;
    params.noise.lacunarity = preset.noise.lacunarity;
    params.noise.persistence = preset.noise.persistence;
    params.noise.heightScale = scaledHeightScale;
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
   * Setup an offset slider with immediate heightmap preview + debounced erosion
   * WebGPU mode only - enables live terrain exploration
   */
  private setupOffsetSlider(slider: HTMLInputElement, valueDisplay: HTMLSpanElement): void {
    slider.addEventListener('input', () => {
      // Update value display
      valueDisplay.textContent = String(Math.round(parseFloat(slider.value)));
      
      // WebGPU mode: immediate heightmap preview + debounced full generation
      if (this.terrainManager) {
        // Immediate preview: regenerate heightmap only (no erosion)
        const noiseParams = {
          offsetX: parseFloat(this.offsetX.value),
          offsetY: parseFloat(this.offsetZ.value),
        };
        this.terrainManager.regenerateHeightmapOnly(noiseParams);
        
        // Debounced: full regeneration with erosion after user stops scrolling
        this.debouncedErosion();
      }
      // WebGL mode: just sync params
      else {
        this.syncToTerrain();
      }
    });
  }
  
  /**
   * Setup a material slider with live updates (no regeneration needed)
   */
  private setupMaterialSlider(slider: HTMLInputElement, valueDisplay: HTMLSpanElement, format: (v: number) => string): void {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = format(parseFloat(slider.value));
      this.syncToTerrain();
      this.pushMaterialLive();
    });
  }
  
  /**
   * Setup a procedural detail slider with live updates (WebGPU mode only)
   */
  private setupDetailSlider(slider: HTMLInputElement, valueDisplay: HTMLSpanElement, format: (v: number) => string): void {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = format(parseFloat(slider.value));
      this.pushDetailLive();
    });
  }
  
  /**
   * Push procedural detail values to the terrain for live rendering (WebGPU only).
   * Calls TerrainManager.setDetailConfig() for immediate visual feedback.
   */
  private pushDetailLive(): void {
    if (this.terrainManager) {
      this.terrainManager.setDetailConfig({
        frequency: parseFloat(this.detailFreq.value),
        amplitude: parseFloat(this.detailAmp.value),
        octaves: parseInt(this.detailOctaves.value, 10),
        fadeStart: parseFloat(this.detailFadeStart.value),
        fadeEnd: parseFloat(this.detailFadeEnd.value),
        slopeInfluence: parseFloat(this.detailSlope.value),
      });
    }
  }
  
  /**
   * Setup a water slider with live updates (WebGPU mode only)
   */
  private setupWaterSlider(slider: HTMLInputElement, valueDisplay: HTMLSpanElement, format: (v: number) => string): void {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = format(parseFloat(slider.value));
      this.pushWaterConfigLive();
    });
  }
  
  /**
   * Push current water config values to the pipeline for live rendering (WebGPU only).
   * Calls the onWaterConfigChange callback for immediate visual feedback.
   */
  private pushWaterConfigLive(): void {
    if (this.onWaterConfigChange) {
      this.onWaterConfigChange({
        enabled: this.waterEnabled.checked,
        waterLevel: parseFloat(this.waterLevel.value),
        waveHeight: parseFloat(this.waterWaveHeight.value),
        waveSpeed: parseFloat(this.waterWaveSpeed.value),
        shallowColor: this.hexToRgb(this.waterShallowColor.value),
        deepColor: this.hexToRgb(this.waterDeepColor.value),
        depthFalloff: parseFloat(this.waterDepthFalloff.value),
        opacity: parseFloat(this.waterOpacity.value),
      });
    }
  }
  
  /**
   * Update heightScale slider max based on worldSize.
   * Allows height up to 1:10 ratio (worldSize / 10).
   */
  private updateHeightScaleMax(worldSize: number): void {
    const newMax = Math.max(1, worldSize / 10 + 100); // Min of 1 to avoid tiny maxes
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
  
  /**
   * Push current material values to the terrain for live rendering.
   * For WebGPU mode, calls TerrainManager.setMaterial().
   * For WebGL mode, updates TerrainObject directly.
   */
  private pushMaterialLive(): void {
    if (this.terrainManager) {
      // WebGPU mode - call setMaterial for immediate effect
      this.terrainManager.setMaterial({
        snowLine: parseFloat(this.snowLine.value),
        rockLine: parseFloat(this.rockLine.value),
        maxGrassSlope: parseFloat(this.grassSlope.value),
        grassColor: this.hexToRgb(this.grassColor.value),
        rockColor: this.hexToRgb(this.rockColor.value),
        snowColor: this.hexToRgb(this.snowColor.value),
        dirtColor: this.hexToRgb(this.dirtColor.value),
      });
    } else if (this.terrain) {
      // WebGL mode - syncToTerrain already updates it
      this.syncToTerrain();
    }
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
    
    // Clipmap and CDLOD rendering
    this.clipmapEnabled.checked = this.terrain.clipmapEnabled;
    this.cdlodEnabled.checked = this.terrain.cdlodEnabled;
  }
  
  private async handleUpdate(): Promise<void> {
    // Show progress
    this.progressContainer.classList.add('active');
    this.progressFill.style.width = '0%';
    this.progressText.textContent = 'Initializing...';
    this.updateBtn.disabled = true;
    
    try {
      // WebGPU mode - use TerrainManager
      if (this.terrainManager) {
        await this.handleWebGPUUpdate();
      }
      // WebGL mode - use TerrainObject
      else if (this.terrain) {
        this.syncToTerrain();
        await this.terrain.regenerate((info) => {
          this.progressFill.style.width = `${Math.round(info.progress * 100)}%`;
          this.progressText.textContent = info.stage;
        });
        
        // Notify of bounds change
        if (this.onBoundsChanged) {
          const params = this.terrain.params;
          this.onBoundsChanged(params.worldSize, params.noise.heightScale);
        }
      }
    } finally {
      this.progressContainer.classList.remove('active');
      this.updateBtn.disabled = false;
    }
    
    if (this.onUpdate) this.onUpdate();
  }
  
  /**
   * Handle update for WebGPU TerrainManager
   */
  private async handleWebGPUUpdate(): Promise<void> {
    if (!this.terrainManager) return;
    
    // Map UI scale to WebGPU scaleX/scaleY
    const scaleVal = parseFloat(this.scale.value);
    
    // Build generation config from UI values
    // Note: WebGPU NoiseParams uses different field names than WebGL
    // Note: heightScale is NOT in noise params - it's applied at render time via TerrainManager.config.heightScale
    const genConfig: Partial<TerrainGenerationConfig> = {
      resolution: parseInt(this.resolution.value, 10),
      // Noise type is controlled via warpStrength/ridgeWeight in NoiseParams
      noise: {
        seed: parseInt(this.seed.value, 10),
        offsetX: parseFloat(this.offsetX.value),
        offsetY: parseFloat(this.offsetZ.value), // UI Z maps to noise Y
        scaleX: scaleVal,
        scaleY: scaleVal,
        octaves: parseInt(this.octaves.value, 10),
        lacunarity: parseFloat(this.lacunarity.value),
        persistence: parseFloat(this.persistence.value),
        // Domain warping parameters
        warpStrength: parseFloat(this.warpStrength.value),
        warpScale: parseFloat(this.warpScale.value),
        warpOctaves: parseInt(this.warpOctaves.value, 10),
        // Ridge blending
        ridgeWeight: parseFloat(this.ridge.value),
        // Octave rotation
        rotateOctaves: this.rotateOctaves.checked,
        octaveRotation: parseFloat(this.octaveRotation.value),
      },
      enableHydraulicErosion: this.erosionEnabled.checked,
      // Slider shows total droplets (e.g., 100k), but each iteration simulates 10,000 droplets
      // So 100k droplets = 10 iterations × 10,000 droplets/iteration
      hydraulicIterations: Math.ceil(parseInt(this.erosionIterations.value, 10) / 10000),
      hydraulicParams: {
        inertia: parseFloat(this.erosionInertia.value),
        sedimentCapacity: parseFloat(this.erosionCapacity.value),
        depositionRate: parseFloat(this.erosionDeposit.value),
        erosionRate: parseFloat(this.erosionErode.value),
      },
      enableThermalErosion: this.thermalEnabled.checked,
      thermalIterations: parseInt(this.thermalIterations.value, 10),
      thermalParams: {
        talusAngle: parseFloat(this.thermalTalus.value),
      },
    };
    
    // Update manager config
    this.terrainManager.setWorldSize(parseFloat(this.worldSize.value));
    this.terrainManager.setHeightScale(parseFloat(this.heightScale.value));
    
    // Regenerate terrain
    await this.terrainManager.regenerate(genConfig, (stage, progress) => {
      this.progressFill.style.width = `${Math.round(progress)}%`;
      this.progressText.textContent = stage;
    });
    
    // TODO: Update material params on renderer
    // const renderer = this.terrainManager.getRenderer();
    // if (renderer) {
    //   renderer.setMaterial({...});
    // }
    
    // Notify of bounds change
    if (this.onBoundsChanged) {
      const config = this.terrainManager.getConfig();
      this.onBoundsChanged(config.worldSize, config.heightScale);
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
  
  /**
   * Set TerrainObject for WebGL mode
   */
  setTerrain(terrain: TerrainObject | null): void {
    this.terrain = terrain;
    this.terrainManager = null; // Clear WebGPU mode
    if (terrain) {
      this.syncFromTerrain();
    }
  }
  
  /**
   * Set TerrainManager for WebGPU mode
   */
  setTerrainManager(manager: TerrainManager | null): void {
    this.terrainManager = manager;
    this.terrain = null; // Clear WebGL mode
    if (manager) {
      this.syncFromTerrainManager();
    }
  }
  
  /**
   * Sync UI from TerrainManager config (WebGPU mode)
   */
  private syncFromTerrainManager(): void {
    if (!this.terrainManager) return;
    
    const config = this.terrainManager.getConfig();
    const genConfig = config.generationConfig;
    
    // World size and height scale
    this.worldSize.value = String(config.worldSize);
    this.worldSizeVal.textContent = String(config.worldSize);
    this.updateHeightScaleMax(config.worldSize);
    
    // Compute UI heightScale from actual heightScale
    const uiHeightScale = config.heightScale * 10 / config.worldSize;
    this.heightScale.value = String(uiHeightScale);
    this.heightScaleVal.textContent = uiHeightScale.toFixed(1);
    
    // Resolution
    this.resolution.value = String(genConfig?.resolution || 1024);
    
    // Noise params - WebGPU uses scaleX/scaleY, show average as 'scale'
    const noise = genConfig?.noise || {};
    this.seed.value = String(noise.seed ?? 12345);
    const scaleVal = noise.scaleX ?? 3;
    this.scale.value = String(scaleVal);
    this.scaleVal.textContent = scaleVal.toFixed(1);
    this.octaves.value = String(noise.octaves ?? 6);
    this.octavesVal.textContent = String(noise.octaves ?? 6);
    this.lacunarity.value = String(noise.lacunarity ?? 2);
    this.lacunarityVal.textContent = (noise.lacunarity ?? 2).toFixed(1);
    this.persistence.value = String(noise.persistence ?? 0.5);
    this.persistenceVal.textContent = (noise.persistence ?? 0.5).toFixed(2);
    
    // WebGPU doesn't have ridgeWeight - use default
    this.ridge.value = '0.5';
    this.ridgeVal.textContent = '0.50';
    
    // Domain warping - WebGPU doesn't have these in NoiseParams, use defaults
    this.warpStrength.value = '0.5';
    this.warpStrengthVal.textContent = '0.50';
    this.warpScale.value = '2';
    this.warpScaleVal.textContent = '2.0';
    this.warpOctaves.value = '1';
    this.warpOctavesVal.textContent = '1';
    
    // Octave rotation - WebGPU doesn't have these in NoiseParams, use defaults
    this.rotateOctaves.checked = true;
    this.octaveRotation.value = '37';
    this.octaveRotationVal.textContent = '37°';
    
    // Erosion
    this.erosionEnabled.checked = genConfig?.enableHydraulicErosion ?? true;
    this.erosionSettings.classList.toggle('disabled', !this.erosionEnabled.checked);
    const hydraulicIters = (genConfig?.hydraulicIterations ?? 30) * 10000;
    this.erosionIterations.value = String(hydraulicIters);
    this.erosionIterationsVal.textContent = hydraulicIters >= 1000 ? `${Math.round(hydraulicIters / 1000)}k` : String(hydraulicIters);
    
    // Use correct HydraulicErosionParams field names
    const hydraulic = genConfig?.hydraulicParams || {};
    this.erosionInertia.value = String(hydraulic.inertia ?? 0.05);
    this.erosionInertiaVal.textContent = (hydraulic.inertia ?? 0.05).toFixed(2);
    this.erosionCapacity.value = String(hydraulic.sedimentCapacity ?? 4);
    this.erosionCapacityVal.textContent = (hydraulic.sedimentCapacity ?? 4).toFixed(1);
    this.erosionDeposit.value = String(hydraulic.depositionRate ?? 0.3);
    this.erosionDepositVal.textContent = (hydraulic.depositionRate ?? 0.3).toFixed(2);
    this.erosionErode.value = String(hydraulic.erosionRate ?? 0.3);
    this.erosionErodeVal.textContent = (hydraulic.erosionRate ?? 0.3).toFixed(2);
    
    // Thermal erosion
    this.thermalEnabled.checked = genConfig?.enableThermalErosion ?? true;
    this.thermalSettings.classList.toggle('disabled', !this.thermalEnabled.checked);
    this.thermalIterations.value = String(genConfig?.thermalIterations ?? 10);
    this.thermalIterationsVal.textContent = String(genConfig?.thermalIterations ?? 10);
    const thermal = genConfig?.thermalParams || {};
    this.thermalTalus.value = String(thermal.talusAngle ?? 0.5);
    this.thermalTalusVal.textContent = (thermal.talusAngle ?? 0.5).toFixed(2);
    
    // Hide WebGL-only controls in WebGPU mode
    this.clipmapEnabled.parentElement!.style.display = 'none';
    this.cdlodEnabled.parentElement!.style.display = 'none';
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
  
  /**
   * Set callback for when water config changes (WebGPU mode).
   * Used to update water renderer in GPUForwardPipeline.
   */
  setOnWaterConfigChange(callback: (config: {
    enabled: boolean;
    waterLevel?: number;
    waveHeight?: number;
    waveSpeed?: number;
    shallowColor?: [number, number, number];
    deepColor?: [number, number, number];
    depthFalloff?: number;
    opacity?: number;
  }) => void): void {
    this.onWaterConfigChange = callback;
  }
  
  destroy(): void {
    this.container.innerHTML = '';
  }
}
