/**
 * Asset Library Hook
 * Frontend interface for the asset server API
 */

import { signal, computed, batch } from '@preact/signals';
import type { 
  Asset, 
  AssetType,
  AssetCategory,
  AssetQuery, 
  ServerStatus, 
  FileChangeEvent 
} from '../../../../../server/types/index.js';

// Re-export types for consumers
export type { Asset, AssetType, AssetCategory, AssetQuery, ServerStatus, FileChangeEvent };

// ========== State ==========

const assets = signal<Asset[]>([]);
const isLoading = signal(false);
const error = signal<string | null>(null);
const serverStatus = signal<ServerStatus | null>(null);
const lastFetchTime = signal<number | null>(null);

// WebSocket connection
let ws: WebSocket | null = null;
const wsConnected = signal(false);

// ========== API Functions ==========

const API_BASE = '/api';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  
  const data = await response.json();
  
  if (!data.success) {
    throw new Error(data.error || 'API request failed');
  }
  
  return data.data;
}

// ========== Public API ==========

/**
 * Fetch all assets from server
 */
export async function fetchAssets(query?: AssetQuery): Promise<void> {
  isLoading.value = true;
  error.value = null;
  
  try {
    const params = new URLSearchParams();
    if (query?.type) params.set('type', query.type);
    if (query?.category) params.set('category', query.category);
    if (query?.subtype) params.set('subtype', query.subtype);
    if (query?.biome) params.set('biome', query.biome);
    if (query?.tag) params.set('tag', query.tag);
    if (query?.search) params.set('search', query.search);
    if (query?.hasLod !== undefined) params.set('hasLod', String(query.hasLod));
    if (query?.hasBillboard !== undefined) params.set('hasBillboard', String(query.hasBillboard));
    
    const queryString = params.toString();
    const endpoint = queryString ? `/assets?${queryString}` : '/assets';
    
    const result = await fetchApi<{ assets: Asset[]; total: number }>(endpoint);
    
    batch(() => {
      assets.value = result.assets;
      lastFetchTime.value = Date.now();
    });
  } catch (err) {
    error.value = String(err);
    console.error('[AssetLibrary] Failed to fetch assets:', err);
  } finally {
    isLoading.value = false;
  }
}

/**
 * Get a single asset by ID
 */
export async function getAsset(id: string): Promise<Asset | null> {
  try {
    return await fetchApi<Asset>(`/assets/${id}`);
  } catch (err) {
    console.error(`[AssetLibrary] Failed to get asset ${id}:`, err);
    return null;
  }
}

/**
 * Get server status
 */
export async function fetchServerStatus(): Promise<void> {
  try {
    serverStatus.value = await fetchApi<ServerStatus>('/status');
  } catch (err) {
    console.error('[AssetLibrary] Failed to fetch server status:', err);
  }
}

/**
 * Trigger full reindex on server
 */
export async function triggerReindex(): Promise<void> {
  isLoading.value = true;
  
  try {
    await fetchApi('/index/full', { method: 'POST' });
    await fetchAssets(); // Refresh assets after reindex
  } catch (err) {
    error.value = String(err);
    console.error('[AssetLibrary] Failed to trigger reindex:', err);
  } finally {
    isLoading.value = false;
  }
}

/**
 * Generate preview for an asset
 */
export async function getPreviewUrl(assetId: string): Promise<string | null> {
  try {
    const result = await fetchApi<{ previewUrl: string }>(`/preview/${assetId}`);
    return result.previewUrl;
  } catch {
    return null;
  }
}

/**
 * Connect to WebSocket for live updates
 */
