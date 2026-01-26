/**
 * Objects Panel
 * Displays scene objects list and import controls
 */

import { importModelFile, importGLTFDirectory } from '../../../loaders';
import type { PanelContext, Panel } from './panelContext';

// ==================== Constants ====================

const objectsPanelStyles = `
  .objects-panel .object-list {
    list-style: none;
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 12px;
  }
`;

const objectsPanelTemplate = `
  <h3>Scene Objects</h3>
  <div class="section-content">
    <ul id="object-list" class="object-list"></ul>
    <div class="import-controls">
      <input type="file" id="model-file" accept=".glb" style="display: none;">
      <input type="file" id="model-folder" webkitdirectory directory style="display: none;">
      <button id="import-btn" class="primary-btn">Import GLB</button>
      <button id="import-folder-btn" class="secondary-btn">Import glTF Folder</button>
      <select id="preset-models">
        <option value="">Add Preset...</option>
        <option value="duck.glb">Duck</option>
      </select>
    </div>
  </div>
`;

// ==================== ObjectsPanel Class ====================

export class ObjectsPanel implements Panel {
  private panelElement: HTMLElement;
  private context: PanelContext;
  private styleEl: HTMLStyleElement;
  
  // DOM references
  private objectList!: HTMLUListElement;
  private importBtn!: HTMLButtonElement;
  private importFolderBtn!: HTMLButtonElement;
  private modelFile!: HTMLInputElement;
  private modelFolder!: HTMLInputElement;
  private presetModels!: HTMLSelectElement;
  
  constructor(panelElement: HTMLElement, context: PanelContext) {
    this.panelElement = panelElement;
    this.context = context;
    
    // Set panel content
    panelElement.innerHTML = objectsPanelTemplate;
    panelElement.classList.add('objects-panel', 'sidebar-section');
    panelElement.id = 'objects-panel';
    
    // Add styles
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = objectsPanelStyles;
    panelElement.appendChild(this.styleEl);
    
    // Cache DOM references
    this.objectList = panelElement.querySelector('#object-list') as HTMLUListElement;
    this.importBtn = panelElement.querySelector('#import-btn') as HTMLButtonElement;
    this.importFolderBtn = panelElement.querySelector('#import-folder-btn') as HTMLButtonElement;
    this.modelFile = panelElement.querySelector('#model-file') as HTMLInputElement;
    this.modelFolder = panelElement.querySelector('#model-folder') as HTMLInputElement;
    this.presetModels = panelElement.querySelector('#preset-models') as HTMLSelectElement;
    
    this.setup();
  }
  
  private setup(): void {
    const { scene } = this.context;
    
    // Import button
    this.importBtn.addEventListener('click', () => this.modelFile.click());
    
    // Model file input (GLB files)
    this.modelFile.addEventListener('change', async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) {
        const result = await importModelFile(file);
        if (result) {
          const { modelPath, displayName } = result;
          const obj = await scene.addObject(modelPath, displayName);
          if (obj) scene.select(obj.id);
        }
      }
      // Reset input so same file can be selected again
      this.modelFile.value = '';
    });
    
    // Folder input for glTF directory import
    this.importFolderBtn.addEventListener('click', () => this.modelFolder.click());
    
    this.modelFolder.addEventListener('change', async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const files = input.files;
      if (files && files.length > 0) {
        const result = await importGLTFDirectory(files);
        if (result) {
          const { modelPath, displayName } = result;
          const obj = await scene.addObject(modelPath, displayName);
          if (obj) scene.select(obj.id);
        } else {
          console.error('Failed to import glTF folder - no .gltf file found');
        }
      }
      // Reset input so same folder can be selected again
      this.modelFolder.value = '';
    });
    
    // Preset models dropdown
    this.presetModels.addEventListener('change', async (e: Event) => {
      const select = e.target as HTMLSelectElement;
      if (select.value) {
        const obj = await scene.addObject(`/models/${select.value}`);
        if (obj) scene.select(obj.id);
        select.value = '';
      }
    });
  }
  
  update(): void {
    const { scene } = this.context;
    const allObjects = scene.getAllObjects();
    const groups = scene.getAllGroups();
    
    // Build hierarchical list
    const ungrouped = allObjects.filter(o => !o.groupId);
    const groupedByGroupId = new Map<string, typeof allObjects>();
    
    for (const obj of allObjects) {
      if (obj.groupId) {
        if (!groupedByGroupId.has(obj.groupId)) {
          groupedByGroupId.set(obj.groupId, []);
        }
        groupedByGroupId.get(obj.groupId)!.push(obj);
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
    
    this.objectList.innerHTML = html;
    
    // Attach event handlers for object items
    this.objectList.querySelectorAll('li[data-id]').forEach(li => {
      li.addEventListener('click', (e: Event) => {
        const element = li as HTMLLIElement;
        const mouseEvent = e as MouseEvent;
        const inExpandedGroup = element.dataset.inExpandedGroup === 'true';
        scene.select(element.dataset.id!, { additive: mouseEvent.shiftKey, fromExpandedGroup: inExpandedGroup });
      });
    });
    
    // Attach event handlers for group headers
    this.objectList.querySelectorAll('.group-header').forEach(li => {
      li.addEventListener('click', (e: Event) => {
        const element = li as HTMLLIElement;
        const target = e.target as HTMLElement;
        const mouseEvent = e as MouseEvent;
        const groupId = element.dataset.groupId!;
        
        if (target.classList.contains('group-toggle')) {
          scene.toggleGroupExpanded(groupId);
          this.update(); // Re-render
        } else {
          // Select all group members
          const group = scene.getGroup(groupId);
          if (group) {
            if (!mouseEvent.shiftKey) scene.clearSelection();
            scene.selectAll([...group.childIds]);
          }
        }
      });
    });
  }
  
  destroy(): void {
    this.panelElement.innerHTML = '';
  }
}

// ==================== Factory Function ====================

/**
 * Creates the objects panel
 * @deprecated Use `new ObjectsPanel()` directly
 */
export function createObjectsPanel(panelElement: HTMLElement, context: PanelContext): Panel {
  return new ObjectsPanel(panelElement, context);
}
