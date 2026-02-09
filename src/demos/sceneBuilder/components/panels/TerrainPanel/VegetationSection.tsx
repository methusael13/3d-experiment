/**
 * VegetationSection - Vegetation and biome mask controls for TerrainPanel
 * Opens the BiomeMask editor and Plant Registry editor dockable windows
 */

import styles from './TerrainPanel.module.css';

export interface VegetationSectionProps {
  /** Called when Edit Biome Mask button is clicked */
  onOpenBiomeMaskEditor?: () => void;
  /** Called when Edit Plant Registry button is clicked */
  onOpenPlantRegistry?: () => void;
  /** Whether terrain has been generated (heightmap exists) */
  isTerrainReady?: boolean;
  /** Whether flow map is available (hydraulic erosion was run) */
  hasFlowMap?: boolean;
}

export function VegetationSection({ 
  onOpenBiomeMaskEditor,
  onOpenPlantRegistry,
  isTerrainReady = false,
  hasFlowMap = false,
}: VegetationSectionProps) {
  const canEdit = isTerrainReady;
  
  return (
    <div class={styles.section}>
      <div class={styles.sectionTitle}>Vegetation</div>
      
      <div class={styles.buttonRow}>
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
          🗺️ Edit Biome Mask...
        </button>
        
        <button
          class={styles.actionButton}
          onClick={onOpenPlantRegistry}
          title="Opens dockable window to configure plant types and texture atlases"
        >
          🌿 Edit Plants...
        </button>
      </div>
      
      <div class={styles.hint}>
        {!isTerrainReady ? (
          <span class={styles.warningText}>⚠ Generate terrain first to enable biome mask</span>
        ) : !hasFlowMap ? (
          <span class={styles.infoText}>
            Run hydraulic erosion for water-flow-based vegetation placement.
          </span>
        ) : (
          "Configure vegetation zones and plant types for terrain coverage."
        )}
      </div>
    </div>
  );
}