export function connectWebSocket(onUpdate?: (event: FileChangeEvent) => void): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  
  const wsUrl = `ws://localhost:3003`;
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    wsConnected.value = true;
    console.log('[AssetLibrary] WebSocket connected');
  };
  
  ws.onclose = () => {
    wsConnected.value = false;
    console.log('[AssetLibrary] WebSocket disconnected');
    
    // Attempt reconnect after 5 seconds
    setTimeout(() => {
      if (!wsConnected.value) {
        connectWebSocket(onUpdate);
      }
    }, 5000);
  };
  
  ws.onmessage = (event) => {
    try {
      const change = JSON.parse(event.data) as FileChangeEvent;
      console.log('[AssetLibrary] File change:', change);
      
      // Refresh assets on any change
      fetchAssets();
      
      // Call custom handler if provided
      onUpdate?.(change);
    } catch (err) {
      console.error('[AssetLibrary] Failed to parse WebSocket message:', err);
    }
  };
  
  ws.onerror = (err) => {
    console.error('[AssetLibrary] WebSocket error:', err);
  };
}

/**
 * Disconnect WebSocket
 */
export function disconnectWebSocket(): void {
  if (ws) {
    ws.close();
    ws = null;
    wsConnected.value = false;
  }
}

// ========== Computed Values ==========

export const assetsByType = computed(() => {
  const grouped: Record<AssetType, Asset[]> = {
    model: [],
    texture: [],
    material: [],
    unknown: [],
  };
  
  for (const asset of assets.value) {
    grouped[asset.type].push(asset);
  }
  
  return grouped;
});

// Vegetation models (type=model, category=vegetation)
export const vegetationAssets = computed(() => 
  assets.value.filter(a => a.type === 'model' && a.category === 'vegetation')
);

// All models (includes vegetation)
export const modelAssets = computed(() => 
  assets.value.filter(a => a.type === 'model')
);

// Non-vegetation models
export const otherModelAssets = computed(() => 
  assets.value.filter(a => a.type === 'model' && a.category !== 'vegetation')
);

// All textures (includes IBL/HDR)
export const textureAssets = computed(() => 
  assets.value.filter(a => a.type === 'texture')
);

// IBL/HDR textures (type=texture, category=ibl)
export const iblAssets = computed(() => 
  assets.value.filter(a => a.type === 'texture' && a.category === 'ibl')
);

// Alias for backwards compatibility
export const hdrAssets = iblAssets;

// Non-IBL textures
export const otherTextureAssets = computed(() => 
  assets.value.filter(a => a.type === 'texture' && a.category !== 'ibl')
);

// ========== Hook ==========

export interface UseAssetLibraryResult {
  // State
  assets: typeof assets;
  isLoading: typeof isLoading;
  error: typeof error;
  serverStatus: typeof serverStatus;
  wsConnected: typeof wsConnected;
  
  // Computed
  assetsByType: typeof assetsByType;
  vegetationAssets: typeof vegetationAssets;
  modelAssets: typeof modelAssets;
  otherModelAssets: typeof otherModelAssets;
  textureAssets: typeof textureAssets;
  iblAssets: typeof iblAssets;
  hdrAssets: typeof hdrAssets;
  otherTextureAssets: typeof otherTextureAssets;
  
  // Actions
  fetchAssets: typeof fetchAssets;
  getAsset: typeof getAsset;
  fetchServerStatus: typeof fetchServerStatus;
  triggerReindex: typeof triggerReindex;
  getPreviewUrl: typeof getPreviewUrl;
  connectWebSocket: typeof connectWebSocket;
  disconnectWebSocket: typeof disconnectWebSocket;
}

/**
 * Hook to access the asset library
 */
export function useAssetLibrary(): UseAssetLibraryResult {
  return {
    // State
    assets,
    isLoading,
    error,
    serverStatus,
    wsConnected,
    
    // Computed
    assetsByType,
    vegetationAssets,
    modelAssets,
    otherModelAssets,
    textureAssets,
    iblAssets,
    hdrAssets,
    otherTextureAssets,
    
    // Actions
    fetchAssets,
    getAsset,
    fetchServerStatus,
    triggerReindex,
    getPreviewUrl,
    connectWebSocket,
    disconnectWebSocket,
  };
}
