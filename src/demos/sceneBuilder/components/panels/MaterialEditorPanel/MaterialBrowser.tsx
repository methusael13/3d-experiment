/**
 * MaterialBrowser - Left panel in the Materials tab
 * 
 * Lists all materials in the registry with search, create, delete.
 * Clicking a material selects it for editing in the node editor.
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { getMaterialRegistry, type MaterialDefinition } from '@/core/materials';
import styles from './MaterialBrowser.module.css';

// Import CSS variables
import '../../styles/variables.css';

// ==================== Icons ====================

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
  </svg>
);

const DeleteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
  </svg>
);

const DuplicateIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
  </svg>
);

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
  </svg>
);

// ==================== Color Swatch ====================

function ColorSwatch({ color }: { color: [number, number, number] }) {
  const cssColor = `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`;
  return <div class={styles.colorSwatch} style={{ backgroundColor: cssColor }} />;
}

// ==================== Component ====================

export function MaterialBrowser() {
  const registry = getMaterialRegistry();
  const [searchQuery, setSearchQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  
  // Reactive: get all materials from registry
  const allMaterials = registry.materialsSignal;
  const selectedId = registry.selectedMaterialId;
  
  // Filter materials by search query
  const filteredMaterials = useMemo(() => {
    const materials = allMaterials.value;
    if (!searchQuery.trim()) return materials;
    
    const lower = searchQuery.toLowerCase();
    return materials.filter(m =>
      m.name.toLowerCase().includes(lower) ||
      m.tags.some(t => t.toLowerCase().includes(lower))
    );
  }, [allMaterials.value, searchQuery]);
  
  // Separate presets from custom materials
  const presets = useMemo(() => filteredMaterials.filter(m => m.isPreset), [filteredMaterials]);
  const custom = useMemo(() => filteredMaterials.filter(m => !m.isPreset), [filteredMaterials]);
  
  const handleSelect = useCallback((id: string) => {
    registry.select(id);
  }, [registry]);
  
  const handleCreate = useCallback(() => {
    const mat = registry.create('New Material');
    registry.select(mat.id);
  }, [registry]);
  
  const handleDuplicate = useCallback((id: string, e: Event) => {
    e.stopPropagation();
    const mat = registry.duplicate(id);
    if (mat) registry.select(mat.id);
  }, [registry]);
  
  const handleDelete = useCallback((id: string, e: Event) => {
    e.stopPropagation();
    registry.delete(id);
  }, [registry]);
  
  const handleStartRename = useCallback((id: string, currentName: string, e: Event) => {
    e.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);
  
  const handleFinishRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      registry.rename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, registry]);
  
  const handleRenameKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishRename();
    } else if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [handleFinishRename]);
  
  const renderMaterialItem = (mat: MaterialDefinition) => {
    const isSelected = selectedId.value === mat.id;
    const isRenaming = renamingId === mat.id;
    
    return (
      <div
        key={mat.id}
        class={`${styles.materialItem} ${isSelected ? styles.selected : ''}`}
        onClick={() => handleSelect(mat.id)}
      >
        <ColorSwatch color={mat.albedo} />
        <div class={styles.materialInfo}>
          {isRenaming ? (
            <input
              type="text"
              class={styles.renameInput}
              value={renameValue}
              onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              class={styles.materialName}
              onDblClick={(e) => handleStartRename(mat.id, mat.name, e)}
              title="Double-click to rename"
            >
              {mat.name}
            </span>
          )}
          <span class={styles.materialMeta}>
            {mat.metallic > 0.5 ? 'Metallic' : 'Dielectric'}
            {mat.clearcoatFactor > 0 && ' • Clearcoat'}
            {mat.unlit && ' • Unlit'}
          </span>
        </div>
        <div class={styles.materialActions}>
          <button
            class={styles.actionBtn}
            onClick={(e) => handleDuplicate(mat.id, e)}
            title="Duplicate"
          >
            <DuplicateIcon />
          </button>
          {!mat.isPreset && (
            <button
              class={styles.actionBtn}
              onClick={(e) => handleDelete(mat.id, e)}
              title="Delete"
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      </div>
    );
  };
  
  return (
    <div class={styles.container}>
      {/* Header */}
      <div class={styles.header}>
        <span class={styles.headerTitle}>Materials</span>
        <span class={styles.headerCount}>{allMaterials.value.length}</span>
      </div>
      
      {/* Search */}
      <div class={styles.searchRow}>
        <div class={styles.searchInput}>
          <SearchIcon />
          <input
            type="text"
            placeholder="Search materials..."
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      
      {/* Create button */}
      <button class={styles.createButton} onClick={handleCreate}>
        <PlusIcon />
        <span>New Material</span>
      </button>
      
      {/* Material list */}
      <div class={styles.materialList}>
        {/* Custom materials */}
        {custom.length > 0 && (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Custom</div>
            {custom.map(renderMaterialItem)}
          </div>
        )}
        
        {/* Presets */}
        {presets.length > 0 && (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Presets</div>
            {presets.map(renderMaterialItem)}
          </div>
        )}
        
        {filteredMaterials.length === 0 && (
          <div class={styles.emptyState}>
            {searchQuery ? 'No matching materials' : 'No materials yet'}
          </div>
        )}
      </div>
    </div>
  );
}
