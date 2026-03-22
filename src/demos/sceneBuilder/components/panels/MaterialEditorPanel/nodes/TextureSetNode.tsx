/**
 * TextureSet Node - Multi-output texture node from asset library
 * 
 * Picks a texture asset and exposes dynamic outputs for each available map type.
 * Uses a portal to render AssetPickerModal outside the React Flow canvas.
 * Shows a thumbnail preview of the albedo (or selected) texture.
 */

import { useState, useCallback, useMemo } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import { AssetPickerModal } from '../../../ui/AssetPickerModal';
import type { Asset } from '../../../hooks/useAssetLibrary';
import type { NodePortDef } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: NodePortDef = {
  outputs: {
    // Dynamic outputs: handle IDs are fileSubType values (albedo, normal, roughness, etc.)
    // The '*' wildcard resolver extracts the file path from the asset data.
    '*': {
      type: 'texture',
      resolver: (data, handleId) => {
        const asset = data.asset as { files?: Array<{ fileSubType?: string; path?: string }> } | null;
        if (!asset?.files) return undefined;
        const file = asset.files.find(f => f.fileSubType === handleId);
        return file?.path ?? undefined;
      },
    },
  },
  inputs: {},
};

interface TextureSetNodeData {
  asset?: Asset | null;
  availableMaps?: string[];
  [key: string]: unknown;
}

/** Map fileSubType to display labels */
const MAP_LABELS: Record<string, string> = {
  albedo: 'Albedo',
  normal: 'Normal',
  roughness: 'Roughness',
  ao: 'AO',
  displacement: 'Displacement',
  specular: 'Specular',
  bump: 'Bump',
  gloss: 'Gloss',
  cavity: 'Cavity',
  opacity: 'Opacity',
  translucency: 'Translucency',
};

/** Map fileSubType to handle color dots */
const MAP_COLORS: Record<string, string> = {
  albedo: '#e8a060',
  normal: '#6090e8',
  roughness: '#80c080',
  ao: '#c0c0c0',
  displacement: '#c080c0',
  specular: '#e0e060',
  bump: '#a0a0c0',
  gloss: '#80c0c0',
  cavity: '#c09060',
  opacity: '#e0e0e0',
  translucency: '#60c0a0',
};

/** Get the best preview image URL from an asset's files */
function getPreviewUrl(asset: Asset): string | null {
  if (!asset.files) return null;
  // Prefer albedo/basecolor as preview, then any other texture
  const albedoFile = asset.files.find(f => f.fileSubType === 'albedo');
  if (albedoFile) return albedoFile.path;
  // Fallback: use preview path from asset
  if (asset.previewPath) return asset.previewPath;
  // Fallback: first texture file
  const firstTex = asset.files.find(f => f.fileType === 'texture');
  return firstTex?.path ?? null;
}

export function TextureSetNode({ data, id }: NodeProps) {
  const d = data as TextureSetNodeData;
  const asset = d.asset ?? null;
  const availableMaps = d.availableMaps ?? [];
  const { updateNodeData } = useReactFlow();
  
  const [pickerOpen, setPickerOpen] = useState(false);
  
  const handleBrowse = useCallback(() => {
    setPickerOpen(true);
  }, []);
  
  const handleAssetSelect = useCallback((selectedAsset: Asset) => {
    const maps: string[] = [];
    if (selectedAsset.files) {
      for (const file of selectedAsset.files) {
        if (file.fileSubType && !maps.includes(file.fileSubType)) {
          maps.push(file.fileSubType);
        }
      }
    }
    
    updateNodeData(id, {
      asset: selectedAsset,
      availableMaps: maps,
    });
    
    setPickerOpen(false);
  }, [id, updateNodeData]);
  
  const previewUrl = useMemo(() => asset ? getPreviewUrl(asset) : null, [asset]);
  
  return (
    <div class={styles.node} style={{ minWidth: '180px' }}>
      <div class={styles.textureHeader}>
        <span class={styles.nodeHeaderIcon}>🖼️</span>
        Texture Set
      </div>
      <div class={styles.nodeBody}>
        {/* Asset picker area with preview */}
        {!asset ? (
          <div class={styles.texturePreview} onClick={handleBrowse}>
            Click to browse textures
          </div>
        ) : (
          <div>
            <div
              class={`${styles.texturePreview} ${styles.textureLoaded}`}
              onClick={handleBrowse}
              style={previewUrl ? {
                backgroundImage: `url(/${previewUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                height: '80px',
              } : undefined}
            >
              {!previewUrl && <span class={styles.textureName}>{asset.name}</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
              <span class={styles.textureName} style={{ flex: 1 }}>{asset.name}</span>
              <button class={styles.browseBtn} onClick={handleBrowse}>
                Change
              </button>
            </div>
          </div>
        )}
        
        {/* Dynamic output handles based on available maps */}
        {availableMaps.length > 0 && (
          <div class={styles.outputSection}>
            {availableMaps.map((mapType) => (
              <div key={mapType} class={styles.outputHandle}>
                <span class={styles.handleLabelRight}>
                  {MAP_LABELS[mapType] ?? mapType}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={mapType}
                  style={{
                    top: 'auto',
                    background: MAP_COLORS[mapType] ?? '#888',
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* Portal the modal to document.body so it renders outside React Flow */}
      {pickerOpen && createPortal(
        <AssetPickerModal
          isOpen={true}
          onClose={() => setPickerOpen(false)}
          onSelect={handleAssetSelect}
          title="Select Texture Set"
          filterType="texture"
        />,
        document.body
      )}
    </div>
  );
}
