/**
 * Shader Debug Panel
 * Draggable panel for live shader editing with CodeMirror
 */

import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';

import {
  getShaderList,
  getShaderSource,
  compileAndUpdate,
  resetShader,
  isModified,
  applyToAllMatching,
} from './shaderManager.js';

/**
 * Create shader debug panel
 * @param {HTMLElement} container - Parent container
 * @returns {object} Panel API
 */
export function createShaderDebugPanel(container) {
  // Panel state
  let isVisible = false;
  let selectedShader = null;
  let isDragging = false;
  let isResizing = false;
  let dragOffset = { x: 0, y: 0 };
  let editorView = null;
  
  // Create panel element
  const panel = document.createElement('div');
  panel.className = 'shader-debug-panel';
  panel.innerHTML = `
    <div class="shader-panel-header">
      <span class="shader-panel-title">🔧 Shader Editor</span>
      <div class="shader-panel-controls">
        <button class="shader-panel-btn shader-minimize-btn" title="Minimize">−</button>
        <button class="shader-panel-btn shader-close-btn" title="Close">×</button>
      </div>
    </div>
    <div class="shader-panel-body">
      <div class="shader-panel-toolbar">
        <select class="shader-select">
          <option value="">-- Select Shader --</option>
        </select>
        <button class="shader-apply-btn" title="Apply (Ctrl+Enter)">Apply</button>
        <button class="shader-apply-all-btn" title="Apply to all objects">Apply All</button>
        <button class="shader-reset-btn" title="Reset to Original">Reset</button>
      </div>
      <div class="shader-editor-container"></div>
      <div class="shader-error-display"></div>
      <div class="shader-status-bar">
        <span class="shader-status-text">Ready</span>
        <span class="shader-modified-indicator"></span>
      </div>
    </div>
    <div class="shader-resize-handle"></div>
  `;
  
  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    .shader-debug-panel {
      position: absolute;
      right: 10px;
      top: 60px;
      width: 550px;
      height: 500px;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      display: none;
      flex-direction: column;
      z-index: 1000;
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
    }
    
    .shader-debug-panel.visible {
      display: flex;
    }
    
    .shader-debug-panel.minimized .shader-panel-body,
    .shader-debug-panel.minimized .shader-resize-handle {
      display: none;
    }
    
    .shader-debug-panel.minimized {
      height: auto !important;
    }
    
    .shader-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: #313244;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    
    .shader-panel-title {
      color: #cdd6f4;
      font-weight: 600;
      font-size: 13px;
    }
    
    .shader-panel-controls {
      display: flex;
      gap: 4px;
    }
    
    .shader-panel-btn {
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: #a6adc8;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .shader-panel-btn:hover {
      background: #45475a;
      color: #cdd6f4;
    }
    
    .shader-panel-body {
      display: flex;
      flex-direction: column;
      padding: 12px;
      gap: 8px;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    
    .shader-panel-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    
    .shader-select {
      flex: 1;
      padding: 6px 10px;
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 4px;
      color: #cdd6f4;
      font-size: 12px;
    }
    
    .shader-apply-btn, .shader-apply-all-btn, .shader-reset-btn {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .shader-apply-btn {
      background: #89b4fa;
      color: #1e1e2e;
    }
    
    .shader-apply-btn:hover {
      background: #b4befe;
    }
    
    .shader-apply-all-btn {
      background: #a6e3a1;
      color: #1e1e2e;
    }
    
    .shader-apply-all-btn:hover {
      background: #b5e8b0;
    }
    
    .shader-reset-btn {
      background: #45475a;
      color: #cdd6f4;
    }
    
    .shader-reset-btn:hover {
      background: #585b70;
    }
    
    .shader-editor-container {
      flex: 1;
      min-height: 0;
      border: 1px solid #45475a;
      border-radius: 4px;
      overflow: hidden;
    }
    
    .shader-editor-container .cm-editor {
      height: 100%;
    }
    
    .shader-editor-container .cm-scroller {
      overflow: auto;
    }
    
    .shader-error-display {
      max-height: 80px;
      overflow: auto;
      padding: 8px;
      background: #302030;
      border: 1px solid #f38ba8;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      font-size: 11px;
      color: #f38ba8;
      white-space: pre-wrap;
      display: none;
      flex-shrink: 0;
    }
    
    .shader-error-display.visible {
      display: block;
    }
    
    .shader-status-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      font-size: 11px;
      color: #6c7086;
      flex-shrink: 0;
    }
    
    .shader-modified-indicator {
      color: #f9e2af;
    }
    
    .shader-modified-indicator::before {
      content: '● Modified';
    }
    
    .shader-modified-indicator:not(.visible) {
      display: none;
    }
    
    .shader-resize-handle {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 50%, #45475a 50%);
    }
  `;
  container.appendChild(style);
  container.appendChild(panel);
  
  // Get DOM references
  const header = panel.querySelector('.shader-panel-header');
  const closeBtn = panel.querySelector('.shader-close-btn');
  const minimizeBtn = panel.querySelector('.shader-minimize-btn');
  const selectEl = panel.querySelector('.shader-select');
  const applyBtn = panel.querySelector('.shader-apply-btn');
  const applyAllBtn = panel.querySelector('.shader-apply-all-btn');
  const resetBtn = panel.querySelector('.shader-reset-btn');
  const editorContainer = panel.querySelector('.shader-editor-container');
  const errorDisplay = panel.querySelector('.shader-error-display');
  const statusText = panel.querySelector('.shader-status-text');
  const modifiedIndicator = panel.querySelector('.shader-modified-indicator');
  const resizeHandle = panel.querySelector('.shader-resize-handle');
  
  // Initialize CodeMirror editor
  function initEditor() {
    const applyKeymap = keymap.of([{
      key: 'Ctrl-Enter',
      run: () => { applyShader(); return true; },
    }, {
      key: 'Cmd-Enter',
      run: () => { applyShader(); return true; },
    }]);
    
    editorView = new EditorView({
      state: EditorState.create({
        doc: '// Select a shader to edit...',
        extensions: [
          basicSetup,
          javascript(), // GLSL is C-like, JS highlighting works reasonably well
          oneDark,
          applyKeymap,
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
        ],
      }),
      parent: editorContainer,
    });
  }
  
  // Update shader list dropdown
  function refreshShaderList() {
    const shaders = getShaderList();
    const currentValue = selectEl.value;
    
    selectEl.innerHTML = '<option value="">-- Select Shader --</option>' +
      shaders.map(name => `<option value="${name}">${name}</option>`).join('');
    
    if (currentValue && shaders.includes(currentValue)) {
      selectEl.value = currentValue;
    }
  }
  
  // Load shader into editor
  function loadShader(name) {
    selectedShader = name;
    const source = getShaderSource(name);
    
    if (source && editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: source },
      });
      updateModifiedIndicator();
      statusText.textContent = `Loaded: ${name}`;
    } else if (editorView) {
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: '// Select a shader to edit...' },
      });
      statusText.textContent = 'No shader selected';
    }
    
    hideError();
  }
  
  // Get editor content
  function getEditorContent() {
    return editorView ? editorView.state.doc.toString() : '';
  }
  
  // Apply current editor content
  function applyShader() {
    if (!selectedShader) {
      showError('No shader selected');
      return;
    }
    
    const result = compileAndUpdate(selectedShader, getEditorContent());
    
    if (result.success) {
      hideError();
      statusText.textContent = `✓ Applied: ${selectedShader}`;
      updateModifiedIndicator();
    } else {
      showError(result.error);
      statusText.textContent = `✗ Compilation failed`;
    }
  }
  
  // Apply to all shaders of the same type
  function applyToAllShaders() {
    if (!selectedShader) {
      showError('No shader selected');
      return;
    }
    
    // Extract the base name (e.g., "Object Main" from "Object Main #0")
    const baseName = selectedShader.replace(/ #\d+$/, '');
    const source = getEditorContent();
    
    const result = applyToAllMatching(baseName, source);
    
    if (result.failures.length === 0) {
      hideError();
      statusText.textContent = `✓ Applied to ${result.successes} shaders`;
    } else {
      const errorMsg = result.failures.map(f => `${f.name}: ${f.error}`).join('\n\n');
      showError(errorMsg);
      statusText.textContent = `✓ ${result.successes} applied, ✗ ${result.failures.length} failed`;
    }
  }
  
  // Reset shader to original
  function resetCurrentShader() {
    if (!selectedShader) return;
    
    const result = resetShader(selectedShader);
    
    if (result.success) {
      loadShader(selectedShader);
      statusText.textContent = `Reset: ${selectedShader}`;
    } else {
      showError(result.error);
    }
  }
  
  // Show/hide error
  function showError(message) {
    errorDisplay.textContent = message;
    errorDisplay.classList.add('visible');
  }
  
  function hideError() {
    errorDisplay.classList.remove('visible');
  }
  
  // Update modified indicator
  function updateModifiedIndicator() {
    if (selectedShader && isModified(selectedShader)) {
      modifiedIndicator.classList.add('visible');
    } else {
      modifiedIndicator.classList.remove('visible');
    }
  }
  
  // Event handlers
  selectEl.addEventListener('change', () => {
    loadShader(selectEl.value);
  });
  
  applyBtn.addEventListener('click', applyShader);
  applyAllBtn.addEventListener('click', applyToAllShaders);
  resetBtn.addEventListener('click', resetCurrentShader);
  
  // Dragging
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.shader-panel-btn')) return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    panel.style.transition = 'none';
  });
  
  // Resizing
  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const containerRect = container.getBoundingClientRect();
      let x = e.clientX - containerRect.left - dragOffset.x;
      let y = e.clientY - containerRect.top - dragOffset.y;
      
      // Allow moving outside bounds (just keep partially visible)
      x = Math.max(-panel.offsetWidth + 50, x);
      y = Math.max(-20, y);
      
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
    }
    
    if (isResizing) {
      const rect = panel.getBoundingClientRect();
      const newWidth = Math.max(400, e.clientX - rect.left);
      const newHeight = Math.max(300, e.clientY - rect.top);
      panel.style.width = newWidth + 'px';
      panel.style.height = newHeight + 'px';
    }
  });
  
  document.addEventListener('mouseup', () => {
    isDragging = false;
    isResizing = false;
    panel.style.transition = '';
  });
  
  // Close/minimize
  closeBtn.addEventListener('click', () => {
    hide();
  });
  
  minimizeBtn.addEventListener('click', () => {
    panel.classList.toggle('minimized');
    minimizeBtn.textContent = panel.classList.contains('minimized') ? '+' : '−';
  });
  
  // Initialize editor on first show
  let editorInitialized = false;
  
  // Public API
  function show() {
    isVisible = true;
    panel.classList.add('visible');
    
    if (!editorInitialized) {
      initEditor();
      editorInitialized = true;
    }
    
    refreshShaderList();
  }
  
  function hide() {
    isVisible = false;
    panel.classList.remove('visible');
  }
  
  function toggle() {
    if (isVisible) hide();
    else show();
  }
  
  function destroy() {
    if (editorView) {
      editorView.destroy();
    }
    panel.remove();
    style.remove();
  }
  
  return {
    show,
    hide,
    toggle,
    refresh: refreshShaderList,
    destroy,
  };
}
