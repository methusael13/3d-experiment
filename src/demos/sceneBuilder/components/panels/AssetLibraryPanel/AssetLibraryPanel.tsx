/**
 * AssetLibraryPanel - Main asset library panel at bottom of viewport
 * Combines CategoryBrowser (left) with AssetPreviewGrid (right)
 */

import { useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { useAssetLibrary, type Asset } from '../../hooks/useAssetLibrary';
import { CategoryBrowser } from './CategoryBrowser';
import { AssetPreviewGrid } from './AssetPreviewGrid';
import styles from './AssetLibraryPanel.module.css';

// ==================== Types ====================

export interface AssetLibraryPanelProps {
  isVisible: boolean;
  onToggleVisibility: () => void;
  onSelectAsset?: (asset: Asset) => void;
  onAddAssetToScene?: (asset: Asset) => void;
}

// ==================== Icons ====================

const ChevronUpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
  </svg>
);

const LibraryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2z"/>
  </svg>
);

const WarningIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
  </svg>
);

// ==================== Component ====================

export function AssetLibraryPanel({
  isVisible,
  onToggleVisibility,
  onSelectAsset,
  onAddAssetToScene,
}: AssetLibraryPanelProps) {
  const { assets, isLoading, error, fetchAssets, connectWebSocket, disconnectWebSocket } = useAssetLibrary();
  
  // Local state - now includes category for type/category/subtype hierarchy
  const [selectedCategory, setSelectedCategory] = useState<{ type?: string; category?: string | null; subtype?: string } | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['root']));
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Fetch assets on mount
  useEffect(() => {
    fetchAssets();
    connectWebSocket();
    return () => disconnectWebSocket();
  }, []);
  
  // Filter assets by selected category (type -> category -> subtype hierarchy)
  const filteredAssets = useMemo(() => {
    if (!selectedCategory) return assets.value;
    return assets.value.filter(asset => {
      // Match type
      if (selectedCategory.type && asset.type !== selectedCategory.type) return false;
      
      // Match category (if specified in filter)
      // category: null means explicitly filter to uncategorized items
      // category: undefined means don't filter by category
      if ('category' in selectedCategory) {
        const filterCategory = selectedCategory.category;
        const assetCategory = asset.category ?? null;
        if (filterCategory !== assetCategory) return false;
      }
      
      // Match subtype (if specified in filter)
      if (selectedCategory.subtype) {
        const assetSubtype = asset.subtype ?? null;
        if (assetSubtype !== selectedCategory.subtype) return false;
      }
      
      return true;
    });
  }, [assets.value, selectedCategory]);
  
  // Handlers
  const handleToggleExpand = useCallback((categoryId: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);
  
  const handleSelectAsset = useCallback((asset: Asset) => {
    setSelectedAssetId(asset.id);
    onSelectAsset?.(asset);
  }, [onSelectAsset]);
  
  const handleDoubleClickAsset = useCallback((asset: Asset) => {
    onAddAssetToScene?.(asset);
  }, [onAddAssetToScene]);
  
  return (
    <div class={styles.container}>
      {/* Header / Toggle Bar */}
      <button class={styles.header} onClick={onToggleVisibility}>
        <span class={styles.headerIcon}>
          <LibraryIcon />
        </span>
        <span class={styles.headerTitle}>Asset Library</span>
        {isLoading.value && <span class={styles.loadingIndicator}>Loading...</span>}
        <span class={styles.assetCount}>{assets.value.length} assets</span>
        <span class={styles.toggleIcon}>
          {isVisible ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </span>
      </button>
      
      {/* Content (collapsible) */}
      {isVisible && (
        <div class={styles.content}>
          {/* Error State - shown when asset server is unavailable */}
          {error.value ? (
            <div class={styles.errorState}>
              <div class={styles.errorIcon}>
                <WarningIcon />
              </div>
              <div class={styles.errorMessage}>
                <strong>Asset Server Unavailable</strong>
                <p>Cannot connect to the asset server. Make sure the server is running.</p>
                <code>npm run server:assets</code>
              </div>
              <button class={styles.retryButton} onClick={() => fetchAssets()}>
                <RefreshIcon />
                Retry Connection
              </button>
            </div>
          ) : (
            <>
              {/* Category Browser (left) */}
              <div class={styles.categoryBrowser}>
                <CategoryBrowser
                  assets={assets.value}
                  selectedCategory={selectedCategory}
                  expandedCategories={expandedCategories}
                  onSelectCategory={setSelectedCategory}
                  onToggleExpand={handleToggleExpand}
                />
              </div>
              
              {/* Asset Preview Grid (right) */}
              <div class={styles.previewGrid}>
                <AssetPreviewGrid
                  assets={filteredAssets}
                  selectedAssetId={selectedAssetId}
                  searchQuery={searchQuery}
                  onSelectAsset={handleSelectAsset}
                  onDoubleClickAsset={handleDoubleClickAsset}
                  onSearchChange={setSearchQuery}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
