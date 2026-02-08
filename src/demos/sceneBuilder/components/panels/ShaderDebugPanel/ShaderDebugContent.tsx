/**
 * ShaderDebugContent - Preact component for shader editor content
 * Extracted from the imperative ShaderDebugPanel class
 */

import { h } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';

import {
  getShaderSource,
  compileAndUpdate,
  resetShader,
  isModified,
  applyToAllMatching,
  ShaderType,
  getWGSLShaderSource,
  compileAndUpdateWGSL,
  resetWGSLShader,
  isWGSLModified,
  getAllShaderList,
  ShaderBackend,
} from '../../../shaderManager';

import styles from './ShaderDebugContent.module.css';

// ==================== Types ====================

interface ShaderInfo {
  name: string;
  backend: ShaderBackend;
}

// ==================== Component ====================

export function ShaderDebugContent() {
  // State
  const [selectedShader, setSelectedShader] = useState<string | null>(null);
  const [selectedBackend, setSelectedBackend] = useState<ShaderBackend>('webgl');
  const [shaderType, setShaderType] = useState<ShaderType>('fragment');
  const [shaderList, setShaderList] = useState<ShaderInfo[]>([]);
  const [statusText, setStatusText] = useState('Ready');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isModifiedState, setIsModifiedState] = useState(false);
  
  // Refs
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  
  // ==================== Initialize Editor ====================
  
  useEffect(() => {
    if (!editorContainerRef.current) return;
    
    const applyKeymap = keymap.of([
      { key: 'Ctrl-Enter', run: () => { handleApply(); return true; } },
      { key: 'Cmd-Enter', run: () => { handleApply(); return true; } },
    ]);
    
    const editor = new EditorView({
      state: EditorState.create({
        doc: '// Select a shader to edit...',
        extensions: [
          basicSetup,
          javascript(),
          oneDark,
          applyKeymap,
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
          }),
        ],
      }),
      parent: editorContainerRef.current,
    });
    
    editorViewRef.current = editor;
    
    // Initial refresh
    refreshShaderList();
    
    return () => {
      editor.destroy();
      editorViewRef.current = null;
    };
  }, []);
  
  // ==================== Helpers ====================
  
  const refreshShaderList = useCallback(() => {
    const list = getAllShaderList();
    setShaderList(list);
  }, []);
  
  const getEditorContent = useCallback(() => {
    return editorViewRef.current?.state.doc.toString() || '';
  }, []);
  
  const setEditorContent = useCallback((content: string) => {
    const editor = editorViewRef.current;
    if (!editor) return;
    
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
    });
  }, []);
  
  const updateModifiedIndicator = useCallback(() => {
    if (!selectedShader) {
      setIsModifiedState(false);
      return;
    }
    
    const modified = selectedBackend === 'webgpu'
      ? isWGSLModified(selectedShader)
      : isModified(selectedShader, shaderType);
    
    setIsModifiedState(modified);
  }, [selectedShader, selectedBackend, shaderType]);
  
  // ==================== Load Shader ====================
  
  const loadShaderSource = useCallback(() => {
    if (!selectedShader) {
      setEditorContent('// Select a shader to edit...');
      setStatusText('No shader selected');
      setErrorText(null);
      return;
    }
    
    let source: string | null = null;
    
    if (selectedBackend === 'webgpu') {
      source = getWGSLShaderSource(selectedShader);
    } else {
      source = getShaderSource(selectedShader, shaderType);
    }
    
    if (source) {
      setEditorContent(source);
      updateModifiedIndicator();
      
      if (selectedBackend === 'webgpu') {
        setStatusText(`Loaded: ${selectedShader} (WGSL)`);
      } else {
        const typeLabel = shaderType === 'vertex' ? 'VS' : 'FS';
        setStatusText(`Loaded: ${selectedShader} (${typeLabel})`);
      }
    } else {
      setEditorContent('// Shader source not found');
      setStatusText('Error loading shader');
    }
    
    setErrorText(null);
  }, [selectedShader, selectedBackend, shaderType, setEditorContent, updateModifiedIndicator]);
  
  // Load when shader changes
  useEffect(() => {
    loadShaderSource();
  }, [selectedShader, selectedBackend, shaderType]);
  
  // ==================== Handlers ====================
  
  const handleShaderSelect = useCallback((e: Event) => {
    const select = e.target as HTMLSelectElement;
    const option = select.selectedOptions[0];
    const name = select.value;
    const backend = (option?.dataset.backend || 'webgl') as ShaderBackend;
    
    setSelectedShader(name || null);
    setSelectedBackend(backend);
  }, []);
  
  const handleShaderTypeChange = useCallback((type: ShaderType) => {
    setShaderType(type);
  }, []);
  
  const handleApply = useCallback(() => {
    if (!selectedShader) {
      setErrorText('No shader selected');
      return;
    }
    
    const source = getEditorContent();
    let result;
    
    if (selectedBackend === 'webgpu') {
      result = compileAndUpdateWGSL(selectedShader, source);
    } else {
      result = compileAndUpdate(selectedShader, source, shaderType);
    }
    
    if (result.success) {
      setErrorText(null);
      if (selectedBackend === 'webgpu') {
        setStatusText(`✓ Applied WGSL: ${selectedShader}`);
      } else {
        const typeLabel = shaderType === 'vertex' ? 'VS' : 'FS';
        setStatusText(`✓ Applied ${typeLabel}: ${selectedShader}`);
      }
      updateModifiedIndicator();
    } else {
      setErrorText(result.error || 'Unknown error');
      setStatusText('✗ Compilation failed');
    }
  }, [selectedShader, selectedBackend, shaderType, getEditorContent, updateModifiedIndicator]);
  
  const handleApplyAll = useCallback(() => {
    if (!selectedShader) {
      setErrorText('No shader selected');
      return;
    }
    
    const baseName = selectedShader.replace(/ #\d+$/, '');
    const source = getEditorContent();
    const result = applyToAllMatching(baseName, source);
    
    if (result.failures.length === 0) {
      setErrorText(null);
      setStatusText(`✓ Applied to ${result.successes} shaders`);
    } else {
      const errorMsg = result.failures.map((f: { name: string; error: string }) => 
        `${f.name}: ${f.error}`
      ).join('\n\n');
      setErrorText(errorMsg);
      setStatusText(`✓ ${result.successes} applied, ✗ ${result.failures.length} failed`);
    }
  }, [selectedShader, getEditorContent]);
  
  const handleReset = useCallback(() => {
    if (!selectedShader) return;
    
    let result;
    if (selectedBackend === 'webgpu') {
      result = resetWGSLShader(selectedShader);
    } else {
      result = resetShader(selectedShader, shaderType);
    }
    
    if (result.success) {
      loadShaderSource();
      if (selectedBackend === 'webgpu') {
        setStatusText(`Reset WGSL: ${selectedShader}`);
      } else {
        const typeLabel = shaderType === 'vertex' ? 'VS' : 'FS';
        setStatusText(`Reset ${typeLabel}: ${selectedShader}`);
      }
    } else {
      setErrorText(result.error || 'Unknown error');
    }
  }, [selectedShader, selectedBackend, shaderType, loadShaderSource]);
  
  const handleRefresh = useCallback(() => {
    refreshShaderList();
  }, [refreshShaderList]);
  
  // ==================== Render ====================
  
  // Group shaders by backend
  const webglShaders = shaderList.filter(s => s.backend === 'webgl');
  const webgpuShaders = shaderList.filter(s => s.backend === 'webgpu');
  
  return (
    <div class={styles.content}>
      {/* Toolbar */}
      <div class={styles.toolbar}>
        <select 
          class={styles.select}
          value={selectedShader || ''}
          onChange={handleShaderSelect}
        >
          <option value="">-- Select Shader --</option>
          {webglShaders.length > 0 && (
            <optgroup label="WebGL (GLSL)">
              {webglShaders.map(s => (
                <option key={s.name} value={s.name} data-backend="webgl">
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
          {webgpuShaders.length > 0 && (
            <optgroup label="WebGPU (WGSL)">
              {webgpuShaders.map(s => (
                <option key={s.name} value={s.name} data-backend="webgpu">
                  {s.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        
        {/* VS/FS Toggle - only for WebGL shaders */}
        {selectedBackend === 'webgl' && (
          <div class={styles.typeToggle}>
            <button
              class={`${styles.typeBtn} ${shaderType === 'vertex' ? styles.active : ''}`}
              onClick={() => handleShaderTypeChange('vertex')}
              title="Edit Vertex Shader"
            >
              VS
            </button>
            <button
              class={`${styles.typeBtn} ${shaderType === 'fragment' ? styles.active : ''}`}
              onClick={() => handleShaderTypeChange('fragment')}
              title="Edit Fragment Shader"
            >
              FS
            </button>
          </div>
        )}
        
        <button class={styles.applyBtn} onClick={handleApply} title="Apply (Ctrl+Enter)">
          Apply
        </button>
        <button class={styles.applyAllBtn} onClick={handleApplyAll} title="Apply to all objects">
          Apply All
        </button>
        <button class={styles.resetBtn} onClick={handleReset} title="Reset to Original">
          Reset
        </button>
        <button class={styles.refreshBtn} onClick={handleRefresh} title="Refresh shader list">
          ↻
        </button>
      </div>
      
      {/* Editor */}
      <div ref={editorContainerRef} class={styles.editorContainer} />
      
      {/* Error Display */}
      {errorText && (
        <div class={styles.errorDisplay}>
          {errorText}
        </div>
      )}
      
      {/* Status Bar */}
      <div class={styles.statusBar}>
        <span class={styles.statusText}>{statusText}</span>
        {isModifiedState && (
          <span class={styles.modifiedIndicator}>● Modified</span>
        )}
      </div>
    </div>
  );
}

export default ShaderDebugContent;
