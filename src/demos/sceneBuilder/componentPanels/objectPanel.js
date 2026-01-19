/**
 * Object Panel
 * Displays transform controls and modifiers (wind, terrain blend) for selected objects
 */

// Panel-specific styles
const objectPanelStyles = `
  .object-panel .modifier-settings.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
`;

// Panel HTML template
const objectPanelTemplate = `
  <h3>Object</h3>
  <div class="section-content">
    <div class="env-tabs">
      <button class="env-tab active" data-tab="transform">Transform</button>
      <button class="env-tab" data-tab="modifiers">Modifiers</button>
    </div>
    
    <!-- Transform Tab Content -->
    <div id="obj-transform-tab" class="env-tab-content active">
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

/**
 * Creates the object panel
 * @param {HTMLElement} panelElement - The panel container element
 * @param {import('./panelContext').PanelContext} context - Panel context
 * @returns {Object} Panel interface with update and destroy methods
 */
export function createObjectPanel(panelElement, context) {
  const { scene, onGizmoModeChange, onTransformUpdate, getObjectWindSettings, getObjectTerrainBlend } = context;
  
  // Add panel-specific styles
  const styleEl = document.createElement('style');
  styleEl.textContent = objectPanelStyles;
  panelElement.appendChild(styleEl);
  
  // Set panel content
  panelElement.innerHTML = objectPanelTemplate;
  panelElement.classList.add('object-panel', 'sidebar-section');
  panelElement.id = 'object-panel';
  panelElement.style.display = 'none';
  
  // Cache DOM references - Transform tab
  const objectName = panelElement.querySelector('#object-name');
  const posX = panelElement.querySelector('#pos-x');
  const posY = panelElement.querySelector('#pos-y');
  const posZ = panelElement.querySelector('#pos-z');
  const rotX = panelElement.querySelector('#rot-x');
  const rotY = panelElement.querySelector('#rot-y');
  const rotZ = panelElement.querySelector('#rot-z');
  const scaleX = panelElement.querySelector('#scale-x');
  const scaleY = panelElement.querySelector('#scale-y');
  const scaleZ = panelElement.querySelector('#scale-z');
  
  // Cache DOM references - Modifiers tab
  const windEnabled = panelElement.querySelector('#object-wind-enabled');
  const windModifierSettings = panelElement.querySelector('#wind-modifier-settings');
  const windInfluence = panelElement.querySelector('#object-wind-influence');
  const windInfluenceValue = panelElement.querySelector('#object-wind-influence-value');
  const windStiffness = panelElement.querySelector('#object-wind-stiffness');
  const windStiffnessValue = panelElement.querySelector('#object-wind-stiffness-value');
  const windAnchor = panelElement.querySelector('#object-wind-anchor');
  const windAnchorValue = panelElement.querySelector('#object-wind-anchor-value');
  const leafMaterialList = panelElement.querySelector('#leaf-material-list');
  const branchMaterialList = panelElement.querySelector('#branch-material-list');
  
  const terrainBlendEnabled = panelElement.querySelector('#object-terrain-blend-enabled');
  const terrainBlendSettings = panelElement.querySelector('#terrain-blend-settings');
  const terrainBlendDistance = panelElement.querySelector('#terrain-blend-distance');
  const terrainBlendDistanceValue = panelElement.querySelector('#terrain-blend-distance-value');
  
  let currentGizmoMode = 'translate';
  
  /**
   * Updates the transform tab with current selection
   */
  function updateTransformTab() {
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount === 1) {
      const obj = scene.getFirstSelected();
      if (obj) {
        objectName.value = obj.name;
        objectName.disabled = false;
        posX.value = obj.position[0].toFixed(2);
        posY.value = obj.position[1].toFixed(2);
        posZ.value = obj.position[2].toFixed(2);
        rotX.value = obj.rotation[0].toFixed(1);
        rotY.value = obj.rotation[1].toFixed(1);
        rotZ.value = obj.rotation[2].toFixed(1);
        scaleX.value = obj.scale[0].toFixed(2);
        scaleY.value = obj.scale[1].toFixed(2);
        scaleZ.value = obj.scale[2].toFixed(2);
      }
    } else {
      const centroid = scene.getSelectionCentroid();
      objectName.value = `${selectionCount} objects`;
      objectName.disabled = true;
      posX.value = centroid[0].toFixed(2);
      posY.value = centroid[1].toFixed(2);
      posZ.value = centroid[2].toFixed(2);
      rotX.value = '-';
      rotY.value = '-';
      rotZ.value = '-';
      scaleX.value = '-';
      scaleY.value = '-';
      scaleZ.value = '-';
    }
  }
  
  /**
   * Updates the modifiers tab with current selection
   */
  function updateModifiersTab() {
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount !== 1) {
      windModifierSettings.classList.add('disabled');
      terrainBlendSettings.classList.add('disabled');
      return;
    }
    
    const obj = scene.getFirstSelected();
    if (!obj) {
      windModifierSettings.classList.add('disabled');
      terrainBlendSettings.classList.add('disabled');
      return;
    }
    
    // Wind settings
    const windSettings = getObjectWindSettings(obj.id);
    windEnabled.checked = windSettings.enabled;
    windInfluence.value = windSettings.influence;
    windInfluenceValue.textContent = windSettings.influence.toFixed(1);
    windStiffness.value = windSettings.stiffness;
    windStiffnessValue.textContent = windSettings.stiffness.toFixed(1);
    windAnchor.value = windSettings.anchorHeight;
    windAnchorValue.textContent = windSettings.anchorHeight.toFixed(1);
    windModifierSettings.classList.toggle('disabled', !windSettings.enabled);
    
    // Update material lists
    updateMaterialLists(obj, windSettings);
    
    // Terrain blend settings
    const terrainSettings = getObjectTerrainBlend(obj.id);
    terrainBlendEnabled.checked = terrainSettings.enabled;
    terrainBlendDistance.value = terrainSettings.blendDistance;
    terrainBlendDistanceValue.textContent = terrainSettings.blendDistance.toFixed(1);
    terrainBlendSettings.classList.toggle('disabled', !terrainSettings.enabled);
  }
  
  /**
   * Updates material lists for wind settings
   */
  function updateMaterialLists(obj, settings) {
    if (!obj.model || !obj.model.materials) {
      leafMaterialList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      branchMaterialList.innerHTML = '<div style="color: #666; font-size: 11px;">No materials found</div>';
      return;
    }
    
    const materials = obj.model.materials;
    
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
    leafMaterialList.innerHTML = leafHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
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
    branchMaterialList.innerHTML = branchHtml || '<div style="color: #666; font-size: 11px;">No materials</div>';
    
    // Attach click handlers for leaf materials
    leafMaterialList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(item.dataset.materialIdx, 10);
        if (checkbox.checked) {
          settings.leafMaterialIndices.add(idx);
          settings.branchMaterialIndices?.delete(idx);
        } else {
          settings.leafMaterialIndices.delete(idx);
        }
        updateMaterialLists(obj, settings);
      });
    });
    
    // Attach click handlers for branch materials
    branchMaterialList.querySelectorAll('.material-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
        
        const idx = parseInt(item.dataset.materialIdx, 10);
        if (!settings.branchMaterialIndices) settings.branchMaterialIndices = new Set();
        
        if (checkbox.checked) {
          settings.branchMaterialIndices.add(idx);
          settings.leafMaterialIndices.delete(idx);
        } else {
          settings.branchMaterialIndices.delete(idx);
        }
        updateMaterialLists(obj, settings);
      });
    });
  }
  
  /**
   * Sets the active gizmo mode
   */
  function setGizmoMode(mode) {
    currentGizmoMode = mode;
    panelElement.querySelectorAll('.gizmo-btn').forEach(btn => btn.classList.remove('active'));
    panelElement.querySelector(`#gizmo-${mode}`).classList.add('active');
    onGizmoModeChange(mode);
  }
  
  /**
   * Updates the panel visibility and content
   */
  function update() {
    const selectionCount = scene.getSelectionCount();
    
    if (selectionCount === 0) {
      panelElement.style.display = 'none';
      return;
    }
    
    panelElement.style.display = 'block';
    updateTransformTab();
    updateModifiersTab();
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
        panelElement.querySelector(`#obj-${tabName}-tab`).classList.add('active');
      });
    });
    
    // Gizmo mode buttons
    panelElement.querySelector('#gizmo-translate').addEventListener('click', () => setGizmoMode('translate'));
    panelElement.querySelector('#gizmo-rotate').addEventListener('click', () => setGizmoMode('rotate'));
    panelElement.querySelector('#gizmo-scale').addEventListener('click', () => setGizmoMode('scale'));
    
    // Object name
    objectName.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj && scene.getSelectionCount() === 1) {
        obj.name = e.target.value || 'Unnamed';
        context.onObjectListUpdate();
      }
    });
    
    // Transform inputs
    ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-x', 'scale-y', 'scale-z'].forEach(inputId => {
      panelElement.querySelector(`#${inputId}`).addEventListener('input', (e) => {
        if (scene.getSelectionCount() !== 1) return;
        const obj = scene.getFirstSelected();
        if (!obj) return;
        
        const value = parseFloat(e.target.value) || 0;
        const [type, axis] = inputId.split('-');
        const axisIndex = { x: 0, y: 1, z: 2 }[axis];
        
        if (type === 'pos') obj.position[axisIndex] = value;
        else if (type === 'rot') obj.rotation[axisIndex] = value;
        else if (type === 'scale') obj.scale[axisIndex] = Math.max(0.01, value);
        
        scene.updateObjectTransform(obj.id);
        onTransformUpdate();
      });
    });
    
    // Reset buttons
    panelElement.querySelector('#reset-position').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.position = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      update();
      onTransformUpdate();
    });
    
    panelElement.querySelector('#reset-rotation').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.rotation = [0, 0, 0];
        scene.updateObjectTransform(obj.id);
      }
      update();
      onTransformUpdate();
    });
    
    panelElement.querySelector('#reset-scale').addEventListener('click', () => {
      for (const obj of scene.getSelectedObjects()) {
        obj.scale = [1, 1, 1];
        scene.updateObjectTransform(obj.id);
      }
      update();
      onTransformUpdate();
    });
    
    // Delete button
    panelElement.querySelector('#delete-object').addEventListener('click', () => {
      const ids = [...scene.getSelectedIds()];
      for (const id of ids) {
        scene.removeObject(id);
      }
      scene.clearSelection();
    });
    
    // Wind enabled checkbox
    windEnabled.addEventListener('change', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.enabled = e.target.checked;
        windModifierSettings.classList.toggle('disabled', !settings.enabled);
      }
    });
    
    // Wind sliders
    windInfluence.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.influence = parseFloat(e.target.value);
        windInfluenceValue.textContent = settings.influence.toFixed(1);
      }
    });
    
    windStiffness.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.stiffness = parseFloat(e.target.value);
        windStiffnessValue.textContent = settings.stiffness.toFixed(1);
      }
    });
    
    windAnchor.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectWindSettings(obj.id);
        settings.anchorHeight = parseFloat(e.target.value);
        windAnchorValue.textContent = settings.anchorHeight.toFixed(1);
      }
    });
    
    // Terrain blend enabled checkbox
    terrainBlendEnabled.addEventListener('change', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectTerrainBlend(obj.id);
        settings.enabled = e.target.checked;
        terrainBlendSettings.classList.toggle('disabled', !settings.enabled);
      }
    });
    
    // Terrain blend distance slider
    terrainBlendDistance.addEventListener('input', (e) => {
      const obj = scene.getFirstSelected();
      if (obj) {
        const settings = getObjectTerrainBlend(obj.id);
        settings.blendDistance = parseFloat(e.target.value);
        terrainBlendDistanceValue.textContent = settings.blendDistance.toFixed(1);
      }
    });
  }
  
  /**
   * Cleanup
   */
  function destroy() {
    panelElement.innerHTML = '';
  }
  
  // Initialize
  setup();
  
  return {
    update,
    destroy,
    setGizmoMode,
    getGizmoMode: () => currentGizmoMode,
  };
}
