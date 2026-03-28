/**
 * Terrain Node — References a terrain entity in the scene.
 * Output port: terrain (TerrainData).
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: CCNodePortLayout = {
  inputs: [],
  outputs: [
    { id: 'terrain', label: 'Terrain', type: 'terrainData', direction: 'output' },
  ],
};

export function TerrainNode({ data }: NodeProps) {
  const d = data as Record<string, any>;

  return (
    <div class={styles.node} style={{ minWidth: '180px' }}>
      <div class={styles.terrainHeader}>
        <span class={styles.nodeHeaderIcon}>⛰️</span>
        Terrain
      </div>
      <div class={styles.nodeBody}>
        <div class={styles.propRow}>
          <span class={styles.propLabel}>Entity</span>
          <span class={styles.propValue}>{d.terrainEntityId ? 'Connected' : 'Auto-detect'}</span>
        </div>

        {/* Output port */}
        <div class={styles.handleRow}>
          <span class={styles.handleLabelRight}>Terrain</span>
          <Handle type="source" position={Position.Right} id="terrain" style={{ top: 'auto' }} />
        </div>
      </div>
    </div>
  );
}
