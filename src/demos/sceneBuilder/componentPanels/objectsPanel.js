/**
 * Objects Panel
 * Displays scene objects list and import controls
 */

import { importModelFile } from '../sceneSerializer';

// Panel-specific styles
const objectsPanelStyles = `
  .objects-panel .object-list {
    list-style: none;
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 12px;
  }
`;

// Panel HTML template
const objectsPanelTemplate = `
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
`;

/**
 * Creates the objects panel
 * @param {HTMLElement} panelElement - The panel container element
 * @param {import('./panelContext').PanelContext} context - Panel context
 * @returns {Object} Panel interface with update and destroy methods
 */
export function createObjectsPanel(panelElement, context) {
  const { scene, container } = context;
  
  // Add panel-specific styles
  const styleEl = document.createElement('style');
  styleEl.textContent = objectsPanelStyles;
  panelElement.appendChild(styleEl);
  
  // Set panel content
  panelElement.innerHTML = objectsPanelTemplate;
  panelElement.classList.add('objects-panel', 'sidebar-section');
  panelElement.id = 'objects-panel';
  
  // Cache DOM references
  const objectList = panelElement.querySelector('#object-list');
  const importBtn = panelElement.querySelector('#import-btn');
  const modelFile = panelElement.querySelector('#model-file');
  const presetModels = panelElement.querySelector('#preset-models');
  
  /**
   * Updates the object list UI
   */
  function update() {
    const allObjects = scene.getAllObjects();
    const groups = scene.getAllGroups();
    
    // Build hierarchical list
    const ungrouped = allObjects.filter(o => !o.groupId);
    const groupedByGroupId = new Map();
    
    for (const obj of allObjects) {
      if (obj.groupId) {
        if (!groupedByGroupId.has(obj.groupId)) {
          groupedByGroupId.set(obj.groupId, []);
        }
        groupedByGroupId.get(obj.groupId).push(obj);
      }
    }
    
    let html = '';
    
    // Render groups first
    for (const [groupId, groupObjects] of groupedByGroupId) {
      const group = groups.get(groupId);
      if (!group) continue;
      
      const isExpanded = scene.isGroupExpanded(groupId);
      const allSelected = groupObjects.every(o => scene.isSelected(o.id));
      
      html += `
        <li class="group-header ${allSelected ? 'selected' : ''}" data-group-id="${groupId}">
          <span class="group-toggle">${isExpanded ? '▼' : '▶'}</span>
          <span class="group-name">${group.name}</span>
          <span class="group-count">(${groupObjects.length})</span>
        </li>
      `;
      
      if (isExpanded) {
        for (const obj of groupObjects) {
          html += `
            <li class="group-child ${scene.isSelected(obj.id) ? 'selected' : ''}" data-id="${obj.id}" data-in-expanded-group="true">
              <span class="child-indent">└─</span>
              <span>${obj.name}</span>
            </li>
          `;
        }
      }
    }
    
    // Render ungrouped objects
    for (const obj of ungrouped) {
      html += `
        <li data-id="${obj.id}" class="${scene.isSelected(obj.id) ? 'selected' : ''}">
          <span>${obj.name}</span>
        </li>
      `;
    }
    
    objectList.innerHTML = html;
    
    // Attach event handlers for object items
    objectList.querySelectorAll('li[data-id]').forEach(li => {
      li.addEventListener('click', (e) => {
        const inExpandedGroup = li.dataset.inExpandedGroup === 'true';
        scene.select(li.dataset.id, { additive: e.shiftKey, fromExpandedGroup: inExpandedGroup });
      });
    });
    
    // Attach event handlers for group headers
    objectList.querySelectorAll('.group-header').forEach(li => {
      li.addEventListener('click', (e) => {
        const groupId = li.dataset.groupId;
        if (e.target.classList.contains('group-toggle')) {
          scene.toggleGroupExpanded(groupId);
          update(); // Re-render
        } else {
          // Select all group members
          const group = scene.getGroup(groupId);
          if (group) {
            if (!e.shiftKey) scene.clearSelection();
            scene.selectAll([...group.childIds]);
          }
        }
      });
    });
  }
  
  /**
   * Setup event listeners
   */
  function setup() {
    // Import button
    importBtn.addEventListener('click', () => modelFile.click());
    
    // Model file input
    modelFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        const { modelPath, displayName } = await importModelFile(file);
        const obj = await scene.addObject(modelPath, displayName);
        if (obj) scene.select(obj.id);
      }
    });
    
    // Preset models dropdown
    presetModels.addEventListener('change', async (e) => {
      if (e.target.value) {
        const obj = await scene.addObject(`/models/${e.target.value}`);
        if (obj) scene.select(obj.id);
        e.target.value = '';
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
  };
}
