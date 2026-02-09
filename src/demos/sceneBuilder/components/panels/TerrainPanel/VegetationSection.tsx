/**
 * VegetationSection - Vegetation and biome mask controls for TerrainPanel
 * Opens the BiomeMask editor dockable window
 */

import styles from './TerrainPanel.module.css';

export interface VegetationSectionProps {
  /** Called when Edit Biome Mask button is clicked */
  onOpenBiomeMaskEditor?: () => void;
  /** Whether terrain has been generated (heightmap exists) */
  isTerrainReady?: boolean;
  /** Whether flow map is available (hydraulic erosion was run) */
  hasFlowMap?: boolean;
}

export function VegetationSection({ 
  onOpenBiomeMaskEditor,
  isTerrainReady = false,
  hasFlowMap = false,
}: VegetationSectionProps) {
  const canEdit = isTerrainReady;
  
  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Vegetation</div>
      
      <button
        class={styles.actionButton}
        onClick={onOpenBiomeMaskEditor}
        disabled={!canEdit}
        title={
          !isTerrainReady 
            ? "Generate terrain first" 
            : "Opens dockable window to edit biome mask parameters"
        }
      >
        🌿 Edit Biome Mask...
      </button>
      
      <div class={styles.hint}>
        {!isTerrainReady ? (
          <span class={styles.warningText}>⚠ Generate terrain first</span>
        ) : !hasFlowMap ? (
          <span class={styles.infoText}>
            Run hydraulic erosion for water-flow-based vegetation placement.
          </span>
        ) : (
          "Configure vegetation zones based on terrain height, slope, and water flow."
        )}
      </div>
    </div>
  );
}
