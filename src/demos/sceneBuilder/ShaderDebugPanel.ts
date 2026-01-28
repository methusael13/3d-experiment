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
  resetShaderFull,
  isModified,
  applyToAllMatching,
  ShaderType,
} from './shaderManager';

// ==================== Types ====================

export interface ShaderDebugPanelAPI {
  show(): void;
  hide(): void;
  toggle(): void;
  refresh(): void;
  destroy(): void;
}

// ==================== ShaderDebugPanel Class ====================

export class ShaderDebugPanel implements ShaderDebugPanelAPI {
  private container: HTMLElement;
  private panel: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  
  // Panel state
  private isVisible = false;
  private selectedShader: string | null = null;
  private selectedShaderType: ShaderType = 'fragment';
  private isDragging = false;
  private isResizing = false;
  private dragOffset = { x: 0, y: 0 };
  private editorView: EditorView | null = null;
  private editorInitialized = false;
  
  // DOM elements
  private selectEl!: HTMLSelectElement;
  private shaderTypeToggle!: HTMLDivElement;
  private vsBtn!: HTMLButtonElement;
  private fsBtn!: HTMLButtonElement;
  private editorContainer!: HTMLDivElement;
  private errorDisplay!: HTMLDivElement;
  private statusText!: HTMLSpanElement;
  private modifiedIndicator!: HTMLSpanElement;

  constructor(container: HTMLElement) {
    this.container = container;
    
    // Create panel element
    this.panel = document.createElement('div');
    this.panel.className = 'shader-debug-panel';
    this.panel.innerHTML = `
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
          <div class="shader-type-toggle">
            <button class="shader-type-btn vs-btn" title="Edit Vertex Shader">VS</button>
            <button class="shader-type-btn fs-btn active" title="Edit Fragment Shader">FS</button>
          </div>
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
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = this.getStyles();
    container.appendChild(this.styleEl);
    container.appendChild(this.panel);
    
    // Get DOM references
    this.selectEl = this.panel.querySelector('.shader-select') as HTMLSelectElement;
    this.shaderTypeToggle = this.panel.querySelector('.shader-type-toggle') as HTMLDivElement;
    this.vsBtn = this.panel.querySelector('.vs-btn') as HTMLButtonElement;
    this.fsBtn = this.panel.querySelector('.fs-btn') as HTMLButtonElement;
    this.editorContainer = this.panel.querySelector('.shader-editor-container') as HTMLDivElement;
    this.errorDisplay = this.panel.querySelector('.shader-error-display') as HTMLDivElement;
    this.statusText = this.panel.querySelector('.shader-status-text') as HTMLSpanElement;
    this.modifiedIndicator = this.panel.querySelector('.shader-modified-indicator') as HTMLSpanElement;
    
    this.setupEventListeners();
  }

  private getStyles(): string {
    return `
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
      
      .shader-type-toggle {
        display: flex;
        border: 1px solid #45475a;
        border-radius: 4px;
        overflow: hidden;
      }
      
      .shader-type-btn {
        padding: 6px 10px;
        border: none;
        background: #313244;
        color: #6c7086;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .shader-type-btn:hover {
        background: #45475a;
        color: #a6adc8;
      }
      
      .shader-type-btn.active {
        background: #89b4fa;
        color: #1e1e2e;
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
  }

  private setupEventListeners(): void {
    const header = this.panel.querySelector('.shader-panel-header') as HTMLDivElement;
    const closeBtn = this.panel.querySelector('.shader-close-btn') as HTMLButtonElement;
    const minimizeBtn = this.panel.querySelector('.shader-minimize-btn') as HTMLButtonElement;
    const applyBtn = this.panel.querySelector('.shader-apply-btn') as HTMLButtonElement;
    const applyAllBtn = this.panel.querySelector('.shader-apply-all-btn') as HTMLButtonElement;
    const resetBtn = this.panel.querySelector('.shader-reset-btn') as HTMLButtonElement;
    const resizeHandle = this.panel.querySelector('.shader-resize-handle') as HTMLDivElement;
    
    // Shader selection
    this.selectEl.addEventListener('change', () => {
      this.loadShader(this.selectEl.value);
    });
    
    // Shader type toggle
    this.vsBtn.addEventListener('click', () => this.setShaderType('vertex'));
    this.fsBtn.addEventListener('click', () => this.setShaderType('fragment'));
    
    // Buttons
    applyBtn.addEventListener('click', () => this.applyShader());
    applyAllBtn.addEventListener('click', () => this.applyToAllShaders());
    resetBtn.addEventListener('click', () => this.resetCurrentShader());
    
    // Dragging
    header.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.shader-panel-btn')) return;
      this.isDragging = true;
      const rect = this.panel.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      this.panel.style.transition = 'none';
    });
    
