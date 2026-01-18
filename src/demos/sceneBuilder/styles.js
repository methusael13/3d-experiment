/**
 * Scene Builder CSS styles
 */
export const sceneBuilderStyles = `
  .scene-builder-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  
  /* Menu Bar */
  .menu-bar {
    display: flex;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    margin: 0 16px;
    gap: 0;
  }
  
  .menu-item {
    position: relative;
  }
  
  .menu-item > button {
    padding: 8px 16px;
    background: transparent;
    color: #ccc;
    border: none;
    cursor: pointer;
    font-size: 13px;
  }
  
  .menu-item > button:hover,
  .menu-item.open > button {
    background: #333;
    color: #fff;
  }
  
  .menu-dropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    min-width: 180px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    z-index: 1000;
  }
  
  .menu-item.open .menu-dropdown {
    display: block;
  }
  
  .submenu {
    position: relative;
  }
  
  .submenu > button {
    width: 100%;
    padding: 8px 16px;
    background: transparent;
    color: #ccc;
    border: none;
    cursor: pointer;
    font-size: 13px;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .submenu > button::after {
    content: '▶';
    font-size: 10px;
  }
  
  .submenu > button:hover {
    background: #444;
    color: #fff;
  }
  
  .submenu-dropdown {
    display: none;
    position: absolute;
    left: 100%;
    top: 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    min-width: 160px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  }
  
  .submenu:hover .submenu-dropdown {
    display: block;
  }
  
  .menu-action {
    width: 100%;
    padding: 8px 16px;
    background: transparent;
    color: #ccc;
    border: none;
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }
  
  .menu-action:hover {
    background: #ff6666;
    color: #000;
  }
  
  .menu-separator {
    height: 1px;
    background: #444;
    margin: 4px 8px;
  }
  
  .scene-builder-layout {
    display: flex;
    gap: 16px;
    width: 100%;
    flex: 1;
    padding: 16px;
  }
  
  .scene-builder-sidebar {
    width: 280px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  .sidebar-section {
    background: #2a2a2a;
    border-radius: 8px;
    padding: 16px;
  }
  
  .sidebar-section h3 {
    font-size: 14px;
    color: #888;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
  }
  
  .sidebar-section h3::after {
    content: '▼';
    font-size: 10px;
    transition: transform 0.2s;
  }
  
  .sidebar-section.collapsed h3::after {
    transform: rotate(-90deg);
  }
  
  .sidebar-section.collapsed .section-content {
    display: none;
  }
  
  .section-content {
    display: block;
  }
  
  .object-list {
    list-style: none;
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 12px;
  }
  
  .object-list li {
    padding: 8px 12px;
    background: #333;
    margin-bottom: 4px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 13px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .object-list li:hover {
    background: #444;
  }
  
  .object-list li.selected {
    background: #ff6666;
    color: #000;
  }
  
  /* Group styling in object list */
  .object-list .group-header {
    background: #3a3a3a;
    font-weight: bold;
    border-left: 3px solid #ff9966;
  }
  
  .object-list .group-header:hover {
    background: #454545;
  }
  
  .object-list .group-header.selected {
    background: #ff6666;
    color: #000;
    border-left-color: #cc4444;
  }
  
  .object-list .group-toggle {
    cursor: pointer;
    padding: 0 4px;
    font-size: 10px;
    color: #888;
    user-select: none;
  }
  
  .object-list .group-header:hover .group-toggle,
  .object-list .group-header.selected .group-toggle {
    color: inherit;
  }
  
  .object-list .group-name {
    flex: 1;
    margin-left: 4px;
  }
  
  .object-list .group-count {
    font-size: 11px;
    color: #888;
    font-weight: normal;
  }
  
  .object-list .group-header.selected .group-count {
    color: #333;
  }
  
  .object-list .group-child {
    background: #2a2a2a;
    padding-left: 8px;
    border-left: 3px solid transparent;
  }
  
  .object-list .group-child:hover {
    background: #383838;
  }
  
  .object-list .group-child.selected {
    background: #ff6666;
    color: #000;
  }
  
  .object-list .child-indent {
    color: #555;
    font-size: 11px;
    margin-right: 4px;
  }
  
  .object-list .group-child.selected .child-indent {
    color: #333;
  }
  
  .import-controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .primary-btn {
    padding: 10px 16px;
    background: #ff6666;
    color: #000;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
  }
  
  .primary-btn:hover {
    background: #ff8888;
  }
  
  .danger-btn {
    padding: 8px 12px;
    background: transparent;
    color: #ff4444;
    border: 1px solid #ff4444;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 12px;
  }
  
  .danger-btn:hover {
    background: #ff4444;
    color: #000;
  }
  
  .transform-group {
    margin-bottom: 12px;
  }
  
  .transform-group label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #888;
    margin-bottom: 4px;
  }
  
  .reset-btn {
    padding: 2px 6px;
    background: transparent;
    color: #666;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
  }
  
  .reset-btn:hover {
    background: #444;
    color: #f0f0f0;
    border-color: #888;
  }
  
  .vector-inputs {
    display: flex;
    gap: 4px;
  }
  
  .vector-inputs input {
    flex: 1;
    padding: 6px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 4px;
    color: #f0f0f0;
    font-family: monospace;
    font-size: 12px;
    width: 60px;
  }
  
  .vector-inputs input:focus {
    outline: none;
    border-color: #ff6666;
  }
  
  .name-input {
    width: 100%;
    padding: 8px 10px;
    background: #333;
    border: 1px solid #555;
    border-radius: 4px;
    color: #f0f0f0;
    font-family: monospace;
    font-size: 13px;
  }
  
  .name-input:focus {
    outline: none;
    border-color: #ff6666;
  }
  
  .gizmo-mode-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #555;
  }
  
  .gizmo-btn {
    flex: 1;
    padding: 10px 0;
    background: #333;
    color: #888;
    border: none;
    cursor: pointer;
    font-weight: bold;
    font-size: 14px;
    transition: all 0.15s;
  }
  
  .gizmo-btn:not(:last-child) {
    border-right: 1px solid #555;
  }
  
  .gizmo-btn:hover {
    background: #444;
    color: #f0f0f0;
  }
  
  .gizmo-btn.active {
    background: #ff6666;
    color: #000;
  }
  
  .scene-controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .scene-controls button {
    padding: 8px 12px;
    background: #333;
    color: #f0f0f0;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .scene-controls button:hover {
    background: #444;
    border-color: #888;
  }
  
  .scene-builder-viewport {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  
  .scene-builder-viewport canvas {
    background: #0d0d0d;
    border-radius: 8px;
    display: block;
  }
  
  .viewport-toolbar {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 10;
  }
  
  .view-mode-toggle {
    display: flex;
    gap: 0;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #555;
    background: rgba(0, 0, 0, 0.6);
  }
  
  .view-mode-btn {
    padding: 6px 12px;
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: bold;
  }
  
  .view-mode-btn:not(:last-child) {
    border-right: 1px solid #555;
  }
  
  .view-mode-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #f0f0f0;
  }
  
  .view-mode-btn.active {
    background: #ff6666;
    color: #000;
  }
  
  .viewport-controls {
    margin-top: 8px;
    font-size: 12px;
    color: #666;
    text-align: center;
  }
  
  #preset-models {
    padding: 8px 12px;
    background: #333;
    color: #f0f0f0;
    border: 1px solid #555;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .light-mode-indicator {
    margin-bottom: 12px;
    padding: 8px;
    background: #333;
    border-radius: 4px;
    text-align: center;
    font-size: 13px;
    color: #ff9966;
  }
  
  .slider-input {
    width: 100%;
    margin: 4px 0;
    accent-color: #ff6666;
  }
  
  .slider-value {
    font-size: 12px;
    color: #888;
    font-family: monospace;
  }
  
  .hdr-filename {
    margin-top: 8px;
    padding: 8px;
    background: #333;
    border-radius: 4px;
    font-size: 12px;
    color: #888;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  
  .shadow-controls {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #444;
  }
  
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-bottom: 12px;
  }
  
  .checkbox-label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: #ff6666;
  }
  
  .shadow-quality-btns {
    display: flex;
    gap: 0;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #555;
  }
  
  .quality-btn {
    flex: 1;
    padding: 6px 8px;
    background: #333;
    color: #888;
    border: none;
    cursor: pointer;
    font-size: 12px;
  }
  
  .quality-btn:not(:last-child) {
    border-right: 1px solid #555;
  }
  
  .quality-btn:hover {
    background: #444;
    color: #f0f0f0;
  }
  
  .quality-btn.active {
    background: #ff6666;
    color: #000;
  }
`;

