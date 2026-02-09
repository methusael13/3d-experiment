/**
 * AssetPickerModal - Modal component for selecting assets from the library
 * 
 * Reuses AssetPreviewGrid from AssetLibraryPanel for consistent asset display.
 * Supports filtering by type/subtype (e.g., texture atlases).
 */

import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import { useAssetLibrary, type Asset } from '../../hooks/useAssetLibrary';
import { AssetPreviewGrid } from '../../panels/AssetLibraryPanel/AssetPreviewGrid';
import styles from './AssetPickerModal.module.css';

// ==================== Types ====================

export interface AssetPickerModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback when asset is selected */
  onSelect: (asset: Asset) => void;
  /** Modal title */
  title?: string;
  /** Filter by asset type (e.g., 'texture') */
  filterType?: string;
  /** Filter by asset subtype (e.g., 'atlas') */
  filterSubtype?: string;
  /** Filter by asset category */
  filterCategory?: string;
  /** Allow multiple selection */
  multiSelect?: boolean;
}

// ==================== Icons ====================

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
  </svg>
);

// ==================== Component ====================

export function AssetPickerModal({
  isOpen,
  onClose,
  onSelect,
  title = 'Select Asset',
  filterType,
  filterSubtype,
  filterCategory,
  multiSelect = false,
}: AssetPickerModalProps) {
  const { assets, isLoading, error, fetchAssets } = useAssetLibrary();
  
  // Local state
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Reset selection when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedAssetId(null);
      setSearchQuery('');
      // Fetch assets if not already loaded
      if (assets.value.length === 0) {
        fetchAssets();
      }
    }
  }, [isOpen]);
  
  // Filter assets by type/subtype/category
  const filteredAssets = useMemo(() => {
    return assets.value.filter(asset => {
      if (filterType && asset.type !== filterType) return false;
      if (filterSubtype && asset.subtype !== filterSubtype) return false;
      if (filterCategory && asset.category !== filterCategory) return false;
      return true;
    });
  }, [assets.value, filterType, filterSubtype, filterCategory]);
  
  // Handle asset selection
  const handleSelectAsset = useCallback((asset: Asset) => {
    setSelectedAssetId(asset.id);
  }, []);
  
  // Handle double-click to select and close
  const handleDoubleClickAsset = useCallback((asset: Asset) => {
    onSelect(asset);
    onClose();
  }, [onSelect, onClose]);
  
  // Handle confirm button
  const handleConfirm = useCallback(() => {
    const selectedAsset = assets.value.find(a => a.id === selectedAssetId);
    if (selectedAsset) {
      onSelect(selectedAsset);
      onClose();
    }
  }, [selectedAssetId, assets.value, onSelect, onClose]);
  
  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && selectedAssetId) {
        handleConfirm();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedAssetId, onClose, handleConfirm]);
  
  if (!isOpen) return null;
  
  return (
    <div class={styles.overlay} onClick={onClose}>
      <div class={styles.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div class={styles.header}>
          <h2 class={styles.title}>{title}</h2>
          <div class={styles.headerActions}>
            <button 
              class={styles.refreshButton}
              onClick={() => fetchAssets()}
              title="Refresh assets"
            >
              <RefreshIcon />
            </button>
            <button 
              class={styles.closeButton}
              onClick={onClose}
              title="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        
        {/* Content */}
        <div class={styles.content}>
          {error.value ? (
            <div class={styles.errorState}>
              <p>Failed to load assets. Make sure the asset server is running.</p>
              <button onClick={() => fetchAssets()}>Retry</button>
            </div>
          ) : (
            <AssetPreviewGrid
              assets={filteredAssets}
              selectedAssetId={selectedAssetId}
              searchQuery={searchQuery}
              onSelectAsset={handleSelectAsset}
              onDoubleClickAsset={handleDoubleClickAsset}
              onSearchChange={setSearchQuery}
            />
          )}
        </div>
        
        {/* Footer */}
        <div class={styles.footer}>
          <div class={styles.footerInfo}>
            {isLoading.value ? (
              <span>Loading...</span>
            ) : (
              <span>{filteredAssets.length} assets available</span>
            )}
          </div>
          <div class={styles.footerActions}>
            <button class={styles.cancelButton} onClick={onClose}>
              Cancel
            </button>
            <button 
              class={styles.selectButton}
              onClick={handleConfirm}
              disabled={!selectedAssetId}
            >
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
