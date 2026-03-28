/**
 * Input Node — Defines input mode and key bindings.
 * Output port: intent (InputIntent).
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: CCNodePortLayout = {
  inputs: [],
  outputs: [
    { id: 'intent', label: 'Intent', type: 'inputIntent', direction: 'output' },
  ],
};

export function InputNode({ data, id }: NodeProps) {
  const d = data as Record<string, any>;
  const { updateNodeData } = useReactFlow();

  const setMode = useCallback((e: Event) => {
    updateNodeData(id, { mode: (e.target as HTMLSelectElement).value });
  }, [id, updateNodeData]);

  const setSprint = useCallback((e: Event) => {
    updateNodeData(id, { sprintMode: (e.target as HTMLSelectElement).value });
  }, [id, updateNodeData]);

  return (
    <div class={styles.node}>
      <div class={styles.inputHeader}>
        <span class={styles.nodeHeaderIcon}>🎮</span>
        Input
      </div>
      <div class={styles.nodeBody}>
        <div class="nopan nodrag">
          <div class={styles.propRow}>
            <span class={styles.propLabel}>Mode</span>
            <select class={styles.propSelect} value={d.mode ?? 'tps'} onChange={setMode}>
              <option value="tps">TPS</option>
              <option value="fps">FPS</option>
            </select>
          </div>
          <div class={styles.propRow}>
            <span class={styles.propLabel}>Sprint</span>
            <select class={styles.propSelect} value={d.sprintMode ?? 'hold'} onChange={setSprint}>
              <option value="hold">Hold</option>
              <option value="toggle">Toggle</option>
            </select>
          </div>
        </div>

        <div class={styles.section}>
          <div class={styles.sectionLabel}>Bindings</div>
          <div style={{ fontSize: '9px', color: '#666' }}>
            WASD + Space + Shift (default)
          </div>
        </div>

        {/* Output port */}
        <div class={styles.handleRow}>
          <span class={styles.handleLabelRight}>Intent</span>
          <Handle type="source" position={Position.Right} id="intent" style={{ top: 'auto' }} />
        </div>
      </div>
    </div>
  );
}
