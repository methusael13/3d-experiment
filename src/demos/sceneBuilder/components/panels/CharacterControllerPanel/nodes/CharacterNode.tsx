/**
 * Character Node — Central anchor node representing the player entity.
 * Has input ports (input, terrain) and output port (characterState).
 * Displays movement/physics parameters.
 */

import { useCallback } from 'preact/hooks';
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react';
import type { CCNodePortLayout } from './portTypes';
import styles from './nodeStyles.module.css';

/** Port definition — co-located with the node component */
export const portDef: CCNodePortLayout = {
  inputs: [
    { id: 'input', label: 'Input', type: 'inputIntent', direction: 'input' },
    { id: 'terrain', label: 'Terrain', type: 'terrainData', direction: 'input' },
  ],
  outputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'output' },
  ],
};

export function CharacterNode({ data, id }: NodeProps) {
  const d = data as Record<string, any>;
  const { updateNodeData } = useReactFlow();

  const set = useCallback((key: string, value: number) => {
    updateNodeData(id, { [key]: value });
  }, [id, updateNodeData]);

  return (
    <div class={styles.node}>
      <div class={styles.characterHeader}>
        <span class={styles.nodeHeaderIcon}>🏃</span>
        Character
      </div>
      <div class={styles.nodeBody}>
        {/* Input port */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="input" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Input</span>
        </div>

        {/* Terrain port */}
        <div class={styles.handleRow}>
          <Handle type="target" position={Position.Left} id="terrain" style={{ top: 'auto' }} />
          <span class={styles.handleLabelLeft}>Terrain</span>
        </div>

        {/* Properties */}
        <div class={styles.section}>
          <div class={styles.sectionLabel}>Movement</div>
          <div class="nopan nodrag">
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Speed</span>
              <input class={styles.propInput} type="number" step="0.5" value={d.moveSpeed ?? 5} onInput={(e: any) => set('moveSpeed', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Run</span>
              <input class={styles.propInput} type="number" step="0.5" value={d.runSpeed ?? 10} onInput={(e: any) => set('runSpeed', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Jump</span>
              <input class={styles.propInput} type="number" step="0.5" value={d.jumpForce ?? 8} onInput={(e: any) => set('jumpForce', +e.target.value)} />
            </div>
          </div>
        </div>

        <div class={styles.section}>
          <div class={styles.sectionLabel}>Physics</div>
          <div class="nopan nodrag">
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Gravity</span>
              <input class={styles.propInput} type="number" step="1" value={d.gravity ?? -20} onInput={(e: any) => set('gravity', +e.target.value)} />
            </div>
            <div class={styles.propRow}>
              <span class={styles.propLabel}>Height</span>
              <input class={styles.propInput} type="number" step="0.1" value={d.playerHeight ?? 1.8} onInput={(e: any) => set('playerHeight', +e.target.value)} />
            </div>
          </div>
        </div>

        {/* Output port */}
        <div class={styles.handleRow}>
          <span class={styles.handleLabelRight}>Character State</span>
          <Handle type="source" position={Position.Right} id="characterState" style={{ top: 'auto' }} />
        </div>
      </div>
    </div>
  );
}
