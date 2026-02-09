/**
 * AssetPreviewGrid - Grid of asset preview thumbnails
 * Displays assets with lazy-loaded thumbnails
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import type { Asset } from '../../hooks/useAssetLibrary';
import styles from './AssetPreviewGrid.module.css';

// ==================== Constants ====================

/** Custom MIME type for asset library drag-and-drop */
export const ASSET_LIBRARY_MIME_TYPE = 'application/x-asset-library-item';

// ==================== Types ====================

export interface AssetPreviewGridProps {
  assets: Asset[];
  selectedAssetId: string | null;
  searchQuery: string;
  onSelectAsset: (asset: Asset) => void;
  onDoubleClickAsset: (asset: Asset) => void;
  onSearchChange: (query: string) => void;
}

// ==================== Icons ====================

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
  </svg>
);

const ClearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

const ImageIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
    <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
  </svg>
);

// ==================== AssetThumbnail Component ====================

interface AssetThumbnailProps {
  asset: Asset;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onDragStart: (asset: Asset, e: DragEvent) => void;
}

// Asset server base URL
const ASSET_SERVER_URL = 'http://localhost:3002';

function AssetThumbnail({ asset, isSelected, onClick, onDoubleClick, onDragStart }: AssetThumbnailProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  
  // Use direct preview image URL (served at /api/previews/:filename)
  const previewUrl = asset.previewPath 
    ? `${ASSET_SERVER_URL}/api/previews/${asset.id}.webp` 
    : null;
  
  const handleImageLoad = useCallback(() => {
    setImageLoaded(true);
  }, []);
  
  const handleImageError = useCallback(() => {
    setImageError(true);
  }, []);
  
  const handleDragStart = useCallback((e: DragEvent) => {
    setIsDragging(true);
    onDragStart(asset, e);
  }, [asset, onDragStart]);
  
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);
  
  return (
    <div 
      class={`${styles.thumbnail} ${isSelected ? styles.selected : ''} ${isDragging ? styles.dragging : ''}`}
      onClick={onClick}
      onDblClick={onDoubleClick}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      draggable={true}
      title={asset.name}
    >
      <div class={styles.imageContainer}>
        {previewUrl && !imageError ? (
          <>
            {!imageLoaded && (
              <div class={styles.placeholder}>
                <ImageIcon />
              </div>
            )}
            <img
              src={previewUrl}
              alt={asset.name}
              class={`${styles.image} ${imageLoaded ? styles.loaded : ''}`}
              onLoad={handleImageLoad}
              onError={handleImageError}
              loading="lazy"
            />
          </>
        ) : (
          <div class={styles.placeholder}>
            <ImageIcon />
          </div>
        )}
      </div>
      <div class={styles.label}>
        <span class={styles.name}>{asset.name}</span>
        {asset.subtype && (
          <span class={styles.subtype}>{asset.subtype}</span>
        )}
      </div>
    </div>
  );
}

// ==================== Main Component ====================

export function AssetPreviewGrid({
  assets,
  selectedAssetId,
  searchQuery,
  onSelectAsset,
  onDoubleClickAsset,
  onSearchChange,
}: AssetPreviewGridProps) {
  
  // Handle drag start - serialize asset data to transfer
  const handleAssetDragStart = useCallback((asset: Asset, e: DragEvent) => {
    if (!e.dataTransfer) return;
    
    // Set custom MIME type with asset JSON
    e.dataTransfer.setData(ASSET_LIBRARY_MIME_TYPE, JSON.stringify(asset));
    
    // Also set text/plain as fallback for debugging
    e.dataTransfer.setData('text/plain', asset.name);
    
    // Set drag effect
    e.dataTransfer.effectAllowed = 'copy';
  }, []);
  
  // Filter assets by search query
  const filteredAssets = useMemo(() => {
    if (!searchQuery.trim()) return assets;
    const query = searchQuery.toLowerCase();
    return assets.filter(asset => 
      asset.name.toLowerCase().includes(query) ||
      asset.subtype?.toLowerCase().includes(query) ||
      asset.metadata?.latinName?.toLowerCase().includes(query)
    );
  }, [assets, searchQuery]);
  
  const handleSearchInput = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    onSearchChange(target.value);
  }, [onSearchChange]);
  
  const handleClearSearch = useCallback(() => {
    onSearchChange('');
  }, [onSearchChange]);
  
  return (
    <div class={styles.container}>
      {/* Search Bar */}
      <div class={styles.searchBar}>
        <div class={styles.searchIcon}>
          <SearchIcon />
        </div>
        <input
          type="text"
          class={styles.searchInput}
          placeholder="Search assets..."
          value={searchQuery}
          onInput={handleSearchInput}
        />
        {searchQuery && (
          <button class={styles.clearButton} onClick={handleClearSearch}>
            <ClearIcon />
          </button>
        )}
      </div>
      
      {/* Asset Grid */}
      <div class={styles.grid}>
        {filteredAssets.length > 0 ? (
          filteredAssets.map(asset => (
            <AssetThumbnail
              key={asset.id}
              asset={asset}
              isSelected={asset.id === selectedAssetId}
              onClick={() => onSelectAsset(asset)}
              onDoubleClick={() => onDoubleClickAsset(asset)}
              onDragStart={handleAssetDragStart}
            />
          ))
        ) : (
          <div class={styles.emptyState}>
            {searchQuery ? (
              <span>No assets match "{searchQuery}"</span>
            ) : (
              <span>No assets in this category</span>
            )}
          </div>
        )}
      </div>
      
      {/* Status Bar */}
      <div class={styles.statusBar}>
        <span>{filteredAssets.length} asset{filteredAssets.length !== 1 ? 's' : ''}</span>
        {searchQuery && filteredAssets.length !== assets.length && (
          <span class={styles.filterInfo}> (filtered from {assets.length})</span>
        )}
      </div>
    </div>
  );
}