    // Resizing
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      this.isResizing = true;
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isDragging) {
        const containerRect = this.container.getBoundingClientRect();
        let x = e.clientX - containerRect.left - this.dragOffset.x;
        let y = e.clientY - containerRect.top - this.dragOffset.y;
        
        x = Math.max(-this.panel.offsetWidth + 50, x);
        y = Math.max(-20, y);
        
        this.panel.style.left = x + 'px';
        this.panel.style.top = y + 'px';
        this.panel.style.right = 'auto';
      }
      
      if (this.isResizing) {
        const rect = this.panel.getBoundingClientRect();
        const newWidth = Math.max(400, e.clientX - rect.left);
        const newHeight = Math.max(300, e.clientY - rect.top);
        this.panel.style.width = newWidth + 'px';
        this.panel.style.height = newHeight + 'px';
      }
    });
    
    document.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.isResizing = false;
      this.panel.style.transition = '';
    });
    
    // Close/minimize
    closeBtn.addEventListener('click', () => this.hide());
    
    minimizeBtn.addEventListener('click', () => {
      this.panel.classList.toggle('minimized');
      minimizeBtn.textContent = this.panel.classList.contains('minimized') ? '+' : '−';
    });
    
    // Prevent keyboard events from propagating to viewport
    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());
    this.panel.addEventListener('keypress', (e) => e.stopPropagation());
  }

  private initEditor(): void {
    const applyKeymap = keymap.of([{
      key: 'Ctrl-Enter',
      run: () => { this.applyShader(); return true; },
    }, {
      key: 'Cmd-Enter',
      run: () => { this.applyShader(); return true; },
    }]);
    
    this.editorView = new EditorView({
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
      parent: this.editorContainer,
    });
  }

  private setShaderType(type: ShaderType): void {
    if (this.selectedShaderType === type) return;
    
    this.selectedShaderType = type;
    this.vsBtn.classList.toggle('active', type === 'vertex');
    this.fsBtn.classList.toggle('active', type === 'fragment');
    
    // Reload current shader with new type
    if (this.selectedShader) {
      this.loadShaderSource();
    }
  }

  private loadShader(name: string): void {
    this.selectedShader = name || null;
    this.loadShaderSource();
  }
  
  private loadShaderSource(): void {
    const source = this.selectedShader 
      ? getShaderSource(this.selectedShader, this.selectedShaderType) 
      : null;
    
    if (source && this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: source },
      });
      this.updateModifiedIndicator();
      const typeLabel = this.selectedShaderType === 'vertex' ? 'VS' : 'FS';
      this.statusText.textContent = `Loaded: ${this.selectedShader} (${typeLabel})`;
    } else if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: '// Select a shader to edit...' },
      });
      this.statusText.textContent = 'No shader selected';
    }
    
    this.hideError();
  }

  private getEditorContent(): string {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  private applyShader(): void {
    if (!this.selectedShader) {
      this.showError('No shader selected');
      return;
    }
    
    const result = compileAndUpdate(
      this.selectedShader, 
      this.getEditorContent(),
      this.selectedShaderType
    );
    
    if (result.success) {
      this.hideError();
      const typeLabel = this.selectedShaderType === 'vertex' ? 'VS' : 'FS';
      this.statusText.textContent = `✓ Applied ${typeLabel}: ${this.selectedShader}`;
      this.updateModifiedIndicator();
    } else {
      this.showError(result.error || 'Unknown error');
      this.statusText.textContent = `✗ Compilation failed`;
    }
  }

  private applyToAllShaders(): void {
    if (!this.selectedShader) {
      this.showError('No shader selected');
      return;
    }
    
    const baseName = this.selectedShader.replace(/ #\d+$/, '');
    const source = this.getEditorContent();
    
    const result = applyToAllMatching(baseName, source);
    
    if (result.failures.length === 0) {
      this.hideError();
      this.statusText.textContent = `✓ Applied to ${result.successes} shaders`;
    } else {
      const errorMsg = result.failures.map((f: { name: string; error: string }) => `${f.name}: ${f.error}`).join('\n\n');
      this.showError(errorMsg);
      this.statusText.textContent = `✓ ${result.successes} applied, ✗ ${result.failures.length} failed`;
    }
  }

  private resetCurrentShader(): void {
    if (!this.selectedShader) return;
    
    const result = resetShader(this.selectedShader, this.selectedShaderType);
    
    if (result.success) {
      this.loadShaderSource();
      const typeLabel = this.selectedShaderType === 'vertex' ? 'VS' : 'FS';
      this.statusText.textContent = `Reset ${typeLabel}: ${this.selectedShader}`;
    } else {
      this.showError(result.error || 'Unknown error');
    }
  }

  private showError(message: string): void {
    this.errorDisplay.textContent = message;
    this.errorDisplay.classList.add('visible');
  }

  private hideError(): void {
    this.errorDisplay.classList.remove('visible');
  }

  private updateModifiedIndicator(): void {
    if (this.selectedShader && isModified(this.selectedShader, this.selectedShaderType)) {
      this.modifiedIndicator.classList.add('visible');
    } else {
      this.modifiedIndicator.classList.remove('visible');
    }
  }

  // ==================== Public API ====================

  show(): void {
    this.isVisible = true;
    this.panel.classList.add('visible');
    
    if (!this.editorInitialized) {
      this.initEditor();
      this.editorInitialized = true;
    }
    
    this.refresh();
  }

  hide(): void {
    this.isVisible = false;
    this.panel.classList.remove('visible');
  }

  toggle(): void {
    if (this.isVisible) this.hide();
    else this.show();
  }

  refresh(): void {
    const shaders = getShaderList();
    const currentValue = this.selectEl.value;
    
    this.selectEl.innerHTML = '<option value="">-- Select Shader --</option>' +
      shaders.map((name: string) => `<option value="${name}">${name}</option>`).join('');
    
    if (currentValue && shaders.includes(currentValue)) {
      this.selectEl.value = currentValue;
    }
  }

  destroy(): void {
    this.editorView?.destroy();
    this.panel.remove();
    this.styleEl.remove();
  }
}

// ==================== Factory Function ====================

/**
 * Create shader debug panel
 * @deprecated Use `new ShaderDebugPanel()` directly
 */
export function createShaderDebugPanel(container: HTMLElement): ShaderDebugPanelAPI {
  return new ShaderDebugPanel(container);
}
