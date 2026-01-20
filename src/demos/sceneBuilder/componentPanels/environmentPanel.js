/**
 * Environment Panel
 * Displays lighting and global wind controls
 */

import { parseHDR, createPrefilteredHDRTexture } from '../hdrLoader';

// Panel-specific styles
const environmentPanelStyles = `
  .environment-panel .hdr-progress {
    margin-top: 8px;
    padding: 8px;
    background: #333;
    border-radius: 4px;
  }
  
  .environment-panel .hdr-progress-bar {
    height: 4px;
    background: #222;
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }
  
  .environment-panel .hdr-progress-fill {
    height: 100%;
    background: #ff6666;
    width: 0%;
    transition: width 0.1s ease-out;
  }
  
  .environment-panel .hdr-progress-text {
    font-size: 10px;
    color: #888;
  }

  .environment-panel .wind-direction-indicator {
    width: 40px;
    height: 40px;
    border: 1px solid #555;
    border-radius: 50%;
    position: relative;
    margin: 4px auto;
    background: #222;
  }
  
  .environment-panel .wind-direction-arrow {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 16px;
    height: 2px;
    background: #ff6666;
    transform-origin: left center;
    transform: translateY(-50%);
    border-radius: 1px;
  }
  
  .environment-panel .wind-direction-arrow::after {
    content: '';
    position: absolute;
    right: -2px;
    top: -3px;
    border: 4px solid transparent;
    border-left: 6px solid #ff6666;
  }
  
  .environment-panel .wind-enabled-indicator {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #444;
    margin-left: 8px;
  }
  
  .environment-panel .wind-enabled-indicator.active {
    background: #4f4;
    box-shadow: 0 0 4px #4f4;
  }
  
  /* HDR Gallery Styles */
  .environment-panel .hdr-gallery {
    margin-top: 8px;
    margin-bottom: 8px;
  }
  
  .environment-panel .hdr-gallery-label {
    font-size: 11px;
    color: #888;
    margin-bottom: 6px;
  }
  
  .environment-panel .hdr-gallery-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;
    padding: 4px;
    background: #222;
    border-radius: 4px;
  }
  
  .environment-panel .hdr-gallery-item {
    position: relative;
    aspect-ratio: 2 / 1;
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    border: 2px solid transparent;
    transition: border-color 0.15s, transform 0.15s;
    background: #333;
  }
  
  .environment-panel .hdr-gallery-item:hover {
    border-color: #666;
    transform: scale(1.02);
  }
  
  .environment-panel .hdr-gallery-item.selected {
    border-color: #ff6666;
  }
  
  .environment-panel .hdr-gallery-item.loading {
    opacity: 0.5;
    pointer-events: none;
  }
  
  .environment-panel .hdr-gallery-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .environment-panel .hdr-gallery-name {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 2px 4px;
    background: rgba(0,0,0,0.7);
    font-size: 9px;
    color: #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .environment-panel .hdr-gallery-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, #2a2a2a 0%, #3a3a3a 100%);
    color: #666;
    font-size: 16px;
  }
  
  .environment-panel .hdr-gallery-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: #2a2a2a;
    color: #888;
    font-size: 10px;
    gap: 2px;
  }
  
  .environment-panel .hdr-gallery-upload-icon {
    font-size: 18px;
  }
  
  .environment-panel .hdr-load-btn {
    width: 100%;
    padding: 6px 12px;
    margin-top: 8px;
    background: #ff6666;
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  
  .environment-panel .hdr-load-btn:hover {
    background: #ff8080;
  }
  
  .environment-panel .hdr-load-btn:disabled {
    background: #555;
    cursor: not-allowed;
  }
`;

