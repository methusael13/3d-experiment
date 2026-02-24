/**
 * ImportModeDialog - Shown when importing a multi-node glTF file.
 * Lets the user choose between importing as a single combined object
 * or as separate objects (one per node/variant).
 */

import { useEffect, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import styles from './ImportModeDialog.module.css';

// ==================== Types ====================

export type ImportMode = 'combined' | 'separate' | 'cancel';

export interface ImportModePrompt {
  /** Asset/file display name */
  assetName: string;
  /** Node names from the glTF scene graph */
  nodeNames: string[];
  /** Resolve callback to deliver the user's choice */
  resolve: (mode: ImportMode) => void;
}

// ==================== Global State ====================

/**
 * Signal holding the current pending import prompt, or null if no dialog is open.
 * This lives outside the component so useAssetImport can trigger it.
 */
export const pendingImportPrompt = signal<ImportModePrompt | null>(null);

/**
 * Show the import mode dialog and wait for the user's choice.
 * Returns a Promise that resolves to 'combined', 'separate', or 'cancel'.
 */
export function promptImportMode(assetName: string, nodeNames: string[]): Promise<ImportMode> {
  return new Promise<ImportMode>((resolve) => {
    pendingImportPrompt.value = { assetName, nodeNames, resolve };
  });
}

// ==================== Icons ====================

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

// ==================== Component ====================

export function ImportModeDialog() {
  const prompt = pendingImportPrompt.value;
  
  const dismiss = useCallback((mode: ImportMode) => {
    const current = pendingImportPrompt.value;
    if (current) {
      pendingImportPrompt.value = null;
      current.resolve(mode);
    }
  }, []);
  
  // Keyboard shortcuts
  useEffect(() => {
    if (!prompt) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss('cancel');
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prompt, dismiss]);
  
  if (!prompt) return null;
  
  const { assetName, nodeNames } = prompt;
  const nodeCount = nodeNames.length;
  
  return (
    <div class={styles.overlay} onClick={() => dismiss('cancel')}>
      <div class={styles.dialog} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div class={styles.header}>
          <h2 class={styles.title}>Import Model</h2>
          <button
            class={styles.closeButton}
            onClick={() => dismiss('cancel')}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
        
        {/* Body */}
        <div class={styles.body}>
          <p class={styles.message}>
            <strong>{assetName}</strong> contains {nodeCount} nodes:
          </p>
          
          <ul class={styles.nodeList}>
            {nodeNames.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
          
          <p class={styles.prompt}>
            How would you like to import?
          </p>
        </div>
        
        {/* Footer */}
        <div class={styles.footer}>
          <button
            class={styles.cancelButton}
            onClick={() => dismiss('cancel')}
          >
            Cancel
          </button>
          <button
            class={styles.separateButton}
            onClick={() => dismiss('separate')}
          >
            {nodeCount} separate objects
          </button>
          <button
            class={styles.combinedButton}
            onClick={() => dismiss('combined')}
          >
            Single object
          </button>
        </div>
      </div>
    </div>
  );
}