/**
 * Scene Builder HTML template
 */
export const sceneBuilderTemplate = `
  <div class="scene-builder-container">
    <div class="menu-bar">
      <div class="menu-item" id="menu-file">
        <button>File</button>
        <div class="menu-dropdown">
          <button class="menu-action" id="menu-load-scene">Load Scene</button>
          <button class="menu-action" id="menu-save-scene">Save Scene</button>
        </div>
      </div>
      <div class="menu-item" id="menu-view">
        <button>View</button>
        <div class="menu-dropdown">
          <div class="submenu">
            <button>Origin</button>
            <div class="submenu-dropdown">
              <button class="menu-action" id="menu-reset-origin">Reset Origin</button>
            </div>
          </div>
          <div class="submenu">
            <button>Viewport</button>
            <div class="submenu-dropdown">
              <button class="menu-action" id="menu-wireframe-view">Wireframe View</button>
              <button class="menu-action" id="menu-solid-view">Solid View</button>
            </div>
          </div>
          <div class="menu-separator"></div>
          <button class="menu-action" id="menu-shader-editor">Shader Editor</button>
        </div>
      </div>
      <div class="menu-item" id="menu-lighting">
        <button>Lighting</button>
        <div class="menu-dropdown">
          <button class="menu-action" id="menu-sun-mode">Sun Mode</button>
          <button class="menu-action" id="menu-hdr-mode">HDR Mode</button>
          <div class="menu-separator"></div>
          <button class="menu-action" id="menu-load-hdr">Load HDR...</button>
        </div>
      </div>
    </div>
    
    <div class="scene-builder-layout">
    <div class="scene-builder-sidebar">
      <div class="sidebar-section" id="objects-panel">
        <h3>Scene Objects</h3>
        <div class="section-content">
          <ul id="object-list" class="object-list"></ul>
          <div class="import-controls">
            <input type="file" id="model-file" accept=".glb,.gltf" style="display: none;">
            <button id="import-btn" class="primary-btn">Import Model</button>
            <select id="preset-models">
              <option value="">Add Preset...</option>
              <option value="duck.glb">Duck</option>
            </select>
          </div>
        </div>
      </div>
      
      <div class="sidebar-section" id="transform-panel" style="display: none;">
        <h3>Transform</h3>
        <div class="section-content">
          <div class="gizmo-mode-toggle">
          <button id="gizmo-translate" class="gizmo-btn active" title="Translate (T)">T</button>
          <button id="gizmo-rotate" class="gizmo-btn" title="Rotate (R)">R</button>
          <button id="gizmo-scale" class="gizmo-btn" title="Scale (S)">S</button>
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
      </div>
      
      <input type="file" id="scene-file" accept=".json" style="display: none;">
      <input type="file" id="hdr-file" accept=".hdr" style="display: none;">
      
      <div class="sidebar-section" id="lighting-panel">
        <h3>Lighting</h3>
        <div class="section-content">
          <div class="light-mode-indicator">
          <span id="current-light-mode">Sun Mode</span>
        </div>
        <div id="sun-controls">
          <div class="transform-group">
            <label>Azimuth (°)</label>
            <input type="range" id="sun-azimuth" min="0" max="360" value="45" class="slider-input">
            <span id="sun-azimuth-value" class="slider-value">45°</span>
          </div>
          <div class="transform-group">
            <label>Elevation (°)</label>
            <input type="range" id="sun-elevation" min="-90" max="90" value="45" class="slider-input">
            <span id="sun-elevation-value" class="slider-value">45°</span>
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
              <select id="shadow-debug" style="width: 100%; padding: 6px; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 4px;">
                <option value="0">Off (Normal)</option>
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
            <div class="transform-group">
              <label>HDR Exposure</label>
              <input type="range" id="hdr-exposure" min="0.1" max="5" step="0.1" value="1" class="slider-input">
              <span id="hdr-exposure-value" class="slider-value">1.0</span>
            </div>
            <div id="hdr-filename" class="hdr-filename">No HDR loaded</div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="scene-builder-viewport">
      <div class="viewport-toolbar">
        <div class="view-mode-toggle">
          <button id="viewport-solid-btn" class="view-mode-btn active" title="Solid View">Solid</button>
          <button id="viewport-wireframe-btn" class="view-mode-btn" title="Wireframe View">Wire</button>
        </div>
      </div>
      <canvas id="canvas"></canvas>
      <div class="viewport-controls">
        <span>Left-drag: Orbit | Right-drag: Pan | Scroll: Zoom | Double-click: Set Origin</span>
      </div>
    </div>
  </div>
  </div>
`;
