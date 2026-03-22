/**
 * MaterialEditorView - Full-page view for the Materials tab
 * 
 * Layout: Material browser (left sidebar) + Node editor (center)
 * This is rendered when the "Materials" tab is active in the MenuBar.
 */

import { useCallback } from 'preact/hooks';
import { getMaterialRegistry } from '@/core/materials';
import { MaterialBrowser } from './MaterialBrowser';
import { MaterialNodeEditor } from './MaterialNodeEditor';
import styles from './MaterialEditorView.module.css';

export function MaterialEditorView() {
  const registry = getMaterialRegistry();
  
  const handleCreateMaterial = useCallback(() => {
    const mat = registry.create('New Material');
    registry.select(mat.id);
  }, [registry]);
  
  return (
    <div class={styles.container}>
      {/* Left sidebar: Material browser */}
      <div class={styles.browserPanel}>
        <MaterialBrowser />
      </div>
      
      {/* Center: Node editor */}
      <div class={styles.editorPanel}>
        <MaterialNodeEditor />
      </div>
    </div>
  );
}
