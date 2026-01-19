/**
 * Material Panel - PBR material controls for primitives
 * Shows metallic/roughness sliders and albedo color picker
 */

/**
 * Create the material panel
 * @param {HTMLElement} container - Parent element to render into
 * @param {object} context - Panel context with callbacks
 */
export function createMaterialPanel(container, context) {
  const {
    getSelectedObjects,
    getObjectMaterial,
    setObjectMaterial,
    onMaterialChange,
  } = context;
  
  // Create panel structure
  const panel = document.createElement('div');
  panel.className = 'material-panel';
  panel.innerHTML = `
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
          <input type="range" class="metallic-slider" min="0" max="1" step="0.01" value="0">
        </div>
        <div class="control-group">
          <label>Roughness <span class="value-display roughness-value">0.5</span></label>
          <input type="range" class="roughness-slider" min="0.04" max="1" step="0.01" value="0.5">
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
  
  container.appendChild(panel);
  
  // Get elements
  const noSelection = panel.querySelector('.no-selection');
  const materialControls = panel.querySelector('.material-controls');
  const glbMaterialInfo = panel.querySelector('.glb-material-info');
  
  const albedoInput = panel.querySelector('.albedo-color');
  const colorHex = panel.querySelector('.color-hex');
  const metallicSlider = panel.querySelector('.metallic-slider');
  const metallicValue = panel.querySelector('.metallic-value');
  const roughnessSlider = panel.querySelector('.roughness-slider');
  const roughnessValue = panel.querySelector('.roughness-value');
  const presetButtons = panel.querySelectorAll('.preset-btn');
  const glbProps = panel.querySelector('.glb-props');
  
  // Material presets
  const presets = {
    plastic: { albedo: [0.8, 0.2, 0.2], metallic: 0.0, roughness: 0.4 },
    metal: { albedo: [0.9, 0.9, 0.9], metallic: 1.0, roughness: 0.3 },
    gold: { albedo: [1.0, 0.84, 0.0], metallic: 1.0, roughness: 0.2 },
    ceramic: { albedo: [0.95, 0.95, 0.92], metallic: 0.0, roughness: 0.1 },
  };
  
  // Helper: RGB array to hex
  function rgbToHex(rgb) {
    const r = Math.round(rgb[0] * 255);
    const g = Math.round(rgb[1] * 255);
    const b = Math.round(rgb[2] * 255);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  
  // Helper: hex to RGB array
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [0.75, 0.75, 0.75];
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255,
    ];
  }
  
  // Current state
  let currentObjectId = null;
  let isPrimitive = false;
  
  // Event handlers
  function handleAlbedoChange() {
    const hex = albedoInput.value;
    colorHex.textContent = hex;
    
    if (currentObjectId && isPrimitive) {
      const albedo = hexToRgb(hex);
      setObjectMaterial(currentObjectId, { albedo });
      onMaterialChange?.();
    }
  }
  
  function handleMetallicChange() {
    const value = parseFloat(metallicSlider.value);
    metallicValue.textContent = value.toFixed(2);
    
    if (currentObjectId && isPrimitive) {
      setObjectMaterial(currentObjectId, { metallic: value });
      onMaterialChange?.();
    }
  }
  
  function handleRoughnessChange() {
    const value = parseFloat(roughnessSlider.value);
    roughnessValue.textContent = value.toFixed(2);
    
    if (currentObjectId && isPrimitive) {
      setObjectMaterial(currentObjectId, { roughness: value });
      onMaterialChange?.();
    }
  }
  
  function handlePreset(e) {
    const presetName = e.target.dataset.preset;
    const preset = presets[presetName];
    if (!preset || !currentObjectId || !isPrimitive) return;
    
    // Update UI
    albedoInput.value = rgbToHex(preset.albedo);
    colorHex.textContent = albedoInput.value;
    metallicSlider.value = preset.metallic;
    metallicValue.textContent = preset.metallic.toFixed(2);
    roughnessSlider.value = preset.roughness;
    roughnessValue.textContent = preset.roughness.toFixed(2);
    
    // Apply material
    setObjectMaterial(currentObjectId, preset);
    onMaterialChange?.();
  }
  
  // Bind events
  albedoInput.addEventListener('input', handleAlbedoChange);
  metallicSlider.addEventListener('input', handleMetallicChange);
  roughnessSlider.addEventListener('input', handleRoughnessChange);
  presetButtons.forEach(btn => btn.addEventListener('click', handlePreset));
  
  // Update panel based on selection
  function update() {
    const selected = getSelectedObjects();
    
    if (selected.length === 0) {
      noSelection.style.display = 'block';
      materialControls.style.display = 'none';
      glbMaterialInfo.style.display = 'none';
      currentObjectId = null;
      isPrimitive = false;
      return;
    }
    
    // Use first selected object
    const obj = selected[0];
    currentObjectId = obj.id;
    isPrimitive = obj.type === 'primitive';
    
    if (isPrimitive) {
      // Show editable controls
      noSelection.style.display = 'none';
      materialControls.style.display = 'block';
      glbMaterialInfo.style.display = 'none';
      
      // Get current material from renderer
      const material = getObjectMaterial(obj.id);
      if (material) {
        albedoInput.value = rgbToHex(material.albedo || [0.75, 0.75, 0.75]);
        colorHex.textContent = albedoInput.value;
        metallicSlider.value = material.metallic ?? 0;
        metallicValue.textContent = (material.metallic ?? 0).toFixed(2);
        roughnessSlider.value = material.roughness ?? 0.5;
        roughnessValue.textContent = (material.roughness ?? 0.5).toFixed(2);
      }
    } else {
      // GLB model - show read-only info
      noSelection.style.display = 'none';
      materialControls.style.display = 'none';
      glbMaterialInfo.style.display = 'block';
      
      // Show material info from GLB
      const material = getObjectMaterial(obj.id);
      if (material) {
        glbProps.innerHTML = `
          <div class="glb-prop">Metallic: ${(material.metallic ?? 1).toFixed(2)}</div>
          <div class="glb-prop">Roughness: ${(material.roughness ?? 1).toFixed(2)}</div>
        `;
      } else {
        glbProps.innerHTML = '<div class="glb-prop">No PBR data</div>';
      }
    }
  }
  
  // Cleanup
  function destroy() {
    albedoInput.removeEventListener('input', handleAlbedoChange);
    metallicSlider.removeEventListener('input', handleMetallicChange);
    roughnessSlider.removeEventListener('input', handleRoughnessChange);
    presetButtons.forEach(btn => btn.removeEventListener('click', handlePreset));
    panel.remove();
  }
  
  return { update, destroy };
}