// Panel HTML template
const environmentPanelTemplate = `
  <h3>Environment</h3>
  <div class="section-content">
    <div class="env-tabs">
      <button class="env-tab active" data-tab="lighting">Lighting</button>
      <button class="env-tab" data-tab="wind">Wind</button>
    </div>
    
    <!-- Lighting Tab Content -->
    <div id="env-lighting-tab" class="env-tab-content active">
      <div class="light-mode-indicator">
        <span id="current-light-mode">Sun Mode</span>
      </div>
      <div id="sun-controls">
        <div class="transform-group compact-slider">
          <div class="slider-header">
            <label>Azimuth</label>
            <span id="sun-azimuth-value" class="slider-value">45°</span>
          </div>
          <input type="range" id="sun-azimuth" min="0" max="360" value="45" class="slider-input">
        </div>
        <div class="transform-group compact-slider">
          <div class="slider-header">
            <label>Elevation</label>
            <span id="sun-elevation-value" class="slider-value">45°</span>
          </div>
          <input type="range" id="sun-elevation" min="-90" max="90" value="45" class="slider-input">
        </div>
        <div class="shadow-controls">
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-enabled" checked>
            <span>Enable Shadows</span>
          </label>
          <div class="transform-group">
            <label>Shadow Quality</label>
            <div class="shadow-quality-btns">
              <button id="shadow-1024" class="quality-btn">1024</button>
              <button id="shadow-2048" class="quality-btn active">2048</button>
              <button id="shadow-4096" class="quality-btn">4096</button>
            </div>
          </div>
          <div class="transform-group">
            <label>Shadow Debug</label>
            <select id="shadow-debug" style="width: 100%; padding: 4px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; font-size: 11px;">
              <option value="0">Off</option>
              <option value="1">Depth Map</option>
              <option value="2">UV Coords</option>
              <option value="3">Shadow Value</option>
            </select>
          </div>
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-thumbnail">
            <span>Show Depth Thumbnail</span>
          </label>
        </div>
      </div>
      <div id="hdr-controls" style="display: none;">
        <div class="transform-group compact-slider">
          <div class="slider-header">
            <label>HDR Exposure</label>
            <span id="hdr-exposure-value" class="slider-value">1.0</span>
          </div>
          <input type="range" id="hdr-exposure" min="0.1" max="5" step="0.1" value="1" class="slider-input">
        </div>
        <div id="hdr-filename" class="hdr-filename">No HDR loaded</div>
        
        <!-- HDR Gallery -->
        <div class="hdr-gallery">
          <div class="hdr-gallery-label">Available HDRs</div>
          <div id="hdr-gallery-grid" class="hdr-gallery-grid">
            <!-- Populated dynamically -->
          </div>
          <button id="hdr-load-btn" class="hdr-load-btn" disabled>Load Selected</button>
        </div>
        
        <div id="hdr-progress" class="hdr-progress" style="display: none;">
          <div class="hdr-progress-bar">
            <div id="hdr-progress-fill" class="hdr-progress-fill"></div>
          </div>
          <span id="hdr-progress-text" class="hdr-progress-text">Processing...</span>
        </div>
      </div>
      <input type="file" id="hdr-file" accept=".hdr" style="display: none;">
    </div>
    
    <!-- Wind Tab Content -->
    <div id="env-wind-tab" class="env-tab-content">
      <label class="checkbox-label">
        <input type="checkbox" id="wind-enabled">
        <span>Enable Wind <span id="wind-enabled-indicator" class="wind-enabled-indicator"></span></span>
      </label>
      <div class="transform-group">
        <div class="wind-direction-indicator">
          <div id="wind-direction-arrow" class="wind-direction-arrow"></div>
        </div>
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Direction</label>
          <span id="wind-direction-value" class="slider-value">45°</span>
        </div>
        <input type="range" id="wind-direction" min="0" max="360" value="45" class="slider-input">
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Strength</label>
          <span id="wind-strength-value" class="slider-value">0.5</span>
        </div>
        <input type="range" id="wind-strength" min="0" max="2" step="0.1" value="0.5" class="slider-input">
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Turbulence</label>
          <span id="wind-turbulence-value" class="slider-value">0.5</span>
        </div>
        <input type="range" id="wind-turbulence" min="0" max="1" step="0.1" value="0.5" class="slider-input">
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Gust Strength</label>
          <span id="wind-gust-strength-value" class="slider-value">0.3</span>
        </div>
        <input type="range" id="wind-gust-strength" min="0" max="1" step="0.1" value="0.3" class="slider-input">
      </div>
      <div class="transform-group compact-slider">
        <div class="slider-header">
          <label>Debug</label>
        </div>
        <select id="wind-debug" style="width: 100%; padding: 4px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; font-size: 11px;">
          <option value="0">Off</option>
          <option value="1">Wind Type</option>
          <option value="2">Height Factor</option>
          <option value="3">Displacement</option>
        </select>
      </div>
    </div>
  </div>
`;

