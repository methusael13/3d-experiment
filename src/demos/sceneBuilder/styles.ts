/**
 * Scene Builder CSS styles
 */
export const sceneBuilderStyles = `
  .scene-builder-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  
  .scene-builder-container.expanded {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9999;
    background: #1a1a1a;
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
  
  .scene-builder-sidebar-right {
    width: 240px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  
  .sidebar-section {
    background: #2a2a2a;
    border-radius: 6px;
    padding: 10px 12px;
  }
  
  .sidebar-section h3 {
    font-size: 11px;
    color: #888;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
  }
  
  .sidebar-section h3::after {
    content: '▼';
    font-size: 8px;
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
    padding: 5px 8px;
    background: #333;
    margin-bottom: 2px;
    border-radius: 3px;
    cursor: pointer;
    font-family: monospace;
    font-size: 11px;
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
    padding: 6px 12px;
    background: #ff6666;
    color: #000;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-weight: bold;
    font-size: 11px;
  }
  
  .primary-btn:hover {
    background: #ff8888;
  }
  
  .secondary-btn {
    padding: 6px 12px;
    background: #333;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  
  .secondary-btn:hover {
    background: #444;
    color: #f0f0f0;
    border-color: #666;
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
    margin-bottom: 6px;
  }
  
  .transform-group label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: #888;
    margin-bottom: 2px;
  }
  
  /* Compact slider layout: label and value on same line */
  .transform-group.compact-slider {
    margin-bottom: 5px;
  }
  
  .transform-group.compact-slider .slider-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1px;
  }
  
  .transform-group.compact-slider .slider-header label {
    margin-bottom: 0;
    font-size: 10px;
  }
  
  .transform-group.compact-slider .slider-value {
    font-size: 10px;
    color: #aaa;
    min-width: 30px;
    text-align: right;
  }
  
  .transform-group.compact-slider .slider-input {
    margin: 0;
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
    padding: 4px 6px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #f0f0f0;
    font-family: monospace;
    font-size: 10px;
    width: 50px;
  }
  
  .vector-inputs input:focus {
    outline: none;
    border-color: #ff6666;
  }
  
  .name-input {
    width: 100%;
    padding: 5px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #f0f0f0;
    font-family: monospace;
    font-size: 11px;
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
    padding: 6px 0;
    background: #333;
    color: #888;
    border: none;
    cursor: pointer;
    font-weight: bold;
    font-size: 11px;
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
  
  .gizmo-separator {
    color: #555;
    padding: 0 4px;
    align-self: center;
    font-size: 14px;
  }
  
  .gizmo-btn.orientation-btn {
    background: #2a2a2a;
  }
  
  .gizmo-btn.orientation-btn:hover {
    background: #3a3a3a;
  }
  
  .gizmo-btn.orientation-btn.active {
    background: #555;
    color: #fff;
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
    margin: 2px 0;
    accent-color: #ff6666;
    height: 12px;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  
  .slider-input::-webkit-slider-runnable-track {
    height: 4px;
    background: #444;
    border-radius: 2px;
  }
  
  .slider-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #ff6666;
    cursor: pointer;
    margin-top: -3px;
  }
  
  .slider-input::-moz-range-track {
    height: 4px;
    background: #444;
    border-radius: 2px;
  }
  
  .slider-input::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #ff6666;
    cursor: pointer;
    border: none;
  }
  
  .slider-value {
    font-size: 10px;
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
    gap: 6px;
    cursor: pointer;
    margin-bottom: 8px;
    font-size: 11px;
  }
  
  .checkbox-label input[type="checkbox"] {
    width: 12px;
    height: 12px;
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
  
  /* Environment Panel Tabs */
  .env-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 8px;
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid #555;
  }
  
  .env-tab {
    flex: 1;
    padding: 6px 0;
    background: #333;
    color: #888;
    border: none;
    cursor: pointer;
    font-size: 10px;
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: all 0.15s;
  }
  
  .env-tab:not(:last-child) {
    border-right: 1px solid #555;
  }
  
  .env-tab:hover {
    background: #444;
    color: #f0f0f0;
  }
  
  .env-tab.active {
    background: #ff6666;
    color: #000;
  }
  
  .env-tab-content {
    display: none;
    max-height: 350px;
    overflow-y: auto;
    padding-right: 4px;
  }
  
  .env-tab-content.active {
    display: block;
  }
  
  .env-tab-content::-webkit-scrollbar {
    width: 4px;
  }
  
  .env-tab-content::-webkit-scrollbar-track {
    background: #222;
    border-radius: 2px;
  }
  
  .env-tab-content::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 2px;
  }
  
  .env-tab-content::-webkit-scrollbar-thumb:hover {
    background: #666;
  }
  
  /* Wind Panel Styles */
  .wind-direction-indicator {
    width: 40px;
    height: 40px;
    border: 1px solid #555;
    border-radius: 50%;
    position: relative;
    margin: 4px auto;
    background: #222;
  }
  
  .wind-direction-arrow {
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
  
  .wind-direction-arrow::after {
    content: '';
    position: absolute;
    right: -2px;
    top: -3px;
    border: 4px solid transparent;
    border-left: 6px solid #ff6666;
  }
  
  .material-list {
    max-height: 100px;
    overflow-y: auto;
    background: #222;
    border-radius: 3px;
    padding: 2px;
  }
  
  .material-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
  }
  
  .material-item:hover {
    background: #333;
  }
  
  .material-item input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: #ff6666;
  }
  
  .material-color-swatch {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    border: 1px solid #555;
  }
  
  .material-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .wind-type-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    background: #444;
    color: #aaa;
  }
  
  .wind-type-badge.leaf {
    background: #2a5a2a;
    color: #8f8;
  }
  
  .wind-type-badge.branch {
    background: #5a4a2a;
    color: #da8;
  }
  
  .wind-enabled-indicator {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #444;
    margin-left: 8px;
  }
  
  .wind-enabled-indicator.active {
    background: #4f4;
    box-shadow: 0 0 4px #4f4;
  }
  
  /* Modifier Section Styles */
  .modifier-section {
    margin-bottom: 8px;
  }
  
  .modifier-settings {
    padding-left: 8px;
    border-left: 2px solid #444;
    margin-top: 4px;
    transition: opacity 0.2s;
  }
  
  .modifier-settings.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  
  .modifier-divider {
    height: 1px;
    background: #444;
    margin: 12px 0;
  }
  
  /* Material Panel Styles */
  .material-panel {
    background: #2a2a2a;
    border-radius: 6px;
    padding: 10px 12px;
  }
  
  .material-panel .panel-header {
    font-size: 11px;
    color: #888;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  
  .material-content .no-selection {
    color: #666;
    font-size: 11px;
    text-align: center;
    padding: 12px;
  }
  
  .material-controls .control-group {
    margin-bottom: 10px;
  }
  
  .material-controls .control-group label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: #aaa;
    margin-bottom: 4px;
  }
  
  .material-controls .value-display {
    color: #888;
    font-family: monospace;
    font-size: 10px;
  }
  
  .material-controls .color-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  
  .material-controls .albedo-color {
    width: 48px;
    height: 24px;
    border: 1px solid #555;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
    padding: 0;
  }
  
  .material-controls .color-hex {
    font-family: monospace;
    font-size: 10px;
    color: #888;
  }
  
  .material-controls .preset-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-top: 12px;
  }
  
  .material-controls .preset-btn {
    padding: 5px 8px;
    background: #333;
    border: 1px solid #555;
    border-radius: 3px;
    color: #aaa;
    cursor: pointer;
    font-size: 10px;
    transition: all 0.15s;
  }
  
  .material-controls .preset-btn:hover {
    background: #444;
    color: #fff;
    border-color: #666;
  }
  
  .glb-material-info {
    padding: 8px;
    background: #333;
    border-radius: 4px;
  }
  
  .glb-notice {
    font-size: 10px;
    color: #888;
    margin-bottom: 8px;
    font-style: italic;
  }
  
  .glb-prop {
    font-size: 10px;
    color: #aaa;
    padding: 2px 0;
    font-family: monospace;
  }
  
  /* Rendering Panel Styles */
  .panel-section {
    background: #2a2a2a;
    border-radius: 6px;
    padding: 10px 12px;
  }
  
  .panel-section .panel-header {
    font-size: 11px;
    color: #888;
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: bold;
  }
  
  .panel-group {
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #3a3a3a;
  }
  
  .panel-group:last-child {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  
  .panel-group-title {
    font-size: 10px;
    color: #aaa;
    margin-bottom: 6px;
    font-weight: bold;
  }
  
  .panel-group-disabled {
    opacity: 0.5;
  }
  
  .panel-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
    color: #ccc;
  }
  
  .panel-row:last-child {
    margin-bottom: 0;
  }
  
  .panel-row label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    flex: 1;
  }
  
  .panel-row select {
    background: #333;
    color: #f0f0f0;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 10px;
    cursor: pointer;
  }
  
  .panel-row select:hover {
    border-color: #666;
  }
  
  .panel-row input[type="range"] {
    flex: 1;
    height: 4px;
    accent-color: #ff6666;
  }
  
  .panel-row input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: #ff6666;
  }
  
  .panel-row span {
    min-width: 30px;
    text-align: right;
    font-family: monospace;
    font-size: 10px;
    color: #888;
  }
  
  .disabled-row {
    opacity: 0.5;
    pointer-events: none;
  }
`;

