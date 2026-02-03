import { useState, useEffect, useCallback } from 'preact/hooks';
import styles from './EnvironmentPanel.module.css';

interface HdrManifestEntry {
  name: string;
  displayName: string;
}

interface HdrGalleryProps {
  selectedHdrName: string | null;
  isLoading: boolean;
  progress: number;
  hdrFilename: string;
  onSelectHdr: (name: string) => void;
  onLoadSelected: () => void;
  onUploadClick: () => void;
}

export function HdrGallery({
  selectedHdrName,
  isLoading,
  progress,
  hdrFilename,
  onSelectHdr,
  onLoadSelected,
  onUploadClick,
}: HdrGalleryProps) {
  const [manifest, setManifest] = useState<HdrManifestEntry[]>([]);

  // Load HDR manifest on mount
  useEffect(() => {
    const loadManifest = async () => {
      try {
        const response = await fetch('/ibl/manifest.json');
        const data = await response.json();
        setManifest(data.hdrs || []);
      } catch {
        setManifest([]);
      }
    };
    loadManifest();
  }, []);

  const handleItemClick = useCallback(
    (name: string) => {
      if (!isLoading) {
        onSelectHdr(name);
      }
    },
    [isLoading, onSelectHdr]
  );

  return (
    <div class={styles.hdrGallery}>
      <div class={styles.hdrFilename}>{hdrFilename}</div>

      <div class={styles.hdrGalleryLabel}>Available HDRs</div>
      <div class={styles.hdrGalleryGrid}>
        {manifest.map((hdr) => (
          <div
            key={hdr.name}
            class={`${styles.hdrGalleryItem} ${selectedHdrName === hdr.name ? styles.selected : ''} ${isLoading ? styles.loading : ''}`}
            onClick={() => handleItemClick(hdr.name)}
          >
            <img
              class={styles.hdrGalleryThumb}
              src={`/ibl/${hdr.name}.jpg`}
              alt={hdr.displayName}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                const placeholder = (e.target as HTMLImageElement).nextElementSibling as HTMLElement;
                if (placeholder) placeholder.style.display = 'flex';
              }}
            />
            <div class={styles.hdrGalleryPlaceholder} style={{ display: 'none' }}>
              🌄
            </div>
            <div class={styles.hdrGalleryName}>{hdr.displayName}</div>
          </div>
        ))}

        {/* Upload button */}
        <div class={styles.hdrGalleryItem} onClick={onUploadClick}>
          <div class={styles.hdrGalleryUpload}>
            <span class={styles.hdrGalleryUploadIcon}>+</span>
            <span>Upload</span>
          </div>
        </div>
      </div>

      <button
        class={styles.hdrLoadBtn}
        onClick={onLoadSelected}
        disabled={!selectedHdrName || isLoading}
        type="button"
      >
        {isLoading ? 'Loading...' : 'Load Selected'}
      </button>

      {/* Progress bar */}
      {isLoading && (
        <div class={styles.hdrProgress}>
          <div class={styles.hdrProgressBar}>
            <div
              class={styles.hdrProgressFill}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span class={styles.hdrProgressText}>Processing...</span>
        </div>
      )}
    </div>
  );
}