/**
 * Creates the environment panel
 * @param {HTMLElement} panelElement - The panel container element
 * @param {import('./panelContext').PanelContext} context - Panel context
 * @returns {Object} Panel interface with update and destroy methods
 */
export function createEnvironmentPanel(panelElement, context) {
  const { gl, windManager, lightingManager, setLightMode, setShadowResolution, setShowShadowThumbnail, setHDRTexture, onWindChanged, onLightingChanged } = context;
  
  // Set panel content first
  panelElement.innerHTML = environmentPanelTemplate;
  panelElement.classList.add('environment-panel', 'sidebar-section');
  panelElement.id = 'environment-panel';
  
  // Add panel-specific styles after innerHTML (so they don't get overwritten)
  const styleEl = document.createElement('style');
  styleEl.textContent = environmentPanelStyles;
  panelElement.appendChild(styleEl);
  
  // Cache DOM references - Lighting tab
  const currentLightMode = panelElement.querySelector('#current-light-mode');
  const sunControls = panelElement.querySelector('#sun-controls');
  const hdrControls = panelElement.querySelector('#hdr-controls');
  const sunAzimuth = panelElement.querySelector('#sun-azimuth');
  const sunAzimuthValue = panelElement.querySelector('#sun-azimuth-value');
  const sunElevation = panelElement.querySelector('#sun-elevation');
  const sunElevationValue = panelElement.querySelector('#sun-elevation-value');
  const shadowEnabled = panelElement.querySelector('#shadow-enabled');
  const shadowDebug = panelElement.querySelector('#shadow-debug');
  const shadowThumbnail = panelElement.querySelector('#shadow-thumbnail');
  const hdrExposure = panelElement.querySelector('#hdr-exposure');
  const hdrExposureValue = panelElement.querySelector('#hdr-exposure-value');
  const hdrFilename = panelElement.querySelector('#hdr-filename');
  const hdrFile = panelElement.querySelector('#hdr-file');
  const hdrProgress = panelElement.querySelector('#hdr-progress');
  const hdrProgressFill = panelElement.querySelector('#hdr-progress-fill');
  const hdrProgressText = panelElement.querySelector('#hdr-progress-text');
  
  // HDR Gallery elements
  const hdrGalleryGrid = panelElement.querySelector('#hdr-gallery-grid');
  const hdrLoadBtn = panelElement.querySelector('#hdr-load-btn');
  
  // Cache DOM references - Wind tab
  const windEnabled = panelElement.querySelector('#wind-enabled');
  const windEnabledIndicator = panelElement.querySelector('#wind-enabled-indicator');
  const windDirectionArrow = panelElement.querySelector('#wind-direction-arrow');
  const windDirection = panelElement.querySelector('#wind-direction');
  const windDirectionValue = panelElement.querySelector('#wind-direction-value');
  const windStrength = panelElement.querySelector('#wind-strength');
  const windStrengthValue = panelElement.querySelector('#wind-strength-value');
  const windTurbulence = panelElement.querySelector('#wind-turbulence');
  const windTurbulenceValue = panelElement.querySelector('#wind-turbulence-value');
  const windGustStrength = panelElement.querySelector('#wind-gust-strength');
  const windGustStrengthValue = panelElement.querySelector('#wind-gust-strength-value');
  const windDebug = panelElement.querySelector('#wind-debug');
  
  // HDR Gallery state
  let hdrManifest = [];
  let selectedHdrName = null; // Persists across sun/HDR mode switches
  let isLoadingHdr = false;
  
  /**
   * Loads the HDR manifest from server
   */
  async function loadHdrManifest() {
    try {
      const response = await fetch('/ibl/manifest.json');
      const data = await response.json();
      hdrManifest = data.hdrs || [];
      renderHdrGallery();
    } catch (err) {
      console.warn('Failed to load HDR manifest:', err);
      hdrManifest = [];
      renderHdrGallery();
    }
  }
  
  /**
   * Renders the HDR gallery grid
   */
  function renderHdrGallery() {
    let html = '';
    
    // Render each HDR from manifest
    for (const hdr of hdrManifest) {
      const isSelected = selectedHdrName === hdr.name;
      html += `
        <div class="hdr-gallery-item ${isSelected ? 'selected' : ''}" data-hdr-name="${hdr.name}">
          <img 
            class="hdr-gallery-thumb" 
            src="/ibl/${hdr.name}.jpg" 
            alt="${hdr.displayName}"
            onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
          >
          <div class="hdr-gallery-placeholder" style="display: none;">🌄</div>
          <div class="hdr-gallery-name">${hdr.displayName}</div>
        </div>
      `;
    }
    
    // Add upload button as last item
    html += `
      <div class="hdr-gallery-item" data-hdr-upload="true">
        <div class="hdr-gallery-upload">
          <span class="hdr-gallery-upload-icon">+</span>
          <span>Upload</span>
        </div>
      </div>
    `;
    
    hdrGalleryGrid.innerHTML = html;
    
    // Add click handlers
    hdrGalleryGrid.querySelectorAll('.hdr-gallery-item').forEach(item => {
      item.addEventListener('click', () => {
        if (isLoadingHdr) return;
        
        if (item.dataset.hdrUpload) {
          // Open file picker for custom upload
          hdrFile.click();
        } else {
          // Select this HDR
          const hdrName = item.dataset.hdrName;
          selectHdr(hdrName);
        }
      });
    });
    
    updateLoadButton();
  }
  
  /**
   * Selects an HDR in the gallery
   */
  function selectHdr(hdrName) {
    selectedHdrName = hdrName;
    
    // Update visual selection
    hdrGalleryGrid.querySelectorAll('.hdr-gallery-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.hdrName === hdrName);
    });
    
    updateLoadButton();
  }
  
  /**
   * Updates the Load button state
   */
  function updateLoadButton() {
    hdrLoadBtn.disabled = !selectedHdrName || isLoadingHdr;
    hdrLoadBtn.textContent = isLoadingHdr ? 'Loading...' : 'Load Selected';
  }
  
  /**
   * Loads the selected HDR and applies it to the scene
   */
  async function loadSelectedHdr() {
    if (!selectedHdrName || isLoadingHdr) return;
    
    isLoadingHdr = true;
    updateLoadButton();
    
    // Mark the selected item as loading
    const selectedItem = hdrGalleryGrid.querySelector(`[data-hdr-name="${selectedHdrName}"]`);
    if (selectedItem) selectedItem.classList.add('loading');
    
    try {
      const hdrPath = `/ibl/${selectedHdrName}.hdr`;
      hdrFilename.textContent = 'Loading...';
      hdrProgress.style.display = 'block';
      hdrProgressFill.style.width = '0%';
      hdrProgressText.textContent = 'Fetching HDR...';
      
      // Fetch the HDR file
      const response = await fetch(hdrPath);
      if (!response.ok) throw new Error(`Failed to fetch ${hdrPath}`);
      
      const buffer = await response.arrayBuffer();
      
      hdrProgressText.textContent = 'Parsing HDR...';
      hdrProgressFill.style.width = '10%';
      
      const hdrData = parseHDR(buffer);
      
      hdrProgressText.textContent = 'Pre-filtering for IBL...';
      
      // Create prefiltered texture
      const result = createPrefilteredHDRTexture(gl, hdrData, (progress) => {
        const percent = Math.round(10 + progress * 90);
        hdrProgressFill.style.width = `${percent}%`;
        hdrProgressText.textContent = progress < 1 ? `Pre-filtering... ${percent}%` : 'Complete!';
      });
      
      const { texture, mipLevels } = result;
      
      // Find display name
      const hdrInfo = hdrManifest.find(h => h.name === selectedHdrName);
      const displayName = hdrInfo ? hdrInfo.displayName : selectedHdrName;
      
      lightingManager.hdrLight.setTexture(texture, `${selectedHdrName}.hdr`);
      hdrFilename.textContent = displayName;
      
      // Hide progress after a short delay
      setTimeout(() => {
        hdrProgress.style.display = 'none';
      }, 500);
      
      // Notify viewport about the new texture with mip level count
      setHDRTexture(texture, mipLevels);
      setLightMode('hdr');
      updateLightModeDisplay('hdr');
      
    } catch (err) {
      console.error('Failed to load HDR:', err);
      hdrFilename.textContent = 'Error loading HDR';
      hdrProgress.style.display = 'none';
    } finally {
      isLoadingHdr = false;
      updateLoadButton();
      if (selectedItem) selectedItem.classList.remove('loading');
    }
  }
  
  /**
   * Updates wind direction arrow rotation
   */
  function updateWindDirectionArrow() {
    windDirectionArrow.style.transform = `translateY(-50%) rotate(${windManager.direction}deg)`;
  }
  
  /**
   * Updates wind enabled indicator
   */
  function updateWindEnabledIndicator() {
    windEnabledIndicator.classList.toggle('active', windManager.enabled);
  }
  
  /**
   * Updates lighting mode display
   */
  function updateLightModeDisplay(mode) {
    currentLightMode.textContent = mode === 'sun' ? 'Sun Mode' : 'HDR Mode';
    sunControls.style.display = mode === 'sun' ? 'block' : 'none';
    hdrControls.style.display = mode === 'hdr' ? 'block' : 'none';
  }
  
  /**
   * Updates all UI elements from current state
   */
  function update() {
    // Update lighting UI
    updateLightModeDisplay(lightingManager.activeMode);
    sunAzimuth.value = lightingManager.sunLight.azimuth;
    sunAzimuthValue.textContent = `${lightingManager.sunLight.azimuth}°`;
    sunElevation.value = lightingManager.sunLight.elevation;
    sunElevationValue.textContent = `${lightingManager.sunLight.elevation}°`;
    shadowEnabled.checked = lightingManager.shadowEnabled;
    hdrExposure.value = lightingManager.hdrLight.exposure;
    hdrExposureValue.textContent = lightingManager.hdrLight.exposure.toFixed(1);
    
    // Update shadow quality buttons
    panelElement.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
    panelElement.querySelector(`#shadow-${lightingManager.sunLight.shadowResolution}`)?.classList.add('active');
    
    // Update wind UI
    windEnabled.checked = windManager.enabled;
    windDirection.value = windManager.direction;
    windDirectionValue.textContent = `${windManager.direction}°`;
    windStrength.value = windManager.strength;
    windStrengthValue.textContent = windManager.strength.toFixed(1);
    windTurbulence.value = windManager.turbulence;
    windTurbulenceValue.textContent = windManager.turbulence.toFixed(1);
    windGustStrength.value = windManager.gustStrength;
    windGustStrengthValue.textContent = windManager.gustStrength.toFixed(1);
    
    updateWindDirectionArrow();
    updateWindEnabledIndicator();
  }
  
  /**
   * Setup event listeners
   */
  function setup() {
    // Tab switching
    const tabs = panelElement.querySelectorAll('.env-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const tabName = tab.dataset.tab;
        panelElement.querySelectorAll('.env-tab-content').forEach(content => {
          content.classList.remove('active');
        });
        panelElement.querySelector(`#env-${tabName}-tab`).classList.add('active');
      });
    });
    
    // Sun azimuth
    sunAzimuth.addEventListener('input', (e) => {
      lightingManager.sunLight.azimuth = parseFloat(e.target.value);
      sunAzimuthValue.textContent = `${lightingManager.sunLight.azimuth}°`;
      onLightingChanged();
    });
    
    // Sun elevation
    sunElevation.addEventListener('input', (e) => {
      lightingManager.sunLight.elevation = parseFloat(e.target.value);
      sunElevationValue.textContent = `${lightingManager.sunLight.elevation}°`;
      onLightingChanged();
    });
    
    // Shadow enabled
    shadowEnabled.addEventListener('change', (e) => {
      lightingManager.shadowEnabled = e.target.checked;
      onLightingChanged();
    });
    
    // Shadow quality buttons
    [1024, 2048, 4096].forEach(res => {
      panelElement.querySelector(`#shadow-${res}`).addEventListener('click', () => {
        lightingManager.sunLight.shadowResolution = res;
        setShadowResolution(res);
        panelElement.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
        panelElement.querySelector(`#shadow-${res}`).classList.add('active');
      });
    });
    
    // Shadow debug
    shadowDebug.addEventListener('change', (e) => {
      lightingManager.shadowDebug = parseInt(e.target.value, 10);
      onLightingChanged();
    });
    
    // Shadow thumbnail
    shadowThumbnail.addEventListener('change', (e) => {
      setShowShadowThumbnail(e.target.checked);
    });
    
    // HDR exposure
    hdrExposure.addEventListener('input', (e) => {
      lightingManager.hdrLight.exposure = parseFloat(e.target.value);
      hdrExposureValue.textContent = lightingManager.hdrLight.exposure.toFixed(1);
      onLightingChanged();
    });
    
    // HDR Load button
    hdrLoadBtn.addEventListener('click', loadSelectedHdr);
    
    // HDR file input (for custom uploads)
    hdrFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          // Clear gallery selection for custom uploads
          selectedHdrName = null;
          renderHdrGallery();
          
          hdrFilename.textContent = 'Loading...';
          hdrProgress.style.display = 'block';
          hdrProgressFill.style.width = '0%';
          hdrProgressText.textContent = 'Parsing HDR...';
          
          const buffer = await file.arrayBuffer();
          const hdrData = parseHDR(buffer);
          
          hdrProgressText.textContent = 'Pre-filtering for IBL...';
          hdrProgressFill.style.width = '10%';
          
          // Use prefiltered texture with mip levels for roughness-based IBL
          const result = createPrefilteredHDRTexture(gl, hdrData, (progress) => {
            const percent = Math.round(progress * 100);
            hdrProgressFill.style.width = `${percent}%`;
            hdrProgressText.textContent = progress < 1 ? `Pre-filtering... ${percent}%` : 'Complete!';
          });
          
          const { texture, mipLevels } = result;
          
          lightingManager.hdrLight.setTexture(texture, file.name);
          hdrFilename.textContent = file.name;
          
          // Hide progress after a short delay
          setTimeout(() => {
            hdrProgress.style.display = 'none';
          }, 500);
          
          // Notify viewport about the new texture with mip level count
          setHDRTexture(texture, mipLevels);
          setLightMode('hdr');
          updateLightModeDisplay('hdr');
        } catch (err) {
          console.error('Failed to load HDR:', err);
          hdrFilename.textContent = 'Error loading HDR';
          hdrProgress.style.display = 'none';
        }
      }
    });
    
    // Wind enabled
    windEnabled.addEventListener('change', (e) => {
      windManager.enabled = e.target.checked;
      updateWindEnabledIndicator();
      onWindChanged();
    });
    
    // Wind direction
    windDirection.addEventListener('input', (e) => {
      windManager.direction = parseFloat(e.target.value);
      windDirectionValue.textContent = `${windManager.direction}°`;
      updateWindDirectionArrow();
      onWindChanged();
    });
    
    // Wind strength
    windStrength.addEventListener('input', (e) => {
      windManager.strength = parseFloat(e.target.value);
      windStrengthValue.textContent = windManager.strength.toFixed(1);
      onWindChanged();
    });
    
    // Wind turbulence
    windTurbulence.addEventListener('input', (e) => {
      windManager.turbulence = parseFloat(e.target.value);
      windTurbulenceValue.textContent = windManager.turbulence.toFixed(1);
      onWindChanged();
    });
    
    // Wind gust strength
    windGustStrength.addEventListener('input', (e) => {
      windManager.gustStrength = parseFloat(e.target.value);
      windGustStrengthValue.textContent = windManager.gustStrength.toFixed(1);
      onWindChanged();
    });
    
    // Wind debug
    windDebug.addEventListener('change', (e) => {
      windManager.debug = parseInt(e.target.value, 10);
      onWindChanged();
    });
    
    // Load HDR manifest on init
    loadHdrManifest();
  }
  
  /**
   * Triggers the HDR file picker
   */
  function openHDRFilePicker() {
    hdrFile.click();
  }
  
  /**
   * Sets the displayed HDR filename
   */
  function setHDRFilename(filename) {
    hdrFilename.textContent = filename;
  }
  
  /**
   * Cleanup
   */
  function destroy() {
    panelElement.innerHTML = '';
  }
  
  // Initialize
  setup();
  update();
  
  return {
    update,
    destroy,
    updateLightModeDisplay,
    openHDRFilePicker,
    setHDRFilename,
  };
}