/**
 * Scene Builder HTML template
 * Panel content is injected by componentPanels modules
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
      <div class="menu-item" id="menu-scene">
        <button>Scene</button>
        <div class="menu-dropdown">
          <div class="submenu">
            <button>Add</button>
            <div class="submenu-dropdown">
              <div class="submenu">
                <button>Shapes</button>
                <div class="submenu-dropdown">
                  <button class="menu-action" id="menu-add-cube">Cube</button>
                  <button class="menu-action" id="menu-add-plane">Plane</button>
                  <button class="menu-action" id="menu-add-uvsphere">UV Sphere</button>
                </div>
              </div>
            </div>
          </div>
          <div class="menu-separator"></div>
          <button class="menu-action" id="menu-group">Group Selection <span style="float:right;color:#888">⌘G</span></button>
          <button class="menu-action" id="menu-ungroup">Ungroup <span style="float:right;color:#888">⌘⇧G</span></button>
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
              <div class="menu-separator"></div>
              <button class="menu-action" id="menu-toggle-grid">✓ Show Grid</button>
              <button class="menu-action" id="menu-toggle-axes">✓ Show Axes</button>
            </div>
          </div>
          <div class="menu-separator"></div>
          <button class="menu-action" id="menu-shader-editor">Shader Editor</button>
          <div class="menu-separator"></div>
          <button class="menu-action" id="menu-expand-view">Expand View</button>
        </div>
      </div>
      <div class="menu-item" id="menu-lighting">
        <button>Lighting</button>
        <div class="menu-dropdown">
          <button class="menu-action" id="menu-sun-mode">Sun Mode</button>
          <button class="menu-action" id="menu-hdr-mode">HDR Mode</button>
        </div>
      </div>
    </div>
    
    <div class="scene-builder-layout">
      <div class="scene-builder-sidebar">
        <!-- Objects Panel - populated by createObjectsPanel -->
        <div id="objects-panel-container"></div>
        
        <!-- Object Panel - populated by createObjectPanel -->
        <div id="object-panel-container"></div>
        
        <input type="file" id="scene-file" accept=".json" style="display: none;">
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
      
      <div class="scene-builder-sidebar-right">
        <!-- Environment Panel - populated by createEnvironmentPanel -->
        <div id="environment-panel-container"></div>
        
        <!-- Rendering Panel - populated by RenderingPanel -->
        <div id="rendering-panel-container"></div>
        
        <!-- Material Panel - populated by createMaterialPanel -->
        <div id="material-panel-container"></div>
      </div>
    </div>
  </div>
`;
